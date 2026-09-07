import { passiveBudgetClone, targetClone } from "../config.js";
import { MakerSession, type MakerEvent } from "../live-maker.js";
import { Side, type Fill } from "../models.js";
export interface EngineConfig {
  passiveBudget?: boolean;
  pairCostMax?: number;
  makerLifeSec?: number;
  decisionIntervalMs?: number;
  defensiveCancelBps?: number;
  liveMode?: boolean;
}

export interface ResolveResult {
  winner: Side;
  pnl: number;
  fees: number;
  upShares: number;
  downShares: number;
  cost: number;
  fills: number;
  pairCost: number;
  matchedPairOver1: boolean;
  dailyHalted: boolean;
}

/** In-process engine wrapper around MakerSession. */
export class Engine {
  session: MakerSession;
  preset: string;
  private lastBookTs = Number.NEGATIVE_INFINITY;

  constructor(c: EngineConfig = {}) {
    const cfg = c.passiveBudget ? passiveBudgetClone() : targetClone();
    if (c.pairCostMax != null) {
      cfg.pairCostMax = c.pairCostMax;
      cfg.pairAddCostMax = c.pairCostMax;
    }
    const preset = c.passiveBudget ? "passive_budget_clone" : "target_clone";
    this.session = new MakerSession(
      cfg,
      c.makerLifeSec ?? 15,
      (c.decisionIntervalMs ?? 0) / 1000,
      c.defensiveCancelBps ?? 0,
      c.liveMode ?? false,
    );
    this.preset = preset;
  }

  reset(start: number, end: number): void {
    this.session.reset(start, end);
    this.lastBookTs = Number.NEGATIVE_INFINITY;
  }

  onBtc(ts: number, price: number): void {
    if (Number.isFinite(price) && price > 0) {
      this.session.onBtc(ts, price);
    }
  }

  onBook(
    ts: number,
    upBid?: number,
    upAsk?: number,
    downBid?: number,
    downAsk?: number,
  ) {
    if (!Number.isFinite(ts) || ts + 1e-9 < this.lastBookTs) return [];
    if (!bookOk(upBid, upAsk, downBid, downAsk)) return [];
    this.lastBookTs = ts;
    return this.session.onBook(ts, upBid, upAsk, downBid, downAsk);
  }

  resolve(winner: Side): ResolveResult {
    const [pnl, fees, up, dn, cost, n] = this.session.resolve(winner);
    const pairCost = this.session.pairCost();
    this.session.onMarketEnd(pnl);
    return {
      winner,
      pnl,
      fees,
      upShares: up,
      downShares: dn,
      cost,
      fills: n,
      pairCost,
      matchedPairOver1: up > 0 && dn > 0 && pairCost > 1,
      dailyHalted: this.session.dailyHalted(),
    };
  }

  pairCost(): number {
    return this.session.pairCost();
  }

  fills(): number {
    return this.session.fills();
  }

  confirmExchangeFill(fill: Fill): MakerEvent {
    return this.session.confirmExchangeFill(fill);
  }

  replaceCurrentMarketFills(fills: Fill[]): void {
    this.session.replaceCurrentMarketFills(fills);
    this.lastBookTs = Number.NEGATIVE_INFINITY;
  }

  onOrderCancelled(side?: Side): void {
    this.session.onOrderCancelled(side);
  }

  resizePendingQuote(side: Side, shares: number, price?: number): void {
    this.session.resizePendingQuote(side, shares, price);
  }
}

export function bookOk(
  ub?: number,
  ua?: number,
  db?: number,
  da?: number,
): boolean {
  const fin = (x?: number) => x == null || (Number.isFinite(x) && x > 0 && x < 1);
  if (!fin(ub) || !fin(ua) || !fin(db) || !fin(da)) return false;
  if (ub != null && ua != null && ub >= ua) return false;
  if (db != null && da != null && db >= da) return false;
  if (ua != null && da != null) {
    const sum = ua + da;
    if (sum < 0.8 || sum > 1.2) return false;
  }
  return true;
}
