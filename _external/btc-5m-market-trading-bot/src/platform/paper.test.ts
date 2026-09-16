import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, OrderRequest, TradeFill } from "./contracts.js";
import { PaperGateway } from "./paper.js";

const instrument: Instrument = { tokenId: "up", marketId: "market", outcome: "UP", tickSize: 0.01, minOrderSize: 1 };
const order = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({ clientOrderId: "one", strategyId: "strategy",
  tokenId: "up", direction: "BUY", price: 0.5, shares: 4, timeInForce: "GTC", postOnly: false, ...overrides });
const book = { tokenId: "up", ts: 10, bid: 0.4, ask: 0.5, bidSize: 5, askSize: 5 };

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
    await gateway.close();
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
    await gateway.close();
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
    await vi.runAllTimersAsync();
    expect(events).toEqual(["ack", "fill:5", "cancel"]);
    gateway.trade("up", direction === "BUY" ? "SELL" : "BUY", request.price, 100, 11);
    await gateway.close();
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
    await gateway.close();
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
    await gateway.close();
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
    await gateway.close();
    expect(fills.map(fill => [fill.price, fill.feeUsd, fill.isMaker])).toEqual([[0.5, 0.02, false], [0.6, 0, true]]);
  });

  it("preserves committed fills when cancelled before delivery and closes all timers", async () => {
    const events: string[] = [];
    const gateway = new PaperGateway(fill => events.push(`fill:${fill.shares}`), undefined, () => events.push("cancel"));
    gateway.book(book);
    const ack = await gateway.submit(order({ shares: 6 }), instrument);
    await gateway.cancel(ack.orderId!);
    expect(events).toEqual([]);
    await gateway.close();
    expect(events).toEqual(["fill:5"]);
    expect(vi.getTimerCount()).toBe(0);
    await gateway.close();
    await expect(gateway.submit(order(), instrument)).rejects.toThrow("closed");
    expect(() => gateway.trade("up", "BUY", 0.5, 1, 12)).toThrow("closed");
  });

  it("delivers queued fills before closing cancellation without losing ACK ordering", async () => {
    const events: string[] = [];
    const gateway = new PaperGateway(fill => events.push(`fill:${fill.shares}`), undefined, () => events.push("cancel"));
    gateway.book(book);
    const submission = gateway.submit(order({ shares: 6 }), instrument).then(() => { events.push("ack"); });
    await gateway.close();
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
    await expect(gateway.close()).rejects.toThrow("paper callback failed");
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
    await gateway.close();
  });

  it("rejects fee calculation failures without consuming liquidity", async () => {
    const fills: TradeFill[] = [];
    const fee = vi.fn().mockReturnValueOnce(NaN).mockReturnValue(0);
    const gateway = new PaperGateway(fill => fills.push(fill), fee);
    gateway.book(book);
    expect(await gateway.submit(order({ shares: 5, timeInForce: "FOK" }), instrument))
      .toMatchObject({ status: "rejected", error: "invalid paper fill fee" });
    expect(await gateway.submit(order({ shares: 5, timeInForce: "FOK" }), instrument)).toMatchObject({ status: "accepted" });
    await gateway.close();
    expect(fills.map(fill => fill.shares)).toEqual([5]);
  });

  it("does not fill cancelled passive orders or invent missing displayed size", async () => {
    const fills: TradeFill[] = [];
    const gateway = new PaperGateway(fill => fills.push(fill));
    gateway.book({ ...book, askSize: undefined });
    expect(await gateway.submit(order({ timeInForce: "FAK" }), instrument)).toMatchObject({ status: "rejected" });
    const resting = await gateway.submit(order({ price: 0.4, postOnly: true }), instrument);
    await gateway.cancel(resting.orderId!);
    gateway.trade("up", "SELL", 0.4, 100, 11);
    await gateway.close();
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
    await gateway.close();
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
    await gateway.close();
    expect(fills).toHaveLength(1);
  });
});
