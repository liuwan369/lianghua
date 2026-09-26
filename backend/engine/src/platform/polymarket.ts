import { ClobWrapper, geocheck } from "../live/clob/client.js";
import { connectAccountReader } from "../live/account-data.js";
import * as marketDiscovery from "../live/discovery.js";
import { runPolymarketFeed } from "../live/feeds/polymarket.js";
import { parseAuthenticatedTrade, runUserFeed, type UserFeedControl } from "../live/feeds/user.js";
import { runBtcFeed } from "../live/feeds/btc.js";
import { FeedQueue, type FeedEvent } from "../live/feeds/index.js";
import { ownerSignerPrivateKey } from "../live/account.js";
import { preflightReport } from "../live/onchain.js";
import { polymarketFillFee } from "../models.js";
import type { AccountSnapshot, AssetId, CoreState, ExecutionTiming, GatewayAck, HardLimits, Instrument, MarketBookSnapshot, MarketInfo,
  OrderGateway, OrderRecord, OrderRequest, PlatformAdapters, PreparedOrder, TradingMode } from "./contracts.js";
import { normalizeVenueOrderStatus } from "./contracts.js";
import { TradingPlatform } from "./platform.js";
import { readCashFlowEvidence } from "./cash-flows.js";
import { isSnapshotFreshAfter, validateMarketSnapshot, type SnapshotGateIdentity, type SnapshotRejectReason, type SnapshotWatermark } from "./snapshot-gate.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => typeof value === "object" && value !== null ? value as Row : {};
const numeric = (value: unknown): number => value === null || value === undefined || value === "" ? NaN : Number(value);
const UNKNOWN_ABANDON_AFTER_SEC = 5 * 60;
const UNKNOWN_ACCOUNT_MAX_AGE_SEC = 2 * 60;

type FiveMinuteDiscovery = {
  asset?: string;
  marketId?: string;
  conditionId?: string;
  roundId: string;
  upToken: string;
  downToken: string;
  start: number;
  end: number;
  slug?: string;
};
type DiscoveryModule = typeof marketDiscovery & {
  findFiveMinuteMarket?: (asset: string, options: { now: number; allowCollectorFallback: boolean; directOnly: boolean; signal?: AbortSignal }) => Promise<FiveMinuteDiscovery | undefined>;
};
type RoutedFeedEvent = FeedEvent & { __runtimeMarketId?: string; __runtimeAssetId?: AssetId };

/** A prewarmed next round is expected to be unhealthy until its window starts. */
export function isActiveMarket(market: Pick<MarketInfo, "startsAt" | "endsAt">, now = Date.now() / 1000): boolean {
  return market.startsAt <= now && now < market.endsAt;
}

export function binaryMarketSides(market: MarketInfo): { up: Instrument; down: Instrument } | undefined {
  const up = market.instruments.find(item => ["UP", "YES"].includes(item.outcome.toUpperCase()));
  const down = market.instruments.find(item => ["DOWN", "NO"].includes(item.outcome.toUpperCase()));
  if (!up || !down || up.tokenId === down.tokenId || up.marketId !== market.id || down.marketId !== market.id) return undefined;
  return { up, down };
}

/** Runtime-local producer label; market-data remains authoritative for actual feed availability. */
export function referenceProducerForAsset(assetId: AssetId): string {
  return `${assetId}-reference`;
}

/** Market-data currently names the reference asset `asset`; accept the temporary
 * runtime alias too, but never derive an asset from a price or local receive time. */
export function referenceAssetFromFeedPayload(payload: Record<string, unknown>, fallback?: AssetId): AssetId | undefined {
  const value = payload.asset ?? payload.assetId ?? fallback;
  return typeof value === "string" && /^[a-z0-9_-]{1,32}$/i.test(value) ? value.toLowerCase() : undefined;
}

export function discoveryOptions(directOnly = false): { allowCollectorFallback: boolean; directOnly: boolean } {
  return { allowCollectorFallback: !directOnly, directOnly };
}

