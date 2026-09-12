import { passiveBudgetClone, targetClone } from "../config.js";
import { MakerSession, type MakerEvent } from "../live-maker.js";
import { Side, type Fill } from "../models.js";
import type { RiskExposure, RiskStore } from "../risk-store.js";
import {
  MakerMicrostructureGate,
  type EngineBookMicrostructure,
} from "./microstructure.js";
export interface EngineConfig {
  passiveBudget?: boolean;
  pairCostMax?: number;
  makerLifeSec?: number;
  decisionIntervalMs?: number;
  defensiveCancelBps?: number;
  liveMode?: boolean;
  minMakerFillProbability?: number;
  fullMakerSizeProbability?: number;
  makerQueueConservatism?: number;
  minimumMakerShares?: number;
  tradeRateWindowSec?: number;
  /** Realized daily-loss gate; account-equity accounting is a separate requirement. */
  dailyLossLimitUsd?: number;
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
  private microstructure: MakerMicrostructureGate;
  private settled = false;

  constructor(c: EngineConfig = {}, private readonly riskStore?: RiskStore) {
    const cfg = c.passiveBudget ? passiveBudgetClone() : targetClone();
    if (c.dailyLossLimitUsd != null) {
      if (!Number.isFinite(c.dailyLossLimitUsd) || c.dailyLossLimitUsd <= 0) {
        throw new Error("daily loss limit must be positive and finite");
      }
      cfg.dailyHardLossUsd = c.dailyLossLimitUsd;
      cfg.maxDailyLossUsd = c.dailyLossLimitUsd;
    }
    if (c.pairCostMax != null) {
      cfg.pairCostMax = c.pairCostMax;
      cfg.pairAddCostMax = c.pairCostMax;
    }
    const preset = c.passiveBudget ? "passive_budget_clone" : "target_clone";
    const makerLifeSec = c.makerLifeSec ?? 15;
    const liveMode = c.liveMode ?? false;
    const risk = riskStore?.restore();
    if (risk) {
      risk.advanceRiskDay(Date.now() / 1000);
      const allowed = risk.canTrade(cfg);
      riskStore!.checkpoint(risk);
      if (!allowed) throw new Error("persisted risk halt prevents a new run");
      riskStore!.begin(risk);
    }
    this.session = new MakerSession(
      cfg,
      makerLifeSec,
      (c.decisionIntervalMs ?? 0) / 1000,
      c.defensiveCancelBps ?? 0,
      liveMode,
      risk,
    );
    const minimumProbability = clamp01(
      c.minMakerFillProbability ?? (liveMode ? 0.05 : 0),
    );
    this.microstructure = new MakerMicrostructureGate({
      minimumProbability,
      fullSizeProbability: Math.max(
        minimumProbability,
        clamp01(c.fullMakerSizeProbability ?? 0.5),
      ),
      queueConservatism: Math.max(1, c.makerQueueConservatism ?? 1.5),
      minimumShares: Math.max(1, c.minimumMakerShares ?? 5),
      tradeRateWindowSec: Math.max(1, c.tradeRateWindowSec ?? 10),
      expectedRestingSeconds: Math.max(0.1, makerLifeSec),
    });
    this.preset = preset;
  }

  reset(start: number, end: number): void {
    const exposure = this.session.exposure();
    if (this.riskStore && (exposure.pendingOrders > 0 || (!this.settled &&
      (exposure.upShares > 0 || exposure.downShares > 0 || exposure.cost > 0)))) {
      this.requireReconciliation("market rollover has unsettled exposure");
      throw new Error("cannot reset unreconciled market exposure");
    }
    this.session.reset(start, end);
    this.settled = false;
    this.lastBookTs = Number.NEGATIVE_INFINITY;
    this.microstructure.reset();
    this.checkpoint();
  }

  onBtc(ts: number, price: number): void {
    if (Number.isFinite(price) && price > 0) {
      this.session.onBtc(ts, price);
    }
  }

  onMarketTrade(side: Side, takerSide: string, shares: number, tsUnix: number): void {
    this.microstructure.recordTrade(side, takerSide, shares, tsUnix);
  }

  onBook(
    ts: number,
    upBid?: number,
    upAsk?: number,
    downBid?: number,
    downAsk?: number,
    microstructure: EngineBookMicrostructure = {},
  ): MakerEvent[] {
    if (!Number.isFinite(ts) || ts + 1e-9 < this.lastBookTs) return [];
    if (!bookOk(upBid, upAsk, downBid, downAsk)) return [];
    this.lastBookTs = ts;
    const books = this.microstructure.books(
      ts,
      upBid,
      upAsk,
      downBid,
      downAsk,
      microstructure,
    );
    const events = this.session.onBook(ts, upBid, upAsk, downBid, downAsk, {
      upTickSize: books.up.tickSize,
      downTickSize: books.down.tickSize,
    });
    const filtered = this.microstructure.filterQuotes(
      events,
      books,
      (side) => this.session.onOrderCancelled(side),
      (side, shares, price) => this.session.resizePendingQuote(side, shares, price),
    );
    const result = [
      ...filtered,
      ...this.microstructure.filterPending(
        this.session.pendingQuotes(false),
        books,
        (side) => this.session.requestOrderCancellation(side),
      ),
    ];
    this.checkpoint();
    return result;
  }

  resolve(winner: Side): ResolveResult {
    const [pnl, fees, up, dn, cost, n] = this.session.resolve(winner);
    const pairCost = this.session.pairCost();
    this.session.onMarketEnd(pnl);
    this.settled = true;
    this.checkpoint();
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

  confirmExchangeFill(fill: Fill, pendingFillShares = fill.shares): MakerEvent {
    const event = this.session.confirmExchangeFill(fill, pendingFillShares);
    this.settled = false;
    this.checkpoint();
    return event;
  }

  replaceCurrentMarketFills(fills: Fill[]): void {
    this.session.replaceCurrentMarketFills(fills);
    this.lastBookTs = Number.NEGATIVE_INFINITY;
    this.settled = false;
    this.checkpoint();
  }

  onOrderCancelled(side?: Side): void {
    this.session.onOrderCancelled(side);
    this.checkpoint();
  }

  resizePendingQuote(side: Side, shares: number, price?: number): void {
    this.session.resizePendingQuote(side, shares, price);
    this.checkpoint();
  }

  private riskExposure(): RiskExposure {
    const exposure = this.session.exposure();
    return { marketStart: this.session.marketStart, marketEnd: this.session.marketEnd,
      upShares: exposure.upShares, downShares: exposure.downShares, cost: exposure.cost,
      fees: exposure.fees, pendingOrders: exposure.pendingOrders, settled: this.settled };
  }

  checkpoint(): void {
    try {
      this.riskStore?.checkpoint(this.session.strat.risk, this.riskExposure());
    } catch (error) {
      this.session.haltNew = true;
      throw error;
    }
  }

  prepareSubmission(): void {
    try {
      this.riskStore?.verifyBeforeSubmission();
      if (this.session.haltNew || !this.session.strat.risk.canTrade(this.session.strat.config)) {
        this.checkpoint();
        throw new Error("risk stop prevents new order submission");
      }
      this.checkpoint();
    } catch (error) {
      this.session.haltNew = true;
      throw error;
    }
  }

  requireReconciliation(reason: string): void {
    this.session.haltNew = true;
    this.riskStore?.requireReconciliation(reason);
  }

  finishRiskRun(): void {
    this.riskStore?.finish(this.session.strat.risk, this.riskExposure());
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
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
