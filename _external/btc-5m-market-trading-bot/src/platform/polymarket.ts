import { ClobWrapper, geocheck } from "../live/clob/client.js";
import { connectAccountReader } from "../live/account-data.js";
import { findMarket } from "../live/discovery.js";
import { runPolymarketFeed } from "../live/feeds/polymarket.js";
import { runUserFeed, type UserFeedControl } from "../live/feeds/user.js";
import { runBtcFeed } from "../live/feeds/btc.js";
import type { FeedEvent } from "../live/feeds/index.js";
import { ownerSignerPrivateKey } from "../live/account.js";
import { polymarketFillFee } from "../models.js";
import type { AccountSnapshot, Book, CoreState, GatewayAck, HardLimits, Instrument, MarketInfo,
  OrderGateway, OrderRecord, OrderRequest, PlatformAdapters, TradingMode } from "./contracts.js";
import { PaperGateway } from "./paper.js";
import { TradingPlatform } from "./platform.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => typeof value === "object" && value !== null ? value as Row : {};
const numeric = (value: unknown): number => value === null || value === undefined || value === "" ? NaN : Number(value);

/** Explicit market selector used by the existing BTC command, outside the generic platform. */
export async function discoverBtcMarket(): Promise<MarketInfo[]> {
  const market = await findMarket(Date.now() / 1000);
  if (!market) return [];
  const instruments = await Promise.all([[market.upToken, "UP"], [market.downToken, "DOWN"]].map(async ([tokenId, outcome]) => {
    const response = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("market rules unavailable");
    const book = row(await response.json());
    const tickSize = numeric(book.tick_size), minOrderSize = numeric(book.min_order_size);
    if (!(tickSize > 0 && tickSize < 1 && minOrderSize > 0)) throw new Error("invalid venue instrument rules");
    return { tokenId, outcome, marketId: market.conditionId, tickSize, minOrderSize };
  }));
  return [{ id: market.conditionId, name: market.slug, startsAt: market.start, endsAt: market.end, instruments }];
}

export function accountSnapshot(raw: unknown): AccountSnapshot {
  const data = row(raw), collateral = row(data.collateral), positions = row(data.positions), open = row(data.open_orders);
  if (![collateral, positions, open].every(s => s.available === true && s.complete === true)
    || !Array.isArray(positions.items) || !Array.isArray(open.items)) throw new Error("account sections incomplete");
  const at = Date.parse(String(data.checked_at)) / 1000;
  const orders = open.items.map(rawOrder => {
    const o = row(rawOrder), direction = String(o.side).toUpperCase();
    if (direction !== "BUY" && direction !== "SELL") throw new Error("unknown account order direction");
    const shares = numeric(o.original_size ?? o.size), filledShares = numeric(o.size_matched ?? 0), price = numeric(o.price);
    if (!o.id || !o.asset_id || ![shares, filledShares, price].every(Number.isFinite)) throw new Error("invalid open account order");
    return { clientOrderId: `import:${String(o.id)}`, strategyId: "external", orderId: String(o.id),
      tokenId: String(o.asset_id), direction, price, shares, filledShares,
      timeInForce: "GTC", postOnly: false, status: filledShares > 0 ? "PARTIAL" : "OPEN",
      reservedUsd: direction === "BUY"
        ? Math.max(0, shares - filledShares) * (price + 0.07 * 0.25) : 0,
      reservedShares: direction === "SELL" ? Math.max(0, shares - filledShares) : 0, createdAt: at, updatedAt: at } as OrderRecord;
  });
  const result: AccountSnapshot = { accountId: String(data.wallet ?? ""), at, complete: true,
    cashUsd: numeric(collateral.value), openOrders: orders,
    positions: positions.items.map(rawPosition => {
      const p = row(rawPosition), shares = numeric(p.size), avg = numeric(p.avgPrice);
      if (!p.asset || !Number.isFinite(shares) || shares < 0 || !Number.isFinite(avg) || avg < 0) throw new Error("invalid account position basis");
      return { tokenId: String(p.asset), shares, costUsd: shares * avg, realizedPnlUsd: numeric(p.realizedPnl ?? 0) };
    }) };
  return result;
}

/** One CLOB connection is shared by every strategy and order direction. */
export class PolymarketGateway implements OrderGateway {
  readonly mode = "live" as const;
  constructor(readonly client: ClobWrapper, private readonly ready: () => boolean = () => true) {}
  async submit(request: OrderRequest, instrument: Instrument): Promise<GatewayAck> {
    if (!this.ready()) return { status: "rejected", error: "authenticated feed is not ready" };
    const response = await this.client.submitOrder({ tokenId: request.tokenId, price: request.price,
      size: request.shares, tickSize: instrument.tickSize, direction: request.direction,
      timeInForce: request.timeInForce, postOnly: request.postOnly });
    return { status: response.success && response.orderId ? "accepted"
      : response.stateUnknown || response.orderId || response.success ? "unknown" : "rejected",
      orderId: response.orderId, error: response.errorMsg, tradeIds: response.tradeIds,
      signLatencyMs: response.signLatencyMs, ackLatencyMs: response.ackLatencyMs };
  }
  cancel(orderId: string): Promise<boolean> { return this.client.cancel(orderId); }
}

