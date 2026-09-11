import type { StrategyConfig } from "./config.js";
import { Inventory, SideInventory } from "./inventory.js";
import {
  Side,
  bookMid,
  btcProxyChangePct,
  combinedAskSum,
  polymarketFillFee,
  MIN_ORDER_SHARES,
  quantizeMakerBuyPrice,
  type BookQuote,
  type Fill,
  type MarketBooks,
  type PendingExposure,
} from "./models.js";
import {
  MarketMode,
  RiskState,
  bestRepairSide,
  effectiveLimits,
  evaluateRisk,
  heavySideBlocked,
  isRepairFill,
  repairSide,
  trackSingleSide,
} from "./risk.js";
import { fairUpFromChange } from "./live/fair.js";

/** Seeded mulberry32 PRNG (seed 42) replacing Rust StdRng. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DynamicHedgeClipInput {
  thisShares: number;
  thisCost: number;
  otherShares: number;
  otherCost: number;
  price: number;
  baseClip: number;
  targetPairCost: number;
}

export interface DecisionRejection {
  code: "maker_tick_missing_or_invalid" | "maker_price_invalid" | "hedge_pair_cost" |
    "order_limits_or_minimum" | "risk_blocked" | "entry_pair_cost";
  side?: Side;
  price?: number;
  pairCost?: number;
  limit?: number;
}

/**
 * Size a repair order from the live odds and current inventory.
 *
 * The order never makes the light side heavier than the opposite side. When
 * its current average is above the permitted hedge average, calculate the
 * minimum quantity needed to pull it back to the target pair cost. Returning
 * zero means that the current price cannot repair the inventory safely.
 */
export function dynamicHedgeClip(input: DynamicHedgeClipInput): number {
  const {
    thisShares,
    thisCost,
    otherShares,
    otherCost,
    price,
    baseClip,
    targetPairCost,
  } = input;
  if (
    ![thisShares, thisCost, otherShares, otherCost, price, baseClip, targetPairCost].every(Number.isFinite) ||
    otherShares <= thisShares || otherShares <= 0 || price <= 0 || price >= 1 || baseClip <= 0
  ) return 0;

  const deficit = otherShares - thisShares;
  const otherAverage = otherCost / otherShares;
  const allowedAverage = targetPairCost - otherAverage;
  if (allowedAverage <= 0 || allowedAverage >= 1) return 0;
  if (thisShares <= 0) return price <= allowedAverage + 1e-9 ? Math.min(baseClip, deficit) : 0;

  // Even when our current average is below the limit, buying above the
  // permitted average would push the pair cost in the wrong direction.
  if (price > allowedAverage + 1e-9) return 0;

  const currentAverage = thisCost / thisShares;
  if (currentAverage <= allowedAverage + 1e-9) return Math.min(baseClip, deficit);
  if (price >= allowedAverage - 1e-9) return 0;

  const required = (thisCost - allowedAverage * thisShares) / (allowedAverage - price);
  if (!Number.isFinite(required) || required <= 0 || required > deficit + 1e-9) return 0;
  return Math.min(deficit, Math.max(baseClip, required));
}

export class PairCostMarketMaker {
  config: StrategyConfig;
  risk: RiskState;
  private rng: () => number;
  private pendingClipMult = 1.0;
  private pendingUrgent = false;
  private pendingHardImb = 0.12;
  private pendingBudgetPx?: number;
  private rejection: DecisionRejection | null = null;

  lastDecisionRejection(): DecisionRejection | null {
    return this.rejection ? { ...this.rejection } : null;
  }

  private reject(code: DecisionRejection["code"], details: Omit<DecisionRejection, "code"> = {}): undefined {
    this.rejection = { code, ...details };
    return undefined;
  }

  constructor(config: StrategyConfig) {
    this.config = config;
    this.risk = new RiskState();
    this.rng = mulberry32(42);
    this.pendingHardImb = config.hardImbalance;
  }

  private passiveBudgetEntry(books: MarketBooks): [Side, number] | undefined {
    const ceiling = this.config.passivePairCeiling;
    const floor = this.config.passiveMinLegPrice;
    const aggr = Math.min(Math.max(this.config.passiveHedgeAggr, 0.0), 1.0);

    const budget = (
      myBid: number | undefined,
      myTick: number | undefined,
      otherBid: number | undefined,
      otherAsk: number | undefined,
    ): number | undefined => {
      if (otherAsk == null || !(otherAsk > 0.0 && otherAsk < 1.0)) return undefined;
      const ob = otherBid != null && otherBid > 0.0 && otherBid < otherAsk ? otherBid : otherAsk;
      const hedgeCost = ob + aggr * (otherAsk - ob);
      const cap = ceiling - hedgeCost - aggr * this.takerFeePerShare(otherAsk);
      if (myBid == null || !(myBid > 0.0 && myBid < 1.0)) return undefined;
      const px = quantizeMakerBuyPrice(Math.min(cap, myBid), myTick);
      if (px != null && px >= floor) return px;
      return undefined;
    };

    const up = budget(books.up.bid, books.up.tickSize, books.down.bid, books.down.ask);
    const dn = budget(books.down.bid, books.down.tickSize, books.up.bid, books.up.ask);

    if (up != null && dn != null) {
      const ug = (books.up.bid ?? up) - up;
      const dg = (books.down.bid ?? dn) - dn;
      return ug <= dg ? [Side.Up, up] : [Side.Down, dn];
    }
    if (up != null) return [Side.Up, up];
    if (dn != null) return [Side.Down, dn];
    return undefined;
  }

