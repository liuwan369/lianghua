/** Dual-side pair-cost market maker configuration. */
export interface StrategyConfig {
  clipShares: number;
  fillIntervalSec: number;
  burstIntervalSec: number;
  startDelaySec: number;
  stopBeforeEndSec: number;

  pairCostMax: number;
  pairCostTarget: number;
  secondLegPairCostMax: number;
  rebalancePairCostMax: number;

  maxTotalCost: number;
  maxFillsPerMarket: number;
  maxSharesPerSide: number;
  maxMarketLossUsd: number;
  maxSessionLossUsd: number;
  pairCostHardStop: number;
  pairCostEmergencyStop: number;
  repairOnlyAbovePairCost: number;
  reduceClipAbovePairCost: number;
  elevatedPairCostClipFactor: number;
  maxUnhedgedSecs: number;
  maxDailyLossUsd: number;
  dailySoftLossUsd: number;
  dailyHardLossUsd: number;
  marketSoftLossUsd: number;
  maxConsecutiveLosses: number;
  resolutionRepairWindowSec: number;
  resolutionPairCostTarget: number;
  maxFillsWhilePairCostHot: number;
  maxImbalanceRatio: number;
  consecutiveLossClipDecay: number;
  minClipFactor: number;

  makerFillRatio: number;

  btcChaseBias: number;
  btcChangeThresholdPct: number;
  cheapMidThreshold: number;
  deepCheapThreshold: number;
  expensiveHedgeThreshold: number;

  lateWindowSec: number;
  latePairCostOnly: boolean;

  instantArbSumMax: number;
  pyramidOnMomentum: boolean;
  preferAlternate: boolean;
  alternateWeight: number;

  dualSideTargetSec: number;
  blockWorseningPairCost: boolean;
  lotteryPriceThreshold: number;
  btcHighVolThresholdPct: number;

  backtestAlwaysTaker: boolean;

  takerFeeRate: number;
  makerFeeRate: number;
  feeExponent: number;
  feeAware: boolean;

  stableMode: boolean;
  targetImbalance: number;
  hardImbalance: number;
  pairAddCostMax: number;
  forceFlattenSec: number;
  cheapLegPrice: number;
  hedgePairCostCeiling: number;
  holdLockPairCost: number;
  holdLockMinShares: number;
  edgeScaledSizing: boolean;
  edgeRefCost: number;
  edgeFullCost: number;
  edgeMaxClipMult: number;

  passiveBudgetMode: boolean;
  passivePairCeiling: number;
  passiveMinLegPrice: number;
  passiveForcedHedgeCeiling: number;
  passiveNakedLegMaxUsd: number;
  passiveHedgeAggr: number;

  leadHighProbOpen: boolean;
  fairValueGate: boolean;
  fairSigmaPctPerSqrtSec: number;
  fairGateTolerance: number;

  activeCross: boolean;
  activeCrossMaxSpread: number;

  closeToParity: boolean;
  makerSpreadFrac: number;
  dynamicHedgeSizing: boolean;
}

/** Canonical locked preset id (31d backtest: +$8,315.61 net, 0/31 losing UTC days). */
export const LOCKED_CONFIG_ID = "stable_live_v2_fill1s_20260531";

function merge(base: StrategyConfig, patch: Partial<StrategyConfig>): StrategyConfig {
  return { ...base, ...patch };
}

