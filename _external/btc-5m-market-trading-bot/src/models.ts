export enum Side {
  Up = "Up",
  Down = "Down",
}

export namespace Side {
  export function other(s: Side): Side {
    return s === Side.Up ? Side.Down : Side.Up;
  }

  export function asStr(s: Side): string {
    return s === Side.Up ? "UP" : "DOWN";
  }

  export function fromTokenType(s: string): Side | undefined {
    const t = s.toLowerCase();
    if (t === "up") return Side.Up;
    if (t === "down") return Side.Down;
    return undefined;
  }
}

export function decisionBucketTs(tsUnix: number, intervalSec: number): number {
  const interval = Math.max(1, intervalSec);
  return Math.floor(tsUnix / interval) * interval;
}

export interface BookQuote {
  bid?: number;
  ask?: number;
  bidSize?: number;
  /** Visible bid levels used to estimate how many shares are ahead of us. */
  bidLevels?: BookLevel[];
  sellTradeRateSharesPerSec?: number;
  tickSize?: number;
  tsUnix: number;
}

export interface BookLevel {
  price: number;
  size: number;
}

export function bookMid(q: BookQuote): number | undefined {
  const { bid, ask } = q;
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return undefined;
}

export interface MarketBooks {
  tsUnix: number;
  up: BookQuote;
  down: BookQuote;
  expectedRestingSeconds?: number;
  volatilityBps?: number;
}

export interface MarketTickSizes {
  upTickSize?: number;
  downTickSize?: number;
}

/** Quantize a BUY without inventing a venue tick or raising the risk-approved price. */
export function quantizeMakerBuyPrice(price: number, tickSize: number | undefined): number | undefined {
  if (!Number.isFinite(price) || price <= 0 || price >= 1 ||
    tickSize == null || !Number.isFinite(tickSize) || tickSize <= 0 || tickSize >= 1) return undefined;
  const rounded = Math.round(Math.floor(price / tickSize + 1e-9) * tickSize * 1e9) / 1e9;
  return rounded >= tickSize - 1e-12 && rounded <= 1 - tickSize + 1e-12 &&
    rounded <= price + 1e-12 ? rounded : undefined;
}

export function btcProxyChangePct(books: MarketBooks): number {
  const m = bookMid(books.up);
  return m != null ? (m - 0.5) * 2 : 0;
}

export function combinedAskSum(books: MarketBooks): number | undefined {
  const u = books.up.ask;
  const d = books.down.ask;
  if (u == null || d == null) return undefined;
  return u + d;
}

export interface MakerFillProbabilityInput {
  /** Visible shares already resting at our price before our order. */
  queueAheadShares: number;
  /** Recent opposite-side executions, measured in shares per second. */
  recentTradeRateSharesPerSec: number;
  /** Size of the maker order being estimated. */
  orderShares: number;
  /** How long the order is expected to rest. */
  restingSeconds: number;
  /** Number of ticks our order is behind the current best maker price. */
  ticksBehindBest: number;
  /** Short-window absolute price volatility in basis points. */
  volatilityBps: number;
  /** Inflates the visible queue because public depth is not our exact queue position. */
  queueConservatism?: number;
}

/**
 * Conservative maker-fill estimate from public market microstructure.
 *
 * This is deliberately a pure estimate, not a claim about actual exchange
 * priority. Real queue position can only be calibrated from our own orders.
 */