  private edgeClipMult(edgeBasis: number): number {
    if (!this.config.edgeScaledSizing) return 1.0;
    const hi = this.config.edgeRefCost;
    const lo = this.config.edgeFullCost;
    if (hi <= lo) return 1.0;
    const t = Math.min(Math.max((hi - edgeBasis) / (hi - lo), 0.0), 1.0);
    return 1.0 + t * (this.config.edgeMaxClipMult - 1.0);
  }

  private takerFeePerShare(price: number): number {
    return polymarketFillFee(
      1.0,
      price,
      false,
      this.config.takerFeeRate,
      this.config.makerFeeRate,
      this.config.feeExponent,
    );
  }

  private fairUpSignal(
    tsUnix: number,
    marketEnd: number,
    btcChangePct: number | undefined,
  ): number | undefined {
    const secsLeft = marketEnd - tsUnix;
    return fairUpFromChange(btcChangePct, secsLeft, this.config.fairSigmaPctPerSqrtSec);
  }

  private fairPriceOk(side: Side, px: number, fairUp: number | undefined): boolean {
    if (!this.config.fairValueGate) return true;
    if (fairUp == null) return true;
    const fairS = side === Side.Up ? fairUp : 1.0 - fairUp;
    return px <= fairS + this.config.fairGateTolerance + 1e-9;
  }

  private wantCross(
    side: Side,
    inv: Inventory,
    books: MarketBooks,
    clip: number,
    ceiling: number,
  ): boolean {
    if (!this.config.activeCross) return false;
    const q = side === Side.Up ? books.up : books.down;
    const bid = q.bid;
    const ask = q.ask;
    if (bid == null || ask == null || !(ask > bid && ask > 0.0 && ask < 1.0)) return false;
    if (ask - bid > this.config.activeCrossMaxSpread + 1e-9) return false;
    if (inv.up.shares === 0 && inv.down.shares === 0) {
      const hedge = this.stableMakerPrice(side === Side.Up ? books.down : books.up);
      if (hedge == null) return false;
      return ask + this.takerFeePerShare(ask) + hedge + this.fillFee(1, hedge, true) <= ceiling + 1e-9;
    }
    const projT = inv.projectedPairCostIfBuy(side, clip, ask);
    return projT + this.takerFeePerShare(ask) <= ceiling + 1e-9;
  }

  onMarketStart(marketStartUnix: number): void {
    this.rejection = null;
    this.risk.onMarketStart(marketStartUnix, this.config);
    this.pendingClipMult = 1.0;
    this.pendingUrgent = false;
    this.pendingBudgetPx = undefined;
    this.pendingHardImb = this.config.hardImbalance;
  }

  onMarketEnd(pnl: number, marketStartUnix: number): void {
    this.risk.onMarketEnd(pnl, marketStartUnix, this.config);
  }

  recordFill(inv: Inventory): void {
    this.risk.onFill(this.withFees(inv), this.config);
  }

  /** Risk decisions include incurred fees; rebates are never assumed income. */
  private withFees(inv: Inventory): Inventory {
    const accounting = new Inventory();
    Object.assign(accounting, inv);
    accounting.up = Object.assign(new SideInventory(), inv.up);
    accounting.down = Object.assign(new SideInventory(), inv.down);
    for (const fill of inv.fills) {
      const fee = this.fillFee(fill.shares, fill.price, fill.isMaker);
      (fill.side === Side.Up ? accounting.up : accounting.down).cost += fee;
    }
    return accounting;
  }

  private fillFee(shares: number, price: number, isMaker: boolean): number {
    return polymarketFillFee(shares, price, isMaker, this.config.takerFeeRate,
      this.config.makerFeeRate, this.config.feeExponent);
  }

  private boundedClip(inv: Inventory, side: Side, requested: number, unitCost: number,
    pending: PendingExposure): number {
    const thisShares = side === Side.Up ? inv.up.shares : inv.down.shares;
    const otherShares = side === Side.Up ? inv.down.shares : inv.up.shares;
    const reservedShares = side === Side.Up ? pending.upShares : pending.downShares;
    const committed = inv.totalCost() + pending.cost;
    if (![requested, unitCost, committed, thisShares, otherShares, reservedShares,
      pending.orders, this.config.maxTotalCost, this.config.maxSharesPerSide,
      this.config.maxMarketLossUsd, this.config.maxFillsPerMarket].every(Number.isFinite) ||
      requested <= 0 || unitCost <= 0 || pending.cost < 0 || reservedShares < 0 ||
      inv.fills.length + pending.orders >= this.config.maxFillsPerMarket) return 0;
    let clip = Math.min(requested, (this.config.maxTotalCost - committed) / unitCost,
      this.config.maxSharesPerSide - thisShares - reservedShares);
    if (this.config.maxMarketLossUsd > 0) {
      // Pending orders can fill unilaterally: reserve their cost without credit
      // for a complementary payout that has not actually been acquired.
      const deficit = Math.max(0, otherShares - thisShares);
      const currentLoss = committed - Math.min(thisShares, otherShares);
      clip = Math.min(clip, (this.config.maxMarketLossUsd - currentLoss + deficit) / unitCost);
      const projectedLoss = currentLoss + clip * unitCost - Math.min(clip, deficit);
      if (projectedLoss > this.config.maxMarketLossUsd + 1e-9) return 0;
    }
    return clip >= MIN_ORDER_SHARES ? clip : 0;
  }