function researchBaselineFields(): StrategyConfig {
  return {
    clipShares: 20.0,
    fillIntervalSec: 10,
    burstIntervalSec: 3,
    startDelaySec: 6,
    stopBeforeEndSec: 60,

    pairCostMax: 0.99,
    pairCostTarget: 0.97,
    secondLegPairCostMax: 0.995,
    rebalancePairCostMax: 1.02,

    maxTotalCost: 360.0,
    maxFillsPerMarket: 35,
    maxSharesPerSide: 400.0,
    maxMarketLossUsd: 23.0,
    maxSessionLossUsd: 0.0,
    pairCostHardStop: 1.0,
    pairCostEmergencyStop: 1.02,
    repairOnlyAbovePairCost: 0.98,
    reduceClipAbovePairCost: 0.95,
    elevatedPairCostClipFactor: 0.5,
    maxUnhedgedSecs: 45,
    maxDailyLossUsd: 0.0,
    dailySoftLossUsd: 0.0,
    dailyHardLossUsd: 0.0,
    marketSoftLossUsd: 0.0,
    maxConsecutiveLosses: 0,
    resolutionRepairWindowSec: 90,
    resolutionPairCostTarget: 0.98,
    maxFillsWhilePairCostHot: 12,
    maxImbalanceRatio: 0.38,
    consecutiveLossClipDecay: 0.0,
    minClipFactor: 0.5,

    makerFillRatio: 0.57,

    btcChaseBias: 0.56,
    btcChangeThresholdPct: 0.003,
    cheapMidThreshold: 0.48,
    deepCheapThreshold: 0.35,
    expensiveHedgeThreshold: 0.70,

    lateWindowSec: 90,
    latePairCostOnly: true,

    instantArbSumMax: 0.995,
    pyramidOnMomentum: true,
    preferAlternate: true,
    alternateWeight: 0.85,

    dualSideTargetSec: 30,
    blockWorseningPairCost: true,
    lotteryPriceThreshold: 0.25,
    btcHighVolThresholdPct: 0.03,

    backtestAlwaysTaker: false,

    takerFeeRate: 0.07,
    makerFeeRate: 0.0,
    feeExponent: 1.0,
    feeAware: false,

    stableMode: false,
    targetImbalance: 0.08,
    hardImbalance: 0.15,
    pairAddCostMax: 0.99,
    forceFlattenSec: 75,
    cheapLegPrice: 0.55,
    hedgePairCostCeiling: 1.0,
    holdLockPairCost: 0.97,
    holdLockMinShares: 80.0,
    edgeScaledSizing: false,
    edgeRefCost: 0.99,
    edgeFullCost: 0.93,
    edgeMaxClipMult: 3.0,

    passiveBudgetMode: false,
    passivePairCeiling: 0.98,
    passiveMinLegPrice: 0.05,
    passiveForcedHedgeCeiling: 1.0,
    passiveNakedLegMaxUsd: 10.0,
    passiveHedgeAggr: 1.0,

    leadHighProbOpen: false,
    fairValueGate: false,
    fairSigmaPctPerSqrtSec: 3.0e-5,
    fairGateTolerance: 0.03,

    activeCross: false,
    activeCrossMaxSpread: 0.0,
    closeToParity: false,
    makerSpreadFrac: 0.15,
    dynamicHedgeSizing: true,
  };
}

/** Non-production baseline for optimizer seeds only — not live/backtest default. */
export function researchBaseline(): StrategyConfig {
  return researchBaselineFields();
}

export function targetTrader(): StrategyConfig {
  return merge(researchBaselineFields(), {
    stopBeforeEndSec: 58,
    pairCostEmergencyStop: 1.03,
    reduceClipAbovePairCost: 0.96,
    maxUnhedgedSecs: 50,
    maxFillsWhilePairCostHot: 15,
    maxImbalanceRatio: 0.4,
    alternateWeight: 0.71,
  });
}

export function stable(): StrategyConfig {
  return merge(targetTrader(), {
    stableMode: true,
    takerFeeRate: 0.07,
    makerFeeRate: 0.0,
    feeExponent: 1.0,
    feeAware: true,
    clipShares: 25.0,
    fillIntervalSec: 1,
    burstIntervalSec: 1,
    startDelaySec: 4,
    stopBeforeEndSec: 10,
    forceFlattenSec: 75,
    targetImbalance: 0.062,
    hardImbalance: 0.11,
    maxImbalanceRatio: 0.11,
    pairAddCostMax: 0.985,
    secondLegPairCostMax: 1.02,
    pairCostHardStop: 1.0,
    pairCostEmergencyStop: 1.05,
    rebalancePairCostMax: 1.05,
    cheapLegPrice: 0.6,
    hedgePairCostCeiling: 0.995,
    holdLockPairCost: 0.94,
    holdLockMinShares: 360.0,
    maxUnhedgedSecs: 30,
    edgeScaledSizing: true,
    edgeRefCost: 0.99,
    edgeFullCost: 0.94,
    edgeMaxClipMult: 3.5,
    maxTotalCost: 360.0,
    maxFillsPerMarket: 60,
    maxSharesPerSide: 460.0,
    maxMarketLossUsd: 12.0,
    marketSoftLossUsd: 8.0,
    dailySoftLossUsd: 35.0,
    dailyHardLossUsd: 80.0,
    maxDailyLossUsd: 0.0,
    consecutiveLossClipDecay: 0.0,
    pyramidOnMomentum: false,
    btcChaseBias: 0.0,
    preferAlternate: false,
    latePairCostOnly: true,
  });
}

export function targetClone(): StrategyConfig {
  return merge(stable(), {
    clipShares: 20.0,
    edgeScaledSizing: false,
    edgeMaxClipMult: 1.0,
    pairAddCostMax: 0.98,
    hedgePairCostCeiling: 0.99,
    targetImbalance: 0.02,
    hardImbalance: 0.04,
    maxImbalanceRatio: 0.04,
    cheapLegPrice: 0.95,
  });
}

