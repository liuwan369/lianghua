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
}
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
  cashUsd: number;
  positions: Position[];
  openOrders: OrderRecord[];
  /** Queries are ordinary venue reads; no atomic provider is required. */
  complete: boolean;
}
export interface HardLimits {
  capitalUsd: number;
  dailyLossUsd: number;
  maxOrderUsd: number;
  maxOpenOrders: number;
}
export interface RiskView {
  halted: boolean;
  reason?: string;
  day: string;
  baselineAt: number;
  baselineEquityUsd: number;
  equityUsd: number;
  dailyPnlUsd: number;
  occupiedUsd: number;
  availableUsd: number;
}
export interface CoreState {
  schemaVersion: 1;
  accountId: string;
  mode: TradingMode;
  cashUsd: number;
  positions: Position[];
  orders: OrderRecord[];
  fills: TradeFill[];
  risk: RiskView;
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
  submit(request: OrderRequest, instrument: Instrument): Promise<GatewayAck>;
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
}
export interface PlatformAdapters {
  gateway: OrderGateway;
  readAccount?: () => Promise<AccountSnapshot>;
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
  | { kind: "error"; message: string; strategyId?: string; clientOrderId?: string; orderId?: string };
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
