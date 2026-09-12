import { Inventory } from "./inventory.js";
import {
  polymarketFillFee,
  Side,
  type Fill,
  type MarketBooks,
  type PendingExposure,
  type MarketTickSizes,
} from "./models.js";
import type { StrategyConfig } from "./config.js";
import { PairCostMarketMaker, type DecisionRejection } from "./strategy.js";
import { MarketMode, type RiskState } from "./risk.js";

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
    const cutoff = Math.max(sec, this.lastSec) - 600;
    for (const timestamp of this.px.keys()) if (timestamp < cutoff) this.px.delete(timestamp);
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
  cancelRequested?: boolean;
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
    riskState?: RiskState,
  ) {
    this.strat = new PairCostMarketMaker(cfg);
    if (riskState) this.strat.risk = riskState;
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
    this.strat.onMarketEnd(pnl, this.marketEnd || this.marketStart);
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
    ticks: MarketTickSizes = {},
  ): MakerEvent[] {
    const book: MarketBooks = {
      tsUnix,
      up: { bid: upBid, ask: upAsk, tickSize: ticks.upTickSize, tsUnix },
      down: { bid: downBid, ask: downAsk, tickSize: ticks.downTickSize, tsUnix },
    };
    const out: MakerEvent[] = [];
    const btcNow = this.btc.price(Math.round(tsUnix));

    const still: RestingQuote[] = [];
    for (const q of this.pending) {
      if (q.cancelRequested) {
        still.push(q);
        continue;
      }
      const cancel = (): void => {
        out.push({ kind: "cancel", side: q.side, price: q.price });
        // A live cancellation request is not an exchange acknowledgement.
        if (this.liveMode) still.push({ ...q, cancelRequested: true });
      };
      if (this.haltNew || tsUnix >= q.lifeEnd ||
        tsUnix >= this.marketEnd - this.strat.config.stopBeforeEndSec) {
        cancel();
        continue;
      }
      if (this.defensiveCancelBps > 0 && btcNow != null && q.btcAtPost > 0) {
        const mvBps = ((btcNow - q.btcAtPost) / q.btcAtPost) * 1e4;
        const adverse =
          q.side === Side.Up
            ? mvBps <= -this.defensiveCancelBps
            : mvBps >= this.defensiveCancelBps;
        if (adverse) {
          cancel();
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

      if (side != null && !this.pending.some((quote) => quote.side === side)) {
        const f = this.strat.buildFill(
          side,
          this.inv,
          book,
          tsUnix,
          this.marketEnd,
          this.pendingExposure(),
        );
        if (f) {
          if (f.isMaker) {
            const hasLive = this.pending.some((q) => q.side === f.side);
            if (!hasLive) {
              this.pending.push({
                side: f.side,
                price: f.price,
                shares: f.shares,
                lifeEnd: Math.min(tsUnix + this.makerLifeSec,
                  this.marketEnd - this.strat.config.stopBeforeEndSec),
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
  confirmExchangeFill(fill: Fill, pendingFillShares: number = fill.shares): MakerEvent {
    this.validateFill(fill);
    if (!Number.isFinite(pendingFillShares) || pendingFillShares < 0 ||
      pendingFillShares > fill.shares + 1e-9) throw new Error("Invalid pending fill quantity");
    this.pending = this.pending.flatMap((quote) => {
      if (quote.side !== fill.side || pendingFillShares === 0) return [quote];
      const shares = Math.max(0, quote.shares - pendingFillShares);
      return shares > 1e-9 ? [{ ...quote, shares }] : [];
    });
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

  lastDecisionRejection(): DecisionRejection | null {
    return this.strat.lastDecisionRejection();
  }

  private validateFill(fill: Fill): void {
    if (![fill.shares, fill.price, fill.tsUnix].every(Number.isFinite) ||
      fill.shares <= 0 || fill.price <= 0 || fill.price >= 1 ||
      (fill.side !== Side.Up && fill.side !== Side.Down)) {
      throw new Error("Invalid exchange fill");
    }
  }

  private pendingExposure(): PendingExposure {
    return this.pending.reduce((exposure, quote) => ({
      cost: exposure.cost + quote.shares * quote.price + this.fee(quote.shares, quote.price, true),
      upShares: exposure.upShares + (quote.side === Side.Up ? quote.shares : 0),
      downShares: exposure.downShares + (quote.side === Side.Down ? quote.shares : 0),
      orders: exposure.orders + 1,
    }), { cost: 0, upShares: 0, downShares: 0, orders: 0 });
  }

  /** Replace current-market inventory from an authenticated complete trade snapshot. */
  replaceCurrentMarketFills(fills: Fill[]): void {
    // A trade snapshot says nothing about remaining exchange orders. Preserve
    // reservations until a separate order reconciliation confirms cancellation.
    fills.forEach((fill) => this.validateFill(fill));
    const halted = this.strat.risk.marketMode === MarketMode.Halted;
    this.inv = new Inventory();
    this.strat.risk.marketFillsWhileHot = 0;
    this.strat.risk.marketPeakPairCost = 0;
    for (const fill of [...fills].sort((a, b) => a.tsUnix - b.tsUnix)) {
      this.confirmExchangeFill(fill, 0);
    }
    if (halted) this.strat.risk.marketMode = MarketMode.Halted;
  }

  onOrderCancelled(side?: Side): void {
    if (side != null) {
      this.pending = this.pending.filter((q) => q.side !== side);
    } else {
      this.pending = [];
    }
  }

  /** Used for an already submitted order; retain its liability until ACK. */
  requestOrderCancellation(side: Side): void {
    if (!this.liveMode) {
      this.onOrderCancelled(side);
      return;
    }
    this.pending = this.pending.map((quote) => quote.side === side
      ? { ...quote, cancelRequested: true } : quote);
  }

  /** Snapshot of quotes still represented in the local strategy state. */
  pendingQuotes(includeCancelling = true): PendingQuote[] {
    return this.pending.filter((quote) => includeCancelling || !quote.cancelRequested)
      .map(({ side, price, shares }) => ({ side, price, shares }));
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

  exposure(): { upShares: number; downShares: number; residualShares: number; residualSide: Side | null; cost: number; fees: number; worstCaseLoss: number; pendingOrders: number } {
    const upShares = this.inv.up.shares;
    const downShares = this.inv.down.shares;
    const fees = this.inv.fills.reduce((sum, fill) => sum + this.fee(fill.shares, fill.price, fill.isMaker), 0);
    return { upShares, downShares, residualShares: Math.abs(upShares - downShares),
      residualSide: upShares === downShares ? null : upShares > downShares ? Side.Up : Side.Down,
      cost: this.inv.totalCost(), fees,
      worstCaseLoss: Math.max(0, this.inv.totalCost() + fees - Math.min(upShares, downShares)),
      pendingOrders: this.pending.length };
  }

  pairCost(): number {
    return this.inv.pairCost();
  }

  fills(): number {
    return this.inv.fills.length;
  }
}
