import { describe, expect, it } from "vitest";
import {
  targetClone,
  targetCloneActive,
  targetCloneV2,
  type StrategyConfig,
} from "./config.js";
import { Inventory } from "./inventory.js";
import { Side, type Fill, type MarketBooks } from "./models.js";
import { dynamicHedgeClip, PairCostMarketMaker } from "./strategy.js";

const START = 1000;
const END = 1300;
const TS = 1050.0;

function books(ub: number, ua: number, db: number, da: number): MarketBooks {
  return {
    tsUnix: TS,
    up: { bid: ub, ask: ua, tsUnix: TS },
    down: { bid: db, ask: da, tsUnix: TS },
  };
}

function firstPick(s: PairCostMarketMaker, b: MarketBooks, chg?: number): Side | undefined {
  s.onMarketStart(START);
  return s.chooseSide(new Inventory(), b, TS, START, END, chg);
}

function firstFill(s: PairCostMarketMaker, b: MarketBooks, chg?: number): Fill | undefined {
  s.onMarketStart(START);
  const inv = new Inventory();
  const side = s.chooseSide(inv, b, TS, START, END, chg);
  if (side == null) return undefined;
  return s.buildFill(side, inv, b, TS, END);
}

describe("fair entry tests", () => {
  it("active_cross crosses a tight spread as taker", () => {
    const b = books(0.48, 0.49, 0.48, 0.49);
    const f = firstFill(new PairCostMarketMaker(targetCloneActive()), b, 0.0);
    expect(f).toBeDefined();
    expect(f!.isMaker).toBe(false);
  });

  it("active_cross rests a wide spread as maker", () => {
    const b = books(0.45, 0.52, 0.45, 0.52);
    const f = firstFill(new PairCostMarketMaker(targetCloneActive()), b, 0.0);
    expect(f).toBeDefined();
    expect(f!.isMaker).toBe(true);
  });

  it("maker_only preset never crosses a tight spread", () => {
    const b = books(0.48, 0.49, 0.48, 0.49);
    const f = firstFill(new PairCostMarketMaker(targetCloneV2()), b, 0.0);
    expect(f).toBeDefined();
    expect(f!.isMaker).toBe(true);
  });

  it("lead_high_prob opens the favourite not the cheap leg", () => {
    const b = books(0.7, 0.72, 0.25, 0.27);
    const chg = 0.0004;
    expect(firstPick(new PairCostMarketMaker(targetClone()), b, chg)).toBe(Side.Down);
    expect(firstPick(new PairCostMarketMaker(targetCloneV2()), b, chg)).toBe(Side.Up);
  });

  it("lead_high_prob falls back to cheap leg without btc signal", () => {
    const b = books(0.7, 0.72, 0.25, 0.27);
    expect(firstPick(new PairCostMarketMaker(targetCloneV2()), b)).toBe(Side.Down);
  });

  it("fair_gate blocks overpaying a leg vs model fair", () => {
    const b = books(0.77, 0.79, 0.18, 0.2);
    const chg = 0.0007;
    expect(firstPick(new PairCostMarketMaker(targetClone()), b, chg)).toBe(Side.Down);
    const gated: StrategyConfig = { ...targetClone(), fairValueGate: true };
    expect(firstPick(new PairCostMarketMaker(gated), b, chg)).toBeUndefined();
  });
});

describe("dynamic hedge sizing", () => {
  it("increases the clip enough to pull the light-side average to the target", () => {
    const clip = dynamicHedgeClip({
      thisShares: 50,
      thisCost: 22.5,
      otherShares: 100,
      otherCost: 60,
      price: 0.30,
      baseClip: 20,
      targetPairCost: 0.99,
    });
    expect(clip).toBeCloseTo(33.333333, 5);
    const newAverage = (22.5 + clip * 0.30) / (50 + clip);
    expect(0.60 + newAverage).toBeCloseTo(0.99, 8);
  });

  it("rejects a hedge price that cannot repair the pair cost", () => {
    expect(dynamicHedgeClip({
      thisShares: 50,
      thisCost: 22.5,
      otherShares: 100,
      otherCost: 60,
      price: 0.40,
      baseClip: 20,
      targetPairCost: 0.99,
    })).toBe(0);
  });

  it("rejects a high hedge price even when the current average is already safe", () => {
    expect(dynamicHedgeClip({
      thisShares: 50,
      thisCost: 20,
      otherShares: 100,
      otherCost: 60,
      price: 0.42,
      baseClip: 20,
      targetPairCost: 0.99,
    })).toBe(0);
  });

  it("does not overfill beyond the inventory deficit", () => {
    expect(dynamicHedgeClip({
      thisShares: 90,
      thisCost: 31.5,
      otherShares: 100,
      otherCost: 60,
      price: 0.20,
      baseClip: 20,
      targetPairCost: 0.99,
    })).toBe(10);
  });
});
