import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Side } from "../models.js";
import { Executor } from "./executor.js";
import { Engine } from "./engine.js";
import type { Market } from "./discovery.js";
import type { Journal } from "./journal.js";
import type { UserFeedControl } from "./feeds/user.js";
import {
  assertOfficialClobHealth,
  liveBookIsFresh,
  handleUserEvent,
  applyEvents,
  finalizeMarketAccount,
} from "./orchestrator.js";

beforeEach(()=>vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({minimum_tick_size:0.01})))));
afterEach(()=>vi.unstubAllGlobals());

describe("final account reconciliation", () => {
  afterEach(()=>vi.useRealTimers());
  it("journals late owned fills once and excludes other account trades from run PnL", async () => {
    vi.useFakeTimers();
    const executor = new Executor(false,10,10,100);
    const first = await executor.submit(Side.Up,"up",0.4,5);
    const second = await executor.submit(Side.Down,"down",0.5,5);
    const engine = new Engine({liveMode:true});
    engine.reset(100,400);
    const market = {conditionId:"condition",start:100} as Market;
    const seen = new Set<string>();
    const log = vi.fn();
    const journal = {log,logEvent:vi.fn()} as unknown as Journal;
    const normal = {kind:"exchangeFill" as const,tradeId:"trade-1",orderId:first.orderId!,
      fill:{side:Side.Up,shares:2,price:0.4,tsUnix:101,isMaker:true}};
    const late = {kind:"exchangeFill" as const,tradeId:"trade-2",orderId:second.orderId!,
      fill:{side:Side.Down,shares:3,price:0.5,tsUnix:102,isMaker:true}};
    await handleUserEvent(engine,executor,market,journal,101,normal,seen);
    const user = {isHealthy:()=>true,reconcileRecentTrades:async()=>[
      normal,late,{...late,tradeId:"foreign",orderId:"manual-order"},
    ]} as unknown as UserFeedControl;
    const finishing=finalizeMarketAccount(executor,engine,market,user,
      event=>handleUserEvent(engine,executor,market,journal,102,event,seen),seen);
    await vi.advanceTimersByTimeAsync(300);
    await finishing;
    const fills=log.mock.calls.filter(([event])=>event === "fill").map((row)=>row[3]);
    expect(fills).toHaveLength(2);
    expect(new Set(fills.map(row=>row.event_id)).size).toBe(2);
    expect(fills.reduce((total,row)=>total+row.shares*row.price,0)).toBeCloseTo(2.3);
    expect(engine.fills()).toBe(2);
  });
  it("rejects a stable REST snapshot that omits a fill already written to the ledger", async () => {
    vi.useFakeTimers();
    const executor={pauseSubmissions:async()=>{},cancelAll:async()=>{},getOpenOrders:async()=>[],isOurOrder:()=>true};
    const engine={replaceCurrentMarketFills:vi.fn()};
    const user={isHealthy:()=>true,reconcileRecentTrades:async()=>[]};
    const finishing=finalizeMarketAccount(executor as unknown as Executor,engine as unknown as Engine,
      {conditionId:"c",start:100} as Market,user as unknown as UserFeedControl,undefined,
      new Set([JSON.stringify(["known-trade","known-order",Side.Up])]));
    const rejected=expect(finishing).rejects.toThrow(/omits previously journaled fills/);
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    expect(engine.replaceCurrentMarketFills).not.toHaveBeenCalled();
  });
  it("freezes submissions and waits for cancellation before rebuilding all final fills", async () => {
    vi.useFakeTimers();
    const steps:string[]=[];
    const executor = {pauseSubmissions:async()=>{steps.push("pause");},cancelAll:async()=>{steps.push("cancel");},
      getOpenOrders:async()=>{steps.push("open");return [];},confirmAccountReconciled:()=>{steps.push("complete");},isOurOrder:()=>true};
    const fill={side:Side.Up,shares:2,price:0.4,tsUnix:100,isMaker:true};
    const engine={replaceCurrentMarketFills:vi.fn(),onOrderCancelled:vi.fn()};
    const user={isHealthy:()=>true,reconcileRecentTrades:async()=>{steps.push("fills");return [{kind:"exchangeFill",fill,orderId:"our",tradeId:"trade"}];},stop:vi.fn()};
    const finishing=finalizeMarketAccount(executor as unknown as Executor,engine as unknown as Engine,
      {conditionId:"condition",start:100} as Market,user as unknown as UserFeedControl);
    await vi.advanceTimersByTimeAsync(300);
    await finishing;
    expect(steps).toEqual(["pause","cancel","open","open","fills","complete"]);
    expect(engine.replaceCurrentMarketFills).toHaveBeenCalledWith([fill]);
    expect(user.stop).not.toHaveBeenCalled();
  });
  it("propagates a failed cancellation without claiming the market is settled", async () => {
    const executor={pauseSubmissions:async()=>{},cancelAll:async()=>{throw new Error("cancel unknown");}};
    const engine={replaceCurrentMarketFills:vi.fn()};
    const user={reconcileRecentTrades:vi.fn()};
    await expect(finalizeMarketAccount(executor as unknown as Executor,engine as unknown as Engine,
      {} as Market,user as unknown as UserFeedControl)).rejects.toThrow("cancel unknown");
    expect(engine.replaceCurrentMarketFills).not.toHaveBeenCalled();
    expect(user.reconcileRecentTrades).not.toHaveBeenCalled();
  });
});

