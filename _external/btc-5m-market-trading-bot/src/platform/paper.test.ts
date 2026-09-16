import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, OrderRequest, TradeFill, TradingEvent } from "./contracts.js";
import { TradingCore } from "./core.js";
import { PaperGateway } from "./paper.js";

const instrument: Instrument = { tokenId: "up", marketId: "market", outcome: "UP", tickSize: 0.01, minOrderSize: 1 };
const order = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({ clientOrderId: "one", strategyId: "strategy",
  tokenId: "up", direction: "BUY", price: 0.5, shares: 4, timeInForce: "GTC", postOnly: false, ...overrides });
const book = { tokenId: "up", ts: 10, bid: 0.4, ask: 0.5, bidSize: 5, askSize: 5 };

async function flushed<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await settled;
  if ("error" in result) throw result.error;
  return result.value;
}

function integrated(onEvent?: (event: TradingEvent) => void) {
  let core!: TradingCore;
  const gateway = new PaperGateway(fill => core.applyFill(fill), undefined,
    id => core.confirmCancelled(id, true));
  core = new TradingCore({
    account: { accountId: "paper", at: 10, cashUsd: 20, positions: [], openOrders: [], complete: true },
    instruments: [instrument], now: () => 10,
    limits: { capitalUsd: 20, dailyLossUsd: 30, maxOrderUsd: 10, maxOpenOrders: 10 },
    adapters: { gateway }, onEvent,
  });
  gateway.book(book);
  core.mark(book);
  return { core, gateway };
}

