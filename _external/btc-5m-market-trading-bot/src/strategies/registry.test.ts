import { describe, expect, it, vi } from "vitest";
import { targetClone } from "../config.js";
import { MakerSession } from "../live-maker.js";
import { Engine } from "../live/engine.js";
import { Side } from "../models.js";
import { RiskState } from "../risk.js";
import { buyStrategyFactory, createBuyStrategy } from "./registry.js";
import type { BuyStrategyFactory } from "./types.js";

const ticks = { upTickSize: 0.01, downTickSize: 0.01 };

describe("BUY strategy boundary", () => {
  it("runs an independent injected strategy through the existing session and engine", () => {
    const chooseSide = vi.fn(() => Side.Down);
    const recordFill = vi.fn();
    const factory: BuyStrategyFactory = (config) => {
      const risk = new RiskState();
      return {
        id: "test-independent", executionMode: "buy", config, risk,
        onMarketStart: (start) => risk.onMarketStart(start, config),
        onMarketEnd: (pnl, ts) => risk.onMarketEnd(pnl, ts, config),
        chooseSide, recordFill,
        buildFill: (side, _inventory, _book, ts) => ({
          side, price: 0.52, shares: 5, tsUnix: ts, isMaker: true,
        }),
        lastDecisionRejection: () => null,
      };
    };
    const engine = new Engine({ strategyFactory: factory, minMakerFillProbability: 0,
      decisionIntervalMs: 60_000, liveMode: true });
    engine.reset(1000, 1300);
    expect(engine.strategyId).toBe("test-independent");
    expect(engine.onBook(1010, 0.45, 0.46, 0.52, 0.53, ticks)).toContainEqual({
      kind: "quote", side: Side.Down, price: 0.52, shares: 5,
    });
    engine.confirmExchangeFill({ side: Side.Down, price: 0.52, shares: 5,
      tsUnix: 1010.01, isMaker: true });
    expect(recordFill).toHaveBeenCalledOnce();
    expect(engine.onBook(1010.02, 0.45, 0.46, 0.52, 0.53, ticks)).toEqual([]);
    expect(engine.onBook(1010.03, 0.45, 0.46, 0.52, 0.53, ticks, true))
      .toContainEqual({ kind: "quote", side: Side.Down, price: 0.52, shares: 5 });
    expect(chooseSide).toHaveBeenCalledTimes(2);
  });

  it("keeps the default algorithm and both legacy parameter presets unchanged", () => {
    for (const passiveBudget of [false, true]) {
      const implicit = new Engine({ passiveBudget, minMakerFillProbability: 0 });
      const explicit = new Engine({ strategyId: "pair-cost", passiveBudget,
        minMakerFillProbability: 0 });
      implicit.reset(1000, 1300);
      explicit.reset(1000, 1300);
      expect(explicit.strategyId).toBe("pair-cost");
      expect(explicit.preset).toBe(passiveBudget ? "passive_budget_clone" : "target_clone");
      expect(explicit.onBook(1010, 0.45, 0.46, 0.52, 0.53, ticks))
        .toEqual(implicit.onBook(1010, 0.45, 0.46, 0.52, 0.53, ticks));
    }
  });

  it("observes books and fills without generating quote, taker or cancellation intents", () => {
    const engine = new Engine({ strategyId: "observe" });
    engine.reset(1000, 1300);
    engine.onBtc(1010, 100_000);
    expect(engine.onBook(1010, 0.45, 0.46, 0.52, 0.53, ticks)).toEqual([]);
    engine.confirmExchangeFill({ side: Side.Up, shares: 5, price: 0.45,
      tsUnix: 1010, isMaker: true });
    engine.onMarketTrade(Side.Down, "SELL", 10_000, 1010.01);
    expect(engine.onBook(1010.02, 0.45, 0.46, 0.52, 0.53, ticks, true)).toEqual([]);
    expect(engine.onBook(1299, 0.45, 0.46, 0.52, 0.53, ticks, true)).toEqual([]);
    expect(engine.fills()).toBe(1);
    expect(engine.session.pendingQuotes()).toEqual([]);
    expect(engine.resolve(Side.Up).pnl).toBeCloseTo(2.75);
  });

  it("rejects live observation before the orchestrator can create an executor or exit orders", () => {
    expect(() => new Engine({ strategyId: "observe", liveMode: true })).toThrow("paper-only");
    expect(() => new Engine({ strategyFactory: buyStrategyFactory("observe"), liveMode: true }))
      .toThrow("paper-only");
    expect(() => new MakerSession(targetClone(), 15, 0, 0, true, undefined,
      buyStrategyFactory("observe"))).toThrow("paper-only");
  });

  it("rejects unknown IDs and ambiguous factory selection instead of using the default", () => {
    for (const id of ["unknown", "", "constructor", "target_clone"]) {
      expect(() => createBuyStrategy(id, targetClone())).toThrow("Unknown strategy");
      expect(() => new Engine({ strategyId: id })).toThrow("Unknown strategy");
    }
    expect(() => new Engine({ strategyId: "pair-cost", strategyFactory: buyStrategyFactory() }))
      .toThrow("not both");
  });
});