  private effectiveClip(multiplier: number): number {
    return Math.max(this.config.clipShares * multiplier, 5.0);
  }

  private balanceClip(inv: Inventory, side: Side, clip: number): number {
    const thisShares = side === Side.Up ? inv.up.shares : inv.down.shares;
    const otherShares = side === Side.Up ? inv.down.shares : inv.up.shares;
    if (thisShares <= 0 || otherShares <= 0) return clip;
    const target = Math.min(Math.max(this.config.targetImbalance, 0.005), 0.10);
    const maxThis = (otherShares * (1 + target)) / (1 - target);
    return Math.max(0, Math.min(clip, maxThis - thisShares));
  }

  private fillPrice(quote: BookQuote): [number, boolean] {
    const bid = quote.bid;
    const ask = quote.ask;
    if (bid != null && ask != null) {
      if (this.config.backtestAlwaysTaker) return [ask, false];
      const spread = ask - bid;
      if (this.rng() < this.config.makerFillRatio) {
        return [quantizeMakerBuyPrice(bid + spread * 0.2, quote.tickSize) ?? 0, true];
      }
      return [ask, false];
    }
    if (bid == null && ask != null) return [ask, false];
    if (bid != null && ask == null) return [quantizeMakerBuyPrice(bid, quote.tickSize) ?? 0, true];
    return [0.0, false];
  }

  private minIntervalOk(
    inv: Inventory,
    tsUnix: number,
    urgent: boolean,
    openingSecondLeg: boolean,
  ): boolean {
    if (inv.lastFillUnix <= 0.0) return true;
    const gap = tsUnix - inv.lastFillUnix;
    if (openingSecondLeg) return gap >= 0.0;
    if (urgent) return gap >= this.config.burstIntervalSec;
    return gap >= this.config.fillIntervalSec;
  }

  private worseningBlocked(inv: Inventory, projected: number): boolean {
    if (!this.config.blockWorseningPairCost || !inv.bothSidesOpened) return false;
    const current = inv.pairCost();
    if (current <= this.config.pairCostTarget) return false;
    return projected > current + 0.002;
  }

  private pairCostLimit(inv: Inventory, projected: number, rebalance: boolean): boolean {
    const lim = effectiveLimits(this.config, this.risk);
    if (inv.up.shares <= 0.0 || inv.down.shares <= 0.0) {
      if (!inv.bothSidesOpened && (inv.up.shares > 0.0) !== (inv.down.shares > 0.0)) {
        return projected <= this.config.secondLegPairCostMax;
      }
      return projected <= lim.pairCostMax + 0.01;
    }
    return rebalance ? projected <= lim.rebalanceMax : projected <= lim.pairCostMax;
  }

  private btcBiasSide(books: MarketBooks, btcChangePct: number | undefined): Side | undefined {
    const chg = btcChangePct ?? btcProxyChangePct(books) * 0.05;
    if (Math.abs(chg) < this.config.btcChangeThresholdPct) return undefined;
    return chg > 0.0 ? Side.Up : Side.Down;
  }

  private isUrgent(inv: Inventory, books: MarketBooks): boolean {
    if (!inv.bothSidesOpened) return inv.up.shares > 0.0 || inv.down.shares > 0.0;
    if (inv.netImbalanceRatio() > 0.25) return true;
    const sum = combinedAskSum(books);
    if (sum != null && sum < this.config.instantArbSumMax) return true;
    return false;
  }

  private stableMakerPrice(quote: BookQuote): number | undefined {
    if (quote.tickSize == null || !Number.isFinite(quote.tickSize) ||
      quote.tickSize <= 0 || quote.tickSize >= 1) return this.reject("maker_tick_missing_or_invalid");
    const f = Math.min(Math.max(this.config.makerSpreadFrac, 0.0), 1.0);
    let px: number | undefined;
    if (quote.bid != null && quote.ask != null && quote.bid > 0.0 && quote.bid < 1.0) {
      px = Math.min(quote.bid + (quote.ask - quote.bid) * f, quote.ask - quote.tickSize);
    } else if (quote.bid != null && quote.bid > 0.0 && quote.bid < 1.0) {
      px = quote.bid;
    } else {
      return undefined;
    }
    const executable = quantizeMakerBuyPrice(px, quote.tickSize);
    return executable ?? this.reject("maker_price_invalid");
  }

