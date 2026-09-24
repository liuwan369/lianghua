/** Venue-neutral contracts. Strategies never import a venue client or maker configuration. */
export type Direction = "BUY" | "SELL";
export type TimeInForce = "GTC" | "FOK" | "FAK";
export type TradingMode = "live";
export type PriceLevel = [price: number, shares: number];
export interface Instrument {
  tokenId: string;
  marketId: string;
  outcome: string;
  tickSize: number;
  minOrderSize: number;
  feeRate?: number;
  feeExponent?: number;
  takerDelayMs?: number;
}
export interface MarketInfo {
  id: string;
  /** Explicit five-minute execution identity from market discovery. */
  roundId: string;
  name: string;
  startsAt: number;
  endsAt: number;
  instruments: Instrument[];
}
export interface Book {
  tokenId: string;
  ts: number;
  /** Exchange timestamp, when the venue supplies one. `ts` remains the ordering key. */
  exchangeTs?: number;
  receivedAt?: number;
  receivedAtMonoMs?: number;
  processedAtMonoMs?: number;
  processingLatencyMs?: number;
  /** Local receive age calculated from exchange and local clocks; may be unavailable. */
  sourceAgeMs?: number;
  source?: "polymarket-ws" | "clob-rest" | "collector-rest";
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  /** Sorted best first. Strategies may slice(0, 5) for top-five depth. */
  bids?: PriceLevel[];
  asks?: PriceLevel[];
}
/** Paired market snapshot accepted by the trading runtime after feed gating. */
export interface RuntimeMarketAssetSnapshot {
  assetId: string;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  bids?: PriceLevel[];
  asks?: PriceLevel[];
  sourceAt?: number;
  expiresAt?: number;
  sequence?: number;
}
export interface MarketBookSnapshot {
  marketId?: string;
  roundId?: string;
  sequence?: number;
  sourceAt?: number;
  expiresAt?: number;
  YES?: RuntimeMarketAssetSnapshot;
  NO?: RuntimeMarketAssetSnapshot;
  /** Feed receive/processing telemetry. These never replace sourceAt. */
  tsUnix: number;
  receivedAtUnix?: number;
  receivedAtMonoMs?: number;
  processedAtMonoMs?: number;
  marketAgeMs?: number;
  source?: "polymarket-ws" | "clob-rest" | "collector-rest";
  /** Legacy fields remain readable by old observers only. */
  upExchangeTsUnix?: number;
  downExchangeTsUnix?: number;
  upReceivedAtUnix?: number;
  downReceivedAtUnix?: number;
  upReceivedAtMonoMs?: number;
  downReceivedAtMonoMs?: number;
  upProcessedAtMonoMs?: number;
  downProcessedAtMonoMs?: number;
  upMarketAgeMs?: number;
  downMarketAgeMs?: number;
  upBid?: number;
  upAsk?: number;
  downBid?: number;
  downAsk?: number;
  upBidSz?: number;
  upAskSz?: number;
  downBidSz?: number;
  downAskSz?: number;
  upBidLevels?: PriceLevel[];
  upAskLevels?: PriceLevel[];
  downBidLevels?: PriceLevel[];
  downAskLevels?: PriceLevel[];
}
export interface OrderRequest {
  clientOrderId: string;
  strategyId: string;
  /** Optional caller assertion; the platform fills it from the registered market. */
  marketId?: string;
  roundId?: string;
  tokenId: string;
  direction: Direction;
  price: number;
  shares: number;
  timeInForce: TimeInForce;
  postOnly: boolean;
  /** Optional strategy round cap; execution includes fee and unknown-order reserves. */
  roundBudgetUsd?: number;
}
export type OrderStatus = "SUBMITTING" | "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED" | "REJECTED" | "UNKNOWN";
export type VenueOrderStatus = "live" | "matched" | "delayed" | "unmatched" | "canceled" | "cancelled" | "expired";
export type VenueStateSource = "http_ack" | "user_ws" | "account_read";
export type CancellationSource = "local_http" | "user_ws" | "account_read";
const VENUE_ORDER_STATUSES = new Set<VenueOrderStatus>(["live", "matched", "delayed", "unmatched", "canceled", "cancelled", "expired"]);
export function normalizeVenueOrderStatus(value: unknown): VenueOrderStatus | undefined {
  const status = typeof value === "string" ? value.trim().toLowerCase() as VenueOrderStatus : undefined;
  return status && VENUE_ORDER_STATUSES.has(status) ? status : undefined;
}
export interface OrderRecord extends OrderRequest {
  orderId?: string;
  status: OrderStatus;
  /** Last official CLOB order state; it does not replace the local lifecycle. */
  venueStatus?: VenueOrderStatus;
  /** Source and receive time for the latest official venue state. */
  venueStatusSource?: VenueStateSource;
  venueStatusAt?: number;
  venueStatusLatencyMs?: number;
  /** Additional time from the order HTTP ACK until a later venue state report. */
  venueStatusAfterAckLatencyMs?: number;
  /** Wall-clock time at which the CLOB HTTP order response was accepted. */
  httpAckAt?: number;
  filledShares: number;
  reservedUsd: number;
  reservedShares: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  tradeIds?: string[];
  signLatencyMs?: number;
  riskMetadataLatencyMs?: number;
  l2HeaderLatencyMs?: number;
  responseHeadersLatencyMs?: number;
  responseBodyLatencyMs?: number;
  postLatencyMs?: number;
  failurePhase?: "risk_metadata" | "signing" | "post";
  ackLatencyMs?: number;
  totalLatencyMs?: number;
  triggerToPostLatencyMs?: number;
  decisionToPostLatencyMs?: number;
  reactionLatencyMs?: number;
  durableCommitLatencyMs?: number;
  /** Wall-clock seconds when the core started the venue cancel request. */
  cancelRequestedAt?: number;
  /** Wall-clock seconds when the venue confirmed the cancellation. */
  cancelAckAt?: number;
  cancelAckLatencyMs?: number;
  /** A venue cancel ACK can race with a fill already in flight. */
  reconciliationPending?: boolean;
  /** Distinguishes an engine cancel request from an exchange-side termination. */
  cancellationSource?: CancellationSource;
  /** Signed order identity persisted before HTTP; never exposed in UI journals. */
  prepared?: PreparedOrder;
  identityProtocol?: "signed-before-post";
  preparedReplayAttempts?: number;
}
export interface PreparedOrder { orderHash: string; signedPayload: unknown; preparedAt: number }
export type TradeStatus = "MATCHED" | "MATCHED_NOT_BROADCASTED" | "MINED" | "RETRYING" | "CONFIRMED" | "FAILED";
export interface TradeFill {
  tradeId: string;
  orderId: string;
  /** Market identity carried through authenticated fills. */
  marketId?: string;
  roundId?: string;
  tokenId: string;
  direction: Direction;
  price: number;
  shares: number;
  feeUsd: number;
  ts: number;
  isMaker: boolean;
  status?: TradeStatus;
  feeSource?: "reported" | "rate-derived" | "estimate";
  /** Basis removed by a provisional SELL, retained for an exact failure compensation. */
  accountingBasisUsd?: number;
  accountingInventoryBeforeShares?: number;
}
export interface Position {
  tokenId: string;
  shares: number;
  costUsd: number;
  realizedPnlUsd: number;
}
export interface AccountSnapshot {
  accountId: string;
  at: number;
  /** Cash section observation time; other account queries may finish later. */
  cashAt?: number;
  cashUsd: number;
  positions: Position[];
  openOrders: OrderRecord[];
  /** Queries are ordinary venue reads; no atomic provider is required. */
  complete: boolean;
  cashFlowCoverage?: CashFlowCoverage;
  externalFlows?: ExternalCashFlow[];
}
export interface CashFlowCoverage {
  fromBlock: number;
  toBlock: number;
  /** Unix seconds for the actual scanned block boundaries. */
  fromAt: number;
  toAt: number;
  /** Complete classification of this block window, not a claim of real-time finality. */
  complete: boolean;
  reason?: string;
}
export interface ExternalCashFlow {
  id: string;
  kind: "deposit" | "withdrawal";
  amountUsd: number;
  block: number;
  at: number;
  transactionHash: string;
}
export interface CashFlowTracking {
  baselineAt: number;
  baselineBlock?: number;
  cursorBlock?: number;
  coveredThroughAt?: number;
  complete: boolean;
  reason?: string;
  appliedFlows: ExternalCashFlow[];
}
export interface HardLimits {
  capitalUsd: number;
  /** Unset disables only the optional daily loss stop; cash checks remain active. */
  dailyLossUsd?: number | null;
  maxOrderUsd: number;
  maxOpenOrders: number;
}
export interface RiskView {
  halted: boolean;
  reason?: string;
  /** Number of orders whose venue outcome is not yet confirmed. */
  unresolvedOrderCount?: number;
  /** True while any order still needs authenticated venue evidence. */
  reconciliationRequired?: boolean;
  /** Markets blocked by an unresolved order; other markets may continue. */
  blockedMarketIds?: string[];
  day: string;
  baselineAt: number;
  /** Account observation included in a day boundary baseline, for late flow corrections. */
  baselineAccountAt?: number;
  baselineEquityUsd: number;
  equityUsd: number;
  dailyPnlUsd: number;
  occupiedUsd: number;
  availableUsd: number;
  cashFlowComplete?: boolean;
  cashFlowReason?: string;
  cashFlowCoverageFrom?: number;
  cashFlowCoverageUntil?: number;
  netExternalFlowUsd?: number;
  pnlVerified?: boolean;
  dailyLossStatus?: "disabled" | "active" | "estimated";
}
export interface CoreState {
  schemaVersion: 1;
  accountId: string;
  /** Last ordinary account snapshot accepted by reconcile(). */
  accountAt?: number;
  /** Observation time of the cash section accepted by reconcile(). */
  cashAt?: number;
  mode: TradingMode;
  cashUsd: number;
  positions: Position[];
  orders: OrderRecord[];
  fills: TradeFill[];
  /** UNKNOWN orders whose complete open-order snapshot excludes them while detail lookup is unavailable. */
  quarantinedOrderIds?: string[];
  risk: RiskView;
  /** Opaque plugin state is persisted in the same commit as the account ledger. */
  strategyStates?: Record<string, unknown>;
  markets?: MarketInfo[];
  cashFlowTracking?: CashFlowTracking;
}
export interface GatewayAck {
  status: "accepted" | "rejected" | "unknown";
  venueStatus?: VenueOrderStatus;
  orderId?: string;
  error?: string;
  tradeIds?: string[];
  signLatencyMs?: number;
  riskMetadataLatencyMs?: number;
  l2HeaderLatencyMs?: number;
  responseHeadersLatencyMs?: number;
  responseBodyLatencyMs?: number;
  postLatencyMs?: number;
  failurePhase?: "risk_metadata" | "signing" | "post";
  ackLatencyMs?: number;
  totalLatencyMs?: number;
  triggerToPostLatencyMs?: number;
  decisionToPostLatencyMs?: number;
  reactionLatencyMs?: number;
}
export interface ExecutionTiming {
  /** Monotonic receive time of the market frame that produced this action. */
  triggerReceivedAtMonoMs?: number;
  /** Monotonic time immediately after the synchronous strategy decision. */
  decisionAtMonoMs?: number;
}
export interface OrderGateway {
  readonly mode: TradingMode;
  readonly durableIdentity?: boolean;
  submit(request: OrderRequest, instrument: Instrument, prepared?: (value: PreparedOrder) => void,
    timing?: ExecutionTiming): Promise<GatewayAck>;
  cancel(orderId: string): Promise<boolean>;
  /** No hidden position selection or automatic account-wide cancellation. */
  close?(): Promise<void>;
}
export interface SettlementRequest {
  marketId: string;
  /** Explicit market round when the caller already has it. */
  roundId?: string;
  tokenIds: string[];
}
export interface SettlementResult {
  marketId: string;
  /** Resolved only from the registered market identity, never from time or slug. */
  roundId?: string;
  state: "confirmed" | "pending" | "unsupported";
  transactionId?: string;
  reason?: string;
  /** False for no-holdings completion and pending or failed transactions. */
  payoutVerified?: boolean;
  creditedUsd?: number;
  expectedPayoutUsd?: number;
  /** Balance observations can include unrelated wallet activity; not round PnL. */
  cashBeforeUsd?: number;
  cashAfterUsd?: number;
}
export interface PlatformAdapters {
  gateway: OrderGateway;
  readAccount?: () => Promise<AccountSnapshot>;
  /** Freeze authenticated event sources before the final account read on stop. */
  beforeFinalReconcile?: () => void;
  discoverMarkets?: () => Promise<MarketInfo[]>;
  settle?: (request: SettlementRequest) => Promise<SettlementResult>;
  /** A fee reserve is a venue rule, not a strategy parameter. */
  estimateFee?: (request: OrderRequest) => number;
  /** Hold a pending background snapshot until a signed identity can join it. */
  deferPersistence?: () => void;
  /** Persist only the signed order identity before the venue POST. */
  persistPreparedOrder?: (order: OrderRecord) => void;
  persist?: (state: CoreState, critical: boolean) => void;
  record?: (event: TradingEvent) => void;
}
export type TradingEvent =
  | { kind: "market"; market: MarketInfo }
  | { kind: "book"; book: Book; snapshot?: undefined }
  | { kind: "book"; snapshot: MarketBookSnapshot; marketId: string; roundId: string; book?: undefined }
  | { kind: "reference"; symbol: string; price: number; ts: number }
  | { kind: "fill"; fill: TradeFill; marketId?: string; roundId?: string }
  | { kind: "order"; order: OrderRecord; marketId?: string; roundId?: string }
  | { kind: "account"; snapshot: AccountSnapshot }
  | { kind: "settlement"; result: SettlementResult }
  | { kind: "timer"; ts: number }
  | { kind: "latency"; metric: string; durationMs: number; ts: number; marketId?: string;
      tokenId?: string; strategyId?: string; clientOrderId?: string; orderId?: string; outcome?: string }
  | { kind: "stopped"; reason: string }
  | { kind: "error"; message: string; strategyId?: string; clientOrderId?: string; orderId?: string; marketId?: string; code?: string };
export type StrategyAction =
  | { kind: "submit"; order: Omit<OrderRequest, "strategyId"> }
  | { kind: "cancel"; orderId: string }
  | { kind: "replace"; orderId: string; order: Omit<OrderRequest, "strategyId"> };
export interface StrategyContext {
  readonly mode: TradingMode;
  readonly now: number;
  readonly markets: readonly MarketInfo[];
  readonly books: readonly Book[];
  readonly account: Readonly<Omit<CoreState, "fills">>;
  readonly estimateFee?: (order: Omit<OrderRequest, "strategyId">) => number;
}
export interface StrategyPlugin {
  readonly id: string;
  onEvent(event: TradingEvent, context: StrategyContext): readonly StrategyAction[];
  onStop?(): void;
}
export interface CoreOptions {
  account: AccountSnapshot;
  instruments: Instrument[];
  limits: HardLimits;
  adapters: PlatformAdapters;
  restored?: CoreState;
  now?: () => number;
  onEvent?: (event: TradingEvent) => void;
}