export interface ConnectOptions {
  mode: TradingMode;
  markets: MarketInfo[];
  limits: HardLimits;
  paperCashUsd?: number;
  /** Caller-supplied portfolio enables replay of an existing position without a strategy. */
  paperAccount?: AccountSnapshot;
  restored?: CoreState;
  persist?: PlatformAdapters["persist"];
  record?: PlatformAdapters["record"];
  settle?: PlatformAdapters["settle"];
  durationSec?: number;
  referenceFeed?: boolean;
}

export async function connectPolymarketPlatform(options: ConnectOptions) {
  if (!options.markets.length || options.markets.some(m => m.instruments.length !== 2)) {
    throw new Error("the current Polymarket feed adapter requires explicit binary markets");
  }
  if (options.mode === "live" && (options.limits.capitalUsd > 50 || options.limits.dailyLossUsd > 30)) {
    throw new Error("live account limits exceed the configured $50 capital / $30 daily loss budget");
  }
  let platform!: TradingPlatform;
  let client: ClobWrapper | undefined;
  let readAccount: PlatformAdapters["readAccount"];
  let paper: PaperGateway | undefined;
  const controls: { stop: () => void }[] = [];
  const users: UserFeedControl[] = [];
  const booksHealthy = new Map<string, boolean>();
  const userHealthy = new Map<string, boolean>();
  const registered = new Set<string>();
  let started = false;
  let stopped = false;
  let stopHeartbeat: (() => void) | undefined;
  const fee = (order: OrderRequest, shares = order.shares) => order.postOnly ? 0
    // Reserve the maximum convex fee at p=0.50; the actual fill uses its own price.
    : polymarketFillFee(shares, 0.5, false, 0.07, 0, 1);
  let account: AccountSnapshot;
  let gateway: OrderGateway;
  if (options.mode === "live") {
    if (!options.persist) throw new Error("live platform requires durable account-scoped state persistence");
    await geocheck();
    const key = ownerSignerPrivateKey();
    if (!key) throw new Error("wallet signing key unavailable");
    const reader = await connectAccountReader();
    readAccount = async () => accountSnapshot(await reader());
    account = await readAccount();
    client = await ClobWrapper.connect({ key });
    for (const market of options.markets) await client.warmMarket(market.id);
    gateway = new PolymarketGateway(client, () => !stopped && options.markets.every(m =>
      booksHealthy.get(m.id) && userHealthy.get(m.id)) && users.every(u => u.isHealthy() && (u.isContinuous?.() ?? true)));
  } else {
    account = options.paperAccount ?? { accountId: "paper", at: Date.now() / 1000,
      cashUsd: options.paperCashUsd ?? 1000, positions: [], openOrders: [], complete: true };
    if (account.openOrders.length) throw new Error("paper imported orders require explicit broker restoration");
    paper = new PaperGateway(fill => platform.ingest({ kind: "fill", fill }),
      (_order, shares, execution) => polymarketFillFee(shares, execution.price, execution.isMaker, 0.07, 0, 1),
      orderId => platform.core.confirmCancelled(orderId));
    gateway = paper;
  }
  platform = new TradingPlatform({ account, instruments: options.markets.flatMap(m => m.instruments),
    limits: options.limits, restored: options.restored,
    adapters: { gateway, readAccount, discoverMarkets: discoverBtcMarket, estimateFee: fee,
      persist: options.persist, record: options.record, settle: options.settle } });
  if (options.mode === "live" && options.restored) {
    // Resolve persisted in-flight orders against the fresh ordinary account read
    // before starting feeds. Missing or changed orders fail closed in reconcile().
    platform.account.reconcile(account);
  }
  for (const market of options.markets) platform.ingest({ kind: "market", market });
  platform.subscribe(event => {
    if (event.kind !== "order" || !event.order.orderId || registered.has(event.order.orderId)) return;
    registered.add(event.order.orderId);
    for (const user of users) user.registerOrder(event.order.orderId, event.order.tradeIds);
  });

  const sink = (market: MarketInfo) => (event: FeedEvent) => {
    try {
      if (event.kind === "bookStatus") { booksHealthy.set(market.id, event.healthy); return; }
      if (event.kind === "userStatus") { userHealthy.set(market.id, event.healthy); return; }
      if (event.kind === "book") {
        const b = event.snapshot;
        const values: Book[] = [
          { tokenId: market.instruments[0].tokenId, ts: b.upExchangeTsUnix ?? b.tsUnix, exchangeTs: b.upExchangeTsUnix,
            receivedAt: b.receivedAtUnix, receivedAtMonoMs: b.receivedAtMonoMs, processedAtMonoMs: b.processedAtMonoMs,
            processingLatencyMs: b.receivedAtMonoMs != null && b.processedAtMonoMs != null ? b.processedAtMonoMs - b.receivedAtMonoMs : undefined,
            sourceAgeMs: b.marketAgeMs, source: b.source, bid: b.upBid, ask: b.upAsk, bidSize: b.upBidSz, askSize: b.upAskSz,
            bids: b.upBidLevels, asks: b.upAskLevels },
          { tokenId: market.instruments[1].tokenId, ts: b.downExchangeTsUnix ?? b.tsUnix, exchangeTs: b.downExchangeTsUnix,
            receivedAt: b.receivedAtUnix, receivedAtMonoMs: b.receivedAtMonoMs, processedAtMonoMs: b.processedAtMonoMs,
            processingLatencyMs: b.receivedAtMonoMs != null && b.processedAtMonoMs != null ? b.processedAtMonoMs - b.receivedAtMonoMs : undefined,
            sourceAgeMs: b.marketAgeMs, source: b.source, bid: b.downBid, ask: b.downAsk, bidSize: b.downBidSz, askSize: b.downAskSz,
            bids: b.downBidLevels, asks: b.downAskLevels },
        ];
        for (const book of values) { paper?.book(book); platform.ingest({ kind: "book", book }); }
      } else if (event.kind === "tickSize") {
        const instrument = platform.core.instrument(event.token);
        if (instrument) {
          market.instruments = market.instruments.map(i => i.tokenId === event.token ? { ...i, tickSize: event.tickSize } : i);
          platform.ingest({ kind: "market", market }); client?.updateTickSize(event.token, event.tickSize);
        }
      } else if (event.kind === "marketTrade") {
        const direction = event.takerSide.toUpperCase();
        if (direction === "BUY" || direction === "SELL") paper?.trade(event.token, direction, event.price, event.shares, event.tsUnix);
      } else if (event.kind === "btc" || event.kind === "oracle") {
        platform.ingest({ kind: "reference", symbol: event.kind === "btc" ? "BTC" : "BTC_ORACLE", price: event.price, ts: event.tsUnix });
      } else if (event.kind === "user") {
        const userEvent = event.event;
        if (userEvent.kind === "orderCancelled") {
          if (platform.orders.get(userEvent.orderId)) platform.core.confirmCancelled(userEvent.orderId);
        } else {
          if (!userEvent.orderId || !userEvent.tradeId || !userEvent.tokenId || !userEvent.direction
            || !platform.orders.get(userEvent.orderId)) throw new Error("account trade requires order ownership reconciliation");
          const f = userEvent.fill;
          platform.ingest({ kind: "fill", fill: { tradeId: userEvent.tradeId, orderId: userEvent.orderId,
            tokenId: userEvent.tokenId, direction: userEvent.direction, price: f.price, shares: f.shares,
            feeUsd: polymarketFillFee(f.shares, f.price, f.isMaker, 0.07, 0, 1), ts: f.tsUnix, isMaker: f.isMaker } });
        }
      }
    } catch (error) {
      userHealthy.set(market.id, false);
      platform.ingest({ kind: "error", message: error instanceof Error ? error.message : "feed processing failed" });
    }
  };
  return {
    platform,
    async start() {
      if (started || stopped) throw new Error("connection already started or stopped");
      started = true;
      const deadline = Date.now() / 1000 + (options.durationSec ?? 3600);
      for (const market of options.markets) {
        const [up, down] = market.instruments;
        const feed = runPolymarketFeed(sink(market), up.tokenId, down.tokenId, deadline);
        controls.push(feed);
        if (client) {
          const user = runUserFeed(sink(market), { creds: client.creds, conditionId: market.id,
            upToken: up.tokenId, downToken: down.tokenId, accountAddress: client.funder,
            includeSellTrades: true, orderDirection: id => platform.orders.get(id)?.direction,
            isOurOrder: id => !!platform.orders.get(id),
            fetchTrades: ids => client!.getTradesByIds(ids), fetchRecentTrades: after => client!.getRecentTrades(market.id, after),
            fetchOpenOrders: () => client!.getOpenOrders(market.id),
            verifyAuthenticated: async () => { await client!.getOpenOrders(market.id); return true; },
          }, deadline);
          users.push(user); controls.push(user);
        }
      }
      if (options.referenceFeed) controls.push(runBtcFeed(sink(options.markets[0])));
      if (client) {
        stopHeartbeat = client.startHeartbeat();
        try { await Promise.all(users.map(user => user.waitUntilReady())); }
        catch (error) { for (const control of controls) control.stop(); stopHeartbeat?.(); stopped = true; throw error; }
      }
    },
    async stop(reason = "operator stop") {
      stopped = true;
      // Keep user events alive while cancellation requests finish.
      try { await platform.stop(reason); }
      finally { for (const control of controls) control.stop(); stopHeartbeat?.(); client?.stopHeartbeat(); }
    },
  };
}
