import type { StrategyConfig } from "./config.js";
import type { Inventory } from "./inventory.js";
import { bookMid, type MarketBooks, Side } from "./models.js";

export enum DailyMode {
  Normal = "Normal",
  Cautious = "Cautious",
  Halted = "Halted",
}

export enum MarketMode {
  Normal = "Normal",
  Cautious = "Cautious",
  Halted = "Halted",
}

export class RiskState {
  sessionPnl = 0.0;
  sessionHalted = false;
  dailyDate = "";
  dailyPnl = 0.0;
  dailyMode = DailyMode.Normal;
  marketMode = MarketMode.Normal;
  singleSideSince?: number;
  consecutiveMarketLosses = 0;
  marketFillsWhileHot = 0;
  marketPeakPairCost = 0.0;

  onMarketStart(marketStartUnix: number, _cfg: StrategyConfig): void {
    this.marketMode = MarketMode.Normal;
    this.singleSideSince = undefined;
    this.marketFillsWhileHot = 0;
    this.marketPeakPairCost = 0.0;

    const day = utcDayKey(marketStartUnix);
    if (this.dailyDate !== day) {
      this.dailyDate = day;
      this.dailyPnl = 0.0;
      this.dailyMode = DailyMode.Normal;
    }

    if (this.dailyMode === DailyMode.Halted) return;
    if (this.dailyMode === DailyMode.Cautious) {
      this.marketMode = MarketMode.Cautious;
    }
  }

  onMarketEnd(pnl: number, marketStartUnix: number, cfg: StrategyConfig): void {
    this.sessionPnl += pnl;
    if (cfg.maxSessionLossUsd > 0.0 && this.sessionPnl <= -cfg.maxSessionLossUsd) {
      this.sessionHalted = true;
    }

    const day = utcDayKey(marketStartUnix);
    if (this.dailyDate !== day) {
      this.dailyDate = day;
      this.dailyPnl = 0.0;
      this.dailyMode = DailyMode.Normal;
    }
    this.dailyPnl += pnl;
    this.updateDailyMode(cfg);

    if (pnl < 0.0) this.consecutiveMarketLosses += 1;
    else this.consecutiveMarketLosses = 0;
  }

  private updateDailyMode(cfg: StrategyConfig): void {
    const hard = cfg.dailyHardLossUsd > 0.0 ? cfg.dailyHardLossUsd : cfg.maxDailyLossUsd;
    if (hard > 0.0 && this.dailyPnl <= -hard) {
      this.dailyMode = DailyMode.Halted;
      return;
    }
    if (cfg.dailySoftLossUsd > 0.0 && this.dailyPnl <= -cfg.dailySoftLossUsd) {
      this.dailyMode = DailyMode.Cautious;
    } else if (
      cfg.dailySoftLossUsd > 0.0 &&
      this.dailyMode === DailyMode.Cautious &&
      this.dailyPnl > -cfg.dailySoftLossUsd
    ) {
      this.dailyMode = DailyMode.Normal;
    }
  }

  onFill(inv: Inventory, cfg: StrategyConfig): void {
    const pc = inv.pairCost();
    if (inv.bothSidesOpened && pc >= cfg.repairOnlyAbovePairCost) {
      this.marketFillsWhileHot += 1;
    }
    if (pc > this.marketPeakPairCost) this.marketPeakPairCost = pc;

    if (inv.bothSidesOpened && cfg.marketSoftLossUsd > 0.0) {
      if (worstCaseLossUsd(inv) >= cfg.marketSoftLossUsd) {
        this.marketMode = MarketMode.Cautious;
      }
    }
  }

  canTrade(cfg: StrategyConfig): boolean {
    if (this.sessionHalted || this.dailyMode === DailyMode.Halted) return false;
    if (this.marketMode === MarketMode.Halted) return false;
    if (cfg.maxConsecutiveLosses > 0 && this.consecutiveMarketLosses >= cfg.maxConsecutiveLosses) {
      return false;
    }
    return true;
  }

