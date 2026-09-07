import type { MakerEvent } from "../live-maker.js";
import {
  estimateMakerFillProbability,
  Side,
  visibleBuyQueueAhead,
  type BookLevel,
  type BookQuote,
  type MarketBooks,
} from "../models.js";

export interface EngineBookMicrostructure {
  upBidLevels?: BookLevel[];
  downBidLevels?: BookLevel[];
  upBidSize?: number;
  downBidSize?: number;
  upSellTradeRateSharesPerSec?: number;
  downSellTradeRateSharesPerSec?: number;
  upTickSize?: number;
  downTickSize?: number;
  expectedRestingSeconds?: number;
  volatilityBps?: number;
}

export interface MakerMicrostructureConfig {
  minimumProbability: number;
  fullSizeProbability: number;
  queueConservatism: number;
  minimumShares: number;
  tradeRateWindowSec: number;
  expectedRestingSeconds: number;
}

interface FlowObservation {
  tsUnix: number;
  side: Side;
  shares: number;
}

export class MakerMicrostructureGate {
  private flow: FlowObservation[] = [];
  private midHistory: Array<{ tsUnix: number; up: number; down: number }> = [];

  constructor(private readonly config: MakerMicrostructureConfig) {}

  reset(): void {
    this.flow = [];
    this.midHistory = [];
  }

  recordTrade(side: Side, takerSide: string, shares: number, tsUnix: number): void {
    if (
      takerSide.toUpperCase() !== "SELL" ||
      !Number.isFinite(shares) ||
      shares <= 0 ||
      !Number.isFinite(tsUnix)
    ) return;
    this.flow.push({ side, shares, tsUnix });
    this.pruneFlow(tsUnix);
  }

  books(
    tsUnix: number,
    upBid: number | undefined,
    upAsk: number | undefined,
    downBid: number | undefined,
    downAsk: number | undefined,
    micro: EngineBookMicrostructure,
  ): MarketBooks {
    this.updateMids(tsUnix, upBid, upAsk, downBid, downAsk);
    return {
      tsUnix,
      up: this.quote(
        Side.Up,
        tsUnix,
        upBid,
        upAsk,
        micro.upBidSize,
        micro.upBidLevels,
        micro.upSellTradeRateSharesPerSec,
        micro.upTickSize,
      ),
      down: this.quote(
        Side.Down,
        tsUnix,
        downBid,
        downAsk,
        micro.downBidSize,
        micro.downBidLevels,
        micro.downSellTradeRateSharesPerSec,
        micro.downTickSize,
      ),
      expectedRestingSeconds:
        micro.expectedRestingSeconds ?? this.config.expectedRestingSeconds,
      volatilityBps: micro.volatilityBps ?? this.recentVolatilityBps(),
    };
  }

  filterQuotes(
    events: MakerEvent[],
    books: MarketBooks,
    removePending: (side: Side) => void,
    resizePending: (side: Side, shares: number, price: number) => void,
  ): MakerEvent[] {
    if (this.config.minimumProbability <= 0) return events;
    const out: MakerEvent[] = [];
    for (const event of events) {
      if (event.kind !== "quote") {
        out.push(event);
        continue;
      }
      const quote = event.side === Side.Up ? books.up : books.down;
      const tickSize = quote.tickSize != null && quote.tickSize > 0 ? quote.tickSize : 0.01;
      const price = Math.floor((event.price + 1e-12) / tickSize) * tickSize;
      const probability = this.probability(quote, price, event.shares, books);
      if (probability == null || probability < this.config.minimumProbability) {
        removePending(event.side);
        continue;
      }
      const sizeFactor = Math.min(1, probability / this.config.fullSizeProbability);
      const shares = Math.floor(event.shares * sizeFactor * 100) / 100;
      if (shares < this.config.minimumShares) {
        removePending(event.side);
        continue;
      }
      resizePending(event.side, shares, price);
      out.push({ ...event, price, shares });
    }
    return out;
  }