  private chooseSideStable(
    inv: Inventory,
    books: MarketBooks,
    tsUnix: number,
    marketStart: number,
    marketEnd: number,
    btcChangePct: number | undefined,
  ): Side | undefined {
    const secsIn = tsUnix - marketStart;
    const secsLeft = marketEnd - tsUnix;

    if (secsIn < this.config.startDelaySec) return undefined;
    if (secsLeft < this.config.stopBeforeEndSec) return undefined;
    if (!this.risk.canTrade(this.config)) return undefined;

    trackSingleSide(inv, this.risk, tsUnix);

    const upPx = this.stableMakerPrice(books.up);
    const dnPx = this.stableMakerPrice(books.down);

    const upS = inv.up.shares;
    const dnS = inv.down.shares;
    const both = upS > 0.0 && dnS > 0.0;

    const base = evaluateRisk(inv, this.risk, this.config, tsUnix, marketEnd);
    if (!base.allow) {
      if (base.haltMarket) this.risk.marketMode = MarketMode.Halted;
      return this.reject("risk_blocked");
    }

    const flatten = secsLeft <= this.config.forceFlattenSec;
    const clip = this.effectiveClip(base.clipMultiplier);
    this.pendingClipMult = 1.0;
    this.pendingUrgent = false;
    this.pendingBudgetPx = undefined;

    const cautious = this.risk.isCautious();
    const effPairAddCostMax = cautious
      ? Math.min(this.config.pairAddCostMax, 0.975)
      : this.config.pairAddCostMax;

    const trend = btcChangePct != null ? Math.abs(btcChangePct) : 0.0;
    const thr = this.config.btcHighVolThresholdPct;
    const trendFactor =
      trend >= 2.0 * thr ? 0.45 : trend >= thr ? 0.62 : 1.0;
    const cautiousFactor = cautious ? 0.8 : 1.0;
    const imbFactor = trendFactor * cautiousFactor;
    const effTargetImb = this.config.targetImbalance * imbFactor;
    const effHardImb = this.config.hardImbalance * imbFactor;
    this.pendingHardImb = effHardImb;

    if (!both && upS <= 0.0 && dnS <= 0.0) {
      if (upPx == null || dnPx == null) return undefined;
      if (flatten) return undefined;
      if (!this.minIntervalOk(inv, tsUnix, true, false)) return undefined;
      if (upPx + dnPx <= effPairAddCostMax) {
        let openSide: Side;
        let openPx: number;
        if (upPx <= dnPx) {
          openSide = Side.Up;
          openPx = upPx;
        } else {
          openSide = Side.Down;
          openPx = dnPx;
        }
        const fu = this.fairUpSignal(tsUnix, marketEnd, btcChangePct);
        if (this.config.leadHighProbOpen && fu != null) {
          const upMargin = fu - upPx;
          const dnMargin = 1.0 - fu - dnPx;
          if (upMargin >= dnMargin) {
            openSide = Side.Up;
            openPx = upPx;
          } else {
            openSide = Side.Down;
            openPx = dnPx;
          }
        }
        if (openPx > this.config.cheapLegPrice) return undefined;
        if (!this.fairPriceOk(openSide, openPx, fu)) return undefined;
        this.pendingClipMult = 1.0;
        if (this.wantCross(openSide, inv, books, clip, effPairAddCostMax)) {
          this.pendingUrgent = true;
        }
        return openSide;
      }
      if (this.config.passiveBudgetMode) {
        const entry = this.passiveBudgetEntry(books);
        if (entry != null) {
          this.pendingClipMult = 1.0;
          this.pendingBudgetPx = entry[1];
          return entry[0];
        }
      }
      return undefined;
    }

    if ((upS > 0.0) !== (dnS > 0.0)) {
      const need = upS <= 0.0 ? Side.Up : Side.Down;
      const needPx = need === Side.Up ? upPx : dnPx;
      if (needPx == null) return undefined;
      const needAsk = need === Side.Up ? books.up.ask : books.down.ask;
      const nakedFor =
        this.risk.singleSideSince != null ? tsUnix - this.risk.singleSideSince : 0.0;
      const forced = flatten || nakedFor >= this.config.maxUnhedgedSecs;
      this.pendingClipMult = 1.0;

      const ceiling = this.hedgeLimit(inv, tsUnix, marketEnd);
      // Once overdue, an affordable resting maker is not a completed hedge.
      // Cross only within the existing emergency/passive and dollar limits.
      if (forced && needAsk != null) {
        const cost = inv.projectedPairCostIfBuy(need, Math.min(clip, Math.max(upS, dnS)),
          needAsk + this.takerFeePerShare(needAsk));
        if (cost <= ceiling + 1e-9) {
          this.pendingUrgent = true;
          return need;
        }
      }
      const makerCost = inv.projectedPairCostIfBuy(need, clip,
        needPx + this.fillFee(1, needPx, true));
      if (makerCost <= ceiling + 1e-9) {
        this.pendingUrgent = !forced && this.wantCross(need, inv, books, clip, ceiling);
        return need;
      }
      return this.reject("hedge_pair_cost", { side: need, price: needPx,
        pairCost: makerCost, limit: ceiling });
    }

    const total = upS + dnS;
    const imb = Math.abs(upS - dnS) / total;
    const matched = Math.min(upS, dnS);
    const curPc = inv.pairCost();
    const lighter = upS < dnS ? Side.Up : Side.Down;
    const lighterPx = lighter === Side.Up ? upPx : dnPx;
    const lighterAsk = lighter === Side.Up ? books.up.ask : books.down.ask;

    if (flatten) {
      if (
        this.config.closeToParity &&
        imb > effTargetImb &&
        this.minIntervalOk(inv, tsUnix, true, false)
      ) {
        if (lighterAsk != null) {
          const projT = inv.projectedPairCostIfBuy(lighter, clip, lighterAsk);
          if (projT + this.takerFeePerShare(lighterAsk) < 1.0) {
            this.pendingUrgent = true;
            return lighter;
          }
        }
        if (lighterPx != null) {
          if (inv.projectedPairCostIfBuy(lighter, clip, lighterPx) < 1.0) {
            return lighter;
          }
        }
        return undefined;
      }
      if (imb > effTargetImb && this.minIntervalOk(inv, tsUnix, true, false)) {
        if (lighterPx != null) {
          const proj = inv.projectedPairCostIfBuy(lighter, clip, lighterPx);
          if (proj <= this.config.hedgePairCostCeiling) return lighter;
        }
        if (this.config.feeAware) {
          if (lighterAsk != null) {
            const projT = inv.projectedPairCostIfBuy(lighter, clip, lighterAsk);
            if (
              projT + this.takerFeePerShare(lighterAsk) <=
              this.config.hedgePairCostCeiling
            ) {
              this.pendingUrgent = true;
              return lighter;
            }
          }
        } else if (lighterAsk != null) {
          const proj = inv.projectedPairCostIfBuy(lighter, clip, lighterAsk);
          if (proj <= this.config.hedgePairCostCeiling) {
            this.pendingUrgent = true;
            return lighter;
          }
        }
      }
      return undefined;
    }

    if (imb > effHardImb) {
      if (lighterPx != null) {
        const proj = inv.projectedPairCostIfBuy(lighter, clip, lighterPx);
        if (
          proj <= this.config.hedgePairCostCeiling &&
          this.minIntervalOk(inv, tsUnix, true, false)
        ) {
          return lighter;
        }
      }
      return undefined;
    }

    if (matched >= this.config.holdLockMinShares && curPc <= this.config.holdLockPairCost) {
      return undefined;
    }

    if (inv.totalCost() >= this.config.maxTotalCost) return undefined;
    if (inv.fills.length >= this.config.maxFillsPerMarket) return undefined;
    if (!this.minIntervalOk(inv, tsUnix, false, false)) return undefined;

    let cand: Side;
    if (imb > 0.02) {
      cand = lighter;
    } else {
      if (upPx == null || dnPx == null) return undefined;
      cand = upPx <= dnPx ? Side.Up : Side.Down;
    }
    const candPx = cand === Side.Up ? upPx : dnPx;
    if (candPx == null) return undefined;

    const proj = inv.projectedPairCostIfBuy(cand, clip, candPx);
    if (proj > effPairAddCostMax) return undefined;
    if (
      !this.fairPriceOk(
        cand,
        candPx,
        this.fairUpSignal(tsUnix, marketEnd, btcChangePct),
      )
    ) {
      return undefined;
    }
    const mult = this.edgeClipMult(Math.min(curPc, proj));
    this.pendingClipMult = cautious ? Math.min(mult, 1.5) : mult;
    if (this.wantCross(cand, inv, books, clip, effPairAddCostMax)) {
      this.pendingUrgent = true;
    }
    return cand;
  }

