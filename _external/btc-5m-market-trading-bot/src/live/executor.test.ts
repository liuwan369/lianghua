import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Side } from "../models.js";
import { Executor, UnknownOrderStateError } from "./executor.js";

beforeEach(()=>vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({minimum_tick_size:0.01})))));
afterEach(()=>vi.unstubAllGlobals());

describe("market tick metadata", () => {
  it("does not roll back a token's tick from a stale exchange notification or affect its other leg", () => {
    const executor=new Executor(false,10,10,100);
    executor.updateTickSize("up",0.01,100);
    executor.updateTickSize("down",0.001,200);
    executor.updateTickSize("down",0.01,150);
    expect(executor.knownTickSize("up")).toBe(0.01);
    expect(executor.knownTickSize("down")).toBe(0.001);
  });
  it("loads real per-token paper ticks and uses subsequent tick changes for execution", async () => {
    const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify({minimum_tick_size:url.endsWith("up")?0.01:0.005})));
    vi.stubGlobal("fetch",fetchMock);
    const executor=new Executor(false,10,10,100);
    await executor.prepareMarket("market",["up","down"]);
    expect(executor.knownTickSize("up")).toBe(0.01);
    expect(executor.knownTickSize("down")).toBe(0.005);
    expect((await executor.submit(Side.Down,"down",0.7615,5)).price).toBe(0.76);
    executor.updateTickSize("down",0.001);
    expect((await executor.submit(Side.Down,"down",0.7615,5)).price).toBe(0.761);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("loads both live ticks after SDK market warmup", async () => {
    const executor=new Executor(true,10,10,100);
    const warmMarket=vi.fn().mockResolvedValue(1);
    (executor as unknown as {clob:Record<string,unknown>}).clob={warmMarket,tickSize:async(token:string)=>token==="up"?0.01:0.001};
    await executor.prepareMarket("market",["up","down"]);
    expect(warmMarket).toHaveBeenCalledWith("market");
    expect(executor.knownTickSize("up")).toBe(0.01);
    expect(executor.knownTickSize("down")).toBe(0.001);
  });
  it("refuses paper execution when official tick metadata is missing", async () => {
    vi.stubGlobal("fetch",vi.fn(async()=>new Response("{}")));
    const executor=new Executor(false,10,10,100);
    await expect(executor.submit(Side.Up,"up",0.7615,5)).rejects.toThrow(/tick size/);
    expect(executor.sent).toBe(0);
  });
});