  /** Cancel an existing quote when a fresh book makes its fill estimate unsafe. */
  filterPending(
    pending: Array<{ side: Side; price: number; shares: number }>,
    books: MarketBooks,
    removePending: (side: Side) => void,
  ): MakerEvent[] {
    if (this.config.minimumProbability <= 0) return [];
    const out: MakerEvent[] = [];
    for (const item of pending) {
      const quote = item.side === Side.Up ? books.up : books.down;
      const tickSize = quote.tickSize != null && quote.tickSize > 0 ? quote.tickSize : 0.01;
      const price = Math.floor((item.price + 1e-12) / tickSize) * tickSize;
      const probability = this.probability(quote, price, item.shares, books);
      if (probability == null || probability < this.config.minimumProbability) {
        removePending(item.side);
        out.push({ kind: "cancel", side: item.side, price: item.price });
      }
    }
    return out;
  }

  private quote(
    side: Side,
    tsUnix: number,
    bid: number | undefined,
    ask: number | undefined,
    bidSize: number | undefined,
    bidLevels: BookLevel[] | undefined,
    suppliedSellRate: number | undefined,
    tickSize: number | undefined,
  ): BookQuote {
    return {
      bid,
      ask,
      bidSize,
      bidLevels,
      sellTradeRateSharesPerSec: suppliedSellRate ?? this.sellRate(side, tsUnix),
      tickSize,
      tsUnix,
    };
  }

  private probability(
    quote: BookQuote,
    price: number,
    shares: number,
    books: MarketBooks,
  ): number | undefined {
    const queueAheadShares = visibleBuyQueueAhead(quote, price);
    const tradeRate = quote.sellTradeRateSharesPerSec;
    const restingSeconds = books.expectedRestingSeconds;
    const volatilityBps = books.volatilityBps;
    if (
      queueAheadShares == null ||
      tradeRate == null ||
      restingSeconds == null ||
      volatilityBps == null
    ) return undefined;
    const tickSize = quote.tickSize != null && quote.tickSize > 0 ? quote.tickSize : 0.01;
    const ticksBehindBest = quote.bid != null
      ? Math.max(0, (quote.bid - price) / tickSize)
      : 0;
    return estimateMakerFillProbability({
      queueAheadShares,
      recentTradeRateSharesPerSec: tradeRate,
      orderShares: shares,
      restingSeconds,
      ticksBehindBest,
      volatilityBps,
      queueConservatism: this.config.queueConservatism,
    });
  }

  private pruneFlow(nowUnix: number): void {
    const cutoff = nowUnix - this.config.tradeRateWindowSec;
    this.flow = this.flow.filter(
      (event) => event.tsUnix >= cutoff && event.tsUnix <= nowUnix + 1,
    );
  }

  private sellRate(side: Side, nowUnix: number): number | undefined {
    this.pruneFlow(nowUnix);
    const matching = this.flow.filter((event) => event.side === side);
    if (matching.length === 0) return undefined;
    return matching.reduce((sum, event) => sum + event.shares, 0) /
      this.config.tradeRateWindowSec;
  }

  private updateMids(
    tsUnix: number,
    upBid?: number,
    upAsk?: number,
    downBid?: number,
    downAsk?: number,
  ): void {
    if (upBid == null || upAsk == null || downBid == null || downAsk == null) return;
    this.midHistory.push({
      tsUnix,
      up: (upBid + upAsk) / 2,
      down: (downBid + downAsk) / 2,
    });
    const cutoff = tsUnix - 5;
    this.midHistory = this.midHistory.filter((point) => point.tsUnix >= cutoff);
  }

  private recentVolatilityBps(): number | undefined {
    if (this.midHistory.length < 2) return undefined;
    let largest = 0;
    for (let i = 1; i < this.midHistory.length; i += 1) {
      const previous = this.midHistory[i - 1]!;
      const current = this.midHistory[i]!;
      largest = Math.max(
        largest,
        Math.abs(current.up - previous.up) * 10_000,
        Math.abs(current.down - previous.down) * 10_000,
      );
    }
    return largest;
  }
}