  chooseSide(
    inv: Inventory,
    books: MarketBooks,
    tsUnix: number,
    marketStart: number,
    marketEnd: number,
    btcChangePct?: number,
  ): Side | undefined {
    this.rejection = null;
    inv = this.withFees(inv);
    if (this.config.stableMode) {
      return this.chooseSideStable(inv, books, tsUnix, marketStart, marketEnd, btcChangePct);
    }

    const secsIn = tsUnix - marketStart;
    const secsLeft = marketEnd - tsUnix;

    if (secsIn < this.config.startDelaySec) return undefined;
    if (secsLeft < this.config.stopBeforeEndSec) return undefined;
    if (!this.risk.canTrade(this.config)) return undefined;

    trackSingleSide(inv, this.risk, tsUnix);
    const baseRisk = evaluateRisk(inv, this.risk, this.config, tsUnix, marketEnd);
    if (!baseRisk.allow) {
      if (baseRisk.haltMarket) this.risk.marketMode = MarketMode.Halted;
      return undefined;
    }
    if (inv.totalCost() >= this.config.maxTotalCost) return undefined;
    if (inv.fills.length >= this.config.maxFillsPerMarket) return undefined;

    const repairOnly = baseRisk.repairOnly;
    const openingSecondLeg =
      !inv.bothSidesOpened && (inv.up.shares > 0.0) !== (inv.down.shares > 0.0);
    const urgent =
      this.isUrgent(inv, books) ||
      (openingSecondLeg && secsIn <= this.config.dualSideTargetSec);
    if (!this.minIntervalOk(inv, tsUnix, urgent, openingSecondLeg)) return undefined;

    if (openingSecondLeg && secsIn <= this.config.dualSideTargetSec) {
      const need = inv.up.shares <= 0.0 ? Side.Up : Side.Down;
      const quote = need === Side.Up ? books.up : books.down;
      if (quote.ask != null) {
        const [price] = this.fillPrice(quote);
        const proj = inv.projectedPairCostIfBuy(need, this.config.clipShares, price);
        if (
          !this.worseningBlocked(inv, proj) &&
          price > 0.0 &&
          price < 1.0 &&
          proj <= this.config.secondLegPairCostMax
        ) {
          return need;
        }
      }
    }

    const upQ = books.up;
    const downQ = books.down;
    if (upQ.ask == null || downQ.ask == null) return undefined;

    const late = secsLeft <= this.config.lateWindowSec;
    const rebalance =
      inv.netImbalanceRatio() > 0.2 ||
      (late && this.config.latePairCostOnly && inv.pairCost() >= this.config.pairCostMax);

    if (late && this.config.latePairCostOnly && inv.bothSidesOpened) {
      if (inv.pairCost() > 0.0 && inv.pairCost() < this.config.pairCostMax) return undefined;
      if (inv.pairCost() >= this.config.pairCostMax) {
        const clip = this.effectiveClip(baseRisk.clipMultiplier);
        const side = bestRepairSide(inv, books, clip) ?? repairSide(inv);
        if (side != null) return side;
        return undefined;
      }
    }

    if ((repairOnly || baseRisk.resolutionRepairOnly) && inv.bothSidesOpened) {
      const clip = this.effectiveClip(baseRisk.clipMultiplier);
      const side = bestRepairSide(inv, books, clip) ?? repairSide(inv);
      if (side != null) {
        const quote = side === Side.Up ? upQ : downQ;
        if (quote.ask != null) {
          const [price] = this.fillPrice(quote);
          const proj = inv.projectedPairCostIfBuy(side, clip, price);
          if (
            evaluateRisk(inv, this.risk, this.config, tsUnix, marketEnd, proj).allow
          ) {
            return side;
          }
        }
      }
      return undefined;
    }

    const sum = combinedAskSum(books);
    if (sum != null && sum < this.config.instantArbSumMax) {
      return inv.up.shares <= inv.down.shares ? Side.Up : Side.Down;
    }

    const clip = this.effectiveClip(baseRisk.clipMultiplier);
    const maxShares = this.config.maxSharesPerSide;
    const deepCheap = this.config.deepCheapThreshold;
    const expensive = this.config.expensiveHedgeThreshold;
    const rebalanceMax = this.config.rebalancePairCostMax;
    const cheapMid = this.config.cheapMidThreshold;

    const candidates: [Side, number, number][] = [];

    for (const [side, quote] of [
      [Side.Up, upQ] as const,
      [Side.Down, downQ] as const,
    ]) {
      if (heavySideBlocked(inv, side, this.config)) continue;
      const sideShares = side === Side.Up ? inv.up.shares : inv.down.shares;
      if (sideShares >= maxShares) continue;
      const [price] = this.fillPrice(quote);
      if (price <= 0.0 || price >= 1.0) continue;
      const proj = inv.projectedPairCostIfBuy(side, clip, price);
      if (this.worseningBlocked(inv, proj)) continue;
      if (this.pairCostLimit(inv, proj, rebalance)) {
        candidates.push([side, price, proj]);
      } else {
        const mid = bookMid(quote);
        if (mid != null && mid < this.config.lotteryPriceThreshold) {
          if (proj <= rebalanceMax) candidates.push([side, price, proj]);
        } else if (mid != null && mid < deepCheap) {
          if (proj <= rebalanceMax) candidates.push([side, price, proj]);
        } else if (price >= expensive) {
          const otherAvg =
            side === Side.Up ? inv.down.avgPrice() : inv.up.avgPrice();
          if (otherAvg > 0.0 && otherAvg < 0.45 && proj <= rebalanceMax) {
            candidates.push([side, price, proj]);
          }
        }
      }
    }

    const filtered = candidates.filter(
      ([side, , proj]) =>
        !heavySideBlocked(inv, side, this.config) &&
        evaluateRisk(inv, this.risk, this.config, tsUnix, marketEnd, proj).allow &&
        this.pairCostLimit(inv, proj, rebalance),
    );

    if (filtered.length === 0) return undefined;

    filtered.sort((a, b) => a[2] - b[2]);

    if (btcChangePct != null && Math.abs(btcChangePct) >= this.config.btcHighVolThresholdPct) {
      let cheapest: [Side, number, number] | undefined;
      for (const c of filtered) {
        const ma = bookMid(c[0] === Side.Up ? upQ : downQ) ?? 1.0;
        if (cheapest == null) {
          cheapest = c;
        } else {
          const mb = bookMid(cheapest[0] === Side.Up ? upQ : downQ) ?? 1.0;
          if (ma < mb) cheapest = c;
        }
      }
      if (cheapest != null) return cheapest[0];
    }

    if (inv.up.shares <= 0.0 && inv.down.shares <= 0.0) {
      if (this.rng() < 0.56) {
        const c = filtered.find((x) => x[0] === Side.Up);
        if (c != null) return c[0];
      }
      let min = filtered[0];
      for (const c of filtered) {
        if (c[1] < min[1]) min = c;
      }
      return min[0];
    }
    if (inv.up.shares <= 0.0) {
      return filtered.find((c) => c[0] === Side.Up)?.[0] ?? filtered[0][0];
    }
    if (inv.down.shares <= 0.0) {
      return filtered.find((c) => c[0] === Side.Down)?.[0] ?? filtered[0][0];
    }

    for (const [side, quote] of [
      [Side.Up, upQ] as const,
      [Side.Down, downQ] as const,
    ]) {
      const mid = bookMid(quote);
      if (mid != null && mid < cheapMid && filtered.some((c) => c[0] === side)) {
        return side;
      }
    }

    for (const [side, quote] of [
      [Side.Up, upQ] as const,
      [Side.Down, downQ] as const,
    ]) {
      const mid = bookMid(quote);
      if (mid != null && mid < deepCheap && filtered.some((c) => c[0] === side)) {
        return side;
      }
    }

    if (this.config.pyramidOnMomentum && inv.lastSide != null) {
      const last = inv.lastSide;
      const bias = this.btcBiasSide(books, btcChangePct);
      if (bias === last && filtered.some((c) => c[0] === last)) {
        if (this.rng() < 0.45) return last;
      }
    }

    const bias = this.btcBiasSide(books, btcChangePct);
    if (bias != null && this.rng() < this.config.btcChaseBias) {
      if (filtered.some((c) => c[0] === bias)) return bias;
    }

    if (inv.netImbalanceRatio() > 0.2) {
      const need = inv.up.shares > inv.down.shares ? Side.Down : Side.Up;
      if (filtered.some((c) => c[0] === need)) return need;
    }

    if (this.config.preferAlternate && inv.lastSide != null) {
      const other = Side.other(inv.lastSide);
      if (this.rng() < this.config.alternateWeight && filtered.some((c) => c[0] === other)) {
        return other;
      }
    }

    return filtered[0][0];
  }

