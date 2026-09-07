import { describe, expect, it } from "vitest";
import { Side } from "../models.js";
import { Engine, bookOk } from "./engine.js";

describe("bookOk gate", () => {
  it("accepts a good ~50/50 book", () => {
    expect(bookOk(0.49, 0.51, 0.49, 0.5)).toBe(true);
  });

  it("rejects crossed UP side", () => {
    expect(bookOk(0.55, 0.51, 0.49, 0.5)).toBe(false);
  });

  it("rejects ask sum too low", () => {
    expect(bookOk(0.3, 0.35, 0.3, 0.35)).toBe(false);
  });

  it("rejects price at boundary", () => {
    expect(bookOk(0, 0.51, 0.49, 0.5)).toBe(false);
  });
});

describe("Engine book ordering", () => {
  it("drops out-of-order books", () => {
    const e = new Engine({});
    e.reset(1000, 1300);
    e.onBook(1050, 0.49, 0.51, 0.49, 0.5);
    const ev = e.onBook(1040, 0.49, 0.51, 0.49, 0.5);
    expect(ev).toEqual([]);
  });

  it("replaces current inventory idempotently from authenticated fills", () => {
    const e = new Engine({ liveMode: true });
    e.reset(1000, 1300);
    const fills = [
      { side: Side.Up, shares: 5, price: 0.4, tsUnix: 1010, isMaker: true },
      { side: Side.Down, shares: 5, price: 0.5, tsUnix: 1020, isMaker: false },
    ];
    e.replaceCurrentMarketFills(fills);
    e.replaceCurrentMarketFills(fills);
    expect(e.fills()).toBe(2);
    expect(e.pairCost()).toBeCloseTo(0.9);
  });
});

describe("Engine maker microstructure gate", () => {
  const liquid = {
    upBidLevels: [{ price: 0.45, size: 1 }],
    downBidLevels: [{ price: 0.52, size: 1 }],
    upSellTradeRateSharesPerSec: 100,
    downSellTradeRateSharesPerSec: 100,
    upTickSize: 0.01,
    downTickSize: 0.01,
    expectedRestingSeconds: 15,
    volatilityBps: 0,
  };

  it("fails closed in live mode when queue-flow inputs are missing", () => {
    const e = new Engine({ liveMode: true });
    e.reset(1000, 1300);
    const events = e.onBook(1010, 0.45, 0.46, 0.52, 0.53);
    expect(events.filter((event) => event.kind === "quote")).toHaveLength(0);
  });

  it("allows and sizes a maker quote from public depth and sell flow", () => {
    const e = new Engine({ liveMode: true, minMakerFillProbability: 0.05 });
    e.reset(1000, 1300);
    const events = e.onBook(1010, 0.45, 0.46, 0.52, 0.53, liquid);
    const quote = events.find((event) => event.kind === "quote");
    expect(quote?.kind).toBe("quote");
    if (quote?.kind === "quote") {
      expect(quote.price).toBeCloseTo(0.45);
      expect(quote.shares).toBeGreaterThanOrEqual(5);
      expect(quote.shares).toBeLessThanOrEqual(20);
    }
  });

  it("rejects a quote behind a slow, deep queue", () => {
    const e = new Engine({ liveMode: true, minMakerFillProbability: 0.1 });
    e.reset(1000, 1300);
    const events = e.onBook(1010, 0.45, 0.46, 0.52, 0.53, {
      ...liquid,
      upBidLevels: [{ price: 0.45, size: 100_000 }],
      downBidLevels: [{ price: 0.52, size: 100_000 }],
      upSellTradeRateSharesPerSec: 0.01,
      downSellTradeRateSharesPerSec: 0.01,
    });
    expect(events.filter((event) => event.kind === "quote")).toHaveLength(0);
  });

  it("derives sell flow from public market trades", () => {
    const e = new Engine({ liveMode: true, minMakerFillProbability: 0.05 });
    e.reset(1000, 1300);
    e.onMarketTrade(Side.Up, "SELL", 1_000, 1009);
    e.onMarketTrade(Side.Down, "SELL", 1_000, 1009);
    e.onBook(1009, 0.45, 0.46, 0.52, 0.53, {
      upBidLevels: liquid.upBidLevels,
      downBidLevels: liquid.downBidLevels,
      upTickSize: 0.01,
      downTickSize: 0.01,
    });
    const events = e.onBook(1010, 0.45, 0.46, 0.52, 0.53, {
      upBidLevels: liquid.upBidLevels,
      downBidLevels: liquid.downBidLevels,
      upTickSize: 0.01,
      downTickSize: 0.01,
    });
    expect(events.some((event) => event.kind === "quote")).toBe(true);
  });

  it("cancels a resting quote when queue conditions deteriorate", () => {
    const e = new Engine({ liveMode: true, minMakerFillProbability: 0.05 });
    e.reset(1000, 1300);
    const first = e.onBook(1010, 0.45, 0.46, 0.52, 0.53, liquid);
    expect(first.some((event) => event.kind === "quote")).toBe(true);

    const second = e.onBook(1011, 0.45, 0.46, 0.52, 0.53, {
      ...liquid,
      upBidLevels: [{ price: 0.45, size: 100_000 }],
      downBidLevels: [{ price: 0.52, size: 100_000 }],
      upSellTradeRateSharesPerSec: 0.01,
      downSellTradeRateSharesPerSec: 0.01,
    });
    expect(second.some((event) => event.kind === "cancel")).toBe(true);
    expect(e.session.pendingQuotes()).toHaveLength(0);
  });
});
