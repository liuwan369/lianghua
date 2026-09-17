import { describe, expect, it, vi } from "vitest";
import type { MarketInfo, OrderRecord, StrategyAction, StrategyContext } from "../platform/contracts.js";
import { TradingPlatform } from "../platform/platform.js";
import { createStrategy, normalizeBtcReversalConfig, type BtcReversalConfig, type BtcReversalState } from "./btc-reversal.js";

function market(start = 1000): MarketInfo {
  return { id: `m${start}`, name: `btc-updown-5m-${start}`, startsAt: start, endsAt: start + 300,
    instruments: ["UP", "DOWN"].map(outcome => ({ tokenId: `${outcome}${start}`, outcome,
      marketId: `m${start}`, tickSize: 0.01, minOrderSize: 5 })) };
}
function fixture(config: Partial<BtcReversalConfig> = {}, restored?: BtcReversalState) {
  const persist = vi.fn();
  const strategy = createStrategy(config, restored, { persist });
  const ctx: StrategyContext = { mode: "live", now: 1000, markets: [market()], books: [],
    account: { schemaVersion: 1, accountId: "account", mode: "live", cashUsd: 10_000, positions: [], orders: [],
      risk: { halted: false, day: "2026-09-17", baselineAt: 1000, baselineEquityUsd: 10_000,
        equityUsd: 10_000, dailyPnlUsd: 0, occupiedUsd: 0, availableUsd: 10_000 } } };
  const tick = (at: number, up: number, down: number, currentMarket = market()) => {
    Object.assign(ctx, { now: at, markets: [currentMarket], books: [
      { tokenId: currentMarket.instruments[0].tokenId, ask: up, ts: at, receivedAt: at, exchangeTs: at },
      { tokenId: currentMarket.instruments[1].tokenId, ask: down, ts: at, receivedAt: at, exchangeTs: at },
    ] });
    return strategy.onEvent({ kind: "book", book: ctx.books[0] }, ctx);
  };
  const timer = (at: number) => {
    Object.assign(ctx, { now: at });
    return strategy.onEvent({ kind: "timer", ts: at }, ctx);
  };
  return { strategy, ctx, persist, tick, timer };
}
function submit(actions: readonly StrategyAction[]) {
  const action = actions.find(action => action.kind === "submit");
  if (!action || action.kind !== "submit") throw new Error("no submit intention");
  return action.order;
}
function record(order: ReturnType<typeof submit>, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return { ...order, strategyId: "btc-reversal", orderId: `exchange-${order.clientOrderId}`, status: "OPEN",
    filledShares: 0, reservedShares: 0, reservedUsd: order.price * order.shares, createdAt: 1000,
    updatedAt: 1000, ...overrides };
}