  /** The decision and final sizing must use the same configured repair policy. */
  private hedgeLimit(inv: Inventory, tsUnix: number, marketEnd: number): number {
    let ceiling = this.config.hedgePairCostCeiling;
    const oneSide = (inv.up.shares > 0) !== (inv.down.shares > 0);
    if (oneSide) {
      const nakedFor = this.risk.singleSideSince == null ? 0 : tsUnix - this.risk.singleSideSince;
      if (marketEnd - tsUnix <= this.config.forceFlattenSec || nakedFor >= this.config.maxUnhedgedSecs) {
        ceiling = this.config.pairCostEmergencyStop;
      } else if (this.config.feeAware) {
        const fraction = this.config.maxUnhedgedSecs > 0
          ? Math.min(1, Math.max(0, nakedFor / this.config.maxUnhedgedSecs)) : 1;
        const top = Math.min(ceiling + 0.01, 0.999);
        ceiling = Math.min(ceiling + (top - ceiling) * fraction, 0.999);
      }
    } else if (this.config.closeToParity && marketEnd - tsUnix <= this.config.forceFlattenSec) {
      ceiling = Math.min(1 - 1e-9, this.config.pairCostEmergencyStop);
    }
    return this.config.passiveBudgetMode ? Math.min(ceiling, this.config.passiveForcedHedgeCeiling) : ceiling;
  }

