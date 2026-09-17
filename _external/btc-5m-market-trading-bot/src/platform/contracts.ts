/** Venue-neutral contracts. Strategies never import a venue client or maker configuration. */
export type Direction = "BUY" | "SELL";
export type TimeInForce = "GTC" | "FOK" | "FAK";
export type TradingMode = "paper" | "live";
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
  source?: "polymarket-ws" | "clob-rest" | "collector-rest" | "paper";
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  /** Sorted best first. Strategies may slice(0, 5) for top-five depth. */
  bids?: PriceLevel[];
  asks?: PriceLevel[];
}
export interface OrderRequest {
  clientOrderId: string;
  strategyId: string;
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
export interface OrderRecord extends OrderRequest {
  orderId?: string;
  status: OrderStatus;
  filledShares: number;
  reservedUsd: number;
  reservedShares: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  tradeIds?: string[];
  signLatencyMs?: number;
  ackLatencyMs?: number;
  /** Wall-clock seconds when the core started the venue cancel request. */
  cancelRequestedAt?: number;
  /** Wall-clock seconds when the venue confirmed the cancellation. */
  cancelAckAt?: number;
  cancelAckLatencyMs?: number;
  /** A venue cancel ACK can race with a fill already in flight. */
  reconciliationPending?: boolean;
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
  risk: RiskView;
  /** Opaque plugin state is persisted in the same commit as the account ledger. */
  strategyStates?: Record<string, unknown>;
  markets?: MarketInfo[];
  cashFlowTracking?: CashFlowTracking;
}
export interface GatewayAck {
  status: "accepted" | "rejected" | "unknown";
  orderId?: string;
  error?: string;
  tradeIds?: string[];
  signLatencyMs?: number;
  ackLatencyMs?: number;
}
export interface OrderGateway {
  readonly mode: TradingMode;
  readonly durableIdentity?: boolean;
  submit(request: OrderRequest, instrument: Instrument, prepared?: (value: PreparedOrder) => void): Promise<GatewayAck>;
  cancel(orderId: string): Promise<boolean>;
  /** No hidden position selection or automatic account-wide cancellation. */
  close?(): Promise<void>;
}
export interface SettlementRequest {
  marketId: string;
  tokenIds: string[];
}
export interface SettlementResult {
  marketId: string;
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
  persist?: (state: CoreState, critical: boolean) => void;
  record?: (event: TradingEvent) => void;
}
export type TradingEvent =
  | { kind: "market"; market: MarketInfo }
  | { kind: "book"; book: Book }
  | { kind: "reference"; symbol: string; price: number; ts: number }
  | { kind: "fill"; fill: TradeFill }
  | { kind: "order"; order: OrderRecord }
  | { kind: "account"; snapshot: AccountSnapshot }
  | { kind: "settlement"; result: SettlementResult }
  | { kind: "timer"; ts: number }
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