export function estimateMakerFillProbability(input: MakerFillProbabilityInput): number {
  const values = [
    input.queueAheadShares,
    input.recentTradeRateSharesPerSec,
    input.orderShares,
    input.restingSeconds,
    input.ticksBehindBest,
    input.volatilityBps,
    input.queueConservatism ?? 1.5,
  ];
  if (!values.every(Number.isFinite)) return 0;

  const queueAhead = Math.max(0, input.queueAheadShares);
  const tradeRate = Math.max(0, input.recentTradeRateSharesPerSec);
  const orderShares = Math.max(0, input.orderShares);
  const restingSeconds = Math.max(0, input.restingSeconds);
  const ticksBehind = Math.max(0, input.ticksBehindBest);
  const volatilityBps = Math.max(0, input.volatilityBps);
  const conservatism = Math.max(1, input.queueConservatism ?? 1.5);
  if (tradeRate <= 0 || orderShares <= 0 || restingSeconds <= 0) return 0;

  // Assume our average share sits halfway through our own order. Inflating the
  // public queue makes the estimate conservative when hidden priority exists.
  const effectiveQueue = queueAhead * conservatism + orderShares * 0.5;
  const expectedConsumption = tradeRate * restingSeconds;
  const queueProbability = 1 - Math.exp(-expectedConsumption / Math.max(effectiveQueue, 1e-9));

  // Orders behind the touch and orders exposed during a fast market are less
  // likely to receive a safe passive fill before repricing or cancellation.
  const distancePenalty = Math.exp(-0.7 * ticksBehind);
  const volatilityPenalty = 1 / (1 + volatilityBps / 25);
  return Math.min(1, Math.max(0, queueProbability * distancePenalty * volatilityPenalty));
}

/** Visible shares with equal or better priority than a passive BUY. */
export function visibleBuyQueueAhead(
  quote: BookQuote,
  orderPrice: number,
): number | undefined {
  if (!Number.isFinite(orderPrice) || orderPrice <= 0 || orderPrice >= 1) return undefined;
  const tickSize = quote.tickSize != null && quote.tickSize > 0 ? quote.tickSize : 0.01;
  const tolerance = tickSize / 10;
  if (quote.bidLevels != null) {
    if (quote.bidLevels.length === 0) return undefined;
    let total = 0;
    let hasBest = false;
    for (const level of quote.bidLevels) {
      if (
        !Number.isFinite(level.price) ||
        !Number.isFinite(level.size) ||
        level.price <= 0 ||
        level.price >= 1 ||
        level.size < 0
      ) return undefined;
      if (quote.bid != null && Math.abs(level.price - quote.bid) <= tolerance) hasBest = true;
      if (level.price + tolerance >= orderPrice) total += level.size;
    }
    if (quote.bid != null && !hasBest) return undefined;
    return total;
  }
  if (quote.bid == null || !Number.isFinite(quote.bid)) return undefined;
  if (orderPrice > quote.bid + tolerance) return 0;
  if (Math.abs(orderPrice - quote.bid) <= tolerance) {
    return quote.bidSize != null && Number.isFinite(quote.bidSize) && quote.bidSize >= 0
      ? quote.bidSize
      : undefined;
  }
  return undefined;
}

export interface Fill {
  side: Side;
  shares: number;
  price: number;
  tsUnix: number;
  isMaker: boolean;
  estimatedFillProbability?: number;
}

/** Remaining BUY commitments; these are not fills or guaranteed paired payouts. */
export interface PendingExposure {
  cost: number;
  upShares: number;
  downShares: number;
  orders: number;
}

export const MIN_ORDER_SHARES = 5;

/** Polymarket fee for one fill: fee = shares × rate × (p·(1−p))^exponent */
export function polymarketFillFee(
  shares: number,
  price: number,
  isMaker: boolean,
  takerFeeRate: number,
  makerFeeRate: number,
  feeExponent: number,
): number {
  const rate = isMaker ? makerFeeRate : takerFeeRate;
  if (rate <= 0 || price <= 0 || price >= 1 || shares <= 0) return 0;
  const variance = price * (1 - price);
  const curve =
    Math.abs(feeExponent - 1) < 1e-9 ? variance : Math.pow(variance, feeExponent);
  return shares * rate * curve;
}

export interface MarketResult {
  slug: string;
  startUnix: number;
  endUnix: number;
  fills: Fill[];
  winner?: Side;
  totalCost: number;
  payout: number;
  pnl: number;
  fees: number;
  pairCost: number;
  actualTraderPnl?: number;
  rewardsScore: number;
}

export interface BacktestSummary {
  markets: number;
  totalFills: number;
  totalPnl: number;
  totalFees: number;
  grossPnl: number;
  winRate: number;
  avgPnlPerMarket: number;
  avgPairCost: number;
  avgFillsPerMarket: number;
  traderPnl?: number;
}