describe("Executor fill tracking", () => {
  it("blocks every new order until all shares of the current taker are authoritatively filled", async () => {
    const executor = new Executor(true, 10, 20, 100);
    const submitOrder = vi.fn().mockResolvedValue({success:true,orderId:"new-maker"});
    (executor as unknown as {clob:Record<string,unknown>}).clob = {
      tickSize:async()=>0.01,minOrderSize:()=>5,submitOrder,
      submitMarketBuy:vi.fn().mockResolvedValue({success:true,orderId:"taker-1"}),
    };
    expect((await executor.submitTaker(Side.Up,"up",0.4,5)).ok).toBe(true);
    executor.noteFill(Side.Up,"old-maker",5);
    expect((await executor.submit(Side.Down,"down",0.5,5)).ok).toBe(false);
    expect((await executor.submitTaker(Side.Down,"down",0.5,5)).ok).toBe(false);
    executor.noteFill(Side.Up,"taker-1",2);
    expect((await executor.submit(Side.Down,"down",0.5,5)).ok).toBe(false);
    executor.noteFill(Side.Up,"taker-1",3);
    expect((await executor.submit(Side.Down,"down",0.5,5)).ok).toBe(true);
    expect(submitOrder).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight order ACK before shutdown cancellation and rejects new work", async () => {
    const executor = new Executor(true,10,10,100);
    let ack!: (value:{success:boolean;orderId:string}) => void;
    const submitted = new Promise<{success:boolean;orderId:string}>(resolve=>{ack=resolve;});
    const submitOrder = vi.fn().mockReturnValue(submitted);
    const cancelAll = vi.fn().mockResolvedValue(undefined);
    (executor as unknown as {clob:Record<string,unknown>}).clob = {
      tickSize:async()=>0.01,minOrderSize:()=>5,submitOrder,cancelAll,stopHeartbeat:vi.fn(),
    };
    const posting = executor.submit(Side.Up,"up",0.4,5);
    await vi.waitFor(()=>expect(submitOrder).toHaveBeenCalledOnce());
    const stopping = executor.shutdown();
    expect(cancelAll).not.toHaveBeenCalled();
    expect((await executor.submit(Side.Down,"down",0.5,5)).ok).toBe(false);
    ack({success:true,orderId:"late-ack"});
    await posting;
    await stopping;
    expect(cancelAll).toHaveBeenCalledOnce();
    expect(executor.restingId(Side.Up)).toBeUndefined();
  });
  it.each(["maker", "taker"])("never increases a strategy-approved size to the %s venue minimum", async (kind) => {
    const executor = new Executor(true, 10, 10, 100);
    const submit = vi.fn();
    (executor as unknown as {clob:Record<string,unknown>}).clob = {
      tickSize:async()=>0.01,minOrderSize:()=>10,submitOrder:submit,submitMarketBuy:submit,
    };
    const result = kind === "maker" ? await executor.submit(Side.Up,"up",0.3,5)
      : await executor.submitTaker(Side.Up,"up",0.3,5);
    expect(result.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(executor.spentUsd).toBe(0);
  });
  it("recognizes a fill after cancellation without cancelling the replacement order", async () => {
    const executor = new Executor(false, 10, 10, 100);
    const first = await executor.submit(Side.Up, "token-up", 0.4, 5);
    await executor.cancelSide(Side.Up);
    const replacement = await executor.submit(Side.Up, "token-up", 0.39, 5);
    expect(executor.isOurOrder(first.orderId!)).toBe(true);
    expect(executor.onOrderCancelled(first.orderId!, Side.Up)).toBeUndefined();
    executor.noteFill(Side.Up, first.orderId, 2);
    expect(executor.restingId(Side.Up)).toBe(replacement.orderId);
    expect(executor.onOrderCancelled(replacement.orderId!, Side.Up)).toBe(Side.Up);
  });

  it.each([{ success: true }, { success: false, orderId: "ambiguous" }])(
    "freezes an ambiguous maker ACK instead of allowing untracked orders: %j", async (response) => {
      const executor = new Executor(true, 10, 10, 100);
      (executor as unknown as { clob: Record<string, unknown> }).clob = {
        tickSize: vi.fn().mockResolvedValue(0.01), minOrderSize: () => 5,
        submitOrder: vi.fn().mockResolvedValue(response),
      };
      await expect(executor.submit(Side.Up, "token-up", 0.4, 5)).rejects.toBeInstanceOf(UnknownOrderStateError);
      expect(executor.spentUsd).toBe(2);
    },
  );
  it("enforces the USD cap on the actual submitted size", async () => {
    const executor = new Executor(false, 1, 10, 10);

    expect((await executor.submit(Side.Up, "token-up", 0.36, 20)).ok).toBe(false);
    expect((await executor.submit(Side.Up, "token-up", 0.2001, 20)).size).toBe(5);
    expect((await executor.submit(Side.Up, "token-up", 0.19, 20)).size).toBe(5.26);
    expect((await executor.submit(Side.Up, "token-up", 0.18, 20)).size).toBe(5.55);
    expect((await executor.submit(Side.Up, "token-up", 0.04, 20)).size).toBe(20);
  });

  it("keeps a partially filled maker order tracked until its remaining size fills", async () => {
    const executor = new Executor(false, 10, 10, 100);
    const submitted = await executor.submit(Side.Up, "token-up", 0.4, 5);

    expect(submitted.ok).toBe(true);
    expect(submitted.orderId).toBeDefined();
    expect(executor.restingId(Side.Up)).toBe(submitted.orderId);

    executor.live = true;
    executor.noteFill(Side.Up, submitted.orderId, 2);
    expect(executor.restingId(Side.Up)).toBe(submitted.orderId);
    expect(executor.isOurOrder(submitted.orderId!)).toBe(true);

    executor.noteFill(Side.Up, submitted.orderId, 3);
    expect(executor.restingId(Side.Up)).toBeUndefined();
    expect(executor.isOurOrder(submitted.orderId!)).toBe(true);
  });

  it("keeps local order tracking when cancel-all is not confirmed", async () => {
    const executor = new Executor(false, 10, 10, 100);
    const submitted = await executor.submit(Side.Up, "token-up", 0.4, 5);
    expect(submitted.orderId).toBeDefined();

    executor.live = true;
    (executor as unknown as { clob: { cancelAll: () => Promise<void> } }).clob = {
      cancelAll: vi.fn().mockRejectedValue(new Error("not confirmed")),
    };

    await expect(executor.cancelAll()).rejects.toThrow(/not confirmed/i);
    expect(executor.restingId(Side.Up)).toBe(submitted.orderId);
    expect(executor.isOurOrder(submitted.orderId!)).toBe(true);
  });

  it("conservatively charges limits when an order ACK is unknown", async () => {
    const executor = new Executor(true, 10, 10, 100);
    (executor as unknown as { clob: Record<string, unknown> }).clob = {
      tickSize: vi.fn().mockResolvedValue(0.01),
      minOrderSize: vi.fn().mockReturnValue(5),
      submitOrder: vi.fn().mockResolvedValue({
        success: false,
        stateUnknown: true,
        errorMsg: "timeout",
      }),
    };

    await expect(executor.submit(Side.Up, "token-up", 0.4, 5))
      .rejects.toBeInstanceOf(UnknownOrderStateError);
    expect(executor.sent).toBe(1);
    expect(executor.spentUsd).toBeCloseTo(2);
  });

  it("refuses live submission when market minimum size was not loaded", async () => {
    const executor = new Executor(true, 10, 10, 100);
    const submitOrder = vi.fn();
    (executor as unknown as { clob: Record<string, unknown> }).clob = {
      tickSize: vi.fn().mockResolvedValue(0.01),
      minOrderSize: vi.fn().mockReturnValue(undefined),
      submitOrder,
    };
    const result = await executor.submit(Side.Up, "token-up", 0.4, 5);
    expect(result.ok).toBe(false);
    expect(result.size).toBe(0);
    expect(submitOrder).not.toHaveBeenCalled();
  });
});


describe("uncertain ACK circuit breaker", () => {
  it("keeps submissions paused after the caller catches an unknown maker ACK", async () => {
    const executor=new Executor(true,10,20,100);
    const submitOrder=vi.fn().mockResolvedValue({success:false,stateUnknown:true,errorMsg:"timeout"});
    (executor as unknown as {clob:Record<string,unknown>}).clob={
      tickSize:async()=>0.01,minOrderSize:()=>5,submitOrder};
    await expect(executor.submit(Side.Up,"up",0.4,5)).rejects.toBeInstanceOf(UnknownOrderStateError);
    expect((await executor.submit(Side.Down,"down",0.5,5)).ok).toBe(false);
    expect(submitOrder).toHaveBeenCalledOnce();
    expect(executor.spentUsd).toBe(2);
  });
  it("returns actual signing and HTTP ACK durations without inventing paper samples", async () => {
    const executor=new Executor(true,10,20,100);
    (executor as unknown as {clob:Record<string,unknown>}).clob={tickSize:async()=>0.01,
      minOrderSize:()=>5,submitOrder:async()=>({success:true,orderId:"ack",signLatencyMs:4,ackLatencyMs:9})};
    expect(await executor.submit(Side.Up,"up",0.4,5)).toMatchObject({ok:true,signLatencyMs:4,ackLatencyMs:9});
    const paper=new Executor(false,10,20,100);
    const result=await paper.submit(Side.Up,"up",0.4,5);
    expect(result.ackLatencyMs).toBeUndefined();
  });

  it("persists a reservation before a live network submission and closes rejected orders", async () => {
    const events: string[] = [];
    const coordinator = {
      prepare: vi.fn((id: string) => events.push(`prepare:${id}`)),
      transition: vi.fn((_id: string, status: 'submitted' | 'unknown' | 'acknowledged' | 'reconciled') => events.push(status)),
    };
    const executor = new Executor(true, 10, 10, 100, coordinator);
    const submitOrder = vi.fn().mockResolvedValue({ success: false, status: 400, errorMsg: "rejected" });
    (executor as unknown as {clob: Record<string, unknown>}).clob = {
      tickSize: async()=>0.01, minOrderSize:()=>5, submitOrder,
    };
    const result = await executor.submit(Side.Up, "up", 0.4, 5);
    expect(result.ok).toBe(false);
    expect(events[0]).toMatch(/^prepare:order-/);
    expect(events.slice(1)).toEqual(["submitted", "reconciled"]);
    expect(submitOrder).toHaveBeenCalledOnce();
  });

  it("advances the bound reservation through partial fill and final reconciliation", async () => {
    const events: string[] = [];
    const coordinator = {
      prepare: vi.fn((id: string) => events.push(`prepare:${id}`)),
      transition: vi.fn((_id: string, status: 'submitted' | 'unknown' | 'acknowledged' | 'partially_filled' | 'settlement_pending' | 'reconciled') => events.push(status)),
    };
    const executor = new Executor(true, 10, 10, 100, coordinator);
    (executor as unknown as {clob: Record<string, unknown>}).clob = {
      tickSize: async()=>0.01, minOrderSize:()=>5,
      submitOrder: async()=>({ success: true, orderId: "bound-order" }),
    };
    await executor.submit(Side.Up, "up", 0.4, 10);
    executor.noteFill(Side.Up, "bound-order", 2);
    executor.noteFill(Side.Up, "bound-order", 8);
    executor.confirmAccountReconciled();
    expect(events.slice(1)).toEqual(["submitted", "acknowledged", "partially_filled", "settlement_pending", "reconciled"]);
  });

  it("keeps a cancelled order reservation active until account reconciliation", async () => {
    const events: string[] = [];
    const coordinator = {
      prepare: vi.fn((id: string) => events.push(`prepare:${id}`)),
      transition: vi.fn((_id: string, status: 'submitted' | 'unknown' | 'acknowledged' | 'partially_filled' | 'settlement_pending' | 'reconciled') => events.push(status)),
    };
    const executor = new Executor(true, 10, 10, 100, coordinator);
    (executor as unknown as {clob: Record<string, unknown>}).clob = {
      tickSize: async()=>0.01, minOrderSize:()=>5,
      submitOrder: async()=>({ success: true, orderId: "cancel-race" }),
      cancel: async()=>true,
    };
    await executor.submit(Side.Up, "up", 0.4, 5);
    await executor.cancelSide(Side.Up);
    expect(events.slice(1)).toEqual(["submitted", "acknowledged"]);
    executor.confirmAccountReconciled();
    expect(events.at(-1)).toBe("reconciled");
  });

  it("tracks a residual exit through reservation reconciliation", async () => {
    const events: string[] = [];
    const coordinator = {
      prepare: vi.fn((id: string) => events.push(`prepare:${id}`)),
      transition: vi.fn((_id: string, status: 'submitted' | 'unknown' | 'acknowledged' | 'partially_filled' | 'settlement_pending' | 'reconciled') => events.push(status)),
    };
    const executor = new Executor(true, 10, 10, 100, coordinator);
    (executor as unknown as { clob: Record<string, unknown> }).clob = {
      tickSize: async () => 0.01,
      submitMarketSell: async () => ({ success: true, orderId: 'exit-order', tradeIds: ['trade-1'] }),
    };
    const result = await executor.submitExit(Side.Up, 'up', 0.4, 5);
    expect(result).toMatchObject({ ok: true, orderId: 'exit-order' });
    expect(events.slice(1)).toEqual(['submitted', 'acknowledged']);
    executor.confirmAccountReconciled();
    expect(events.at(-1)).toBe('reconciled');
  });
});
