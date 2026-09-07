import { Inventory } from "./inventory.js";
import {
  polymarketFillFee,
  Side,
  type Fill,
  type MarketBooks,
} from "./models.js";
import type { StrategyConfig } from "./config.js";
import { PairCostMarketMaker } from "./strategy.js";

/** Incremental 1-second BTC spot price ring. */
export class BtcRing {
  private px = new Map<number, number>();
  private lastSec = Number.MIN_SAFE_INTEGER;
  private lastPx = 0;

  push(sec: number, price: number): void {
    if (price <= 0) return;
    if (this.lastSec !== Number.MIN_SAFE_INTEGER && sec > this.lastSec + 1) {
      const from = Math.max(sec - 600, this.lastSec + 1);
      for (let s = from; s < sec; s++) {
        if (!this.px.has(s)) this.px.set(s, this.lastPx);
      }
    }
    this.px.set(sec, price);
    if (sec >= this.lastSec) {
      this.lastSec = sec;
      this.lastPx = price;
    }
  }

  price(sec: number): number | undefined {
    const p = this.px.get(sec);
    return p != null && p > 0 ? p : undefined;
  }
}

export type MakerEvent =
  | { kind: "quote"; side: Side; price: number; shares: number }
  | { kind: "taker"; side: Side; price: number; shares: number }
  | {
      kind: "fill";
      side: Side;
      price: number;
      shares: number;
      isMaker: boolean;
      fee: number;
    }
  | { kind: "cancel"; side: Side; price: number };

interface RestingQuote {
  side: Side;
  price: number;
  shares: number;
  lifeEnd: number;
  btcAtPost: number;
}

export interface PendingQuote {
  side: Side;
  price: number;
  shares: number;
}

/** Streaming MAKER session for live/paper. */
export class MakerSession {
  strat: PairCostMarketMaker;
  marketStart = 0;
  marketEnd = 0;
  makerLifeSec: number;
  decisionIntervalSec: number;
  defensiveCancelBps: number;
  liveMode: boolean;
  btc = new BtcRing();
  haltNew = false;

  private lastDecisionTs = Number.NEGATIVE_INFINITY;
  private inv = new Inventory();
  private btcAtStart?: number;
  private pending: RestingQuote[] = [];

  constructor(
    cfg: StrategyConfig,
    makerLifeSec: number,
    decisionIntervalSec: number,
    defensiveCancelBps: number,
    liveMode = false,
  ) {
    this.strat = new PairCostMarketMaker(cfg);
    this.makerLifeSec = Math.max(0.1, makerLifeSec);
    this.decisionIntervalSec = Math.max(0, decisionIntervalSec);
    this.defensiveCancelBps = Math.max(0, defensiveCancelBps);
    this.liveMode = liveMode;
  }

  reset(start: number, end: number): void {
    this.marketStart = start;
    this.marketEnd = end;
    this.inv = new Inventory();
    this.lastDecisionTs = Number.NEGATIVE_INFINITY;
    this.btcAtStart = undefined;
    this.pending = [];
    this.strat.onMarketStart(start);
  }

  onMarketEnd(pnl: number): void {
    this.strat.onMarketEnd(pnl, this.marketStart);
  }

  dailyHalted(): boolean {
    return !this.strat.risk.canTrade(this.strat.config);
  }

  onBtc(tsUnix: number, price: number): void {
    this.btc.push(Math.round(tsUnix), price);
    if (
      this.btcAtStart == null &&
      Math.round(tsUnix) >= this.marketStart &&
      price > 0
    ) {
      this.btcAtStart = price;
    }
  }

  private fee(shares: number, price: number, isMaker: boolean): number {
    const c = this.strat.config;
    return polymarketFillFee(
      shares,
      price,
      isMaker,
      c.takerFeeRate,
      c.makerFeeRate,
      c.feeExponent,
    );
  }

