import { describe, expect, it } from "vitest";
import {
  decisionBucketTs,
  quantizeMakerBuyPrice,
  estimateMakerFillProbability,
  polymarketFillFee,
  visibleBuyQueueAhead,
} from "./models.js";

describe("decisionBucketTs", () => {
  it("aligns wall seconds", () => {
    expect(decisionBucketTs(1780179003.9, 1)).toBe(1780179003);
    expect(decisionBucketTs(1780179007, 5)).toBe(1780179005);
  });
});

describe("polymarket fill fee", () => {
  it("crypto taker fee peaks at money", () => {
    const f50 = polymarketFillFee(100, 0.5, false, 0.072, 0, 1);
    expect(Math.abs(f50 - 1.8)).toBeLessThan(1e-9);
    const f70 = polymarketFillFee(100, 0.7, false, 0.072, 0, 1);
    expect(f70).toBeLessThan(f50);
    expect(Math.abs(f70 - 1.512)).toBeLessThan(1e-6);
    expect(polymarketFillFee(100, 0.5, true, 0.072, 0, 1)).toBe(0);
  });
});

describe("maker fill probability", () => {
  const baseline = {
    queueAheadShares: 100,
    recentTradeRateSharesPerSec: 20,
    orderShares: 20,
    restingSeconds: 5,
    ticksBehindBest: 0,
    volatilityBps: 0,
  };

  it("stays bounded and returns zero without expected queue consumption", () => {
    expect(estimateMakerFillProbability({ ...baseline, recentTradeRateSharesPerSec: 0 })).toBe(0);
    const p = estimateMakerFillProbability(baseline);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("rises with trade consumption and resting time", () => {
    const slow = estimateMakerFillProbability(baseline);
    const fast = estimateMakerFillProbability({
      ...baseline,
      recentTradeRateSharesPerSec: 40,
      restingSeconds: 10,
    });
    expect(fast).toBeGreaterThan(slow);
  });

  it("falls behind a larger queue, more ticks, and higher volatility", () => {
    const clean = estimateMakerFillProbability(baseline);
    const difficult = estimateMakerFillProbability({
      ...baseline,
      queueAheadShares: 400,
      ticksBehindBest: 2,
      volatilityBps: 50,
    });
    expect(difficult).toBeLessThan(clean);
  });

  it("applies the configured conservative queue multiplier", () => {
    const normal = estimateMakerFillProbability({ ...baseline, queueConservatism: 1 });
    const conservative = estimateMakerFillProbability({ ...baseline, queueConservatism: 3 });
    expect(conservative).toBeLessThan(normal);
  });
});

describe("visible maker BUY queue", () => {
  it("sums every visible bid with equal or better priority", () => {
    expect(visibleBuyQueueAhead({
      bid: 0.48,
      ask: 0.5,
      bidLevels: [
        { price: 0.48, size: 30 },
        { price: 0.47, size: 20 },
        { price: 0.46, size: 10 },
      ],
      tickSize: 0.01,
      tsUnix: 1,
    }, 0.47)).toBe(50);
  });

  it("uses touch size at best bid and refuses to guess below it", () => {
    const quote = { bid: 0.48, ask: 0.5, bidSize: 30, tickSize: 0.01, tsUnix: 1 };
    expect(visibleBuyQueueAhead(quote, 0.48)).toBe(30);
    expect(visibleBuyQueueAhead(quote, 0.49)).toBe(0);
    expect(visibleBuyQueueAhead(quote, 0.47)).toBeUndefined();
  });

  it("rejects malformed depth instead of understating the queue", () => {
    expect(visibleBuyQueueAhead({
      bid: 0.48,
      ask: 0.5,
      bidLevels: [{ price: 0.48, size: -1 }],
      tsUnix: 1,
    }, 0.48)).toBeUndefined();
  });

  it("does not treat empty or inconsistent depth as an empty queue", () => {
    expect(visibleBuyQueueAhead({
      bid: 0.48,
      ask: 0.5,
      bidLevels: [],
      tsUnix: 1,
    }, 0.48)).toBeUndefined();
    expect(visibleBuyQueueAhead({
      bid: 0.48,
      ask: 0.5,
      bidLevels: [{ price: 0.47, size: 30 }],
      tsUnix: 1,
    }, 0.48)).toBeUndefined();
  });
});


describe("maker tick quantization", () => {
  it.each([[0.7615,0.01,0.76],[0.7615,0.001,0.761],[0.761,0.001,0.761],[0.29,0.01,0.29]])
    ("quantizes %s with token tick %s to %s",(price,tick,expected)=>{
      expect(quantizeMakerBuyPrice(price,tick)).toBe(expected);
    });
  it("never raises a sub-tick bid or guesses missing metadata",()=>{
    expect(quantizeMakerBuyPrice(0.005,0.01)).toBeUndefined();
    expect(quantizeMakerBuyPrice(0.7615,undefined)).toBeUndefined();
    expect(quantizeMakerBuyPrice(0.7615,Number.NaN)).toBeUndefined();
  });
});