describe("BTC five-minute reversal strategy", () => {
  it("enters the first fresh in-band sample once, persists before returning and allows marketable GTC", () => {
    const f = fixture();
    const order = submit(f.tick(1000, 0.68, 0.33));
    expect(order).toMatchObject({ price: 0.7, shares: 5, tokenId: "UP1000", direction: "BUY", timeInForce: "GTC", postOnly: false });
    expect(f.persist.mock.lastCall?.[0].rounds[0].stages).toHaveLength(1);
    expect(f.strategy.snapshot().rounds[0].stages[0].trigger).toBe("initial_band_entry");
    expect(f.tick(1000.1, 0.69, 0.32)).toEqual([]);
    expect(f.tick(1000.2, 0.66, 0.35)).toEqual([]);
    expect(f.tick(1000.3, 0.67, 0.34)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0].stages).toHaveLength(1);
  });

  it("does not enter first sample above the cap but does enter a later crossing above it at the fixed limit", () => {
    const f = fixture();
    expect(f.tick(1000, 0.71, 0.30)).toEqual([]);
    expect(f.tick(1000.1, 0.66, 0.35)).toEqual([]);
    expect(submit(f.tick(1000.2, 0.71, 0.30)).price).toBe(0.7);
  });

  it("keeps unfilled and partially filled old orders and alternates directions without waiting for confirmation", () => {
    const f = fixture();
    const first = submit(f.tick(1000, 0.68, 0.33));
    f.strategy.onEvent({ kind: "order", order: record(first, { filledShares: 2, status: "PARTIAL" }) }, f.ctx);
    const second = f.tick(1000.1, 0.33, 0.68);
    expect(second).toHaveLength(1);
    expect(submit(second)).toMatchObject({ tokenId: "DOWN1000", shares: 18 });
    expect(f.strategy.snapshot().rounds[0]).toMatchObject({ confirmationCount: 0,
      stages: [{ filledShares: 2, status: "PARTIAL" }, { shares: 18, status: "CREATED" }] });
    expect(f.tick(1000.2, 0.32, 0.69)).toEqual([]);
  });

  it("processes distinct same-millisecond frames, resolves ambiguity and never duplicates a stage", () => {
    const f = fixture();
    expect(f.tick(1000, 0.68, 0.68)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0]).toMatchObject({ pendingAmbiguity: true, reason: "双边价格冲突，等待明确方向" });
    const order = submit(f.tick(1000, 0.69, 0.31));
    expect(order).toMatchObject({ tokenId: "UP1000", shares: 5 });
    expect(f.strategy.snapshot().rounds[0].pendingAmbiguity).toBe(false);
    expect(f.tick(1000, 0.69, 0.31)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0].stages).toHaveLength(1);
  });

  it("persists an invalidated ambiguity before accepting a later crossing", () => {
    const f = fixture();
    expect(f.tick(1000, 0.68, 0.68)).toEqual([]);
    expect(f.tick(1000, 0.66, 0.35)).toEqual([]);
    expect(f.persist.mock.lastCall?.[0].rounds[0]).toMatchObject({ pendingAmbiguity: false,
      reason: "双边均已回落，本次冲突信号作废" });
    expect(submit(f.tick(1000, 0.68, 0.33))).toMatchObject({ tokenId: "UP1000", shares: 5 });
  });

  it("does not add the same direction after ambiguity but adds the opposite direction once", () => {
    const f = fixture();
    expect(submit(f.tick(1000, 0.68, 0.33))).toMatchObject({ tokenId: "UP1000", shares: 5 });
    expect(f.tick(1000, 0.68, 0.68)).toEqual([]);
    expect(f.tick(1000, 0.69, 0.31)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0].stages).toHaveLength(1);
    expect(f.tick(1000, 0.68, 0.68)).toEqual([]);
    expect(submit(f.tick(1000, 0.31, 0.69))).toMatchObject({ tokenId: "DOWN1000", shares: 18 });
    expect(f.tick(1000, 0.31, 0.69)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0].stages).toHaveLength(2);
  });

  it("counts confirmations independently after the configured stage limit", () => {
    const f = fixture({ stageShares: [5, 6] });
    f.tick(1000, 0.68, 0.33);
    f.tick(1000.1, 0.33, 0.68);
    f.tick(1000.2, 0.71, 0.30);
    f.tick(1000.3, 0.30, 0.71);
    f.tick(1000.4, 0.29, 0.72);
    f.tick(1000.5, 0.71, 0.30);
    expect(f.strategy.snapshot().rounds[0]).toMatchObject({ confirmationCount: 2, lastConfirmedDirection: "UP" });
    expect(f.strategy.snapshot().rounds[0].stages).toHaveLength(2);
  });

  it("accepts any configured number of stages rather than a four-stage ceiling", () => {
    const f = fixture({ stageShares: [5, 6, 7, 8, 9, 10] });
    for (let i = 0; i < 6; i++) expect(submit(f.tick(1000 + i / 10, i % 2 ? 0.33 : 0.68, i % 2 ? 0.68 : 0.33)).shares).toBe(5 + i);
    expect(f.strategy.snapshot().rounds[0].stages).toHaveLength(6);
  });

  it("ignores first-start mid-round, then uses the next round with its own tokens", () => {
    const f = fixture();
    expect(f.tick(1100, 0.68, 0.33)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0].reason).toContain("中途启动");
    expect(f.strategy.getStatus().currentRound).toMatchObject({ marketId: "m1000", status: "waiting_next_round", isRunning: false });
    expect(submit(f.tick(1300, 0.33, 0.68, market(1300))).tokenId).toBe("DOWN1300");
  });

  it("applies a saved revision only when the next round starts, even if it was discovered in advance", () => {
    const f = fixture();
    f.tick(1000, 0.68, 0.33);
    Object.assign(f.ctx, { markets: [market(), market(1300)] });
    f.timer(1000.1);
    f.strategy.updateConfig({ revision: "2", stageShares: [9, 11], maxBuyPrice: 0.75 });
    expect(submit(f.tick(1000.2, 0.33, 0.68)).shares).toBe(18);
    expect(submit(f.tick(1300, 0.68, 0.33, market(1300)))).toMatchObject({ shares: 9, price: 0.75 });
    expect(f.strategy.getStatus().currentRound?.configRevision).toBe("2");
  });

  it("does not invent crossings across stale data or an explicit disconnect", () => {
    const f = fixture();
    f.tick(1000, 0.66, 0.35);
    f.timer(1003);
    expect(f.tick(1003.1, 0.70, 0.31)).toEqual([]);
    f.tick(1003.2, 0.66, 0.35);
    expect(submit(f.tick(1003.3, 0.70, 0.31)).shares).toBe(5);
    f.strategy.resetQuoteReference();
    expect(f.tick(1003.4, 0.31, 0.70)).toEqual([]);
    f.tick(1003.5, 0.35, 0.66);
    expect(submit(f.tick(1003.6, 0.31, 0.70)).shares).toBe(18);
  });

  it("drops a pending ambiguous signal across reconnect and rebases before trading", () => {
    const f = fixture();
    expect(f.tick(1000, 0.68, 0.68)).toEqual([]);
    f.strategy.onEvent({ kind: "error", strategyId: "btc-reversal", message: "market_feed_disconnected" }, f.ctx);
    expect(f.strategy.snapshot().rounds[0]).toMatchObject({ pendingAmbiguity: false, rebuildingReference: true });
    expect(f.tick(1000.1, 0.69, 0.31)).toEqual([]);
    expect(f.tick(1000.2, 0.66, 0.35)).toEqual([]);
    expect(submit(f.tick(1000.3, 0.69, 0.31))).toMatchObject({ tokenId: "UP1000", shares: 5 });
  });

  it("waits for both sides after a short disconnect rather than using one cached side", () => {
    const f = fixture();
    f.tick(1000, 0.66, 0.35);
    f.strategy.onEvent({ kind: "error", strategyId: "btc-reversal", message: "market_feed_disconnected" }, f.ctx);
    Object.assign(f.ctx, { now: 1000.1, books: [
      { tokenId: "UP1000", ts: 1000.1, exchangeTs: 1000.1, receivedAt: 1000.1, ask: 0.69 },
      { tokenId: "DOWN1000", ts: 1000, exchangeTs: 1000, receivedAt: 1000, ask: 0.35 },
    ] });
    expect(f.strategy.onEvent({ kind: "book", book: f.ctx.books[0] }, f.ctx)).toEqual([]);
    expect(f.tick(1000.2, 0.69, 0.32)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0].stages).toHaveLength(0);
  });

  it("does not reset the new round when an old market feed disconnects", () => {
    const f = fixture();
    f.tick(1000, 0.66, 0.35);
    f.tick(1300, 0.66, 0.35, market(1300));
    f.strategy.onEvent({ kind: "error", strategyId: "btc-reversal", message: "market_feed_disconnected", marketId: "m1000" }, f.ctx);
    expect(submit(f.tick(1300.1, 0.68, 0.33, market(1300))).tokenId).toBe("UP1300");
    f.strategy.resetQuoteReference("m1300");
    expect(f.tick(1300.2, 0.33, 0.68, market(1300))).toEqual([]);
  });

  it("requires fresh source and receive timestamps with a coherent two-sided pair", () => {
    const f = fixture();
    f.tick(1000, 0.66, 0.35);
    Object.assign(f.ctx, { now: 1002, books: [
      { tokenId: "UP1000", ts: 1002, exchangeTs: 1002, receivedAt: 1002, ask: 0.68 },
      { tokenId: "DOWN1000", ts: 1000, exchangeTs: 1000, receivedAt: 1000, ask: 0.33 },
    ] });
    expect(f.strategy.onEvent({ kind: "book", book: f.ctx.books[0] }, f.ctx)).toEqual([]);
    expect(f.tick(1002.1, 0.68, 0.33)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0].stages).toHaveLength(0);
  });

  it("rebases a multi-second feed gap even if the timer was delayed too", () => {
    const f = fixture();
    f.tick(1000, 0.66, 0.35);
    expect(f.tick(1008, 0.69, 0.32)).toEqual([]);
    f.tick(1008.1, 0.66, 0.35);
    expect(submit(f.tick(1008.2, 0.69, 0.32)).shares).toBe(5);
  });

  it("does not turn an ambiguous first frame after a long feed gap into a trade signal", () => {
    const f = fixture();
    f.tick(1000, 0.66, 0.35);
    expect(f.tick(1008, 0.68, 0.68)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0]).toMatchObject({ pendingAmbiguity: false, rebuildingReference: false,
      reason: "行情已恢复，等待下一次跨价" });
    expect(f.tick(1008.1, 0.69, 0.31)).toEqual([]);
    expect(f.tick(1008.2, 0.66, 0.35)).toEqual([]);
    expect(submit(f.tick(1008.3, 0.69, 0.31))).toMatchObject({ tokenId: "UP1000", shares: 5 });
  });

  it("waits for contradictory books to resolve before choosing a side", () => {
    const f = fixture();
    expect(f.tick(1000, 0.70, 0.70)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0].lastConfirmedDirection).toBeUndefined();
    expect(submit(f.tick(1000.1, 0.72, 0.30)).tokenId).toBe("UP1000");
    expect(f.tick(1000.2, 0.66, 0.35)).toEqual([]);
    expect(f.tick(1000.3, 0.67, 0.34)).toEqual([]);
  });

  it("retains stages across restart, rebases prices, and never resubmits an already known order", () => {
    const original = fixture();
    const first = submit(original.tick(1000, 0.68, 0.33));
    original.strategy.onEvent({ kind: "order", order: record(first) }, original.ctx);
    const restarted = fixture({}, JSON.parse(JSON.stringify(original.strategy.exportState())));
    expect(restarted.tick(1000.2, 0.33, 0.68)).toEqual([]);
    restarted.tick(1000.3, 0.35, 0.66);
    const second = submit(restarted.tick(1000.4, 0.33, 0.68));
    expect(second.clientOrderId).toBe("btc-reversal:m1000:2");
    expect(restarted.strategy.snapshot().rounds[0].stages).toHaveLength(2);
  });

  it("replays a saved undispatched intent under its original id exactly once after a crash", () => {
    const original = fixture();
    const first = submit(original.tick(1000, 0.68, 0.33));
    const restarted = fixture({}, original.strategy.exportState());
    expect(submit(restarted.tick(1000.1, 0.33, 0.68))).toEqual(first);
    expect(restarted.tick(1000.2, 0.33, 0.68)).toEqual([]);
    expect(restarted.strategy.snapshot().rounds[0].stages).toHaveLength(1);
  });

  it("does not treat a missed opening during process downtime as a new-round first sample", () => {
    const original = fixture();
    Object.assign(original.ctx, { now: 999 });
    original.timer(999);
    const restarted = fixture({}, original.strategy.snapshot());
    expect(restarted.tick(1005, 0.68, 0.33)).toEqual([]);
    expect(restarted.strategy.snapshot().rounds[0].status).toBe("waiting_next_round");
    expect(submit(restarted.tick(1300, 0.68, 0.33, market(1300))).tokenId).toBe("UP1300");
  });

  it("does not replay a CREATED stage if the restored core already knows its terminal order", () => {
    const original = fixture();
    const order = submit(original.tick(1000, 0.68, 0.33));
    const restarted = fixture({}, original.strategy.snapshot());
    restarted.strategy.onEvent({ kind: "order", order: record(order, { status: "FILLED", filledShares: 5 }) }, restarted.ctx);
    expect(restarted.tick(1000.1, 0.68, 0.33)).toEqual([]);
    expect(restarted.strategy.snapshot().rounds[0].stages[0].status).toBe("FILLED");
  });

  it("pauses only new stages and still cancels real remainders at the cutoff", () => {
    const f = fixture();
    const first = submit(f.tick(1000, 0.68, 0.33));
    f.strategy.onEvent({ kind: "order", order: record(first, { filledShares: 2, status: "PARTIAL" }) }, f.ctx);
    f.strategy.setPaused(true);
    expect(f.tick(1000.1, 0.33, 0.68)).toEqual([]);
    f.strategy.setPaused(false);
    expect(f.tick(1000.2, 0.33, 0.68)).toEqual([]);
    expect(f.timer(1300)).toEqual([{ kind: "cancel", orderId: `exchange-${first.clientOrderId}` }]);
    expect(f.timer(1300.2)).toEqual([]);
    expect(f.timer(1301)).toHaveLength(1);
    f.strategy.onEvent({ kind: "order", order: record(first, { status: "CANCELLED", filledShares: 2 }) }, f.ctx);
    expect(f.timer(1302)).toEqual([]);
  });

  it("does not invent a final-seconds entry ban and never creates a post-cutoff stage", () => {
    const f = fixture();
    f.tick(1000, 0.66, 0.35);
    // Keep a current continuous reference; the exact cutoff is the only time boundary.
    f.tick(1299.8, 0.66, 0.35);
    expect(submit(f.tick(1299.9, 0.68, 0.33)).shares).toBe(5);
    expect(f.tick(1300, 0.33, 0.68)).toEqual([]);
  });

  it("uses configured budgets and actual available funds without historic $50/$30 constants", () => {
    const f = fixture({ stageShares: [100, 100], roundBudgetUsd: 140, totalBudgetUsd: 1000 });
    expect(submit(f.tick(1000, 0.68, 0.33)).shares).toBe(100);
    expect(submit(f.tick(1000.1, 0.33, 0.68)).shares).toBe(100);
    const lowBudget = fixture({ roundBudgetUsd: 3 });
    expect(lowBudget.tick(1000, 0.68, 0.33)).toEqual([]);
    expect(lowBudget.strategy.snapshot().rounds[0].reason).toContain("单场预算");
    const lowCash = fixture();
    lowCash.ctx.account.risk.availableUsd = 3;
    expect(lowCash.tick(1000, 0.68, 0.33)).toEqual([]);
    expect(lowCash.strategy.snapshot().rounds[0].reason).toContain("可用余额不足");
  });

  it("includes the venue fee reserve in round, total and available-cash checks", () => {
    for (const config of [{ roundBudgetUsd: 3.5 }, { totalBudgetUsd: 3.5 }, {}]) {
      const f = fixture(config);
      Object.assign(f.ctx, { estimateFee: () => 0.1 });
      if (!Object.keys(config).length) f.ctx.account.risk.availableUsd = 3.5;
      expect(f.tick(1000, 0.68, 0.33)).toEqual([]);
      expect(f.strategy.snapshot().rounds[0].stages).toHaveLength(0);
    }
  });

  it("uses actual filled cost plus pending fee reserves, and forwards the per-round cap for core enforcement", () => {
    const f = fixture({ stageShares: [5, 5], roundBudgetUsd: 6.7 });
    Object.assign(f.ctx, { estimateFee: () => 0.1 });
    const first = submit(f.tick(1000, 0.68, 0.33));
    expect(first.roundBudgetUsd).toBe(6.7);
    f.strategy.onEvent({ kind: "order", order: record(first, { status: "FILLED", filledShares: 5, reservedUsd: 0 }) }, f.ctx);
    Object.assign(f.ctx.account, { positions: [{ tokenId: "UP1000", shares: 5, costUsd: 3.1, realizedPnlUsd: 0 }] });
    expect(submit(f.tick(1000.1, 0.33, 0.68))).toMatchObject({ shares: 5, roundBudgetUsd: 6.7 });
    expect(f.strategy.snapshot().rounds[0].stages[1].feeReserveUsd).toBe(0.1);
    const restored = fixture({}, f.strategy.snapshot());
    expect(submit(restored.tick(1000.2, 0.33, 0.68)).roundBudgetUsd).toBe(6.7);
  });

  it("releases a definitively rejected local intent and does not replay it after restart", () => {
    const f = fixture({ stageShares: [5, 5], roundBudgetUsd: 3.5, totalBudgetUsd: 3.5 });
    const first = submit(f.tick(1000, 0.68, 0.33));
    f.strategy.onEvent({ kind: "error", strategyId: "btc-reversal", clientOrderId: first.clientOrderId,
      code: "order_not_submitted", message: "per-order limit" }, f.ctx);
    expect(f.strategy.snapshot().rounds[0].stages[0].status).toBe("REJECTED");
    const restored = fixture({}, f.strategy.snapshot());
    expect(restored.tick(1000.1, 0.68, 0.33)).toEqual([]);
    expect(submit(f.tick(1000.2, 0.33, 0.68))).toMatchObject({ shares: 5, tokenId: "DOWN1000" });
  });

  it("does not relabel an unknown exchange submission as a definitively rejected intent", () => {
    const f = fixture();
    const first = submit(f.tick(1000, 0.68, 0.33));
    f.strategy.onEvent({ kind: "order", order: record(first, { status: "UNKNOWN" }) }, f.ctx);
    f.strategy.onEvent({ kind: "error", strategyId: "btc-reversal", clientOrderId: first.clientOrderId,
      message: "gateway timeout" }, f.ctx);
    expect(f.strategy.snapshot().rounds[0].stages[0].status).toBe("UNKNOWN");
    const restored = fixture({}, f.strategy.snapshot());
    expect(restored.tick(1000.1, 0.68, 0.33)).toEqual([]);
  });

  it("validates dynamic exchange limits and rejects corrupt persisted stage identities", () => {
    expect(() => normalizeBtcReversalConfig({ stageShares: [] })).toThrow();
    expect(() => normalizeBtcReversalConfig({ stageShares: [5], maxStages: 2 })).toThrow();
    expect(() => normalizeBtcReversalConfig({ triggerPrice: 0.8 })).toThrow();
    const f = fixture({ stageShares: [1] });
    expect(f.tick(1000, 0.68, 0.33)).toEqual([]);
    expect(f.strategy.snapshot().rounds[0].reason).toContain("交易所规则");
    const ok = fixture(); ok.tick(1000, 0.68, 0.33);
    const bad = ok.strategy.exportState(); bad.rounds[0].stages[0].clientOrderId = "replacement";
    expect(() => createStrategy({}, bad)).toThrow("persisted reversal stage");
    const snapshot = ok.strategy.snapshot(); snapshot.rounds[0].stages.length = 0;
    expect(ok.strategy.snapshot().rounds[0].stages).toHaveLength(1);
  });

  it("does not return a submit when critical stage persistence fails", () => {
    const f = fixture();
    f.persist.mockImplementation(() => { throw new Error("disk failure"); });
    expect(() => f.tick(1000, 0.68, 0.33)).toThrow("disk failure");
  });

  it("receives the core's definitive pre-submit rejection without keeping a phantom reservation", async () => {
    const gateway = { mode: "live" as const,
      submit: vi.fn(async () => ({ status: "accepted" as const, orderId: "not-sent" })), cancel: vi.fn(async () => true) };
    const platform = new TradingPlatform({ account: { accountId: "account", at: 1000, cashUsd: 1000,
      complete: true, positions: [], openOrders: [] }, instruments: [], now: () => 1000,
      limits: { capitalUsd: 1000, dailyLossUsd: 1000, maxOrderUsd: 1, maxOpenOrders: 20 }, adapters: { gateway } });
    const strategy = createStrategy(); platform.attach(strategy);
    platform.ingest({ kind: "market", market: market() });
    platform.ingest({ kind: "book", book: { tokenId: "UP1000", ts: 1000, ask: 0.68 } });
    platform.ingest({ kind: "book", book: { tokenId: "DOWN1000", ts: 1000, ask: 0.33 } });
    await platform.idle();
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(platform.orders.list()).toHaveLength(0);
    expect(strategy.snapshot().rounds[0].stages[0]).toMatchObject({ status: "REJECTED", error: "per-order limit" });
    const restored = fixture({}, strategy.snapshot());
    expect(restored.tick(1000.1, 0.68, 0.33)).toEqual([]);
    await platform.stop();
  });

  it("uses the shared core for order identity and remainder cancellation", async () => {
    let now = 1000;
    const gateway = { mode: "live" as const, submit: vi.fn(async () => ({ status: "accepted" as const, orderId: "venue-one" })),
      cancel: vi.fn(async () => true) };
    const platform = new TradingPlatform({ account: { accountId: "account", at: now, cashUsd: 1000, complete: true, positions: [], openOrders: [] },
      instruments: [], now: () => now, limits: { capitalUsd: 1000, dailyLossUsd: 1000, maxOrderUsd: 1000, maxOpenOrders: 20 },
      adapters: { gateway } });
    const strategy = createStrategy();
    platform.attach(strategy);
    platform.ingest({ kind: "market", market: market() });
    platform.ingest({ kind: "book", book: { tokenId: "UP1000", ts: now, ask: 0.68, bid: 0.66 } });
    platform.ingest({ kind: "book", book: { tokenId: "DOWN1000", ts: now, ask: 0.33, bid: 0.31 } });
    await platform.idle();
    expect(gateway.submit).toHaveBeenCalledOnce();
    expect(strategy.snapshot().rounds[0].stages[0].orderId).toBe("venue-one");
    platform.ingest({ kind: "fill", fill: { tradeId: "partial", orderId: "venue-one", tokenId: "UP1000", direction: "BUY",
      price: 0.68, shares: 2, feeUsd: 0, ts: now, isMaker: false } });
    await platform.idle();
    expect(strategy.snapshot().rounds[0].stages[0].filledShares).toBe(2);
    now = 1300;
    platform.ingest({ kind: "timer", ts: now });
    await platform.idle();
    expect(gateway.cancel).toHaveBeenCalledWith("venue-one");
    expect(platform.orders.list()).toHaveLength(1);
    expect(platform.portfolio.positions()[0].shares).toBe(2);
    platform.core.confirmCancelled("venue-one", true);
    await platform.stop();
  });
});