  private buildFillStable(
    side: Side,
    inv: Inventory,
    price: number,
    isMaker: boolean,
    tsUnix: number,
    marketEnd: number,
    pending: PendingExposure,
  ): Fill | undefined {
    const unitCost = price + this.fillFee(1, price, isMaker);
    const hedgeLimit = this.hedgeLimit(inv, tsUnix, marketEnd);
    const base = evaluateRisk(inv, this.risk, this.config, tsUnix, marketEnd);
    let clip = this.effectiveClip(base.clipMultiplier) * Math.max(this.pendingClipMult, 1.0);

    const upS = inv.up.shares;
    const dnS = inv.down.shares;
    const thisS = side === Side.Up ? upS : dnS;
    const otherS = side === Side.Up ? dnS : upS;

    if (otherS > thisS) {
      if (this.config.dynamicHedgeSizing) {
        clip = dynamicHedgeClip({
          thisShares: thisS,
          thisCost: side === Side.Up ? inv.up.cost : inv.down.cost,
          otherShares: otherS,
          otherCost: side === Side.Up ? inv.down.cost : inv.up.cost,
          price: unitCost,
          baseClip: clip,
          targetPairCost: hedgeLimit,
        });
        if (clip <= 0) return this.reject("hedge_pair_cost", { side, price,
          pairCost: unitCost + (otherS > 0 ? (side === Side.Up ? inv.down.cost : inv.up.cost) / otherS : 0),
          limit: hedgeLimit });
      } else {
        clip = Math.min(clip, otherS - thisS);
      }
    }
    if (otherS > 0.0) {
      const h = Math.min(Math.max(this.pendingHardImb, 0.01), 0.5);
      const maxThis = (otherS * (1.0 + h)) / (1.0 - h);
      if (thisS + clip > maxThis) {
        clip = Math.max(maxThis - thisS, 0.0);
      }
    }
    clip = this.balanceClip(inv, side, clip);
    clip = Math.min(clip, Math.max(this.config.maxSharesPerSide - thisS, 0.0));
    if (
      this.config.passiveBudgetMode &&
      otherS <= 0.0 &&
      this.config.passiveNakedLegMaxUsd > 0.0 &&
      price > 0.0
    ) {
      clip = Math.min(clip, this.config.passiveNakedLegMaxUsd / price);
    }
    clip = this.boundedClip(inv, side, clip, unitCost, pending);
    if (clip < MIN_ORDER_SHARES) return this.reject("order_limits_or_minimum", { side, price });

    const proj = inv.projectedPairCostIfBuy(side, clip, unitCost);
    if (otherS > thisS &&
      proj > hedgeLimit + 1e-9) return this.reject("hedge_pair_cost", {
        side, price, pairCost: proj, limit: hedgeLimit });
    const risk = evaluateRisk(inv, this.risk, this.config, tsUnix, marketEnd, proj);
    if (risk.haltMarket) {
      this.risk.marketMode = MarketMode.Halted;
      return undefined;
    }
    if (!risk.allow) return this.reject("risk_blocked", { side, price });

    const newUp = upS + (side === Side.Up ? clip : 0.0);
    const newDn = dnS + (side === Side.Down ? clip : 0.0);
    if (newUp > 0.0 && newDn > 0.0) {
      const newCost = inv.totalCost() + pending.cost + clip * unitCost;
      const worst = newCost - Math.min(newUp, newDn);
      if (this.config.maxMarketLossUsd > 0.0 && worst > this.config.maxMarketLossUsd) {
        return undefined;
      }
      if (
        this.config.passiveBudgetMode &&
        proj > this.config.passiveForcedHedgeCeiling + 1e-9
      ) {
        return undefined;
      }
    }

    return { side, shares: clip, price, tsUnix, isMaker };
  }