describe("independent paper gateway", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares displayed depth across simultaneous aggressive BUY and SELL orders", async () => {
    const fills: TradeFill[] = [];
    const gateway = new PaperGateway(fill => fills.push(fill));
    gateway.book(book);
    await Promise.all([
      gateway.submit(order(), instrument),
      gateway.submit(order({ clientOrderId: "two" }), instrument),
      gateway.submit(order({ clientOrderId: "three", direction: "SELL", price: 0.4 }), instrument),
      gateway.submit(order({ clientOrderId: "four", direction: "SELL", price: 0.4 }), instrument),
    ]);
    expect(fills).toEqual([]);
    await vi.runAllTimersAsync();
    expect(fills.map(fill => [fill.direction, fill.shares, fill.price])).toEqual([
      ["BUY", 4, 0.5], ["BUY", 1, 0.5], ["SELL", 4, 0.4], ["SELL", 1, 0.4],
    ]);
    await flushed(gateway.close());
  });

  it("does not restore consumed liquidity from a duplicate or stale book", async () => {
    const fills: TradeFill[] = [];
    const gateway = new PaperGateway(fill => fills.push(fill));
    gateway.book(book);
    await gateway.submit(order({ shares: 5, timeInForce: "FOK" }), instrument);
    gateway.book(book);
    gateway.book({ ...book, ts: 9, askSize: 100 });
    expect(await gateway.submit(order({ timeInForce: "FOK" }), instrument)).toMatchObject({ status: "rejected" });
    gateway.book({ ...book, ts: 11 });
    expect(await gateway.submit(order({ timeInForce: "FOK" }), instrument)).toMatchObject({ status: "accepted" });
    await flushed(gateway.close());
    expect(fills.map(fill => fill.shares)).toEqual([5, 4]);
  });

  it.each(["BUY", "SELL"] as const)("enforces FOK all-or-none and FAK remainder cancellation for %s", async direction => {
    const events: string[] = [];
    const gateway = new PaperGateway(fill => events.push(`fill:${fill.shares}`), undefined, () => events.push("cancel"));
    gateway.book(book);
    const request = order({ direction, price: direction === "BUY" ? 0.5 : 0.4, shares: 6, timeInForce: "FOK" });
    expect(await gateway.submit(request, instrument)).toMatchObject({ status: "rejected" });
    expect(await gateway.submit({ ...request, timeInForce: "FAK" }, instrument)).toMatchObject({ status: "accepted" });
    events.push("ack");
    gateway.trade("up", direction === "BUY" ? "SELL" : "BUY", request.price, 100, 11);
    await vi.runAllTimersAsync();
    expect(events).toEqual(["ack", "fill:5", "cancel"]);
    gateway.trade("up", direction === "BUY" ? "SELL" : "BUY", request.price, 100, 11);
    await flushed(gateway.close());
    expect(events).toEqual(["ack", "fill:5", "cancel"]);
  });

  it("never fills a passive order from book updates and allocates tape volume by price then time", async () => {
    const fills: TradeFill[] = [];
    const gateway = new PaperGateway(fill => fills.push(fill));
    gateway.book(book);
    const low = await gateway.submit(order({ price: 0.38, postOnly: true }), instrument);
    const first = await gateway.submit(order({ clientOrderId: "two", price: 0.4, postOnly: true }), instrument);
    const second = await gateway.submit(order({ clientOrderId: "three", price: 0.4, postOnly: true }), instrument);
    gateway.book({ ...book, ts: 11, ask: 0.35, bid: 0.3 });
    await vi.runAllTimersAsync();
    expect(fills).toHaveLength(0);
    gateway.trade("up", "SELL", 0.38, 7, 12);
    await vi.runAllTimersAsync();
    expect(fills.map(fill => [fill.orderId, fill.shares])).toEqual([[first.orderId, 4], [second.orderId, 3]]);
    gateway.trade("up", "SELL", 0.37, 10, 13);
    await flushed(gateway.close());
    expect(fills.map(fill => [fill.orderId, fill.shares])).toEqual([
      [first.orderId, 4], [second.orderId, 3], [second.orderId, 1], [low.orderId, 4],
    ]);
    expect(fills.every(fill => fill.isMaker)).toBe(true);
  });

  it("ranks passive sells by lowest price and excludes pre-submission tape events", async () => {
    const fills: TradeFill[] = [];
    const gateway = new PaperGateway(fill => fills.push(fill));
    gateway.book(book);
    const high = await gateway.submit(order({ direction: "SELL", price: 0.6 }), instrument);
    const low = await gateway.submit(order({ direction: "SELL", price: 0.55 }), instrument);
    gateway.trade("up", "BUY", 0.7, 10, 9);
    gateway.trade("up", "BUY", 0.6, 5, 10);
    await flushed(gateway.close());
    expect(fills.map(fill => [fill.orderId, fill.shares])).toEqual([[low.orderId, 4], [high.orderId, 1]]);
  });

  it("uses actual execution price and liquidity role for fee calculation", async () => {
    const fee = vi.fn((_request: OrderRequest, shares: number, execution: { price: number; isMaker: boolean }) =>
      execution.isMaker ? 0 : shares * execution.price * 0.01);
    const fills: TradeFill[] = [];
    const gateway = new PaperGateway(fill => fills.push(fill), fee);
    gateway.book(book);
    await gateway.submit(order({ price: 0.6 }), instrument);
    await gateway.submit(order({ direction: "SELL", price: 0.6 }), instrument);
    gateway.trade("up", "BUY", 0.6, 4, 11);
    await flushed(gateway.close());
    expect(fills.map(fill => [fill.price, fill.feeUsd, fill.isMaker])).toEqual([[0.5, 0.02, false], [0.6, 0, true]]);
  });

  it("preserves committed fills when cancelled before delivery and closes all timers", async () => {
    const events: string[] = [];
    const gateway = new PaperGateway(fill => events.push(`fill:${fill.shares}`), undefined, () => events.push("cancel"));
    gateway.book(book);
    const ack = await gateway.submit(order({ shares: 6 }), instrument);
    await flushed(gateway.cancel(ack.orderId!));
    expect(events).toEqual(["fill:5", "cancel"]);
    await flushed(gateway.close());
    expect(events).toEqual(["fill:5", "cancel"]);
    expect(vi.getTimerCount()).toBe(0);
    await flushed(gateway.close());
    await expect(gateway.submit(order(), instrument)).rejects.toThrow("closed");
    expect(() => gateway.trade("up", "BUY", 0.5, 1, 12)).toThrow("closed");
  });

  it("does not acknowledge a paper cancellation for an unknown order", async () => {
    const gateway = new PaperGateway(() => undefined);
    await expect(gateway.cancel("missing-order")).resolves.toBe(false);
  });

  it("does not let a same-turn tape event fill the cancelled FAK remainder in the account", async () => {
    const { core, gateway } = integrated();
    const submission = core.submit(order({ shares: 6, timeInForce: "FAK" }));
    gateway.trade("up", "SELL", 0.5, 100, 11);
    await submission;
    await vi.runAllTimersAsync();
    expect(core.order("one")).toMatchObject({ status: "CANCELLED", filledShares: 5,
      reservedUsd: 0, reconciliationPending: false });
    expect(core.positions()).toMatchObject([{ shares: 5, costUsd: 2.5 }]);
    expect(core.snapshot().cashUsd).toBe(17.5);
    await flushed(gateway.close());
  });

  it("binds a concurrent submission ACK before cancelling another order delivers its fill", async () => {
    const { core, gateway } = integrated();
    const resting = await core.submit(order({ price: 0.4, postOnly: true }));
    const submission = core.submit(order({ clientOrderId: "two" }));
    const cancellation = core.cancel(resting.orderId!);
    await flushed(Promise.all([submission, cancellation]));
    expect(core.order("one")).toMatchObject({ status: "CANCELLED", reservedUsd: 0 });
    expect(core.order("two")).toMatchObject({ status: "FILLED", filledShares: 4 });
    expect(core.positions()).toMatchObject([{ shares: 4, costUsd: 2 }]);
    expect(core.snapshot().cashUsd).toBe(18);
    expect(core.risk().halted).toBe(false);
    await flushed(gateway.close());
  });

  it("preserves ACK ordering when cancellation starts inside the new submission event", async () => {
    let cancellation: Promise<unknown> | undefined;
    const { core, gateway } = integrated(event => {
      if (event.kind === "order" && event.order.clientOrderId === "two" && event.order.status === "SUBMITTING") {
        cancellation = core.cancel("one");
      }
    });
    await core.submit(order({ price: 0.4, postOnly: true }));
    const submission = core.submit(order({ clientOrderId: "two" }));
    await flushed(Promise.all([submission, cancellation]));
    expect(core.order("one")).toMatchObject({ status: "CANCELLED", reservedUsd: 0 });
    expect(core.order("two")).toMatchObject({ status: "FILLED", filledShares: 4 });
    expect(core.risk().halted).toBe(false);
    await flushed(gateway.close());
  });

  it("defers callback-created submissions and cancellation without reentrant delivery", async () => {
    let replacement: Promise<unknown> | undefined;
    let cancellation: Promise<unknown> | undefined;
    const { core, gateway } = integrated(event => {
      if (event.kind === "fill" && core.order(event.fill.orderId)?.clientOrderId === "one") {
        replacement = core.submit(order({ clientOrderId: "two", shares: 1 }));
        cancellation = core.cancel("resting");
      }
    });
    await core.submit(order({ clientOrderId: "resting", price: 0.4, postOnly: true }));
    await core.submit(order());
    await vi.runAllTimersAsync();
    await Promise.all([replacement, cancellation]);
    expect(core.order("resting")).toMatchObject({ status: "CANCELLED", reservedUsd: 0 });
    expect(core.order("two")).toMatchObject({ status: "FILLED", filledShares: 1 });
    expect(core.positions()).toMatchObject([{ shares: 5, costUsd: 2.5 }]);
    expect(core.risk().halted).toBe(false);
    await flushed(gateway.close());
  });

  it("shares a cancellation delivery with concurrent close calls", async () => {
    const events: string[] = [];
    const gateway = new PaperGateway(fill => events.push(`fill:${fill.shares}`), undefined,
      () => events.push("cancel"));
    gateway.book(book);
    const ack = await gateway.submit(order({ shares: 6, timeInForce: "FAK" }), instrument);
    const cancellations = [gateway.cancel(ack.orderId!), gateway.cancel(ack.orderId!)];
    const closing = gateway.close();
    expect(gateway.close()).toBe(closing);
    await flushed(Promise.all([...cancellations, closing]));
    expect(events).toEqual(["fill:5", "cancel"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes displayed top liquidity when public tape fills a passive order", async () => {
    const fills: TradeFill[] = [];
    const gateway = new PaperGateway(fill => fills.push(fill));
    gateway.book({ ...book, bid: 0.4, bidSize: 5 });
    await gateway.submit(order({ price: 0.4, postOnly: true, shares: 3 }), instrument);
    gateway.trade("up", "SELL", 0.4, 3, 11);
    await vi.runAllTimersAsync();
    expect(fills).toHaveLength(1);
    expect(await gateway.submit(order({ clientOrderId: "aggressive", direction: "SELL", price: 0.4,
      shares: 3, timeInForce: "FOK" }), instrument)).toMatchObject({ status: "rejected" });
    await flushed(gateway.close());
  });

  it("delivers queued fills before closing cancellation without losing ACK ordering", async () => {
    const events: string[] = [];
    const gateway = new PaperGateway(fill => events.push(`fill:${fill.shares}`), undefined, () => events.push("cancel"));
    gateway.book(book);
    const submission = gateway.submit(order({ shares: 6 }), instrument).then(() => { events.push("ack"); });
    await flushed(gateway.close());
    await submission;
    expect(events).toEqual(["ack", "fill:5", "cancel"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces callback failures while still draining other committed events", async () => {
    const onFill = vi.fn(() => { throw new Error("account rejected event"); });
    const gateway = new PaperGateway(onFill);
    gateway.book(book);
    await gateway.submit(order(), instrument);
    await gateway.submit(order(), instrument);
    await vi.runAllTimersAsync();
    expect(onFill).toHaveBeenCalledTimes(2);
    await expect(gateway.submit(order(), instrument)).rejects.toThrow("paper callback failed");
    await expect(flushed(gateway.close())).rejects.toThrow("paper callback failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers a tape fill after ACK even when the trade arrives in the same turn", async () => {
    const events: string[] = [];
    const gateway = new PaperGateway(() => events.push("fill"));
    gateway.book(book);
    const submission = gateway.submit(order({ price: 0.4, postOnly: true }), instrument)
      .then(() => events.push("ack"));
    gateway.trade("up", "SELL", 0.4, 4, 11);
    expect(events).toEqual([]);
    await submission;
    await vi.runAllTimersAsync();
    expect(events).toEqual(["ack", "fill"]);
    await flushed(gateway.close());
  });

  it("rejects fee calculation failures without consuming liquidity", async () => {
    const fills: TradeFill[] = [];
    const fee = vi.fn().mockReturnValueOnce(NaN).mockReturnValue(0);
    const gateway = new PaperGateway(fill => fills.push(fill), fee);
    gateway.book(book);
    expect(await gateway.submit(order({ shares: 5, timeInForce: "FOK" }), instrument))
      .toMatchObject({ status: "rejected", error: "invalid paper fill fee" });
    expect(await gateway.submit(order({ shares: 5, timeInForce: "FOK" }), instrument)).toMatchObject({ status: "accepted" });
    await flushed(gateway.close());
    expect(fills.map(fill => fill.shares)).toEqual([5]);
  });

  it("does not fill cancelled passive orders or invent missing displayed size", async () => {
    const fills: TradeFill[] = [];
    const gateway = new PaperGateway(fill => fills.push(fill));
    gateway.book({ ...book, askSize: undefined });
    expect(await gateway.submit(order({ timeInForce: "FAK" }), instrument)).toMatchObject({ status: "rejected" });
    const resting = await gateway.submit(order({ price: 0.4, postOnly: true }), instrument);
    await flushed(gateway.cancel(resting.orderId!));
    gateway.trade("up", "SELL", 0.4, 100, 11);
    await flushed(gateway.close());
    expect(fills).toEqual([]);
  });

  it("rejects malformed orders, unsupported post-only combinations and crossing post-only orders", async () => {
    const gateway = new PaperGateway(() => undefined);
    gateway.book(book);
    for (const request of [order({ shares: NaN }), order({ price: 0.505 }), order({ tokenId: "wrong" }),
      order({ postOnly: true }), order({ direction: "SELL", price: 0.4, postOnly: true }),
      order({ timeInForce: "FAK", postOnly: true }), order({ timeInForce: "FOK", price: 0.4 })]) {
      expect(await gateway.submit(request, instrument)).toMatchObject({ status: "rejected" });
    }
    await flushed(gateway.close());
  });

  it("rejects malformed feed data without corrupting the last usable depth", async () => {
    const fills: TradeFill[] = [];
    const gateway = new PaperGateway(fill => fills.push(fill));
    gateway.book(book);
    expect(() => gateway.book({ ...book, askSize: NaN })).toThrow("invalid paper book");
    expect(() => gateway.book({ ...book, ask: 0.3 })).toThrow("invalid paper book");
    expect(() => gateway.trade("up", "BUY", 0.5, -1, 11)).toThrow("invalid paper trade");
    expect(() => gateway.trade("up", "BUY", 0.5, 1, NaN)).toThrow("invalid paper trade");
    await gateway.submit(order(), instrument);
    await flushed(gateway.close());
    expect(fills).toHaveLength(1);
  });
});
