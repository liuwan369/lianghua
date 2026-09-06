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
