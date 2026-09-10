import { describe, expect, it } from "vitest";
import {
  stableLive,
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
    up: { bid: ub, ask: ua, tickSize: 0.01, tsUnix: TS },
    down: { bid: db, ask: da, tickSize: 0.01, tsUnix: TS },
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


describe("final order risk bounds", () => {
  const cfg = (): StrategyConfig => ({ ...stableLive(), makerSpreadFrac: 0,
    maxMarketLossUsd: 1000, pairCostHardStop: 1.2, pairCostEmergencyStop: 1.3,
    reduceClipAbovePairCost: 1.2 });
  const buy = (inv: Inventory, side: Side, shares: number, price: number, isMaker = true) =>
    inv.execute({ side, shares, price, isMaker, tsUnix: 1010 });

  it("caps the hedge to remaining cash including incurred and proposed fees", () => {
    const config = { ...cfg(), maxTotalCost: 8, makerFeeRate: 0.02 };
    const strat = new PairCostMarketMaker(config);
    const inv = new Inventory();
    buy(inv, Side.Up, 10, 0.4, false);
    const fill = strat.buildFill(Side.Down, inv, books(0.4,0.41,0.5,0.51), TS, END);
    expect(fill).toBeDefined();
    const spent = 4 + 10 * 0.07 * 0.4 * 0.6;
    const unitCost = 0.5 + 0.02 * 0.5 * 0.5;
    expect(spent + fill!.shares * unitCost).toBeCloseTo(8, 8);
    expect(inv.totalCost()).toBe(4); // Risk view must not mutate actual cash accounting.
  });

  it("bounds the very first naked leg by worst settlement loss", () => {
    const strat = new PairCostMarketMaker({ ...cfg(), maxMarketLossUsd: 12 });
    const fill = strat.buildFill(Side.Up, new Inventory(), books(0.6,0.61,0.35,0.36), TS, END);
    expect(fill).toBeDefined();
    expect(fill!.shares * fill!.price).toBeCloseTo(12, 8);
  });

  it("does not round a three-share hedge deficit up to the five-share minimum", () => {
    const inv = new Inventory();
    buy(inv, Side.Up, 8, 0.4); buy(inv, Side.Down, 5, 0.45);
    expect(new PairCostMarketMaker(cfg()).buildFill(Side.Down, inv,
      books(0.4,0.41,0.45,0.46), TS, END)).toBeUndefined();
  });

  it("rechecks dynamic pair cost when the cash cap truncates the required repair", () => {
    const inv = new Inventory();
    buy(inv, Side.Up, 100, 0.6); buy(inv, Side.Down, 50, 0.45);
    const strat = new PairCostMarketMaker({ ...cfg(), maxTotalCost: 90, hedgePairCostCeiling: 0.99 });
    expect(strat.buildFill(Side.Down, inv, books(0.6,0.61,0.3,0.31), TS, END)).toBeUndefined();
  });

  it("reserves unfilled orders without counting them as a guaranteed hedge payout", () => {
    const strat = new PairCostMarketMaker({ ...cfg(), maxTotalCost: 10, maxMarketLossUsd: 8 });
    const fill = strat.buildFill(Side.Down, new Inventory(), books(0.4,0.41,0.5,0.51), TS, END,
      { cost: 5, upShares: 10, downShares: 0, orders: 1 });
    expect(fill).toBeDefined();
    expect(fill!.shares).toBe(6); // $5 pending + $3 new is all at risk until fills arrive.
  });

  it("enforces cutoff even if called after a previously accepted side decision", () => {
    const strat = new PairCostMarketMaker(cfg());
    expect(strat.buildFill(Side.Up, new Inventory(), books(0.4,0.41,0.5,0.51), END-10, END)).toBeUndefined();
  });

  it("blocks an additional order when confirmed fills exhausted the limit", () => {
    const inv = new Inventory(); buy(inv, Side.Up, 10, 0.4);
    const strat = new PairCostMarketMaker({ ...cfg(), maxFillsPerMarket: 1 });
    expect(strat.buildFill(Side.Down, inv, books(0.4,0.41,0.5,0.51), TS, END)).toBeUndefined();
  });
});


describe("entry economics include both legs", () => {
  it("does not cross when the opening fee breaks the paired cost ceiling", () => {
    const config = { ...targetCloneActive(), takerFeeRate: 0.07, pairAddCostMax: 0.98 };
    const fill = firstFill(new PairCostMarketMaker(config), books(0.48,0.49,0.48,0.49));
    expect(fill).toBeDefined();
    expect(fill!.isMaker).toBe(true);
  });
  it("does not treat estimated rebates as negative entry costs", () => {
    const config = { ...targetClone(), makerFeeRate: -1, pairAddCostMax: 0.98 };
    const strat = new PairCostMarketMaker(config);
    expect(strat.buildFill(Side.Up,new Inventory(),books(0.50,0.51,0.50,0.51),TS,END)).toBeUndefined();
  });
});


describe("hedge risk uses the executable market tick", () => {
  function hedgeBook(tickSize: number, downAsk = 0.77): MarketBooks {
    const quote = books(0.23,0.24,0.76,downAsk);
    quote.up.tickSize=tickSize;quote.down.tickSize=tickSize;
    return quote;
  }
  function nakedInventory(): Inventory {
    const inv=new Inventory();
    inv.execute({side:Side.Up,shares:20,price:0.23,tsUnix:1020,isMaker:true});
    return inv;
  }
  it("quotes the affordable .76 hedge on a .01 tick rather than rejecting .7615", () => {
    const strat=new PairCostMarketMaker({...targetClone(),pairAddCostMax:0.99});
    strat.onMarketStart(START);
    const inv=nakedInventory(); const quote=hedgeBook(0.01);
    const side=strat.chooseSide(inv,quote,TS,START,END);
    expect(side).toBe(Side.Down);
    const fill=strat.buildFill(side!,inv,quote,TS,END);
    expect(fill).toMatchObject({side:Side.Down,price:0.76,shares:20,isMaker:true});
    expect(inv.projectedPairCostIfBuy(Side.Down,fill!.shares,fill!.price)).toBeCloseTo(0.99,10);
    expect(strat.lastDecisionRejection()).toBeNull();
  });
  it("keeps .001 tick economics distinct and reports why the same spread is too expensive", () => {
    const strat=new PairCostMarketMaker(targetClone());const inv=nakedInventory();
    expect(strat.buildFill(Side.Down,inv,hedgeBook(0.001),TS,END)).toBeUndefined();
    expect(strat.lastDecisionRejection()).toMatchObject({code:'hedge_pair_cost',price:0.761,limit:0.99});
    expect(strat.buildFill(Side.Down,inv,hedgeBook(0.001,0.761),TS,END)).toMatchObject({price:0.76,shares:20});
  });
  it("does not invent .01 when the token tick is absent or invalid", () => {
    for(const tick of [undefined,0,Number.NaN]) {
      const quote=hedgeBook(0.01);quote.down.tickSize=tick;
      const strat=new PairCostMarketMaker(targetClone());
      expect(strat.buildFill(Side.Down,nakedInventory(),quote,TS,END)).toBeUndefined();
      expect(strat.lastDecisionRejection()?.code).toBe('maker_tick_missing_or_invalid');
    }
  });
  it("recomputes fees and limits from the quantized maker price", () => {
    const inv=nakedInventory();
    const strat=new PairCostMarketMaker({...targetClone(),makerFeeRate:0.02,hedgePairCostCeiling:1.0,maxTotalCost:10});
    const fill=strat.buildFill(Side.Down,inv,hedgeBook(0.01),TS,END)!;
    expect(fill.price).toBe(0.76);
    const firstFee=20*0.02*0.23*0.77;
    expect(4.6+firstFee+fill.shares*(0.76+0.02*0.76*0.24)).toBeCloseTo(10,8);
  });
});