export function targetCloneV2(): StrategyConfig {
  return merge(targetClone(), {
    leadHighProbOpen: true,
    fairValueGate: true,
    fairSigmaPctPerSqrtSec: 3.0e-5,
    fairGateTolerance: 0.03,
  });
}

export function targetCloneActive(): StrategyConfig {
  return merge(targetCloneV2(), {
    activeCross: true,
    activeCrossMaxSpread: 0.012,
    takerFeeRate: 0.0,
    pairAddCostMax: 0.997,
    hedgePairCostCeiling: 0.998,
    fairValueGate: false,
    forceFlattenSec: 45,
    targetImbalance: 0.02,
    hardImbalance: 0.04,
    maxImbalanceRatio: 0.04,
    closeToParity: true,
    makerSpreadFrac: 0.15,
  });
}

export function passiveBudgetClone(): StrategyConfig {
  return merge(targetClone(), {
    passiveBudgetMode: true,
    passivePairCeiling: 0.98,
    passiveMinLegPrice: 0.05,
    passiveForcedHedgeCeiling: 1.0,
    passiveNakedLegMaxUsd: 8.0,
    maxMarketLossUsd: 10.0,
    marketSoftLossUsd: 7.0,
    dailySoftLossUsd: 30.0,
    dailyHardLossUsd: 70.0,
  });
}

/** Live / paper / dashboard / backtest entry point — identical to stable(). LOCKED. */
export function stableLive(): StrategyConfig {
  return stable();
}

export function assertOneSecondDecisionPacing(cfg: StrategyConfig): void {
  if (cfg.fillIntervalSec !== 1) {
    throw new Error(
      `fillIntervalSec must be 1 for live paper = postgres 1s backtest (got ${cfg.fillIntervalSec})`,
    );
  }
  if (cfg.burstIntervalSec !== 1) {
    throw new Error(
      `burstIntervalSec must be 1 when fillIntervalSec is 1 (got ${cfg.burstIntervalSec})`,
    );
  }
}

function checkF64(out: string[], name: string, a: number, b: number): void {
  if (Math.abs(a - b) > 1e-9) out.push(`${name}: got ${a} want ${b}`);
}

function lockedProductionFieldMismatches(got: StrategyConfig, want: StrategyConfig): string[] {
  const out: string[] = [];
  if (got.stableMode !== want.stableMode) {
    out.push(`stableMode: got ${got.stableMode} want ${want.stableMode}`);
  }
  checkF64(out, "clipShares", got.clipShares, want.clipShares);
  checkF64(out, "targetImbalance", got.targetImbalance, want.targetImbalance);
  checkF64(out, "hardImbalance", got.hardImbalance, want.hardImbalance);
  checkF64(out, "maxImbalanceRatio", got.maxImbalanceRatio, want.maxImbalanceRatio);
  checkF64(out, "pairAddCostMax", got.pairAddCostMax, want.pairAddCostMax);
  checkF64(out, "hedgePairCostCeiling", got.hedgePairCostCeiling, want.hedgePairCostCeiling);
  checkF64(out, "cheapLegPrice", got.cheapLegPrice, want.cheapLegPrice);
  checkF64(out, "maxTotalCost", got.maxTotalCost, want.maxTotalCost);
  checkF64(out, "maxMarketLossUsd", got.maxMarketLossUsd, want.maxMarketLossUsd);
  if (got.feeAware !== want.feeAware) {
    out.push(`feeAware: got ${got.feeAware} want ${want.feeAware}`);
  }
  if (got.edgeScaledSizing !== want.edgeScaledSizing) {
    out.push(`edgeScaledSizing: got ${got.edgeScaledSizing} want ${want.edgeScaledSizing}`);
  }
  if (got.fillIntervalSec !== want.fillIntervalSec) {
    out.push(`fillIntervalSec: got ${got.fillIntervalSec} want ${want.fillIntervalSec}`);
  }
  if (got.passiveBudgetMode !== want.passiveBudgetMode) {
    out.push(`passiveBudgetMode: got ${got.passiveBudgetMode} want ${want.passiveBudgetMode}`);
  }
  return out;
}

export function assertLockedProduction(cfg: StrategyConfig): void {
  const locked = stableLive();
  const mismatches = lockedProductionFieldMismatches(cfg, locked);
  if (mismatches.length > 0) {
    throw new Error(
      `StrategyConfig is not locked production preset (${LOCKED_CONFIG_ID}): ${mismatches.join(", ")}`,
    );
  }
  assertOneSecondDecisionPacing(cfg);
}

export function isLockedProduction(cfg: StrategyConfig): boolean {
  return lockedProductionFieldMismatches(cfg, stableLive()).length === 0;
}

export default stableLive;