  onBook(
    tsUnix: number,
    upBid?: number,
    upAsk?: number,
    downBid?: number,
    downAsk?: number,
  ): MakerEvent[] {
    const book: MarketBooks = {
      tsUnix,
      up: { bid: upBid, ask: upAsk, tsUnix },
      down: { bid: downBid, ask: downAsk, tsUnix },
    };
    const out: MakerEvent[] = [];
    const btcNow = this.btc.price(Math.round(tsUnix));

    const still: RestingQuote[] = [];
    for (const q of this.pending) {
      if (this.defensiveCancelBps > 0 && btcNow != null && q.btcAtPost > 0) {
        const mvBps = ((btcNow - q.btcAtPost) / q.btcAtPost) * 1e4;
        const adverse =
          q.side === Side.Up
            ? mvBps <= -this.defensiveCancelBps
            : mvBps >= this.defensiveCancelBps;
        if (adverse) {
          out.push({ kind: "cancel", side: q.side, price: q.price });
          continue;
        }
      }

      const ask = q.side === Side.Up ? upAsk : downAsk;
      const hit =
        !this.liveMode &&
        ask != null &&
        ask > 0 &&
        ask < 1 &&
        ask <= q.price;
      if (hit) {
        const fill: Fill = {
          side: q.side,
          shares: q.shares,
          price: q.price,
          tsUnix,
          isMaker: true,
        };
        const fee = this.fee(q.shares, q.price, true);
        this.inv.execute(fill);
        this.strat.recordFill(this.inv);
        out.push({
          kind: "fill",
          side: q.side,
          price: q.price,
          shares: q.shares,
          isMaker: true,
          fee,
        });
      } else if (tsUnix > q.lifeEnd) {
        out.push({ kind: "cancel", side: q.side, price: q.price });
      } else {
        still.push(q);
      }
    }
    this.pending = still;

    if (
      !this.haltNew &&
      (this.decisionIntervalSec <= 0 ||
        tsUnix - this.lastDecisionTs >= this.decisionIntervalSec)
    ) {
      this.lastDecisionTs = tsUnix;
      let btcChg: number | undefined;
      if (this.btcAtStart != null) {
        const pxNow = this.btc.price(Math.round(tsUnix));
        if (pxNow != null) {
          btcChg = (pxNow - this.btcAtStart) / this.btcAtStart;
        }
      }

      const side = this.strat.chooseSide(
        this.inv,
        book,
        tsUnix,
        this.marketStart,
        this.marketEnd,
        btcChg,
      );

      if (side != null) {
        const f = this.strat.buildFill(
          side,
          this.inv,
          book,
          tsUnix,
          this.marketEnd,
        );
        if (f) {
          if (f.isMaker) {
            const hasLive = this.pending.some((q) => q.side === f.side);
            if (!hasLive) {
              this.pending.push({
                side: f.side,
                price: f.price,
                shares: f.shares,
                lifeEnd: tsUnix + this.makerLifeSec,
                btcAtPost: btcNow ?? 0,
              });
              out.push({
                kind: "quote",
                side: f.side,
                price: f.price,
                shares: f.shares,
              });
            }
          } else if (this.liveMode) {
            out.push({
              kind: "taker",
              side: f.side,
              price: f.price,
              shares: f.shares,
            });
          } else {
            const fee = this.fee(f.shares, f.price, false);
            this.inv.execute(f);
            this.strat.recordFill(this.inv);
            out.push({
              kind: "fill",
              side: f.side,
              price: f.price,
              shares: f.shares,
              isMaker: false,
              fee,
            });
          }
        }
      }
    }

    return out;
  }

  /** Authoritative fill from CLOB user channel (live mode). */
  confirmExchangeFill(fill: Fill): MakerEvent {
    this.pending = this.pending.filter((q) => q.side !== fill.side);
    this.inv.execute(fill);
    this.strat.recordFill(this.inv);
    return {
      kind: "fill",
      side: fill.side,
      price: fill.price,
      shares: fill.shares,
      isMaker: fill.isMaker,
      fee: this.fee(fill.shares, fill.price, fill.isMaker),
    };
  }

  /** Replace current-market inventory from an authenticated complete trade snapshot. */
  replaceCurrentMarketFills(fills: Fill[]): void {
    const start = this.marketStart;
    const end = this.marketEnd;
    this.reset(start, end);
    for (const fill of [...fills].sort((a, b) => a.tsUnix - b.tsUnix)) {
      this.confirmExchangeFill(fill);
    }
  }

  onOrderCancelled(side?: Side): void {
    if (side != null) {
      this.pending = this.pending.filter((q) => q.side !== side);
    } else {
      this.pending = [];
    }
  }

  /** Snapshot of quotes still represented in the local strategy state. */
  pendingQuotes(): PendingQuote[] {
    return this.pending.map(({ side, price, shares }) => ({ side, price, shares }));
  }

  resizePendingQuote(side: Side, shares: number, price?: number): void {
    if (!Number.isFinite(shares) || shares <= 0) {
      this.onOrderCancelled(side);
      return;
    }
    for (const quote of this.pending) {
      if (quote.side === side) {
        quote.shares = shares;
        if (price != null && Number.isFinite(price) && price > 0 && price < 1) {
          quote.price = price;
        }
      }
    }
  }

  resolve(winner: Side): [number, number, number, number, number, number] {
    const payout = this.inv.payoutIfWinner(winner);
    const cost = this.inv.totalCost();
    const fees = this.inv.fills.reduce(
      (s: number, f: Fill) => s + this.fee(f.shares, f.price, f.isMaker),
      0,
    );
    return [
      payout - cost - fees,
      fees,
      this.inv.up.shares,
      this.inv.down.shares,
      cost,
      this.inv.fills.length,
    ];
  }

  pairCost(): number {
    return this.inv.pairCost();
  }

  fills(): number {
    return this.inv.fills.length;
  }
}
