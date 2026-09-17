import { ClobWrapper, geocheck } from "../live/clob/client.js";
import { connectAccountReader } from "../live/account-data.js";
import { findMarket } from "../live/discovery.js";
import { runPolymarketFeed } from "../live/feeds/polymarket.js";
import { parseAuthenticatedTrade, runUserFeed, type UserFeedControl } from "../live/feeds/user.js";
import { runBtcFeed } from "../live/feeds/btc.js";
import type { FeedEvent } from "../live/feeds/index.js";
import { ownerSignerPrivateKey } from "../live/account.js";
import { polymarketFillFee } from "../models.js";
import type { AccountSnapshot, Book, CoreState, GatewayAck, HardLimits, Instrument, MarketInfo,
  OrderGateway, OrderRecord, OrderRequest, PlatformAdapters, PreparedOrder, TradingMode } from "./contracts.js";
import { PaperGateway } from "./paper.js";
import { TradingPlatform } from "./platform.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => typeof value === "object" && value !== null ? value as Row : {};
const numeric = (value: unknown): number => value === null || value === undefined || value === "" ? NaN : Number(value);

/** Explicit market selector used by the existing BTC command, outside the generic platform. */
export async function discoverBtcMarket(at = Date.now() / 1000): Promise<MarketInfo[]> {
  const market = await findMarket(at);
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
  readonly durableIdentity = true;
  constructor(readonly client: ClobWrapper, private readonly ready: (instrument: Instrument) => boolean = () => true) {}
  async submit(request: OrderRequest, instrument: Instrument, prepared?: (value: PreparedOrder) => void): Promise<GatewayAck> {
    if (!this.ready(instrument)) return { status: "rejected", error: "authenticated feed is not ready" };
    const response = await this.client.submitOrder({ tokenId: request.tokenId, price: request.price,
      size: request.shares, tickSize: instrument.tickSize, direction: request.direction,
      timeInForce: request.timeInForce, postOnly: request.postOnly, onPrepared: prepared });
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
  /** Observation runs consume books but do not drive the paper matching model. */
  observationOnly?: boolean;
}

export async function connectPolymarketPlatform(options: ConnectOptions) {
  if (!options.markets.length || options.markets.some(m => m.instruments.length !== 2)) {
    throw new Error("the current Polymarket feed adapter requires explicit binary markets");
  }
  let platform!: TradingPlatform;
  let client: ClobWrapper | undefined;
  let readAccount: PlatformAdapters["readAccount"];
  let paper: PaperGateway | undefined;
  const controls = new Set<{ stop: () => void }>();
  const bookFeeds = new Map<string, { stop: () => void }>();
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const users: UserFeedControl[] = [];
  const booksHealthy = new Map<string, boolean>();
  const bookHealth = new Map<string, () => boolean>();
  const userHealthy = new Map<string, boolean>();
  const usersByMarket = new Map<string, UserFeedControl>();
  const connectedMarkets = new Set<string>();
  const registered = new Map<string, Set<string>>();
  let started = false;
  let stopped = false;
  let acceptUserEvents = true;
  let stopHeartbeat: (() => void) | undefined;
  let recoveryJob: Promise<void> | undefined;
  let recovering = options.mode === "live" && !!options.restored;
  const fee = (order: OrderRequest, shares = order.shares) => {
    if (order.postOnly) return 0;
    const rule = client?.feeRule(order.tokenId);
    // All successful live warmups supply current venue fee rules. The paper
    // reference rate is an estimate and is never labelled a reported fee.
    return Math.ceil(polymarketFillFee(shares, 0.5, false, rule?.rate ?? 0.07, 0, rule?.exponent ?? 1) * 100_000) / 100_000;
  };
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
    gateway = new PolymarketGateway(client, instrument => {
      const user = usersByMarket.get(instrument.marketId);
      return !stopped && !recovering && !!booksHealthy.get(instrument.marketId) && !!bookHealth.get(instrument.marketId)?.()
        && !!userHealthy.get(instrument.marketId) && !!user?.isHealthy() && (user.isContinuous?.() ?? true);
    });
  } else {
    account = options.paperAccount ?? { accountId: "paper", at: Date.now() / 1000,
      cashUsd: options.paperCashUsd ?? 1000, positions: [], openOrders: [], complete: true };
    if (account.openOrders.length) throw new Error("paper imported orders require explicit broker restoration");
    paper = new PaperGateway(fill => platform.ingest({ kind: "fill", fill }),
      (_order, shares, execution) => polymarketFillFee(shares, execution.price, execution.isMaker, 0.07, 0, 1),
      orderId => platform.core.confirmCancelled(orderId, true));
    gateway = paper;
  }
  platform = new TradingPlatform({ account, instruments: options.markets.flatMap(m => m.instruments),
    limits: options.limits, restored: options.restored,
    adapters: { gateway, readAccount, discoverMarkets: discoverBtcMarket, estimateFee: fee,
      persist: options.persist, record: options.record, settle: options.settle,
      beforeFinalReconcile: () => {
        acceptUserEvents = false;
        for (const user of users) user.stop();
      } } });
  for (const market of options.markets) platform.ingest({ kind: "market", market });
  platform.subscribe(event => {
    if (event.kind !== "order" || !event.order.orderId) return;
    const previous = registered.get(event.order.orderId);
    const freshTrades = (event.order.tradeIds ?? []).filter(id => !previous?.has(id));
    if (previous && !freshTrades.length) return;
    const tradeIds = previous ?? new Set<string>();
    for (const id of freshTrades) tradeIds.add(id);
    registered.set(event.order.orderId, tradeIds);
    const marketId = platform.core.instrument(event.order.tokenId)?.marketId;
    const user = marketId ? usersByMarket.get(marketId) : undefined;
    user?.registerOrder(event.order.orderId, freshTrades);
  });

  const sink = (market: MarketInfo) => (event: FeedEvent) => {
    try {
      if (event.kind === "bookStatus") {
        booksHealthy.set(market.id, event.healthy);
        if (!event.healthy && market.endsAt > Date.now() / 1000) platform.ingest({ kind: "error",
          strategyId: "btc-reversal", marketId: market.id, message: "market_feed_disconnected" });
        return;
      }
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
        for (const book of values) {
          if (!options.observationOnly) paper?.book(book);
          platform.ingest({ kind: "book", book });
        }
      } else if (event.kind === "tickSize") {
        const instrument = platform.core.instrument(event.token);
        if (instrument) {
          market.instruments = market.instruments.map(i => i.tokenId === event.token ? { ...i, tickSize: event.tickSize } : i);
          platform.ingest({ kind: "market", market }); client?.updateTickSize(event.token, event.tickSize);
        }
      } else if (event.kind === "marketTrade") {
        const direction = event.takerSide.toUpperCase();
        if (!options.observationOnly && (direction === "BUY" || direction === "SELL")) {
          paper?.trade(event.token, direction, event.price, event.shares, event.tsUnix);
        }
      } else if (event.kind === "btc" || event.kind === "oracle") {
        platform.ingest({ kind: "reference", symbol: event.kind === "btc" ? "BTC" : "BTC_ORACLE", price: event.price, ts: event.tsUnix });
      } else if (event.kind === "user") {
        if (!acceptUserEvents) return;
        const userEvent = event.event;
        if (userEvent.kind === "orderCancelled") {
          if (platform.orders.get(userEvent.orderId)) platform.core.confirmCancelled(userEvent.orderId);
        } else {
          if (!userEvent.orderId || !userEvent.tradeId || !userEvent.tokenId || !userEvent.direction
            || !platform.orders.get(userEvent.orderId)) throw new Error("account trade requires order ownership reconciliation");
          const f = userEvent.fill;
          const feeRule = client?.feeRule(userEvent.tokenId);
          platform.ingest({ kind: "fill", fill: { tradeId: userEvent.tradeId, orderId: userEvent.orderId,
            tokenId: userEvent.tokenId, direction: userEvent.direction, price: f.price, shares: f.shares,
            feeUsd: f.isMaker ? 0 : f.feeUsd ?? Math.round(polymarketFillFee(f.shares, f.price, false,
              feeRule?.rate ?? (f.feeRateBps != null ? f.feeRateBps / 10_000 : 0.07), 0, feeRule?.exponent ?? 1) * 100_000) / 100_000,
            status: f.status, feeSource: f.isMaker || f.feeUsd != null ? "reported" : feeRule || f.feeRateBps != null ? "rate-derived" : "estimate",
            ts: f.tsUnix, isMaker: f.isMaker } });
        }
      }
    } catch (error) {
      userHealthy.set(market.id, false);
      platform.ingest({ kind: "error", message: error instanceof Error ? error.message : "feed processing failed" });
    }
  };
  const recoverAccount = (): Promise<void> => {
    if (recoveryJob) return recoveryJob;
    if (!client || !readAccount) return Promise.resolve();
    recovering = true;
    platform.core.setRecovering(true);
    for (const market of options.markets) if (market.endsAt > Date.now() / 1000) {
      platform.ingest({ kind: "error", strategyId: "btc-reversal", marketId: market.id, message: "market_feed_disconnected" });
    }
    recoveryJob = (async () => {
      await platform.idle();
      const local = platform.account.current();
      for (const market of options.markets) {
        const tokens = new Set(market.instruments.map(instrument => instrument.tokenId));
        const owned = local.orders.filter(order => tokens.has(order.tokenId) && order.strategyId !== "external");
        if (!owned.length) continue;
        const after = Math.max(0, Math.min(...owned.map(order => order.createdAt)) - 5);
        const rows = await client!.getRecentTrades(market.id, after);
        for (const raw of rows) for (const event of parseAuthenticatedTrade(raw, {
          creds: client!.creds, conditionId: market.id, upToken: market.instruments[0].tokenId,
          downToken: market.instruments[1].tokenId, accountAddress: client!.funder,
          includeSellTrades: true, includeTradeStatusUpdates: true,
          isOurOrder: id => !!platform.orders.get(id), orderDirection: id => platform.orders.get(id)?.direction,
        }, new Set())) sink(market)({ kind: "user", event });
      }
      await platform.idle();
      let account = await readAccount!();
      const openIds = new Set(account.openOrders.map(order => order.orderId));
      const cancelledIds: string[] = [];
      let replayed = false;
      for (const order of platform.orders.list()) {
        if (!["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status) || !order.orderId || openIds.has(order.orderId)) continue;
        let detail: Row;
        try { detail = row(await client!.getOrder(order.orderId)); }
        catch (error) {
          const failure = row(error), response = row(failure.response);
          if (numeric(failure.status ?? response.status) !== 404) throw error;
          detail = { status: "NOT_FOUND" };
        }
        const missing = detail.status === "NOT_FOUND" || /order.*not found|not found.*order/i.test(String(detail.error ?? ""));
        const market = options.markets.find(item => item.instruments.some(instrument => instrument.tokenId === order.tokenId));
        if (missing && order.prepared && ["SUBMITTING", "UNKNOWN"].includes(order.status)
          && (order.preparedReplayAttempts ?? 0) < 2 && market && Date.now() / 1000 < market.endsAt) {
          // Repeat exactly the persisted signature/hash. Never generate a new
          // economic order to compensate an uncertain POST.
          platform.core.markPreparedReplay(order.orderId);
          const response = await client!.resubmitPrepared(order.prepared, order);
          platform.core.recoverPreparedAck(order.orderId, { ...response,
            status: response.success && response.orderId ? "accepted" : "unknown", error: response.errorMsg });
          replayed = true;
        }
        const status = String(detail.status ?? "").toUpperCase();
        if (["CANCELED", "CANCELLED", "EXPIRED"].includes(status)) cancelledIds.push(order.orderId);
        // Missing/404 or FILLED without its priced fills cannot release reserve.
      }
      if (replayed) account = await readAccount!();
      platform.account.reconcile(account, 0, cancelledIds);
    })().catch(error => {
      platform.core.requireReconciliation("account recovery incomplete");
      throw error;
    }).finally(() => { recovering = false; platform.core.setRecovering(false); recoveryJob = undefined; });
    return recoveryJob;
  };
  let feedDeadline = Infinity;
  const startMarket = async (market: MarketInfo) => {
    if (stopped || connectedMarkets.has(market.id)) return;
    if (client && market.endsAt > Date.now() / 1000) await client.warmMarket(market.id);
    if (stopped) return;
    if (client) {
      market.instruments = market.instruments.map(instrument => {
        const rule = client!.feeRule(instrument.tokenId);
        return rule ? { ...instrument, feeRate: rule.rate, feeExponent: rule.exponent, takerDelayMs: rule.takerDelayMs } : instrument;
      });
      platform.ingest({ kind: "market", market });
    }
    connectedMarkets.add(market.id);
    const [up, down] = market.instruments;
    if (market.endsAt > Date.now() / 1000) {
      const feed = runPolymarketFeed(sink(market), up.tokenId, down.tokenId, Math.min(feedDeadline, market.endsAt));
      controls.add(feed); bookFeeds.set(market.id, feed);
      bookHealth.set(market.id, feed.isHealthy);
    }
    if (client) {
      const user = runUserFeed(sink(market), { creds: client.creds, conditionId: market.id,
        upToken: up.tokenId, downToken: down.tokenId, accountAddress: client.funder,
        includeSellTrades: true, includeTradeStatusUpdates: true, orderDirection: id => platform.orders.get(id)?.direction,
        isOurOrder: id => !!platform.orders.get(id),
        fetchTrades: ids => client!.getTradesByIds(ids), fetchRecentTrades: after => client!.getRecentTrades(market.id, after),
        fetchOpenOrders: () => client!.getOpenOrders(market.id),
        reconcileAfterReconnect: async () => { await recoverAccount(); },
        verifyAuthenticated: async () => { await client!.getOpenOrders(market.id); return true; },
      }, feedDeadline);
      users.push(user); usersByMarket.set(market.id, user); controls.add(user);
      // Restored orders must be registered too; they need not emit a new ACK.
      for (const order of platform.orders.list()) {
        if (order.orderId && market.instruments.some(instrument => instrument.tokenId === order.tokenId)) {
          user.registerOrder(order.orderId, order.tradeIds);
        }
      }
      await user.waitUntilReady();
    }
  };
  const cleanupExpiredFeeds = () => {
    const now = Date.now() / 1000;
    const account = platform.account.current();
    if (client && !stopped && !recoveryJob && (account.risk.reason?.includes("reconciliation")
      || account.orders.some(order => order.status === "UNKNOWN" || order.reconciliationPending))) {
      void recoverAccount().catch(() => platform.ingest({ kind: "error", message: "order recovery remains pending" }));
    }
    for (const market of options.markets) {
      if (market.endsAt > now) continue;
      const feed = bookFeeds.get(market.id);
      if (feed) { feed.stop(); controls.delete(feed); bookFeeds.delete(market.id); bookHealth.delete(market.id); booksHealthy.delete(market.id); }
      const tokens = new Set(market.instruments.map(instrument => instrument.tokenId));
      const needsUser = account.orders.some(order => tokens.has(order.tokenId)
        && (["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status) || order.reconciliationPending))
        || account.fills.some(fill => tokens.has(fill.tokenId) && fill.status && !["CONFIRMED", "FAILED"].includes(fill.status));
      const user = usersByMarket.get(market.id);
      if (user && !needsUser) {
        user.stop(); controls.delete(user); usersByMarket.delete(market.id); userHealthy.delete(market.id);
        const index = users.indexOf(user); if (index >= 0) users.splice(index, 1);
      }
    }
  };
  return {
    platform,
    recoverAccount,
    async addMarkets(markets: MarketInfo[]) {
      for (const market of markets) {
        if (!options.markets.some(existing => existing.id === market.id)) options.markets.push(market);
        platform.ingest({ kind: "market", market });
        if (started) await startMarket(market);
      }
    },
    async start() {
      if (started || stopped) throw new Error("connection already started or stopped");
      started = true;
      feedDeadline = Date.now() / 1000 + (options.durationSec ?? 3600);
      if (client) stopHeartbeat = client.startHeartbeat();
      try {
        await Promise.all(options.markets.map(startMarket));
        if (client && options.restored) await recoverAccount().catch(() => {
          platform.ingest({ kind: "error", message: "startup account recovery remains pending" });
        });
        if (options.referenceFeed) controls.add(runBtcFeed(sink(options.markets[0])));
        cleanupExpiredFeeds(); cleanupTimer = setInterval(cleanupExpiredFeeds, 5000);
      } catch (error) {
        for (const control of controls) control.stop();
        stopHeartbeat?.(); stopped = true; throw error;
      }
    },
    async stop(reason = "operator stop") {
      stopped = true; clearInterval(cleanupTimer);
      await recoveryJob?.catch(() => undefined);
      try { await platform.stop(reason); }
      finally {
        for (const control of controls) control.stop();
        bookHealth.clear(); stopHeartbeat?.(); client?.stopHeartbeat();
      }
    },
  };
}
