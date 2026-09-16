import { describe, expect, it } from "vitest";
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