  lossStreakClipFactor(cfg: StrategyConfig): number {
    if (cfg.consecutiveLossClipDecay <= 0.0 || this.consecutiveMarketLosses === 0) return 1.0;
    const factor = 1.0 - cfg.consecutiveLossClipDecay * this.consecutiveMarketLosses;
    return Math.min(Math.max(factor, cfg.minClipFactor), 1.0);
  }

  isCautious(): boolean {
    return this.dailyMode === DailyMode.Cautious || this.marketMode === MarketMode.Cautious;
  }
}

function utcDayKey(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

export function worstCaseLossUsd(inv: Inventory): number {
  const cost = inv.totalCost();
  if (cost <= 0.0) return 0.0;
  const pnlIfUp = inv.up.shares - cost;
  const pnlIfDown = inv.down.shares - cost;
  return Math.max(-Math.min(pnlIfUp, pnlIfDown), 0.0);
}

export function isRepairFill(inv: Inventory, projectedPairCost: number): boolean {
  if (!inv.bothSidesOpened) return false;
  const current = inv.pairCost();
  return current > 0.0 && projectedPairCost < current - 0.001;
}

export function bestRepairSide(inv: Inventory, books: MarketBooks, clip: number): Side | undefined {
  if (!inv.bothSidesOpened) return undefined;
  const current = inv.pairCost();
  let best: [Side, number] | undefined;
  for (const [side, q] of [
    [Side.Up, books.up] as const,
    [Side.Down, books.down] as const,
  ]) {
    const ask = q.ask;
    if (ask == null || ask <= 0.0 || ask >= 1.0) continue;
    const proj = inv.projectedPairCostIfBuy(side, clip, ask);
    if (proj < current - 0.001) {
      if (best == null || proj < best[1]) best = [side, proj];
    }
  }
  return best?.[0];
}

export function repairSide(inv: Inventory): Side | undefined {
  if (!inv.bothSidesOpened) return undefined;
  return inv.up.avgPrice() > inv.down.avgPrice() ? Side.Down : Side.Up;
}

export function heavySideBlocked(inv: Inventory, side: Side, cfg: StrategyConfig): boolean {
  if (!inv.bothSidesOpened) return false;
  const imb = inv.netImbalanceRatio();
  const maxImb = cfg.maxImbalanceRatio > 0.0 ? cfg.maxImbalanceRatio : 0.38;
  if (imb < maxImb) return false;
  const heavy = inv.up.shares > inv.down.shares ? Side.Up : Side.Down;
  return side === heavy;
}

export interface EffectiveRiskLimits {
  pairCostHardStop: number;
  repairOnlyAbove: number;
  pairCostMax: number;
  rebalanceMax: number;
}

export function effectiveLimits(cfg: StrategyConfig, state: RiskState): EffectiveRiskLimits {
  if (state.isCautious()) {
    return {
      pairCostHardStop: Math.min(cfg.pairCostHardStop, 0.98),
      repairOnlyAbove: Math.min(cfg.repairOnlyAbovePairCost, 0.96),
      pairCostMax: Math.min(cfg.pairCostMax, 0.97),
      rebalanceMax: Math.min(cfg.rebalancePairCostMax, 0.99),
    };
  }
  return {
    pairCostHardStop: cfg.pairCostHardStop,
    repairOnlyAbove: cfg.repairOnlyAbovePairCost,
    pairCostMax: cfg.pairCostMax,
    rebalanceMax: cfg.rebalancePairCostMax,
  };
}

export interface RiskDecision {
  allow: boolean;
  haltMarket: boolean;
  repairOnly: boolean;
  resolutionRepairOnly: boolean;
  clipMultiplier: number;
}

export function evaluateRisk(
  inv: Inventory,
  state: RiskState,
  cfg: StrategyConfig,
  tsUnix: number,
  marketEnd: number,
  projectedPairCost?: number,
): RiskDecision {
  const limits = effectiveLimits(cfg, state);
  let clipMultiplier = state.lossStreakClipFactor(cfg);
  if (state.isCautious()) clipMultiplier *= 0.6;

  if (!state.canTrade(cfg)) {
    return {
      allow: false,
      haltMarket: true,
      repairOnly: false,
      resolutionRepairOnly: false,
      clipMultiplier: 0.0,
    };
  }

  const secsLeft = marketEnd - tsUnix;
  const resolutionRepairOnly =
    secsLeft <= cfg.resolutionRepairWindowSec &&
    inv.bothSidesOpened &&
    inv.pairCost() > cfg.resolutionPairCostTarget;

  if (
    inv.bothSidesOpened &&
    cfg.maxMarketLossUsd > 0.0 &&
    worstCaseLossUsd(inv) >= cfg.maxMarketLossUsd
  ) {
    return {
      allow: false,
      haltMarket: true,
      repairOnly: false,
      resolutionRepairOnly,
      clipMultiplier: 0.0,
    };
  }

  const pc = inv.pairCost();

  if (inv.bothSidesOpened && state.marketFillsWhileHot >= cfg.maxFillsWhilePairCostHot) {
    const repair = projectedPairCost != null && isRepairFill(inv, projectedPairCost);
    if (!repair) {
      return {
        allow: false,
        haltMarket: false,
        repairOnly: true,
        resolutionRepairOnly,
        clipMultiplier: 0.0,
      };
    }
  }

  if (inv.bothSidesOpened && pc >= cfg.pairCostEmergencyStop) {
    const repair = projectedPairCost != null && isRepairFill(inv, projectedPairCost);
    return {
      allow: repair,
      haltMarket: !repair,
      repairOnly: true,
      resolutionRepairOnly,
      clipMultiplier: repair ? clipMultiplier * 0.5 : 0.0,
    };
  }

  if (inv.bothSidesOpened && pc >= limits.pairCostHardStop) {
    const repair = projectedPairCost != null && isRepairFill(inv, projectedPairCost);
    if (!repair) {
      return {
        allow: false,
        haltMarket: false,
        repairOnly: true,
        resolutionRepairOnly,
        clipMultiplier: 0.0,
      };
    }
    clipMultiplier *= 0.5;
  }

  if (inv.bothSidesOpened && pc >= cfg.reduceClipAbovePairCost) {
    clipMultiplier = Math.min(clipMultiplier, cfg.elevatedPairCostClipFactor);
  }

  const oneSide = (inv.up.shares > 0.0) !== (inv.down.shares > 0.0);
  if (oneSide && !cfg.stableMode) {
    if (state.singleSideSince != null) {
      if (tsUnix - state.singleSideSince > cfg.maxUnhedgedSecs) {
        return {
          allow: false,
          haltMarket: true,
          repairOnly: false,
          resolutionRepairOnly,
          clipMultiplier: 0.0,
        };
      }
    }
  }

  if (projectedPairCost != null) {
    if (
      inv.bothSidesOpened &&
      projectedPairCost >= limits.pairCostHardStop &&
      !isRepairFill(inv, projectedPairCost)
    ) {
      return {
        allow: false,
        haltMarket: false,
        repairOnly: true,
        resolutionRepairOnly,
        clipMultiplier: 0.0,
      };
    }
    if (
      state.isCautious() &&
      inv.bothSidesOpened &&
      projectedPairCost > cfg.resolutionPairCostTarget &&
      !isRepairFill(inv, projectedPairCost)
    ) {
      return {
        allow: false,
        haltMarket: false,
        repairOnly: true,
        resolutionRepairOnly,
        clipMultiplier: 0.0,
      };
    }
  }

  const repairOnly =
    state.isCautious() || resolutionRepairOnly || pc >= limits.repairOnlyAbove;

  return {
    allow: true,
    haltMarket: false,
    repairOnly,
    resolutionRepairOnly,
    clipMultiplier,
  };
}

export function trackSingleSide(inv: Inventory, state: RiskState, tsUnix: number): void {
  const oneSide = (inv.up.shares > 0.0) !== (inv.down.shares > 0.0);
  if (oneSide) {
    if (state.singleSideSince == null) state.singleSideSince = tsUnix;
  } else {
    state.singleSideSince = undefined;
  }
}

// re-export bookMid for callers that need mid price in repair logic
export { bookMid };