describe("order event identity", () => {
  it("retains a paper replacement quote generated in the same tick as an expired cancellation", async () => {
    const engine = new Engine({ liveMode: false, makerLifeSec: 1 });
    const executor = new Executor(false, 20, 20, 200);
    const market = {upToken:"up",downToken:"down"} as Market;
    const journal = {log:vi.fn(),logEvent:vi.fn()} as unknown as Journal;
    engine.reset(1000,1300);
    const ticks={upTickSize:0.01,downTickSize:0.01};
    await applyEvents(engine.onBook(1010,0.45,0.46,0.52,0.53,ticks),executor,engine,market,journal,1010,false);
    const events = engine.onBook(1012,0.45,0.46,0.52,0.53,ticks);
    expect(events.some(event=>event.kind === "cancel")).toBe(true);
    expect(events.some(event=>event.kind === "quote")).toBe(true);
    const pending = engine.session.pendingQuotes();
    await applyEvents(events,executor,engine,market,journal,1012,false);
    expect(engine.session.pendingQuotes().map(({side,shares})=>({side,shares})))
      .toEqual(pending.map(({side,shares})=>({side,shares})));
    expect(pending.length).toBeGreaterThan(0);
  });
  it("late fills update inventory without consuming a newer quote; old cancels leave it intact", async () => {
    const executor = new Executor(false, 10, 10, 100);
    const old = await executor.submit(Side.Up, "up", 0.4, 5);
    const current = await executor.submit(Side.Up, "up", 0.39, 5);
    const engine = { confirmExchangeFill: vi.fn().mockReturnValue({ kind: "fill", side:Side.Up,shares:2,price:0.4,fee:0,isMaker:true }), onOrderCancelled: vi.fn() };
    const journal = { log: vi.fn(), logEvent: vi.fn() };
    const market = {} as Market;
    await handleUserEvent(engine as unknown as Engine, executor, market, journal as unknown as Journal, 100,
      { kind: "orderCancelled", orderId: old.orderId!, side: Side.Up });
    expect(engine.onOrderCancelled).not.toHaveBeenCalled();
    const fill = { side: Side.Up, shares: 2, price: 0.4, tsUnix: 100, isMaker: true };
    await handleUserEvent(engine as unknown as Engine, executor, market, journal as unknown as Journal, 100,
      { kind: "exchangeFill", orderId: old.orderId!, tradeId:"old-trade", fill });
    expect(engine.confirmExchangeFill).toHaveBeenLastCalledWith(fill, 0);
    expect(executor.restingId(Side.Up)).toBe(current.orderId);
    executor.live = true;
    await handleUserEvent(engine as unknown as Engine, executor, market, journal as unknown as Journal, 100,
      { kind: "exchangeFill", orderId: current.orderId!, tradeId:"current-trade", fill });
    expect(engine.confirmExchangeFill).toHaveBeenLastCalledWith(fill, 2);
    expect(executor.restingId(Side.Up)).toBe(current.orderId);
  });
});

describe("official CLOB health gate", () => {
  it("accepts an HTTP success from the official endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      await expect(assertOfficialClobHealth()).resolves.toBeTypeOf("number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an official endpoint error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad", { status: 503 });
    try {
      await expect(assertOfficialClobHealth()).rejects.toThrow(/HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("live book freshness", () => {
  it("rejects a quote older than the live decision budget", () => {
    expect(liveBookIsFresh({ tsUnix: 9.9 }, 10_000, 250)).toBe(true);
    expect(liveBookIsFresh({ tsUnix: 9.7 }, 10_000, 250)).toBe(false);
  });

  it("uses both exchange-side timestamps for a Polymarket websocket book", () => {
    expect(liveBookIsFresh({
      tsUnix: 10,
      source: "polymarket-ws",
      upExchangeTsUnix: 9.9,
      downExchangeTsUnix: 9.8,
    }, 10_000, 250)).toBe(true);
    expect(liveBookIsFresh({
      tsUnix: 10,
      source: "polymarket-ws",
      upExchangeTsUnix: 9.9,
      downExchangeTsUnix: 9.7,
    }, 10_000, 250)).toBe(false);
    expect(liveBookIsFresh({
      tsUnix: 10,
      source: "polymarket-ws",
    }, 10_000, 250)).toBe(false);
  });
});