  buildFill(
    side: Side,
    inv: Inventory,
    books: MarketBooks,
    tsUnix: number,
    marketEnd: number,
    pending: PendingExposure = { cost: 0, upShares: 0, downShares: 0, orders: 0 },
  ): Fill | undefined {
    this.rejection = null;
    if (!Number.isFinite(tsUnix) || !Number.isFinite(marketEnd) ||
      tsUnix >= marketEnd - this.config.stopBeforeEndSec) return undefined;
    inv = this.withFees(inv);
    const quote = side === Side.Up ? books.up : books.down;

    if (this.config.stableMode) {
      let px: number;
      let isMaker: boolean;
      if (this.pendingUrgent) {
        const a = quote.ask;
        if (a == null || !(a > 0.0 && a < 1.0)) return undefined;
        px = a;
        isMaker = false;
      } else if (this.pendingBudgetPx != null) {
        const budgetPrice = quantizeMakerBuyPrice(this.pendingBudgetPx, quote.tickSize);
        if (budgetPrice == null) return this.reject("maker_tick_missing_or_invalid", { side });
        px = budgetPrice;
        isMaker = true;
      } else {
        const makerPrice = this.stableMakerPrice(quote);
        if (makerPrice == null) return undefined;
        px = makerPrice;
        isMaker = true;
      }
      if (!Number.isFinite(px) || px <= 0.0 || px >= 1.0) return undefined;
      if (inv.up.shares === 0 && inv.down.shares === 0) {
        const hedge = this.stableMakerPrice(side === Side.Up ? books.down : books.up);
        const ceiling = this.pendingBudgetPx != null ? this.config.passivePairCeiling : this.config.pairAddCostMax;
        if (hedge == null || px + this.fillFee(1, px, isMaker) + hedge +
          this.fillFee(1, hedge, true) > ceiling + 1e-9) return this.reject("entry_pair_cost", { side, price: px, limit: ceiling });
      }
      return this.buildFillStable(side, inv, px, isMaker, tsUnix, marketEnd, pending);
    }

    const [price, isMaker] = this.fillPrice(quote);
    if (!Number.isFinite(price) || price <= 0.0 || price >= 1.0) return undefined;

    let clip = this.effectiveClip(
      evaluateRisk(inv, this.risk, this.config, tsUnix, marketEnd).clipMultiplier,
    );
    clip = this.balanceClip(inv, side, clip);
    const unitCost = price + this.fillFee(1, price, isMaker);
    clip = this.boundedClip(inv, side, clip, unitCost, pending);
    if (clip < MIN_ORDER_SHARES) return undefined;

    const proj = inv.projectedPairCostIfBuy(side, clip, unitCost);
    const risk = evaluateRisk(inv, this.risk, this.config, tsUnix, marketEnd, proj);
    if (risk.haltMarket) {
      this.risk.marketMode = MarketMode.Halted;
      return undefined;
    }
    if (!risk.allow) return undefined;
    if (this.worseningBlocked(inv, proj)) return undefined;

    const lim = effectiveLimits(this.config, this.risk);
    if (inv.bothSidesOpened && proj >= lim.rebalanceMax) {
      if (!isRepairFill(inv, proj)) return undefined;
    }
    if (
      !inv.bothSidesOpened &&
      inv.up.shares > 0.0 &&
      inv.down.shares > 0.0 &&
      proj >= lim.pairCostMax
    ) {
      return undefined;
    }

    return { side, shares: clip, price, tsUnix, isMaker };
  }
}
