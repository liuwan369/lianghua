import { describe, expect, it, vi } from "vitest";
import type { AccountSnapshot, Instrument, OrderGateway, OrderRequest } from "./contracts.js";
import { TradingCore } from "./core.js";
import { PaperGateway } from "./paper.js";

const instrument: Instrument = { tokenId: "up", marketId: "m", outcome: "UP", tickSize: 0.01, minOrderSize: 1 };
const account: AccountSnapshot = { accountId: "paper", at: 100, cashUsd: 20, positions: [], openOrders: [], complete: true };
const request = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({
  clientOrderId: "buy-1", strategyId: "s", tokenId: "up", direction: "BUY", price: 0.5,
  shares: 4, timeInForce: "GTC", postOnly: true, ...overrides,
});

function setup() {
  let sequence = 0;
  const gateway: OrderGateway = {
    mode: "paper",
    async submit() { return { status: "accepted", orderId: `order-${++sequence}` }; },
    async cancel() { return true; },
  };
  const core = new TradingCore({ account, instruments: [instrument], limits: {
    capitalUsd: 20, dailyLossUsd: 30, maxOrderUsd: 10, maxOpenOrders: 10,
  }, adapters: { gateway, estimateFee: () => 0.01 } });
  return core;
}

describe("strategy-independent account core", () => {
  it("applies a later reported fee once after confirmation", async () => {
    const core = setup(), order = await core.submit(request());
    const fill = { tradeId: "fee-fix", orderId: order.orderId!, tokenId: "up", direction: "BUY" as const,
      price: 0.5, shares: 2, feeUsd: 0.05, feeSource: "estimate" as const, ts: 101, isMaker: false, status: "MATCHED" as const };
    core.applyFill(fill); core.applyFill({ ...fill, status: "CONFIRMED" });
    expect(core.applyFill({ ...fill, feeUsd: 0.03, feeSource: "reported", status: "CONFIRMED" })).toBe(true);
    expect(core.snapshot().cashUsd).toBeCloseTo(18.97);
    expect(core.positions()[0].costUsd).toBeCloseTo(1.03);
    expect(core.applyFill({ ...fill, feeUsd: 0.03, feeSource: "reported", status: "CONFIRMED" })).toBe(false);
  });

  it("halts strategy context while account recovery is in progress", async () => {
    const core = setup();
    core.setRecovering(true);
    expect(core.contextSnapshot().risk).toMatchObject({ halted: true, reason: "账户恢复中" });
    await expect(core.submit(request())).rejects.toThrow("account recovery in progress");
    expect(core.orders()).toHaveLength(0);
    core.setRecovering(false);
  });
  it("reserves venue fees inside the user round budget before any request reaches the gateway", async () => {
    const core = setup();
    await expect(core.submit(request({ roundBudgetUsd: 2 }))).rejects.toThrow("round budget including fees");
    expect(core.orders()).toHaveLength(0);
    const accepted = await core.submit(request({ roundBudgetUsd: 2.01 }));
    expect(accepted.status).toBe("OPEN");
  });

  it("keeps a prepared identity and fill received before a missing HTTP ACK", async () => {
    let core!: TradingCore;
    const gateway: OrderGateway = { mode: "live", cancel: async () => true,
      submit: async (_request, _instrument, prepared) => {
        prepared!({ orderHash: "venue-hash", signedPayload: { signature: "signed" }, preparedAt: 101 });
        core.applyFill({ tradeId: "early", orderId: "venue-hash", tokenId: "up", direction: "BUY",
          price: 0.5, shares: 4, feeUsd: 0, ts: 101, isMaker: false, status: "MATCHED" });
        return { status: "accepted", orderId: "venue-hash" };
      } };
    core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway } });
    const order = await core.submit(request());
    expect(order).toMatchObject({ orderId: "venue-hash", status: "FILLED", filledShares: 4 });
    expect(core.snapshot().cashUsd).toBe(18);
  });

  it("preserves prepared identity and reservations when the HTTP ACK is unknown", async () => {
    const gateway: OrderGateway = { mode: "live", cancel: async () => true,
      submit: async (_request, _instrument, prepared) => {
        prepared!({ orderHash: "lost-ack-hash", signedPayload: { signature: "signed" }, preparedAt: 101 });
        return { status: "unknown", error: "timeout" };
      } };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway } });
    const order = await core.submit(request());
    expect(order).toMatchObject({ orderId: "lost-ack-hash", status: "UNKNOWN", reservedUsd: 2 });
    expect(core.risk().halted).toBe(true);
  });
  it("compensates a failed provisional fill exactly once and blocks duplicate resubmission", async () => {
    const core = setup(), order = await core.submit(request());
    const fill = { tradeId: "provisional", orderId: order.orderId!, tokenId: "up", direction: "BUY" as const,
      price: 0.5, shares: 2, feeUsd: 0.01, ts: 101, isMaker: false, status: "MATCHED" as const };
    core.applyFill(fill);
    expect(core.snapshot().cashUsd).toBeCloseTo(18.99);
    expect(core.applyFill({ ...fill, status: "FAILED" })).toBe(true);
    expect(core.snapshot().cashUsd).toBe(20);
    expect(core.positions()[0]).toMatchObject({ shares: 0, costUsd: 0 });
    expect(core.order(order.orderId!)?.status).toBe("UNKNOWN");
    expect(core.order(order.orderId!)?.reservedUsd).toBeCloseTo(2.01);
    expect(core.risk().halted).toBe(true);
    expect(core.applyFill({ ...fill, status: "FAILED" })).toBe(false);
    expect(core.applyFill({ ...fill, status: "MATCHED" })).toBe(false);
    expect((await core.submit(request())).orderId).toBe(order.orderId);
  });

  it("processes confirmation without charging a fill twice and ignores a late failure", async () => {
    const core = setup(), order = await core.submit(request());
    const fill = { tradeId: "confirmed", orderId: order.orderId!, tokenId: "up", direction: "BUY" as const,
      price: 0.5, shares: 2, feeUsd: 0.01, ts: 101, isMaker: false, status: "MATCHED" as const };
    core.applyFill(fill); core.applyFill({ ...fill, status: "MINED" }); core.applyFill({ ...fill, status: "CONFIRMED" });
    expect(core.applyFill({ ...fill, status: "FAILED" })).toBe(false);
    expect(core.snapshot().cashUsd).toBeCloseTo(18.99);
    expect(core.snapshot().fills).toHaveLength(1);
    expect(core.snapshot().fills[0].status).toBe("CONFIRMED");
  });
  it("accounts BUY and SELL fills by order identity and reserves shares separately", async () => {
    const core = setup();
    const buy = await core.submit(request());
    expect(buy.status).toBe("OPEN");
    expect(core.risk().availableUsd).toBeCloseTo(17.99, 8);

    expect(core.applyFill({ tradeId: "t1", orderId: buy.orderId!, tokenId: "up", direction: "BUY",
      price: 0.5, shares: 2, feeUsd: 0.01, ts: 101, isMaker: true })).toBe(true);
    expect(core.applyFill({ tradeId: "t1", orderId: buy.orderId!, tokenId: "up", direction: "BUY",
      price: 0.5, shares: 2, feeUsd: 0.01, ts: 101, isMaker: true })).toBe(false);
    const sell = await core.submit(request({ clientOrderId: "sell-1", direction: "SELL", price: 0.6, shares: 1, postOnly: true }));
    expect(sell.status).toBe("OPEN");
    expect(sell.reservedShares).toBe(1);
    expect(core.positions()[0]).toMatchObject({ shares: 2, costUsd: 1.01 });

    expect(core.applyFill({ tradeId: "t2", orderId: sell.orderId!, tokenId: "up", direction: "SELL",
      price: 0.6, shares: 1, feeUsd: 0.01, ts: 102, isMaker: true })).toBe(true);
    expect(core.positions()[0]?.realizedPnlUsd).toBeCloseTo(0.085, 8);
    expect(core.snapshot().cashUsd).toBeCloseTo(19.58, 8);
  });

  it("rejects a fill outside the submitted limit and keeps the account unchanged", async () => {
    const core = setup();
    const order = await core.submit(request({ shares: 2 }));
    expect(() => core.applyFill({ tradeId: "too-high", orderId: order.orderId!, tokenId: "up", direction: "BUY",
      price: 0.51, shares: 1, feeUsd: 0, ts: 101, isMaker: false })).toThrow("invalid or unowned fill");
    expect(core.positions()).toEqual([]);
    expect(core.order(order.orderId!)?.filledShares).toBe(0);
  });

  it("does not turn a committed immediate paper fill into an unknown cancellation", async () => {
    let core!: TradingCore;
    const paper = new PaperGateway(fill => core.applyFill(fill), () => 0,
      orderId => core.confirmCancelled(orderId, true));
    const coreAccount = { ...account, accountId: "paper-immediate" };
    core = new TradingCore({ account: coreAccount, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: 30, maxOrderUsd: 10, maxOpenOrders: 10,
    }, adapters: { gateway: paper, estimateFee: () => 0 } });
    const crossedBook = { tokenId: "up", ts: 100, bid: 0.4, ask: 0.5, bidSize: 5, askSize: 5 };
    paper.book(crossedBook);
    expect(core.mark(crossedBook)).toBe(true);
    const submitted = await core.submit(request({ postOnly: false, price: 0.5 }));
    const afterCancel = await core.cancel(submitted.orderId!);
    expect(afterCancel.status).toBe("FILLED");
    expect(core.risk().halted).toBe(false);
    await paper.close();
  });

  it("exposes sorted depth and rejects malformed depth before strategies see it", () => {
    const core = setup();
    expect(core.mark({ tokenId: "up", ts: 1, bid: 0.4, ask: 0.41,
      bids: [[0.4, 5], [0.39, 3]], asks: [[0.41, 4], [0.42, 2]], sourceAgeMs: 18, processingLatencyMs: 0.2 })).toBe(true);
    expect(core.mark({ tokenId: "up", ts: 2, bid: 0.4, ask: 0.41, bids: [[0.4, -1]] })).toBe(false);
    expect(core.mark({ tokenId: "up", ts: 3, bid: 0.4, ask: 0.41, bids: [[0.39, 3], [0.4, 5]] })).toBe(false);
    expect(core.mark({ tokenId: "up", ts: 4, bid: 0.4, ask: 0.41,
      bids: [[0.39, 5]], asks: [[0.41, 4]] })).toBe(false);
    expect(core.mark({ tokenId: "up", ts: 5, bid: 0.4, bidSize: 7,
      bids: [[0.4, 5]] })).toBe(false);
  });

  it("rejects a client ID that collides with a venue order ID", async () => {
    const core = setup();
    const first = await core.submit(request());
    expect(first.orderId).toBe("order-1");
    await expect(core.submit(request({ clientOrderId: "order-1" }))).rejects.toThrow("conflicts");
  });

  it("keeps a cancel reservation until a late fill is reconciled", async () => {
    const core = setup();
    const buy = await core.submit(request({ shares: 4 }));
    expect((await core.cancel(buy.orderId!)).status).toBe("CANCELLED");
    expect(core.order(buy.orderId!)?.reconciliationPending).toBe(true);
    expect(() => core.applyFill({ tradeId: "late", orderId: buy.orderId!, tokenId: "up", direction: "BUY",
      price: 0.5, shares: 1, feeUsd: 0.01, ts: 101, isMaker: true })).not.toThrow();
    expect(core.order(buy.orderId!)?.reservedUsd).toBeGreaterThan(0);
    core.reconcile({ ...account, at: 102, cashUsd: 19.49, openOrders: [], complete: true });
    expect(core.order(buy.orderId!)?.reconciliationPending).toBe(false);
    expect(core.order(buy.orderId!)?.reservedUsd).toBe(0);
    expect(() => core.applyFill({ tradeId: "too-late", orderId: buy.orderId!, tokenId: "up", direction: "BUY",
      price: 0.5, shares: 1, feeUsd: 0.01, ts: 103, isMaker: true })).toThrow("invalid or unowned fill");
  });

  it("commits stage, reservation and signed identity in one critical persistence call", async () => {
    const saves: Array<{ critical: boolean; state: ReturnType<TradingCore["snapshot"]> }> = [];
    let deferred = 0;
    const gateway: OrderGateway = { mode: "live", durableIdentity: true, cancel: async () => true,
      submit: async (_request, _instrument, prepared) => {
        prepared!({ orderHash: "signed-1", signedPayload: { signature: "signed" }, preparedAt: 101 });
        return { status: "accepted", orderId: "signed-1", signLatencyMs: 2, ackLatencyMs: 40 };
      } };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway, deferPersistence: () => { deferred += 1; },
      persist: (state, critical) => saves.push({ critical, state }) } });
    core.setStrategyState("s", { stage: 1 });
    const order = await core.submit(request());
    expect(deferred).toBe(1);
    expect(saves.filter(save => save.critical)).toHaveLength(1);
    expect(saves.find(save => save.critical)?.state).toMatchObject({
      strategyStates: { s: { stage: 1 } },
      orders: [{ clientOrderId: "buy-1", orderId: "signed-1", status: "SUBMITTING" }],
    });
    expect(order).toMatchObject({ status: "OPEN", orderId: "signed-1", signLatencyMs: 2, ackLatencyMs: 40 });
  });

  it("does not include an unprepared concurrent order in another order's durable commit", async () => {
    const critical: Array<ReturnType<TradingCore["snapshot"]>> = [];
    const acknowledgements: Array<() => void> = [];
    let calls = 0;
    const gateway: OrderGateway = { mode: "live", durableIdentity: true, cancel: async () => true,
      submit: async (submitted, _instrument, prepared) => {
        calls += 1;
        prepared!({ orderHash: `signed-${submitted.clientOrderId}`, signedPayload: { signature: submitted.clientOrderId }, preparedAt: 101 });
        await new Promise<void>(resolve => acknowledgements.push(resolve));
        return { status: "accepted", orderId: `signed-${submitted.clientOrderId}` };
      } };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway, deferPersistence: () => undefined,
      persist: (state, isCritical) => { if (isCritical) critical.push(state); } } });
    const first = core.submit(request({ clientOrderId: "one", shares: 1 }));
    const second = core.submit(request({ clientOrderId: "two", shares: 1 }));
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(critical).toHaveLength(2);
    for (const state of critical) {
      expect(state.orders.filter(order => order.status === "SUBMITTING").every(order => !!order.prepared)).toBe(true);
    }
    acknowledgements.forEach(resolve => resolve());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("rechecks available capital after a concurrent durable order reserves funds", async () => {
    let acknowledge!: () => void;
    let calls = 0;
    const gateway: OrderGateway = { mode: "live", durableIdentity: true, cancel: async () => true,
      submit: async (submitted, _instrument, prepared) => {
        calls += 1;
        prepared!({ orderHash: `signed-${submitted.clientOrderId}`,
          signedPayload: { signature: submitted.clientOrderId }, preparedAt: 101 });
        await new Promise<void>(resolve => { acknowledge = resolve; });
        return { status: "accepted", orderId: `signed-${submitted.clientOrderId}` };
      } };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 3, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway, estimateFee: () => 0, deferPersistence: () => undefined } });

    const first = core.submit(request({ clientOrderId: "one" }));
    const rejected = expect(core.submit(request({ clientOrderId: "two" })))
      .rejects.toThrow("insufficient cash or capital");
    await vi.waitFor(() => expect(calls).toBe(1));
    await rejected;
    expect(core.orders()).toHaveLength(1);
    expect(core.risk().availableUsd).toBe(1);
    acknowledge();
    await expect(first).resolves.toMatchObject({ status: "OPEN", orderId: "signed-one" });
  });

  it("durably saves a signed explicit rejection before releasing its reservation", async () => {
    const critical: Array<ReturnType<TradingCore["snapshot"]>> = [];
    const gateway: OrderGateway = { mode: "live", durableIdentity: true, cancel: async () => true,
      submit: async (_submitted, _instrument, prepared) => {
        prepared!({ orderHash: "signed-rejected", signedPayload: { signature: "rejected" }, preparedAt: 101 });
        return { status: "rejected", error: "venue rejected" };
      } };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway, deferPersistence: () => undefined,
      persist: (state, isCritical) => { if (isCritical) critical.push(state); } } });
    await expect(core.submit(request())).resolves.toMatchObject({ status: "REJECTED", reservedUsd: 0 });
    expect(critical.at(-1)?.orders[0]).toMatchObject({ status: "REJECTED", reservedUsd: 0, reservedShares: 0 });
  });

  it("durably saves an unknown halt when the venue ACK changes the signed order identity", async () => {
    const critical: Array<ReturnType<TradingCore["snapshot"]>> = [];
    const gateway: OrderGateway = { mode: "live", durableIdentity: true, cancel: async () => true,
      submit: async (_submitted, _instrument, prepared) => {
        prepared!({ orderHash: "signed-order", signedPayload: { signature: "signed" }, preparedAt: 101 });
        return { status: "accepted", orderId: "different-venue-order" };
      } };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway, deferPersistence: () => undefined,
      persist: (state, isCritical) => { if (isCritical) critical.push(state); } } });

    await expect(core.submit(request())).resolves.toMatchObject({
      status: "UNKNOWN", orderId: "different-venue-order",
      error: "signed hash differs from venue order ID",
    });
    expect(critical.at(-1)).toMatchObject({
      risk: { halted: true, reason: "signed identity requires reconciliation" },
      orders: [{ status: "UNKNOWN", orderId: "different-venue-order" }],
    });
  });

  it("durably saves an unknown halt when a venue order ID collides", async () => {
    const critical: Array<ReturnType<TradingCore["snapshot"]>> = [];
    let calls = 0;
    const gateway: OrderGateway = { mode: "live", cancel: async () => true,
      submit: async () => {
        calls += 1;
        return { status: "accepted", orderId: "venue-one" };
      } };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway,
      persist: (state, isCritical) => { if (isCritical) critical.push(state); } } });

    await expect(core.submit(request({ clientOrderId: "one" }))).resolves.toMatchObject({ status: "OPEN" });
    await expect(core.submit(request({ clientOrderId: "two" }))).resolves.toMatchObject({
      status: "UNKNOWN", error: "duplicate venue order ID requires reconciliation",
    });
    expect(critical.at(-1)).toMatchObject({
      risk: { halted: true, reason: "unknown order requires reconciliation" },
      orders: [{ status: "OPEN", orderId: "venue-one" },
        { status: "UNKNOWN", error: "duplicate venue order ID requires reconciliation" }],
    });
  });

  it("records ACK and reaction latency only for an explicitly accepted result", async () => {
    const events: string[] = [];
    const accepted = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway: { mode: "paper", cancel: async () => true, submit: async () => ({
      status: "accepted", orderId: "accepted", signLatencyMs: 2, ackLatencyMs: 40,
      totalLatencyMs: 50, triggerToPostLatencyMs: 8, decisionToPostLatencyMs: 3, reactionLatencyMs: 55,
    }) } }, onEvent: event => { if (event.kind === "latency") events.push(event.metric); } });
    await accepted.submit(request());
    expect(events).toEqual(expect.arrayContaining(["order_sign", "order_submit_roundtrip", "trigger_to_http_post",
      "decision_to_http_post", "order_http_ack", "reaction"]));

    const rejectedEvents: string[] = [];
    const rejected = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway: { mode: "paper", cancel: async () => true, submit: async () => ({
      status: "rejected", signLatencyMs: 2, ackLatencyMs: 10, totalLatencyMs: 12, reactionLatencyMs: 15,
    }) } }, onEvent: event => { if (event.kind === "latency") rejectedEvents.push(event.metric); } });
    await rejected.submit(request());
    expect(rejectedEvents).not.toContain("order_http_ack");
    expect(rejectedEvents).not.toContain("reaction");
  });

  it("deduplicates an in-flight submission by client order ID", async () => {
    let calls = 0;
    let acknowledge!: () => void;
    const gateway: OrderGateway = { mode: "paper", cancel: async () => true,
      submit: async () => { calls += 1; await new Promise<void>(resolve => { acknowledge = resolve; });
        return { status: "accepted", orderId: "one" }; } };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway } });
    const first = core.submit(request()), duplicate = core.submit(request());
    expect(first).toBe(duplicate);
    await expect(core.submit(request({ shares: 3 }))).rejects.toThrow("different order");
    expect(calls).toBe(1);
    acknowledge();
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("rejects a different request while a durable submission waits before reservation", async () => {
    let acknowledge!: () => void;
    let calls = 0;
    const gateway: OrderGateway = { mode: "live", durableIdentity: true, cancel: async () => true,
      submit: async (submitted, _instrument, prepared) => {
        calls += 1;
        prepared!({ orderHash: "signed-one", signedPayload: { signature: "signed" }, preparedAt: 101 });
        await new Promise<void>(resolve => { acknowledge = resolve; });
        return { status: "accepted", orderId: "signed-one", tradeIds: [String(submitted.shares)] };
      } };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway, deferPersistence: () => undefined } });

    const first = core.submit(request({ shares: 4 }));
    await expect(core.submit(request({ shares: 8 }))).rejects.toThrow("different order");
    await vi.waitFor(() => expect(calls).toBe(1));
    acknowledge();
    await expect(first).resolves.toMatchObject({ status: "OPEN", shares: 4, tradeIds: ["4"] });
  });

  it("rejects an entire book batch when either side is invalid", () => {
    const down = { ...instrument, tokenId: "down", outcome: "DOWN" };
    const core = new TradingCore({ account, instruments: [instrument, down], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 20, maxOpenOrders: 10,
    }, adapters: { gateway: { mode: "paper", submit: async () => ({ status: "rejected" }), cancel: async () => true } } });
    expect(core.markBatch([{ tokenId: "up", ts: 1, bid: 0.4, ask: 0.41 },
      { tokenId: "down", ts: 1, bid: 0.59, ask: 0.58 }])).toBe(false);
    expect(core.mark({ tokenId: "up", ts: 0.5, bid: 0.4, ask: 0.41 })).toBe(true);
  });

  it("records the cancel request and measures the confirmed ACK with a monotonic clock", async () => {
    let now = 100;
    const monotonic = vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(135);
    const gateway: OrderGateway = {
      mode: "live",
      async submit() { return { status: "accepted", orderId: "venue-1" }; },
      async cancel() {
        now = 101.125;
        return true;
      },
    };
    const core = new TradingCore({ account: { ...account, accountId: "live" }, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 10, maxOpenOrders: 10,
    }, now: () => now, adapters: { gateway } });
    const submitted = await core.submit(request());
    now = 101;
    const cancelled = await core.cancel(submitted.orderId!);
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelRequestedAt: 101,
      cancelAckAt: 101.125, cancelAckLatencyMs: 125 });
    monotonic.mockRestore();
  });

  it("keeps the request timestamp but does not invent a cancel ACK on failure", async () => {
    let now = 100;
    const gateway: OrderGateway = {
      mode: "live",
      async submit() { return { status: "accepted", orderId: "venue-1" }; },
      async cancel() { now = 101.5; throw new Error("cancel timeout"); },
    };
    const core = new TradingCore({ account: { ...account, accountId: "live" }, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 10, maxOpenOrders: 10,
    }, now: () => now, adapters: { gateway } });
    const submitted = await core.submit(request());
    now = 101;
    const cancelled = await core.cancel(submitted.orderId!);
    expect(cancelled).toMatchObject({ status: "UNKNOWN", cancelRequestedAt: 101, error: "cancel timeout" });
    expect(cancelled.cancelAckAt).toBeUndefined();
    expect(cancelled.cancelAckLatencyMs).toBeUndefined();
  });

  it("keeps cancel telemetry valid when the wall clock moves backwards", async () => {
    let now = 101;
    const monotonic = vi.spyOn(performance, "now").mockReturnValueOnce(20).mockReturnValueOnce(70);
    const gateway: OrderGateway = {
      mode: "live",
      async submit() { return { status: "accepted", orderId: "venue-1" }; },
      async cancel() { now = 100; return true; },
    };
    const core = new TradingCore({ account: { ...account, accountId: "live" }, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 10, maxOpenOrders: 10,
    }, now: () => now, adapters: { gateway } });
    const submitted = await core.submit(request());
    const cancelled = await core.cancel(submitted.orderId!);
    expect(cancelled).toMatchObject({ cancelRequestedAt: 101, cancelAckAt: 100, cancelAckLatencyMs: 50,
      updatedAt: 101 });
    expect(() => new TradingCore({ account: { ...account, accountId: "live" }, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 10, maxOpenOrders: 10,
    }, adapters: { gateway }, restored: core.snapshot() })).not.toThrow();
    monotonic.mockRestore();
  });

  it("deduplicates concurrent client and venue ID cancellation into one ACK result", async () => {
    let now = 100;
    const monotonic = vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(80);
    let cancelCalls = 0;
    let resolveCancel!: (value: boolean) => void;
    const gateway: OrderGateway = {
      mode: "live",
      async submit() { return { status: "accepted", orderId: "venue-1" }; },
      cancel: async () => {
        cancelCalls += 1;
        if (cancelCalls > 1) throw new Error("duplicate cancellation raced the first request");
        return new Promise<boolean>(resolve => { resolveCancel = resolve; });
      },
    };
    const core = new TradingCore({ account: { ...account, accountId: "live" }, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 10, maxOpenOrders: 10,
    }, now: () => now, adapters: { gateway } });
    const submitted = await core.submit(request());
    now = 101;
    const byClientId = core.cancel(submitted.clientOrderId);
    const byVenueId = core.cancel(submitted.orderId!);
    expect(byClientId).toBe(byVenueId);
    expect(cancelCalls).toBe(1);
    now = 102;
    resolveCancel(true);
    const [first, second] = await Promise.all([byClientId, byVenueId]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "CANCELLED", cancelRequestedAt: 101,
      cancelAckAt: 102, cancelAckLatencyMs: 70 });
    expect(core.risk().halted).toBe(false);
    expect(cancelCalls).toBe(1);
    monotonic.mockRestore();
  });

  it("cannot race a failed first cancellation with a successful duplicate", async () => {
    let cancelCalls = 0;
    let resolveCancel!: (value: boolean) => void;
    const gateway: OrderGateway = {
      mode: "live",
      async submit() { return { status: "accepted", orderId: "venue-1" }; },
      cancel: async () => {
        cancelCalls += 1;
        if (cancelCalls > 1) return true;
        return new Promise<boolean>(resolve => { resolveCancel = resolve; });
      },
    };
    const core = new TradingCore({ account: { ...account, accountId: "live" }, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 10, maxOpenOrders: 10,
    }, now: () => 101, adapters: { gateway } });
    const submitted = await core.submit(request());
    const byClientId = core.cancel(submitted.clientOrderId);
    const byVenueId = core.cancel(submitted.orderId!);
    expect(byClientId).toBe(byVenueId);
    resolveCancel(false);
    const [first, second] = await Promise.all([byClientId, byVenueId]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "UNKNOWN", cancelRequestedAt: 101,
      error: "cancellation not confirmed" });
    expect(first.cancelAckAt).toBeUndefined();
    expect(first.cancelAckLatencyMs).toBeUndefined();
    expect(core.risk()).toMatchObject({ halted: true, reason: "unknown order requires reconciliation" });
    expect(cancelCalls).toBe(1);
  });

  it("restores legacy orders without cancel telemetry fields", async () => {
    const legacy = setup();
    await legacy.submit(request());
    const original = legacy.snapshot();
    expect(original.orders[0].cancelRequestedAt).toBeUndefined();
    expect(() => new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: 30, maxOrderUsd: 10, maxOpenOrders: 10,
    }, adapters: { gateway: { mode: "paper", submit: async () => ({ status: "rejected" }), cancel: async () => true } },
    restored: original })).not.toThrow();
  });

  it("does not apply an account filled-size delta as an unpriced fill", async () => {
    const core = setup();
    const buy = await core.submit(request({ shares: 2 }));
    await core.cancel(buy.orderId!);
    expect(() => core.reconcile({ ...account, at: 102, cashUsd: 19.5,
      openOrders: [{ ...buy, status: "PARTIAL", filledShares: 1, reservedUsd: 0.5 }], complete: true }))
      .toThrow("apply missing fills");
    expect(core.order(buy.orderId!)?.filledShares).toBe(0);
  });

  it("leaves the whole account unchanged when reconciliation rejects a missing fill", async () => {
    const core = setup();
    const first = await core.submit(request({ shares: 2 }));
    const second = await core.submit(request({ clientOrderId: "buy-2", shares: 2 }));
    await core.cancel(first.orderId!);
    await core.cancel(second.orderId!);
    const before = core.snapshot();
    expect(() => core.reconcile({ ...account, at: 102, cashUsd: 19.5,
      positions: [{ tokenId: "up", shares: 1, costUsd: 0.5, realizedPnlUsd: 0 }],
      openOrders: [{ ...second, status: "PARTIAL", filledShares: 1, reservedUsd: 0.5 }],
    }, 3)).toThrow("apply missing fills");
    expect(core.snapshot()).toEqual(before);
    core.applyFill({ tradeId: "late-once", orderId: second.orderId!, tokenId: "up", direction: "BUY",
      price: 0.5, shares: 1, feeUsd: 0, ts: 102, isMaker: true });
    expect(core.snapshot().cashUsd).toBe(19.5);
    expect(core.positions()[0]).toMatchObject({ shares: 1, costUsd: 0.5 });
  });

  it("does not retain an early cancellation when a later snapshot order conflicts", async () => {
    const core = setup();
    const first = await core.submit(request({ shares: 2 }));
    const second = await core.submit(request({ clientOrderId: "buy-2", shares: 2 }));
    core.confirmCancelled(second.orderId!, true);
    const before = core.snapshot();
    expect(() => core.reconcile({ ...account, at: 102, cashUsd: 19,
      openOrders: [second],
    }, 2, [first.orderId!])).toThrow("terminal order");
    expect(core.snapshot()).toEqual(before);
  });

  it("recovers a disconnect-time cancellation with explicit cancellation evidence", async () => {
    const core = setup();
    const buy = await core.submit(request({ shares: 2 }));
    core.reconcile({ ...account, at: 102, openOrders: [], complete: true }, 0, [buy.orderId!]);
    expect(core.order(buy.orderId!)).toMatchObject({ status: "CANCELLED", reconciliationPending: true });
    core.reconcile({ ...account, at: 103, openOrders: [], complete: true });
    expect(core.order(buy.orderId!)).toMatchObject({ status: "CANCELLED", reconciliationPending: false, reservedUsd: 0 });
  });

  it("clears the reconciliation marker when a late fill completes the cancelled order", async () => {
    const core = setup();
    const buy = await core.submit(request({ shares: 2 }));
    await core.cancel(buy.orderId!);
    expect(core.order(buy.orderId!)?.reconciliationPending).toBe(true);
    expect(core.applyFill({ tradeId: "late-full", orderId: buy.orderId!, tokenId: "up", direction: "BUY",
      price: 0.5, shares: 2, feeUsd: 0.01, ts: 101, isMaker: true })).toBe(true);
    expect(core.order(buy.orderId!)).toMatchObject({ status: "FILLED", reconciliationPending: false, reservedUsd: 0 });
  });

  it("rejects an older account snapshot after a newer one was accepted", async () => {
    const core = setup();
    core.reconcile({ ...account, at: 102, cashUsd: 19, openOrders: [], complete: true });
    expect(() => core.reconcile({ ...account, at: 101, cashUsd: 20, openOrders: [], complete: true }))
      .toThrow("older than the last accepted snapshot");
    expect(core.snapshot().cashUsd).toBe(19);
  });

  it("performs a final account read before stopping with live cancellation reservations", async () => {
    const order: string[] = [];
    const gateway: OrderGateway = {
      mode: "live",
      async submit() { return { status: "accepted", orderId: "live-1" }; },
      async cancel() { return true; },
    };
    const core = new TradingCore({ account: { ...account, accountId: "live" }, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: 30, maxOrderUsd: 10, maxOpenOrders: 10,
    }, adapters: {
      gateway,
      estimateFee: () => 0.01,
       readAccount: async () => { order.push("read"); return { ...account, accountId: "live", at: 102, cashUsd: 20, openOrders: [], complete: true }; },
       beforeFinalReconcile: () => order.push("freeze"),
    } });
    const buy = await core.submit(request());
    await expect(core.stop("test stop")).resolves.toBeUndefined();
    expect(order).toEqual(["freeze", "read"]);
    expect(core.order(buy.orderId!)?.reconciliationPending).toBe(false);
  });

  it("rejects a venue ACK that collides with another client order ID", async () => {
    let calls = 0;
    const gateway: OrderGateway = {
      mode: "paper",
      async submit() { calls += 1; return { status: "accepted", orderId: calls === 1 ? "venue-1" : "buy-1" }; },
      async cancel() { return true; },
    };
    const core = new TradingCore({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: 30, maxOrderUsd: 10, maxOpenOrders: 10,
    }, adapters: { gateway, estimateFee: () => 0.01 } });
    const first = await core.submit(request());
    expect(first.status).toBe("OPEN");
    const second = await core.submit(request({ clientOrderId: "buy-2", shares: 1 }));
    expect(second.status).toBe("UNKNOWN");
    expect(core.risk().reason).toContain("reconciliation");
  });

  it("does not resurrect a terminal order from a stale open-order snapshot", async () => {
    const core = setup();
    const buy = await core.submit(request({ shares: 2 }));
    await core.cancel(buy.orderId!);
    core.reconcile({ ...account, at: 102, cashUsd: 20, openOrders: [], complete: true });
    expect(() => core.reconcile({ ...account, at: 103, cashUsd: 20,
      openOrders: [{ ...buy, status: "OPEN", reservedUsd: 1, reservedShares: 0 }], complete: true })).toThrow("terminal order");
  });
});