/** Explicit market selector used by the existing BTC command, outside the generic platform. */
export async function discoverMarket(
  asset: AssetId = "btc",
  at = Date.now() / 1000,
  directOnly = false,
  signal?: AbortSignal,
): Promise<MarketInfo[]> {
  const discovery = marketDiscovery as DiscoveryModule;
  // Trading runtime requires the identity-aware market-data handoff. Do not
  // silently fall back to the old listing/collector discovery path: that path
  // cannot provide the marketId/roundId contract required by execution gates.
  if (typeof discovery.findFiveMinuteMarket !== "function") {
    throw new Error("identity-aware market discovery unavailable; deploy with codex/market-data");
  }
  const market = await discovery.findFiveMinuteMarket(asset, {
    now: at,
    ...discoveryOptions(directOnly),
    signal,
  });
  if (!market) return [];
  const discovered = market as unknown as { marketId?: unknown; conditionId?: unknown };
  const marketId = typeof discovered.marketId === "string"
    ? discovered.marketId
    : typeof discovered.conditionId === "string" ? discovered.conditionId : "";
  if (!marketId) throw new Error("market discovery returned no condition id");
  if (typeof market.roundId !== "string" || !market.roundId.trim()) {
    throw new Error("market discovery returned no round id");
  }
  const upToken = String(market.upToken);
  const downToken = String(market.downToken);
  const start = Number(market.start);
  const end = Number(market.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== 300) {
    throw new Error("market discovery returned an invalid five-minute window");
  }
  const instruments = await Promise.all([[upToken, "UP"], [downToken, "DOWN"]].map(async ([tokenId, outcome]) => {
    const timeout = AbortSignal.timeout(8000);
    const response = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
      { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error("market rules unavailable");
    const book = row(await response.json());
    const tickSize = numeric(book.tick_size), minOrderSize = numeric(book.min_order_size);
    if (!(tickSize > 0 && tickSize < 1 && minOrderSize > 0)) throw new Error("invalid venue instrument rules");
    return { tokenId, outcome, marketId, tickSize, minOrderSize };
  }));
  if (market.roundId !== String(start)) throw new Error("market round id does not match discovery start");
  const discoveredAsset = String(market.asset ?? asset).toLowerCase();
  if (discoveredAsset !== asset) throw new Error("market discovery asset identity mismatch");
  // The market-data discovery contract identifies the asset and market only.
  // Reference producer availability is checked by ConnectOptions.referenceFeeds
  // at startup; do not invent a discovery field that the producer does not own.
  return [{ id: marketId, assetId: asset, referenceProducer: referenceProducerForAsset(asset), roundId: market.roundId,
    name: String(market.slug ?? `${asset}-updown-5m-${start}`), startsAt: start, endsAt: end, instruments }];
}

export async function discoverBtcMarket(at = Date.now() / 1000, directOnly = false, signal?: AbortSignal): Promise<MarketInfo[]> {
  return discoverMarket("btc", at, directOnly, signal);
}

export function accountSnapshot(raw: unknown): AccountSnapshot {
  const data = row(raw), collateral = row(data.collateral), positions = row(data.positions), open = row(data.open_orders);
  if (![collateral, positions, open].every(s => s.available === true && s.complete === true)
    || !Array.isArray(positions.items) || !Array.isArray(open.items)) throw new Error("account sections incomplete");
  const at = Date.parse(String(data.checked_at)) / 1000;
  const cashAt = collateral.checked_at === undefined ? at : Date.parse(String(collateral.checked_at)) / 1000;
  const orders = open.items.map(rawOrder => {
    const o = row(rawOrder), direction = String(o.side).toUpperCase();
    if (direction !== "BUY" && direction !== "SELL") throw new Error("unknown account order direction");
    const shares = numeric(o.original_size ?? o.size), filledShares = numeric(o.size_matched ?? 0), price = numeric(o.price);
    if (!o.id || !o.asset_id || ![shares, filledShares, price].every(Number.isFinite)) throw new Error("invalid open account order");
    const venueStatus = normalizeVenueOrderStatus(o.status);
    return { clientOrderId: `import:${String(o.id)}`, strategyId: "external", orderId: String(o.id),
      tokenId: String(o.asset_id), direction, price, shares, filledShares,
      timeInForce: "GTC", postOnly: false, status: filledShares > 0 ? "PARTIAL" : "OPEN",
      ...(venueStatus ? { venueStatus } : {}),
      reservedUsd: direction === "BUY"
        ? Math.max(0, shares - filledShares) * (price + 0.07 * 0.25) : 0,
      reservedShares: direction === "SELL" ? Math.max(0, shares - filledShares) : 0, createdAt: at, updatedAt: at } as OrderRecord;
  });
  const result: AccountSnapshot = { accountId: String(data.wallet ?? ""), at, cashAt, complete: true,
    ...(data.cashFlowCoverage ? { cashFlowCoverage: data.cashFlowCoverage as AccountSnapshot["cashFlowCoverage"] } : {}),
    ...(data.externalFlows ? { externalFlows: data.externalFlows as AccountSnapshot["externalFlows"] } : {}),
    cashUsd: numeric(collateral.value), openOrders: orders,
    positions: positions.items.flatMap(rawPosition => {
      const p = row(rawPosition), shares = numeric(p.size), avg = numeric(p.avgPrice);
      if (!p.asset || !Number.isFinite(shares) || shares < 0 || !Number.isFinite(avg) || avg < 0) throw new Error("invalid account position basis");
      const currentValue = numeric(p.currentValue);
      // Data API marks resolved outcome tokens redeemable. A redeemable loser
      // with an explicit zero value is historical residue, not executable inventory.
      if (p.redeemable === true && Number.isFinite(currentValue) && currentValue === 0) return [];
      return [{ tokenId: String(p.asset), shares, costUsd: shares * avg, realizedPnlUsd: numeric(p.realizedPnl ?? 0) }];
    }) };
  return result;
}

/** One CLOB connection is shared by every strategy and order direction. */
export class PolymarketGateway implements OrderGateway {
  readonly mode = "live" as const;
  readonly durableIdentity = true;
  constructor(readonly client: ClobWrapper, private readonly ready: (instrument: Instrument) => boolean = () => true) {}
  async submit(request: OrderRequest, instrument: Instrument, prepared?: (value: PreparedOrder) => void,
    timing?: ExecutionTiming): Promise<GatewayAck> {
    if (!this.ready(instrument)) return { status: "rejected", error: "authenticated feed is not ready" };
    const response = await this.client.submitOrder({ tokenId: request.tokenId, price: request.price,
      size: request.shares, tickSize: instrument.tickSize, direction: request.direction,
      timeInForce: request.timeInForce, postOnly: request.postOnly, onPrepared: prepared,
      triggerReceivedAtMonoMs: timing?.triggerReceivedAtMonoMs, decisionAtMonoMs: timing?.decisionAtMonoMs });
    return { status: response.success && response.orderId ? "accepted"
      : response.stateUnknown || response.orderId || response.success ? "unknown" : "rejected",
      orderId: response.orderId, error: response.errorMsg, tradeIds: response.tradeIds,
      venueStatus: response.status,
      signLatencyMs: response.signLatencyMs, ackLatencyMs: response.ackLatencyMs,
      l2HeaderLatencyMs: response.l2HeaderLatencyMs, postLatencyMs: response.postLatencyMs,
      responseHeadersLatencyMs: response.responseHeadersLatencyMs,
      responseBodyLatencyMs: response.responseBodyLatencyMs,
      riskMetadataLatencyMs: response.riskMetadataLatencyMs, failurePhase: response.failurePhase,
      totalLatencyMs: response.latencyMs, triggerToPostLatencyMs: response.triggerToPostLatencyMs,
      decisionToPostLatencyMs: response.decisionToPostLatencyMs,
      reactionLatencyMs: response.reactionLatencyMs };
  }
  cancel(orderId: string): Promise<boolean> { return this.client.cancel(orderId); }
}

export interface ConnectOptions {
  mode: TradingMode;
  markets: MarketInfo[];
  limits: HardLimits;
  restored?: CoreState;
  persist?: PlatformAdapters["persist"];
  deferPersistence?: PlatformAdapters["deferPersistence"];
  persistPreparedOrder?: PlatformAdapters["persistPreparedOrder"];
  record?: PlatformAdapters["record"];
  settle?: PlatformAdapters["settle"];
  durationSec?: number;
  referenceFeed?: boolean;
  /** Selected asset is checked against every supplied market. */
  assetId?: AssetId;
  /** Reference producers are injected by the asset-aware market-data adapter. */
  referenceFeeds?: Partial<Record<string, (sink: (event: FeedEvent) => void, assetId: AssetId) => { stop: () => void }>>;
}

export async function connectPolymarketPlatform(options: ConnectOptions) {
  if (options.mode !== "live") throw new Error("the platform connector only supports live execution");
  if (!options.markets.length || options.markets.some(m => typeof m.roundId !== "string"
    || !/^\d+$/.test(m.roundId) || m.roundId !== String(m.startsAt)
    || !Number.isFinite(m.startsAt) || !Number.isFinite(m.endsAt) || m.endsAt - m.startsAt !== 300
    || m.instruments.length !== 2 || !binaryMarketSides(m)
    || (options.assetId !== undefined && m.assetId !== options.assetId)
    || (m.assetId !== undefined && (!/^[a-z0-9_-]{1,32}$/.test(m.assetId) || !m.referenceProducer)))) {
    throw new Error("the current Polymarket feed adapter requires explicit binary markets");
  }
  if (options.referenceFeed) {
    for (const market of options.markets) {
      const assetId = market.assetId ?? options.assetId ?? "btc";
      if (!options.referenceFeeds?.[assetId] && assetId !== "btc") {
        throw new Error(`reference producer unavailable for asset ${assetId}`);
      }
    }
  }
  let platform!: TradingPlatform;
  let client: ClobWrapper | undefined;
  let readAccount: PlatformAdapters["readAccount"];
  let scanCashFlows: (() => Promise<AccountSnapshot>) | undefined;
  const controls = new Set<{ stop: () => void }>();
  const bookFeeds = new Map<string, { stop: () => void }>();
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let cashFlowTimer: ReturnType<typeof setInterval> | undefined;
  let cashFlowJob: Promise<void> | undefined;
  const cashFlowAbort = new AbortController();
  const users: UserFeedControl[] = [];
  const booksHealthy = new Map<string, boolean>();
  const bookHealth = new Map<string, () => boolean>();
  const userHealthy = new Map<string, boolean>();
  const usersByMarket = new Map<string, UserFeedControl>();
  const connectedMarkets = new Set<string>();
  const registered = new Map<string, Set<string>>();
  // Keep the venue identity as a queue boundary. FeedQueue also keys by round
  // and token pair, but a per-market instance prevents a malformed marketId
  // from poisoning a valid stream that happens to reuse token metadata.
  const feedQueues = new Map<string, FeedQueue>();
  // Advance the starting queue after every consumed event. A busy current
  // round must not starve a prewarmed next-round queue at the boundary.
  let feedQueueCursor = 0;
  let feedWaiter: (() => void) | undefined;
  let feedWaitTimer: ReturnType<typeof setTimeout> | undefined;
  const wakeFeedConsumer = (): void => {
    const resolve = feedWaiter;
    feedWaiter = undefined;
    if (feedWaitTimer) { clearTimeout(feedWaitTimer); feedWaitTimer = undefined; }
    resolve?.();
  };
  const waitForFeedEvent = (timeoutMs: number): Promise<void> => new Promise(resolve => {
    feedWaiter = resolve;
    feedWaitTimer = setTimeout(() => {
      if (feedWaiter === resolve) feedWaiter = undefined;
      feedWaitTimer = undefined;
      resolve();
    }, timeoutMs);
  });
  const snapshotWatermarks = new Map<string, SnapshotWatermark>();
  const snapshotRejectNotice = new Map<string, SnapshotRejectReason>();
  // A disconnect invalidates snapshots already waiting in the queue. The next
  // accepted book must carry a receive timestamp at or after the status event.
  const snapshotFreshAfter = new Map<string, number>();
  const snapshotStateKey = (market: MarketInfo): string => JSON.stringify([market.id, market.roundId]);
  let feedConsumerAlive = false;
  let feedConsumer: Promise<void> | undefined;
  let started = false;
  let stopped = false;
  let acceptUserEvents = true;
  let stopHeartbeat: (() => void) | undefined;
  let recoveryJob: Promise<void> | undefined;
  // A missing venue order has no safe terminal interpretation. Track the
  // affected IDs by market while account recovery retries; reconnect
  // compensation for an unaffected market may still reopen that market.
  let recoveryFailureNotice = false;
  const blockedOrderIdsByMarket = new Map<string, Set<string>>();
  const unmappedBlockedOrderIds = new Set<string>();
  const failedRecoveryMarkets = new Set<string>();
  let recoveryFailureGlobal = false;
  let recoveryFailureMarketId: string | undefined;
  let recoveryFailureMarkets = new Set<string>();
  let recoverAccountNow: (() => Promise<void>) | undefined;
  const marketIdForOrder = (orderId: string): string | undefined => {
    const order = platform?.orders.get(orderId);
    return order ? platform.core.instrument(order.tokenId)?.marketId : undefined;
  };
  const blockedOrdersForMarket = (marketId: string): Set<string> =>
    blockedOrderIdsByMarket.get(marketId) ?? new Set<string>();
  const hasBlockedOrders = (): boolean => recoveryFailureGlobal || unmappedBlockedOrderIds.size > 0
    || failedRecoveryMarkets.size > 0 || [...blockedOrderIdsByMarket.values()].some(ids => ids.size > 0);
  const marketRecoveryBlocked = (marketId: string): boolean => failedRecoveryMarkets.has(marketId)
    || blockedOrdersForMarket(marketId).size > 0;
  const refreshCoreRecoveryGate = () => {
    if (recoveryFailureGlobal || unmappedBlockedOrderIds.size > 0) {
      platform.core.setRecovering(true, ["*"]);
      return;
    }
    const blockedMarkets = new Set<string>(failedRecoveryMarkets);
    for (const marketId of blockedOrderIdsByMarket.keys()) blockedMarkets.add(marketId);
    if (blockedMarkets.size > 0) platform.core.setRecovering(true, [...blockedMarkets]);
    else if (!recoveryJob) platform.core.setRecovering(false);
  };
  const setBlockedOrdersFromPlatform = (onlyMarkets?: ReadonlySet<string>) => {
    blockedOrderIdsByMarket.clear();
    unmappedBlockedOrderIds.clear();
    for (const order of platform.orders.list()) {
      const activeDuringRecovery = ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)
        || (order.reconciliationPending && order.status !== "CANCELLED");
      if (!order.orderId || !activeDuringRecovery
        || platform.core.isOrderQuarantined(order.orderId)
        || ["filled", "canceled", "cancelled", "expired"].includes(order.venueStatus ?? "")) continue;
      const marketId = platform.core.instrument(order.tokenId)?.marketId;
      if (!marketId) {
        if (!onlyMarkets) unmappedBlockedOrderIds.add(order.orderId);
        continue;
      }
      if (onlyMarkets && !onlyMarkets.has(marketId)) continue;
      const ids = blockedOrderIdsByMarket.get(marketId) ?? new Set<string>();
      ids.add(order.orderId);
      blockedOrderIdsByMarket.set(marketId, ids);
    }
    refreshCoreRecoveryGate();
  };
  const allowRecoveryAfterEvidence = (orderId: string) => {
    const marketId = marketIdForOrder(orderId);
    let changed = unmappedBlockedOrderIds.delete(orderId);
    if (marketId) {
      const blockedOrderIds = blockedOrderIdsByMarket.get(marketId);
      changed = (blockedOrderIds?.delete(orderId) ?? false) || changed;
      if (blockedOrderIds?.size === 0) blockedOrderIdsByMarket.delete(marketId);
      changed = failedRecoveryMarkets.delete(marketId) || changed;
    }
    if (!changed) return;
    recoveryFailureNotice = hasBlockedOrders();
    // A failed reconnect compensation leaves the authenticated feed
    // discontinuous even when the venue later sends a terminal order event.
    // Restore only the feed for the affected order's market; another market
    // may still have an unresolved continuity gap.
    refreshCoreRecoveryGate();
    if (marketId && !recoveryFailureGlobal && !marketRecoveryBlocked(marketId)) usersByMarket.get(marketId)?.markContinuous?.();
  };
  const reconnectSnapshotNeedsRecovery = (marketId: string, openOrders: unknown[]): boolean => {
    const openIds = new Set(openOrders.flatMap(rawOrder => {
      const order = row(rawOrder);
      const id = order.id ?? order.order_id ?? order.orderId;
      return typeof id === "string" ? [id] : [];
    }));
    return platform.orders.list().some(order => {
      if (!order.orderId || platform.core.instrument(order.tokenId)?.marketId !== marketId
        || platform.core.isOrderQuarantined(order.orderId)) return false;
      if (!["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)) return false;
      return order.status === "UNKNOWN" || !openIds.has(order.orderId);
    });
  };
  const fee = (order: OrderRequest, shares = order.shares) => {
    if (order.postOnly) return 0;
    const rule = client?.feeRule(order.tokenId);
    // Warmed live markets supply current venue fee rules before an order is submitted.
    return Math.ceil(polymarketFillFee(shares, 0.5, false, rule?.rate ?? 0.07, 0, rule?.exponent ?? 1) * 100_000) / 100_000;
  };
  let account: AccountSnapshot;
  let gateway: OrderGateway;
  if (!options.persist) throw new Error("live platform requires durable account-scoped state persistence");
  await geocheck();
  const key = ownerSignerPrivateKey();
  if (!key) throw new Error("wallet signing key unavailable");
  // Execution uses only the current account cut. Historical order details,
  // closed positions, activity and chain receipts are dashboard data and must
  // never sit in the startup/reconnect/order-recovery critical path.
  const reader = await connectAccountReader({ realtime: true });
  const rpcUrls = [...new Set([process.env.POLYGON_RPC, process.env.PM_ACCOUNT_RPC_URL, process.env.PM_ACCOUNT_RPC_FALLBACK_URL,
    "https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com"].map(value => value?.trim()).filter((value): value is string => !!value))];
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    for (const url of rpcUrls) {
      cashFlowAbort.signal.throwIfAborted();
      try {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.any([AbortSignal.timeout(8000), cashFlowAbort.signal]) });
        if (!response.ok) continue;
        const body = row(await response.json());
        if (!body.error && body.result != null) return body.result;
      } catch { cashFlowAbort.signal.throwIfAborted(); /* Retry a configured read-only RPC endpoint. */ }
    }
    throw new Error("cash_flow_rpc_unavailable");
  };
  let latestCashFlowEvidence: Awaited<ReturnType<typeof readCashFlowEvidence>> | undefined;
  readAccount = async () => {
    const ordinary = accountSnapshot(await reader());
    // Order recovery reads only the venue account. A slow funding scan never delays an ACK.
    const evidence = latestCashFlowEvidence;
    if (!evidence || evidence.externalFlows.some(flow => flow.at > (ordinary.cashAt ?? ordinary.at))) return ordinary;
    return { ...ordinary, cashFlowCoverage: evidence.cashFlowCoverage, externalFlows: evidence.externalFlows };
  };
  scanCashFlows = async () => {
    const raw = await reader();
    cashFlowAbort.signal.throwIfAborted();
    const ordinary = accountSnapshot(raw);
    const tracking = platform?.account.current().cashFlowTracking ?? options.restored?.cashFlowTracking;
    const fromAt = tracking?.baselineAt ?? options.restored?.risk.baselineAt ?? ordinary.cashAt ?? ordinary.at;
    const evidence = await readCashFlowEvidence({ wallet: String(raw.wallet),
      fromAt, fromBlock: tracking?.cursorBlock == null ? tracking?.baselineBlock : tracking.cursorBlock + 1, rpc, raw,
      getActivity: async params => {
        cashFlowAbort.signal.throwIfAborted();
        const url = new URL("https://data-api.polymarket.com/activity");
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(8000), cashFlowAbort.signal]) });
        if (!response.ok) throw new Error(`http_${response.status}`);
        return response.json();
      } });
    if (!stopped && !recoveryJob) latestCashFlowEvidence = evidence;
    return { ...ordinary, cashFlowCoverage: evidence.cashFlowCoverage, externalFlows: evidence.externalFlows };
  };
  account = await readAccount();
  // A live strategy can create a redeemable position before the five-minute
  // round ends. Check the independent settlement route before opening the
  // feed/order path, so a missing Builder/Relayer credential cannot surface
  // only after fills exist. Observation-only connections intentionally skip
  // this check because they never submit or settle strategy orders.
  if (options.settle) {
    let settlementReady = false;
    try {
      const report = await preflightReport(account.accountId);
      settlementReady = report.settlementCredentialsReady === true;
    } catch {
      throw new Error("settlement credentials preflight failed");
    }
    if (!settlementReady) throw new Error("settlement credentials are not ready");
  }
  client = await ClobWrapper.connect({ key });
  gateway = new PolymarketGateway(client, instrument => {
    const user = usersByMarket.get(instrument.marketId);
    return !stopped && !!booksHealthy.get(instrument.marketId) && !!bookHealth.get(instrument.marketId)?.()
      && !!userHealthy.get(instrument.marketId) && !!user?.isHealthy() && (user.isContinuous?.() ?? true);
  });
  platform = new TradingPlatform({ account, instruments: options.markets.flatMap(m => m.instruments),
    limits: options.limits, restored: options.restored,
    adapters: { gateway, readAccount, discoverMarkets: () => discoverMarket(options.assetId ?? "btc"), estimateFee: fee,
      persist: options.persist, deferPersistence: options.deferPersistence,
      persistPreparedOrder: options.persistPreparedOrder,
      record: options.record, settle: options.settle,
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
    if ((event.order.status === "UNKNOWN" || event.order.reconciliationPending === true) && recoverAccountNow) {
      queueMicrotask(() => {
        if (!stopped && !recoveryJob) void recoverAccountNow!().catch(() => undefined);
      });
    }
    const marketId = platform.core.instrument(event.order.tokenId)?.marketId;
    const user = marketId ? usersByMarket.get(marketId) : undefined;
    user?.registerOrder(event.order.orderId, freshTrades);
  });

  const marketIdentity = (market: MarketInfo): SnapshotGateIdentity => {
    const sides = binaryMarketSides(market);
    if (!sides) throw new Error(`market ${market.id} has no UP/DOWN token mapping`);
    return { assetId: market.assetId, marketId: market.id, roundId: market.roundId, endsAt: market.endsAt,
      yesAssetId: sides.up.tokenId, noAssetId: sides.down.tokenId };
  };
  const routeMarket = (event: RoutedFeedEvent): MarketInfo | undefined => {
    const payload = event as unknown as Record<string, unknown>;
    const snapshot = event.kind === "book" ? payload.snapshot as MarketBookSnapshot | undefined : undefined;
    const eventMarketId = typeof payload.marketId === "string" ? payload.marketId : snapshot?.marketId;
    const byIdentity = options.markets.find(market => market.id === (eventMarketId ?? event.__runtimeMarketId));
    if (byIdentity) return byIdentity;
    const eventAsset = referenceAssetFromFeedPayload(payload);
    return eventAsset ? options.markets.find(market => market.assetId === eventAsset) : undefined;
  };
  const rejectSnapshot = (market: MarketInfo, reason: SnapshotRejectReason): void => {
    if (!isActiveMarket(market)) return;
    const key = snapshotStateKey(market);
    if (snapshotRejectNotice.get(key) === reason) return;
    snapshotRejectNotice.set(key, reason);
    platform.ingest({ kind: "error", strategyId: "btc-reversal", marketId: market.id, code: "market_snapshot_rejected",
      message: `market_snapshot_rejected:${reason}` });
  };
  const acceptSnapshot = (market: MarketInfo, snapshot: MarketBookSnapshot): boolean => {
    const identity = marketIdentity(market);
    const key = snapshotStateKey(market);
    const freshAfter = snapshotFreshAfter.get(key);
    if (!isSnapshotFreshAfter(snapshot, freshAfter)) {
      rejectSnapshot(market, "awaiting_fresh_snapshot");
      return false;
    }
    const result = validateMarketSnapshot(snapshot, identity, snapshotWatermarks.get(key), Date.now() / 1000,
      booksHealthy.get(market.id) === true && (bookHealth.get(market.id)?.() ?? false));
    if (!result.ok) {
      rejectSnapshot(market, result.reason);
      return false;
    }
    snapshotRejectNotice.delete(key);
    const accepted = platform.ingestSnapshot(snapshot, market.id, market.roundId);
    if (!accepted) {
      rejectSnapshot(market, "incomplete_book");
      return false;
    }
    snapshotWatermarks.set(key, result.watermark);
    snapshotFreshAfter.delete(key);
    return true;
  };
  const consumeFeedEvent = (raw: FeedEvent): void => {
    const event = raw as RoutedFeedEvent;
    const market = routeMarket(event);
    const payload = event as unknown as Record<string, unknown>;
    if (event.kind === "bookStatus") {
      if (!market) return;
      const eventMarketId = typeof payload.marketId === "string" ? payload.marketId : market.id;
      const eventRoundId = typeof payload.roundId === "string" ? payload.roundId : undefined;
      const sides = binaryMarketSides(market);
      const eventYesAssetId = typeof payload.yesAssetId === "string" ? payload.yesAssetId : undefined;
      const eventNoAssetId = typeof payload.noAssetId === "string" ? payload.noAssetId : undefined;
      if (!sides || eventMarketId !== market.id || eventRoundId !== market.roundId
        || (eventYesAssetId !== undefined && eventYesAssetId !== sides.up.tokenId)
        || (eventNoAssetId !== undefined && eventNoAssetId !== sides.down.tokenId)) return;
      const key = snapshotStateKey(market);
      if (!Number.isFinite(event.tsUnix) || event.tsUnix < 0) {
        booksHealthy.set(market.id, false);
        snapshotFreshAfter.set(key, Number.POSITIVE_INFINITY);
        rejectSnapshot(market, "awaiting_fresh_snapshot");
        return;
      }
      booksHealthy.set(market.id, event.healthy);
      const previousFreshAfter = snapshotFreshAfter.get(key);
      if (event.healthy) {
        if (previousFreshAfter !== undefined && !Number.isFinite(previousFreshAfter)) {
          snapshotFreshAfter.set(key, event.tsUnix);
        }
        snapshotRejectNotice.delete(key);
      }
      else {
        snapshotFreshAfter.set(key, Number.isFinite(previousFreshAfter)
          ? Math.max(previousFreshAfter!, event.tsUnix) : event.tsUnix);
        if (isActiveMarket(market)) platform.ingest({ kind: "error", strategyId: "btc-reversal", marketId: market.id,
          code: "market_feed_unhealthy", message: `market_feed_unhealthy:${event.reason ?? "unknown"}` });
      }
      return;
    }
    if (event.kind === "userStatus") {
      if (market) userHealthy.set(market.id, event.healthy);
      return;
    }
    if (event.kind === "book") {
      const snapshot = payload.snapshot as MarketBookSnapshot | undefined;
      if (!market || !snapshot || !acceptSnapshot(market, snapshot)) return;
      return;
    }
    if (!market && (event.kind === "tickSize" || event.kind === "user")) return;
    if (event.kind === "tickSize") {
      const instrument = platform.core.instrument(event.token);
      if (instrument && market) {
        market.instruments = market.instruments.map(i => i.tokenId === event.token ? { ...i, tickSize: event.tickSize } : i);
        platform.ingest({ kind: "market", market }); client?.updateTickSize(event.token, event.tickSize);
      }
      return;
    }
    if (event.kind === "marketTrade") return;
    if (event.kind === "btc" || event.kind === "oracle") {
      const runtimeAsset = typeof payload.__runtimeAssetId === "string" ? payload.__runtimeAssetId : undefined;
      const declaredAsset = typeof payload.asset === "string" ? payload.asset
        : typeof payload.assetId === "string" ? payload.assetId : undefined;
      // Legacy BTC feed events have no asset field. They are accepted only
      // from the BTC runtime binding; an unlabelled ETH event is rejected.
      if (runtimeAsset !== undefined && declaredAsset !== undefined && declaredAsset.toLowerCase() !== runtimeAsset) return;
      if (runtimeAsset !== undefined && declaredAsset === undefined && runtimeAsset !== "btc") return;
      const eventAsset = referenceAssetFromFeedPayload(payload, runtimeAsset ?? "btc");
      const marketForAsset = options.markets.find(item => (item.assetId ?? "btc") === eventAsset);
      if (!marketForAsset || eventAsset !== (marketForAsset.assetId ?? "btc")) return;
      const producer = typeof payload.producer === "string" ? payload.producer : undefined;
      if (producer && marketForAsset.referenceProducer && marketForAsset.referenceProducer !== producer) return;
      platform.ingest({ kind: "reference", assetId: eventAsset, symbol: event.kind === "btc" ? eventAsset.toUpperCase() : `${eventAsset.toUpperCase()}_ORACLE`, price: event.price, ts: event.tsUnix });
      return;
    }
    if (event.kind !== "user" || !market || !acceptUserEvents) return;
    const userEvent = event.event;
    if (userEvent.kind === "orderCancelled") {
      if (platform.orders.get(userEvent.orderId)) {
        platform.core.observeVenueStatus(userEvent.orderId, "canceled", { source: "user_ws", observedAt: userEvent.receivedAtUnix });
        platform.core.confirmCancelled(userEvent.orderId, false, "user_ws", userEvent.receivedAtUnix);
        allowRecoveryAfterEvidence(userEvent.orderId);
      }
      return;
    }
    if (!userEvent.orderId || !userEvent.tradeId || !userEvent.tokenId || !userEvent.direction) {
      throw new Error("account trade requires order ownership reconciliation");
    }
    if (!platform.orders.get(userEvent.orderId)) return;
    const f = userEvent.fill;
    if (userEvent.reportLatencyMs != null) platform.ingest({ kind: "latency", metric: "authenticated_trade_report",
      durationMs: userEvent.reportLatencyMs, ts: Date.now() / 1000, marketId: market.id,
      tokenId: userEvent.tokenId, orderId: userEvent.orderId });
    const feeRule = client?.feeRule(userEvent.tokenId);
    platform.ingest({ kind: "fill", marketId: market.id, roundId: market.roundId,
      fill: { tradeId: userEvent.tradeId, orderId: userEvent.orderId, marketId: market.id, roundId: market.roundId,
      tokenId: userEvent.tokenId, direction: userEvent.direction, price: f.price, shares: f.shares,
      feeUsd: f.isMaker ? 0 : f.feeUsd ?? Math.round(polymarketFillFee(f.shares, f.price, false,
        feeRule?.rate ?? (f.feeRateBps != null ? f.feeRateBps / 10_000 : 0.07), 0, feeRule?.exponent ?? 1) * 100_000) / 100_000,
      status: f.status, feeSource: f.isMaker || f.feeUsd != null ? "reported" : feeRule || f.feeRateBps != null ? "rate-derived" : "estimate",
      ts: f.tsUnix, isMaker: f.isMaker } });
    if (platform.orders.get(userEvent.orderId)?.status === "FILLED") allowRecoveryAfterEvidence(userEvent.orderId);
  };
  const sink = (market: MarketInfo) => (event: FeedEvent) => {
    // The venue callback only performs a bounded queue push. Strategy code,
    // record listeners, account reads and HTTP work run in the consumer.
    if (stopped) return;
    const queue = feedQueues.get(market.id);
    if (!queue) return;
    queue.push({ ...event, __runtimeMarketId: market.id, __runtimeAssetId: market.assetId ?? "btc" } as RoutedFeedEvent as FeedEvent);
    wakeFeedConsumer();
  };
  const startFeedConsumer = (): void => {
    if (feedConsumer) return;
    feedConsumerAlive = true;
    feedConsumer = (async () => {
      while (feedConsumerAlive) {
        let event: RoutedFeedEvent | undefined;
        const queueKeys = [...feedQueues.keys()];
        if (queueKeys.length) {
          const start = feedQueueCursor % queueKeys.length;
          for (let offset = 0; offset < queueKeys.length; offset += 1) {
            const index = (start + offset) % queueKeys.length;
            const queue = feedQueues.get(queueKeys[index]);
            const candidate = queue?.tryPop();
            if (!candidate) continue;
            feedQueueCursor = (index + 1) % queueKeys.length;
            event = candidate as RoutedFeedEvent;
            break;
          }
        }
        if (!event) {
          await waitForFeedEvent(100);
          continue;
        }
        try { consumeFeedEvent(event); }
        catch (error) {
          const market = routeMarket(event as RoutedFeedEvent);
          if (market) { booksHealthy.set(market.id, false); userHealthy.set(market.id, false); }
          platform.ingest({ kind: "error", strategyId: "btc-reversal", marketId: market?.id, code: "feed_processing_failed",
            message: error instanceof Error ? error.message : "feed processing failed" });
        }
      }
    })().finally(() => { feedConsumer = undefined; });
  };
  const stopFeedConsumer = async (): Promise<void> => {
    feedConsumerAlive = false;
    wakeFeedConsumer();
    await feedConsumer?.catch(() => undefined);
  };
  const recoverAccount = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (recoveryJob) return recoveryJob;
    if (!client || !readAccount) return Promise.resolve();
    recoveryFailureGlobal = false;
    failedRecoveryMarkets.clear();
    recoveryFailureMarketId = undefined;
    recoveryFailureMarkets = new Set<string>();
    // Recovery reads are account-wide, but an unresolved order only makes its
    // own market unsafe to trade. Keep that market closed while the REST
    // evidence is collected; a newly discovered five-minute market can keep
    // consuming its realtime book and submit independently. The account cut
    // is re-read after any concurrent submission before reconciliation, so a
    // new market cannot be overwritten by the older snapshot.
    const localBeforeRecovery = platform.account.current();
    const initialOrderIds = new Set(localBeforeRecovery.orders.map(order => order.clientOrderId));
    const recoveryMarkets = new Set<string>();
    for (const order of localBeforeRecovery.orders) {
      if (!(order.status === "SUBMITTING" || order.status === "OPEN" || order.status === "PARTIAL"
        || order.status === "UNKNOWN" || order.reconciliationPending)) continue;
      const marketId = platform.core.instrument(order.tokenId)?.marketId;
      if (marketId) recoveryMarkets.add(marketId);
    }
    platform.core.setRecovering(true, recoveryMarkets.size ? [...recoveryMarkets] : []);
    for (const market of options.markets) if (market.endsAt > Date.now() / 1000) {
      platform.ingest({ kind: "error", strategyId: "btc-reversal", marketId: market.id,
        code: "account_recovery_started", message: "account_recovery_started" });
    }
    recoveryJob = (async () => {
      await platform.idle();
      const tradeScanComplete = new Set<string>();
      const local = localBeforeRecovery;
      // The current account cut and recent-trade compensation are independent
      // reads. Starting them together removes one full REST timeout from an
      // UNKNOWN-order recovery; the account snapshot is still applied only
      // after all provisional trade events have been ingested below.
      const accountRead = readAccount!().then(
        snapshot => ({ snapshot } as const),
        error => ({ error } as const),
      );
      const tradeScanPromise = Promise.all(options.markets.map(async market => {
        try {
          const tokens = new Set(market.instruments.map(instrument => instrument.tokenId));
          const owned = local.orders.filter(order => tokens.has(order.tokenId) && order.strategyId !== "external");
          if (!owned.length) return;
          const after = Math.max(0, Math.min(...owned.map(order => order.createdAt)) - 5);
          const rows = await client!.getRecentTrades(market.id, after);
          const sides = binaryMarketSides(market);
          if (!sides) throw new Error(`market ${market.id} has no UP/DOWN token mapping`);
          for (const raw of rows) for (const event of parseAuthenticatedTrade(raw, {
            creds: client!.creds, conditionId: market.id, upToken: sides.up.tokenId,
            downToken: sides.down.tokenId, accountAddress: client!.funder,
            isOurOrder: id => !!platform.orders.get(id), orderDirection: id => platform.orders.get(id)?.direction,
          }, new Set())) sink(market)({ kind: "user", event });
          for (const order of owned) if (order.orderId) tradeScanComplete.add(order.orderId);
          return undefined;
        } catch (error) {
          return { marketId: market.id, error };
        }
      }));
      const lookupOrder = async (order: OrderRecord) => {
        if (platform.core.isOrderQuarantined(order.orderId!)) return { order, quarantined: true };
        try {
          const detail = row(await client!.getOrder(order.orderId!));
          return { order, detail: Object.keys(detail).length ? detail : undefined, quarantined: false };
        } catch (error) {
          const failure = row(error), response = row(failure.response);
          if (numeric(failure.status ?? response.status) === 404) return { order, detail: { status: "NOT_FOUND" } as Row };
          // A complete authenticated open-order snapshot is still useful
          // when the point lookup times out. Preserve UNKNOWN and its
          // reservation, then quarantine only that bounded ambiguity.
          return { order, unavailable: true, quarantined: false };
        }
      };
      // UNKNOWN is already sufficient evidence that its point status is
      // relevant. Start that lookup immediately instead of waiting for the
      // account snapshot to enumerate open orders.
      const earlyDetailCandidates = local.orders.filter(order =>
        order.status === "UNKNOWN" && !!order.orderId && !platform.core.isOrderQuarantined(order.orderId));
      const earlyDetailIds = new Set(earlyDetailCandidates.map(order => order.orderId!));
      const earlyDetailResultsPromise = Promise.all(earlyDetailCandidates.map(lookupOrder));
      const accountResult = await accountRead;
      if ("error" in accountResult) throw accountResult.error;
      let account = accountResult.snapshot;
      let openIds = new Set(account.openOrders.map(order => order.orderId));
      const detailCandidates = platform.orders.list().filter(order =>
        ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)
        && !!order.orderId && !openIds.has(order.orderId) && !earlyDetailIds.has(order.orderId));
      // Point order lookups are independent from recent-trade compensation.
      // Start them as soon as the account cut identifies the missing IDs so
      // two 3s REST bounds cannot add up in the recovery critical path.
      const detailResultsPromise = Promise.all(detailCandidates.map(lookupOrder));
      const tradeScanResults = await tradeScanPromise;
      const tradeScanFailures = tradeScanResults.filter((result): result is { marketId: string; error: unknown } => result !== undefined);
      if (tradeScanFailures.length > 0) {
        for (const failure of tradeScanFailures) recoveryFailureMarkets.add(failure.marketId);
        throw tradeScanFailures[0].error;
      }
      recoveryFailureMarketId = undefined;
      await platform.idle();
      // A new market may have submitted while the account snapshot was in
      // flight. Refresh once after the execution queue is idle so that the
      // reconciliation cut includes that order/fill instead of classifying
      // it as a missing old order.
      const currentBeforeReconcile = platform.account.current();
      const hasPostReadOrder = currentBeforeReconcile.orders.some(order =>
        (!initialOrderIds.has(order.clientOrderId) && order.status !== "REJECTED")
        || order.updatedAt > account.at + 1e-8);
      if (hasPostReadOrder) {
        // This account cut predates a live order from another market. Do not
        // apply it: `reconcile()` would otherwise call that fresh order
        // missing and freeze the new market. Leave the affected old market
        // blocked and let the next recovery pass take a newer cut.
        throw new Error("account snapshot predates new order; recovery deferred");
      }
      const cancelledIds: string[] = [];
      let replayed = false;
      const detailUnavailable = new Set<string>();
      const missingUnknown = new Set<string>();
      const currentFills = new Set(platform.portfolio.fills().filter(fill => fill.shares > 0).map(fill => fill.orderId));
      const detailResults = [...await earlyDetailResultsPromise, ...await detailResultsPromise];
      for (const { order, detail, unavailable, quarantined } of detailResults) {
        const currentOrder = platform.orders.get(order.orderId!);
        // A fast trade event can settle an UNKNOWN while its point lookup is
        // still in flight. Never let that older HTTP response overwrite the
        // newer terminal lifecycle.
        if (currentOrder && (["FILLED", "REJECTED"].includes(currentOrder.status)
          || currentOrder.status === "CANCELLED" && !currentOrder.reconciliationPending)) continue;
        if (openIds.has(order.orderId!)) continue;
        if (earlyDetailIds.has(order.orderId!) && currentOrder?.status !== "UNKNOWN") continue;
        const effectiveOrder = currentOrder ?? order;
        if (quarantined) {
          if (effectiveOrder.status === "UNKNOWN" && !effectiveOrder.venueStatus) missingUnknown.add(order.orderId!);
          continue;
        }
        if (unavailable || !detail) {
          detailUnavailable.add(order.orderId!);
          continue;
        }
        const missing = detail.status === "NOT_FOUND" || numeric(detail.status) === 404
          || /order.*not found|not found.*order/i.test(String(detail.error ?? ""));
        const status = String(detail.status ?? "").toUpperCase();
        const venueStatus = normalizeVenueOrderStatus(detail.status);
        const market = options.markets.find(item => item.instruments.some(instrument => instrument.tokenId === order.tokenId));
        recoveryFailureMarketId = market?.id;
        if (missing && effectiveOrder.prepared && ["SUBMITTING", "UNKNOWN"].includes(effectiveOrder.status)
          && !effectiveOrder.venueStatus && !venueStatus
          && (effectiveOrder.preparedReplayAttempts ?? 0) < 2 && market && Date.now() / 1000 < market.endsAt) {
          // Repeat exactly the persisted signature/hash. Never generate a new
          // economic order to compensate an uncertain POST.
          platform.core.markPreparedReplay(order.orderId!);
          const response = await client!.resubmitPrepared(effectiveOrder.prepared, effectiveOrder);
          platform.core.recoverPreparedAck(order.orderId!, { ...response,
            status: response.success && response.orderId ? "accepted" : "unknown", error: response.errorMsg });
          replayed = true;
        }
        if (venueStatus) platform.core.observeVenueStatus(order.orderId!, venueStatus, {
          source: "account_read", observedAt: account.at,
        });
        if (["CANCELED", "CANCELLED", "EXPIRED"].includes(status)) cancelledIds.push(order.orderId!);
        // A 404/Not Found response is not a cancellation proof.  If the
        // original POST was UNKNOWN and the complete open-order snapshot also
        // excludes it, isolate that one ambiguity after any bounded replay so
        // it cannot block every later run or be submitted again.
        if (missing && effectiveOrder.status === "UNKNOWN" && !effectiveOrder.venueStatus) missingUnknown.add(order.orderId!);
        // Missing/404 or FILLED without its priced fills cannot release reserve.
      }
      recoveryFailureMarketId = undefined;
      for (const orderId of new Set([...detailUnavailable, ...missingUnknown])) {
        const order = platform.orders.get(orderId);
        const noPosition = order ? !account.positions.some(position => position.tokenId === order.tokenId && position.shares > 0) : false;
        const canAbandon = (missingUnknown.has(orderId) || detailUnavailable.has(orderId)) && order?.status === "UNKNOWN"
          && order.filledShares === 0 && tradeScanComplete.has(orderId) && !currentFills.has(orderId) && noPosition
          && account.at + 1e-8 >= order.createdAt
          && Date.now() / 1000 - account.at <= UNKNOWN_ACCOUNT_MAX_AGE_SEC
          && Date.now() / 1000 - order.createdAt >= UNKNOWN_ABANDON_AFTER_SEC;
        if (canAbandon && platform.core.abandonUnknown(orderId,
          "complete account and trade reads confirmed no open order, position, or fill after timeout", false)) continue;
        if (!openIds.has(orderId)) {
          platform.core.quarantineUnknown(orderId,
            missingUnknown.has(orderId) ? "order detail returned not found; venue outcome pending"
              : "order detail unavailable; venue outcome pending");
        }
      }
      // The abandonment event is synchronous: a strategy observer can persist
      // its ABANDONED stage together with this core snapshot before this flush.
      platform.core.commit();
      if (replayed) {
        // A replay can create the venue order while this pass is running;
        // reconcile against the fresh open-order cut, never the stale one.
        account = await readAccount!();
        openIds = new Set(account.openOrders.map(order => order.orderId));
      }
      const reconcileBlocked = new Set<string>();
      for (const order of platform.orders.list()) {
        if (!order.orderId || !["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)
          || platform.core.isOrderQuarantined(order.orderId)) continue;
        const marketId = platform.core.instrument(order.tokenId)?.marketId;
        if (!marketId) continue;
        if (!openIds.has(order.orderId)) {
          if (!cancelledIds.includes(order.orderId)) reconcileBlocked.add(marketId);
          continue;
        }
        const incoming = account.openOrders.find(item => item.orderId === order.orderId);
        if (incoming && incoming.filledShares !== order.filledShares) reconcileBlocked.add(marketId);
      }
      recoveryFailureMarkets = reconcileBlocked;
      if (reconcileBlocked.size > 0) {
        throw new Error("missing order needs trade/cancel evidence before reconciliation");
      }
      platform.account.reconcile(account, 0, cancelledIds);
      blockedOrderIdsByMarket.clear();
      unmappedBlockedOrderIds.clear();
      failedRecoveryMarkets.clear();
      recoveryFailureGlobal = false;
      recoveryFailureNotice = false;
      for (const [marketId, user] of usersByMarket) {
        if (!marketRecoveryBlocked(marketId) && !recoveryFailureGlobal && unmappedBlockedOrderIds.size === 0) user.markContinuous?.();
      }
    })().catch(error => {
      // A newer market may have submitted while the shared account read was
      // in flight. Do not turn that fresh order into a false recovery block;
      // only preserve the markets represented by the recovery cut.
      setBlockedOrdersFromPlatform(recoveryMarkets.size ? recoveryMarkets : undefined);
      const affected = new Set(recoveryFailureMarkets);
      for (const marketId of recoveryMarkets) affected.add(marketId);
      for (const marketId of blockedOrderIdsByMarket.keys()) affected.add(marketId);
      if (recoveryFailureMarketId) affected.add(recoveryFailureMarketId);
      if (unmappedBlockedOrderIds.size > 0 || affected.size === 0) recoveryFailureGlobal = true;
      else for (const marketId of affected) failedRecoveryMarkets.add(marketId);
      refreshCoreRecoveryGate();
      recoveryFailureNotice = true;
      throw error;
    }).finally(() => {
      recoveryFailureMarketId = undefined;
      recoveryFailureMarkets = new Set<string>();
      // A failed pass must keep its affected market closed until the next
      // successful recovery or terminal venue evidence. Clearing this gate in
      // finally re-opened an unresolved market after every failed pass.
      if (!recoveryFailureGlobal && unmappedBlockedOrderIds.size === 0
        && failedRecoveryMarkets.size === 0 && blockedOrderIdsByMarket.size === 0) {
        platform.core.setRecovering(false);
      } else {
        refreshCoreRecoveryGate();
      }
      recoveryJob = undefined;
    });
    return recoveryJob;
  };
  let feedDeadline = Infinity;
  const duringMarketSetup = async (job: () => Promise<unknown>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!signal) { await job(); return; }
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { await Promise.race([job(), aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
    signal.throwIfAborted();
  };
  recoverAccountNow = recoverAccount;
  const startMarket = async (market: MarketInfo, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (stopped || connectedMarkets.has(market.id)) return;
    if (client && market.endsAt > Date.now() / 1000) {
      await duringMarketSetup(() => client!.warmMarket(market.id, undefined, undefined, signal), signal);
    }
    signal?.throwIfAborted();
    if (stopped) return;
    if (!feedQueues.has(market.id)) feedQueues.set(market.id, new FeedQueue());
    if (client) {
      market.instruments = market.instruments.map(instrument => {
        const rule = client!.feeRule(instrument.tokenId);
        return rule ? { ...instrument, feeRate: rule.rate, feeExponent: rule.exponent, takerDelayMs: rule.takerDelayMs } : instrument;
      });
      platform.ingest({ kind: "market", market });
    }
    connectedMarkets.add(market.id);
    const sides = binaryMarketSides(market);
    if (!sides) throw new Error(`market ${market.id} has no UP/DOWN token mapping`);
    const { up, down } = sides;
    if (market.endsAt > Date.now() / 1000) {
      const feed = runPolymarketFeed(sink(market), up.tokenId, down.tokenId, Math.min(feedDeadline, market.endsAt), {
        marketId: market.id, roundId: market.roundId,
      });
      controls.add(feed); bookFeeds.set(market.id, feed);
      bookHealth.set(market.id, feed.isHealthy ?? (() => false));
    }
    if (client) {
      const user = runUserFeed(sink(market), { creds: client.creds, conditionId: market.id,
        upToken: up.tokenId, downToken: down.tokenId, accountAddress: client.funder,
        orderDirection: id => platform.orders.get(id)?.direction,
        isOurOrder: id => !!platform.orders.get(id),
        onOrderEvent: event => {
          const order = platform.orders.get(event.orderId);
          const venueStatus = normalizeVenueOrderStatus(event.venueStatus);
          if (order && venueStatus) {
            platform.core.observeVenueStatus(event.orderId, venueStatus, {
              source: "user_ws", observedAt: event.receivedAtUnix,
            });
            if (["filled", "canceled", "cancelled", "expired"].includes(venueStatus)) allowRecoveryAfterEvidence(event.orderId);
          }
        },
        fetchTrades: ids => client!.getTradesByIds(ids), fetchRecentTrades: after => client!.getRecentTrades(market.id, after),
        fetchOpenOrders: () => client!.getOpenOrders(market.id),
        reconcileAfterReconnect: async (_afterUnix, openOrders) => {
          if (stopped) return false;
          // User-feed REST snapshots already cover this market's reconnect
          // gap. A failed global recovery for another market must not keep
          // this market's authenticated feed discontinuous.
          if (marketRecoveryBlocked(market.id) || recoveryFailureGlobal || unmappedBlockedOrderIds.size > 0) return false;
          // The two authenticated snapshots above already cover this
          // market's reconnect gap. A full account recovery reads every
          // market, scans trades, and may query order details; running it here
          // made an ordinary User WS reconnect hold the live execution gate
          // for several seconds even when there was no unresolved order.
          // Only a genuinely blocked account needs that stronger pass.
          if (hasBlockedOrders() || reconnectSnapshotNeedsRecovery(market.id, openOrders)) {
            try { await recoverAccount(); }
            catch { return !recoveryFailureGlobal && !marketRecoveryBlocked(market.id) && unmappedBlockedOrderIds.size === 0; }
          }
          if (stopped) return false;
          return !recoveryFailureGlobal && !marketRecoveryBlocked(market.id) && unmappedBlockedOrderIds.size === 0;
        },
        verifyAuthenticated: async () => { await client!.getOpenOrders(market.id); return true; },
      }, feedDeadline);
      users.push(user); usersByMarket.set(market.id, user); controls.add(user);
      // Restored orders must be registered too; they need not emit a new ACK.
      for (const order of platform.orders.list()) {
        if (order.orderId && market.instruments.some(instrument => instrument.tokenId === order.tokenId)) {
          user.registerOrder(order.orderId, order.tradeIds);
        }
      }
      // User WS authentication is retried by the feed itself. Do not make a
      // transient L2 verification failure abort the whole platform startup.
      // The gateway's readiness predicate remains closed until this feed
      // reports healthy and continuous, so no order can be submitted while
      // authentication or reconnect compensation is still pending.
      void user.waitUntilReady(10_000, signal).catch(error => {
        if (stopped || signal?.aborted) return;
        userHealthy.set(market.id, false);
        platform.ingest({ kind: "error", strategyId: "btc-reversal", marketId: market.id,
          code: "user_feed_not_ready", message: `authenticated user feed not ready: ${error instanceof Error ? error.message : "retrying"}` });
      });
    }
  };
  const cleanupExpiredFeeds = () => {
    const now = Date.now() / 1000;
    const pruneSnapshotState = (entries: Map<string, unknown>) => {
      for (const key of entries.keys()) {
        let marketId: string | undefined;
        let roundId: string | undefined;
        try {
          const parsed = JSON.parse(key) as unknown;
          if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
            marketId = parsed[0]; roundId = parsed[1];
          }
        } catch { /* An invalid local key is safe to discard. */ }
        const market = marketId ? options.markets.find(item => item.id === marketId) : undefined;
        if (!market || market.roundId !== roundId || market.endsAt <= now) entries.delete(key);
      }
    };
    pruneSnapshotState(snapshotWatermarks);
    pruneSnapshotState(snapshotRejectNotice);
    pruneSnapshotState(snapshotFreshAfter);
    const account = platform.account.current();
    if (client && !stopped && !recoveryJob && (account.risk.reason?.includes("reconciliation")
      || account.orders.some(order => (order.status === "UNKNOWN" || order.reconciliationPending)
        && (!order.orderId || !platform.core.isOrderQuarantined(order.orderId))))) {
      void recoverAccount().catch(() => {
        if (recoveryFailureNotice) return;
        recoveryFailureNotice = true;
        platform.ingest({ kind: "error", code: "order_recovery_pending", message: "order recovery remains pending" });
      });
    }
    for (const market of options.markets) {
      if (market.endsAt > now) continue;
      const feed = bookFeeds.get(market.id);
      if (feed) { feed.stop(); controls.delete(feed); bookFeeds.delete(market.id); bookHealth.delete(market.id); booksHealthy.delete(market.id); }
      feedQueues.delete(market.id);
      feedQueueCursor = feedQueues.size ? feedQueueCursor % feedQueues.size : 0;
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
  const refreshCashFlows = (): void => {
    if (stopped || recoveryJob || cashFlowJob || !scanCashFlows) return;
    cashFlowJob = (async () => {
      const snapshot = await scanCashFlows!();
      if (stopped || recoveryJob) return;
      // Cash-flow coverage is financial telemetry. A slow or incomplete scan
      // must be reported without taking the order/user-feed path offline.
      platform.core.observeCashFlowCoverage(snapshot);
    })().catch(() => { if (!stopped) platform.ingest({ kind: "error", code: "cash_flow_refresh_pending",
      message: "cash flow coverage refresh pending" }); })
      .finally(() => { cashFlowJob = undefined; });
  };
  return {
    platform,
    recoverAccount,
    async addMarkets(markets: MarketInfo[], signal?: AbortSignal) {
      for (const market of markets) {
        signal?.throwIfAborted();
        if (stopped) return;
        if (!options.markets.some(existing => existing.id === market.id)) options.markets.push(market);
        platform.ingest({ kind: "market", market });
        if (started) await startMarket(market, signal);
      }
    },
    async start() {
      if (started || stopped) throw new Error("connection already started or stopped");
      started = true;
      feedDeadline = Date.now() / 1000 + (options.durationSec ?? 3600);
      if (client) stopHeartbeat = client.startHeartbeat();
      // Close the execution gate before any feed can deliver its first book.
      // Recovery is still deliberately not awaited, so feed startup and the
      // five-minute scheduler can proceed while account reads run in parallel.
      let startupRecovery: Promise<void> | undefined;
      try {
        startFeedConsumer();
        if (client && options.restored) {
          startupRecovery = recoverAccount().catch(() => {
            recoveryFailureNotice = true;
            platform.ingest({ kind: "error", code: "startup_account_recovery_pending",
              message: "startup account recovery remains pending" });
          });
        }
        await Promise.all(options.markets.map(market => startMarket(market)));
        if (options.referenceFeed) {
          for (const market of options.markets) {
            const assetId = market.assetId ?? options.assetId ?? "btc";
            const producer = options.referenceFeeds?.[assetId];
            if (producer) controls.add(producer(sink(market), assetId));
            else if (assetId === "btc") controls.add(runBtcFeed(sink(market)));
          }
        }
        cleanupExpiredFeeds(); cleanupTimer = setInterval(cleanupExpiredFeeds, 5000);
        refreshCashFlows(); cashFlowTimer = setInterval(refreshCashFlows, 30_000);
      } catch (error) {
        await startupRecovery?.catch(() => undefined);
        await stopFeedConsumer();
        for (const control of controls) control.stop();
        stopHeartbeat?.(); stopped = true; cashFlowAbort.abort(); throw error;
      }
    },
    async stop(reason = "operator stop") {
      stopped = true; clearInterval(cleanupTimer); clearInterval(cashFlowTimer);
      cashFlowAbort.abort();
      await stopFeedConsumer();
      // A startup recovery pass now runs in the background. Let it settle
      // before closing the platform so a late account snapshot cannot publish
      // into an already-stopped execution ledger.
      const pendingRecovery = recoveryJob;
      await pendingRecovery?.catch(() => undefined);
      let stopError: unknown;
      try { await platform.stop(reason); }
      catch (error) { stopError = error; }
      finally {
        for (const control of controls) control.stop();
        bookHealth.clear(); feedQueues.clear(); wakeFeedConsumer(); stopHeartbeat?.(); client?.stopHeartbeat();
      }
      if (stopError) throw stopError;
    },
  };
}
