import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PM_WS_BILATERAL_QUOTE_TIMEOUT_MS,
  PM_WS_MESSAGE_TIMEOUT_MS,
  runPolymarketFeed,
} from "./polymarket.js";
import { runUserFeed } from "./user.js";
import type { FeedEvent } from "./index.js";

interface Socket { emit: (name: string, data?: unknown) => void; readyState: number; }
const mocks = vi.hoisted(() => ({ sockets: [] as Socket[] }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); mocks.sockets.push(this); }
    send() {}
    terminate() { this.readyState = 3; this.emit("close"); }
  } };
});
let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); mocks.sockets.length = 0; });
afterEach(() => { stop?.(); stop = undefined; vi.clearAllTimers(); vi.useRealTimers(); });
async function openSocket() {
  const socket = mocks.sockets[0];
  socket.emit("open");
  await Promise.resolve();
  return socket;
}

describe("live websocket safety", () => {
  it("emits one paired snapshot for a bilateral fast frame and preserves the next reversal", async () => {
    const events: FeedEvent[] = [];
    const feed = runPolymarketFeed((event) => events.push(event), "up", "down", Date.now()/1000+60);
    stop = feed.stop;
    const socket = await openSocket();
    const emit = (payload: unknown) => socket.emit("message", JSON.stringify(payload));
    const at = Date.now();
    const book = (asset_id: string, bid: string, ask: string) => ({ event_type: "book", asset_id,
      timestamp: at, bids: [{ price: bid, size: "10" }], asks: [{ price: ask, size: "10" }] });
    emit([book("up", "0.64", "0.65"), book("down", "0.64", "0.65")]);
    const before = events.filter(event => event.kind === "book").length;
    emit([
      { event_type: "best_bid_ask", asset_id: "up", best_bid: "0.66", best_ask: "0.67", timestamp: at + 1 },
      { event_type: "best_bid_ask", asset_id: "down", best_bid: "0.69", best_ask: "0.70", timestamp: at + 1 },
    ]);
    let books = events.filter(event => event.kind === "book");
    expect(books).toHaveLength(before + 1);
    expect(books.at(-1)?.snapshot).toMatchObject({ upAsk: 0.67, downAsk: 0.7 });
    expect(feed.isHealthy()).toBe(true);
    emit({ event_type: "best_bid_ask", asset_id: "up", best_bid: "0.63", best_ask: "0.64", timestamp: at + 2 });
    books = events.filter(event => event.kind === "book");
    expect(books).toHaveLength(before + 2);
    expect(books.at(-1)?.snapshot.upAsk).toBe(0.64);
  });

  it("discards cached BBO after newer depth and marks empty books unhealthy", async () => {
    const events: FeedEvent[] = [];
    const feed = runPolymarketFeed((event) => events.push(event), "up", "down", Date.now()/1000+60);
    stop = feed.stop;
    const socket = await openSocket();
    const emit = (payload: unknown) => socket.emit("message", JSON.stringify(payload));
    const book = (asset_id: string, bid: string, ask: string) => ({event_type: "book", asset_id,
      timestamp: Date.now(), bids: [{price:bid,size:"10"}], asks:[{price:ask,size:"10"}]});
    emit([book("up", "0.4", "0.41"), book("down", "0.59", "0.6")]);
    emit({event_type:"best_bid_ask",asset_id:"up",best_bid:"0.39",best_ask:"0.4",timestamp:Date.now()});
    await vi.advanceTimersByTimeAsync(10);
    emit(book("up", "0.42", "0.43"));
    const lastBook = events.filter((event) => event.kind === "book").at(-1);
    expect(lastBook?.snapshot.upBid).toBe(0.42);
    expect(feed.isHealthy()).toBe(true);
    emit({event_type:"book",asset_id:"up",bids:[],asks:[],timestamp:Date.now()});
    expect(feed.isHealthy()).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({kind:"bookStatus",healthy:false,
      connected:true,reason:"incomplete_book"}));
  });

  it("keeps fast top separate from delayed L2 and lets newer L2 become authoritative", async () => {
    const events: FeedEvent[] = [];
    const feed = runPolymarketFeed((event) => events.push(event), "up", "down", Date.now()/1000+60);
    stop = feed.stop;
    const socket = await openSocket();
    const emit = (payload: unknown) => socket.emit("message", JSON.stringify(payload));
    const base = Date.now();
    const book = (asset_id:string,bid:string,ask:string,timestamp:number) => ({event_type:"book",asset_id,timestamp,
      bids:[{price:bid,size:"10"}],asks:[{price:ask,size:"10"}]});
    emit([book("up","0.64","0.66",base),book("down","0.33","0.35",base)]);
    vi.setSystemTime(base+10);
    emit({event_type:"best_bid_ask",asset_id:"up",best_bid:"0.66",best_ask:"0.68",timestamp:base+5});
    const fast = events.filter(event=>event.kind==="book").at(-1)?.snapshot;
    vi.setSystemTime(base+100);
    emit({event_type:"price_change",timestamp:base+3,price_changes:[
      {asset_id:"up",side:"SELL",price:"0.66",size:"0"},
      {asset_id:"up",side:"SELL",price:"0.68",size:"10"},
    ]});
    const delayed = events.filter(event=>event.kind==="book").at(-1)?.snapshot;
    expect(delayed?.upAsk).toBe(0.68);
    expect(delayed?.upExchangeTsUnix).toBe((base+5)/1000);
    expect(delayed?.upReceivedAtUnix).toBe((base+10)/1000);
    expect(delayed?.upReceivedAtMonoMs).toBe(fast?.upReceivedAtMonoMs);
    expect(delayed?.upProcessedAtMonoMs).toBe(fast?.upProcessedAtMonoMs);
    expect(delayed?.upMarketAgeMs).toBe(5);
    emit(book("up","0.67","0.69",base+101));
    const latest=events.filter(event=>event.kind==="book").at(-1);
    expect(latest?.snapshot.upAsk).toBe(0.69);
    expect(latest?.snapshot.upAskLevels?.[0]?.[0]).toBe(0.69);
  });

  it("does not label older same-price L2 quantities as fresh BBO depth", async () => {
    const events: FeedEvent[]=[];
    const feed=runPolymarketFeed((event)=>events.push(event),"up","down",Date.now()/1000+60);
    stop=feed.stop;
    const socket=await openSocket();
    const emit=(payload:unknown)=>socket.emit("message",JSON.stringify(payload));
    const base=Date.now();
    const book=(asset_id:string)=>({event_type:"book",asset_id,timestamp:base,
      bids:[{price:"0.64",size:"10"}],asks:[{price:"0.66",size:"10"}]});
    emit([book("up"),book("down")]);
    vi.setSystemTime(base+10);
    emit({event_type:"best_bid_ask",asset_id:"up",best_bid:"0.64",best_ask:"0.66",timestamp:base+5});
    const latest=events.filter(event=>event.kind==="book").at(-1)?.snapshot;
    expect(latest).toMatchObject({upBid:0.64,upAsk:0.66,upExchangeTsUnix:(base+5)/1000});
    expect(latest?.upBidSz).toBeUndefined();
    expect(latest?.upAskSz).toBeUndefined();
    expect(latest?.upBidLevels).toBeUndefined();
    expect(latest?.upAskLevels).toBeUndefined();
    emit({event_type:"book",asset_id:"up",timestamp:base+5,
      bids:[{price:"0.64",size:"12"}],asks:[{price:"0.66",size:"13"}]});
    const caughtUp=events.filter(event=>event.kind==="book").at(-1)?.snapshot;
    expect(caughtUp?.upBidSz).toBe(12);
    expect(caughtUp?.upAskSz).toBe(13);
    expect(caughtUp?.upBidLevels?.[0]).toEqual([0.64,12]);
    expect(caughtUp?.upAskLevels?.[0]).toEqual([0.66,13]);
  });

  it("uses a later same-millisecond L2 snapshot instead of cached fast top", async () => {
    const events: FeedEvent[]=[];
    const feed=runPolymarketFeed((event)=>events.push(event),"up","down",Date.now()/1000+60);
    stop=feed.stop;
    const socket=await openSocket();
    const emit=(payload:unknown)=>socket.emit("message",JSON.stringify(payload));
    const at=Date.now();
    const book=(asset_id:string,bid:string,ask:string)=>({event_type:"book",asset_id,timestamp:at,
      bids:[{price:bid,size:"10"}],asks:[{price:ask,size:"10"}]});
    emit([book("up","0.64","0.66"),book("down","0.33","0.35")]);
    emit({event_type:"best_bid_ask",asset_id:"up",best_bid:"0.66",best_ask:"0.68",timestamp:at+1});
    emit({event_type:"book",asset_id:"up",timestamp:at+1,bids:[{price:"0.67",size:"10"}],asks:[{price:"0.69",size:"10"}]});
    expect(events.filter(event=>event.kind==="book").at(-1)?.snapshot.upAsk).toBe(0.69);
  });

  it("computes fast BBO age from the selected BBO timestamp", async () => {
    const events: FeedEvent[]=[];
    const feed=runPolymarketFeed((event)=>events.push(event),"up","down",Date.now()/1000+60);
    stop=feed.stop;
    const socket=await openSocket();
    const emit=(payload:unknown)=>socket.emit("message",JSON.stringify(payload));
    const base=Date.now();
    const book=(asset_id:string)=>({event_type:"book",asset_id,timestamp:base,
      bids:[{price:"0.40",size:"10"}],asks:[{price:"0.41",size:"10"}]});
    emit([book("up"),book("down")]);
    vi.setSystemTime(base+10);
    emit({event_type:"best_bid_ask",asset_id:"up",best_bid:"0.42",best_ask:"0.43",timestamp:base+5});
    const latest=events.filter(event=>event.kind==="book").at(-1)?.snapshot;
    expect(latest?.upExchangeTsUnix).toBe((base+5)/1000);
    expect(latest?.upMarketAgeMs).toBe(5);
  });

  it("marks a malformed market frame unhealthy and reconnects instead of silently skipping it", async () => {
    const events: FeedEvent[]=[];
    const feed=runPolymarketFeed((event)=>events.push(event),"up","down",Date.now()/1000+60);
    stop=feed.stop;
    const socket=await openSocket();
    const at=Date.now();
    const book=(asset_id:string,bid:string,ask:string)=>({event_type:"book",asset_id,timestamp:at,
      bids:[{price:bid,size:"10"}],asks:[{price:ask,size:"10"}]});
    socket.emit("message",JSON.stringify([book("up","0.4","0.41"),book("down","0.59","0.6")]));
    expect(feed.isHealthy()).toBe(true);

    socket.emit("message","{malformed");

    expect(feed.isHealthy()).toBe(false);
    expect(events.at(-1)).toMatchObject({kind:"bookStatus",healthy:false,
      connected:false,reason:"transport_disconnected"});
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.sockets).toHaveLength(2);
  });

  it("terminates a silent OPEN socket and recovers quotes through the existing reconnect loop", async () => {
    const events: FeedEvent[] = [];
    const feed = runPolymarketFeed((event) => events.push(event), "up", "down", Date.now()/1000+60);
    stop = feed.stop;
    const first = await openSocket();

    await vi.advanceTimersByTimeAsync(PM_WS_MESSAGE_TIMEOUT_MS - 1_000);
    expect(first.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.readyState).toBe(3);
    expect(feed.isHealthy()).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "bookStatus", healthy: false, connected: false, reason: "transport_disconnected",
    }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.sockets).toHaveLength(2);

    const second = mocks.sockets[1];
    second.emit("open");
    await Promise.resolve();
    const book = (asset_id: string) => ({ event_type: "book", asset_id, timestamp: Date.now(),
      bids: [{ price: "0.4", size: "10" }], asks: [{ price: "0.41", size: "10" }] });
    second.emit("message", JSON.stringify([book("up"), book("down")]));
    expect(feed.isHealthy()).toBe(true);
  });

  it.each(["message", "pong"])("does not let %s PONG keep a stalled quote subscription alive", async (eventName) => {
    const events: FeedEvent[] = [];
    const feed = runPolymarketFeed((event) => events.push(event), "up", "down", Date.now()/1000+60);
    stop = feed.stop;
    const socket = await openSocket();
    const book = (asset_id: string) => ({ event_type: "book", asset_id, timestamp: Date.now(),
      bids: [{ price: "0.4", size: "10" }], asks: [{ price: "0.41", size: "10" }] });
    socket.emit("message", JSON.stringify([book("up"), book("down")]));
    expect(feed.isHealthy()).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    socket.emit(eventName, "PONG");
    expect(feed.isHealthy()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    socket.emit(eventName, "PONG");
    expect(socket.readyState).toBe(1);
    expect(events.filter((event) => event.kind === "book")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PM_WS_BILATERAL_QUOTE_TIMEOUT_MS - 20_000);
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.sockets).toHaveLength(2);
  });

  it("reconnects when only one outcome keeps updating", async () => {
    const feed = runPolymarketFeed(() => {}, "up", "down", Date.now()/1000+60);
    stop = feed.stop;
    const socket = await openSocket();
    const book = (asset_id: string) => ({ event_type: "book", asset_id, timestamp: Date.now(),
      bids: [{ price: "0.4", size: "10" }], asks: [{ price: "0.41", size: "10" }] });
    socket.emit("message", JSON.stringify([book("up"), book("down")]));
    for (let elapsed = 10_000; elapsed < PM_WS_BILATERAL_QUOTE_TIMEOUT_MS; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      socket.emit("message", JSON.stringify(book("up")));
      expect(socket.readyState).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.sockets).toHaveLength(2);
  });

  it("keeps a bilateral quote stream connected beyond both watchdog limits", async () => {
    const feed = runPolymarketFeed(() => {}, "up", "down", Date.now()/1000+120);
    stop = feed.stop;
    const socket = await openSocket();
    const book = (asset_id: string) => ({ event_type: "book", asset_id, timestamp: Date.now(),
      bids: [{ price: "0.4", size: "10" }], asks: [{ price: "0.41", size: "10" }] });
    for (let step = 0; step < 4; step += 1) {
      socket.emit("message", JSON.stringify([book("up"), book("down")]));
      expect(feed.isHealthy()).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(socket.readyState).toBe(1);
    expect(mocks.sockets).toHaveLength(1);
  });
  it.each(["INVALID AUTH", JSON.stringify({type:"user",status:"unauthorized"})])(
    "disables authenticated feed on explicit rejection: %s", async (rejection) => {
      const events: FeedEvent[] = [];
      const feed = runUserFeed((event) => events.push(event), {
        creds:{key:"test",secret:"test",passphrase:"test"},conditionId:"market",upToken:"up",downToken:"down",isOurOrder:()=>false,
      }, Date.now()/1000+60);
      stop = feed.stop;
      const socket = await openSocket();
      socket.emit("message", "authenticated");
      expect(feed.isHealthy()).toBe(true);
      socket.emit("message", rejection);
      expect(feed.isHealthy()).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({kind:"userStatus",healthy:false}));
    },
  );

  it("aborts a user-ready waiter and removes its timeout", async () => {
    const feed = runUserFeed(() => {}, {
      creds:{key:"test",secret:"test",passphrase:"test"}, conditionId:"market",
      upToken:"up", downToken:"down", isOurOrder:()=>false,
    }, Date.now()/1000+60);
    stop = feed.stop;
    await openSocket();
    const timersBeforeWait = vi.getTimerCount();
    const controller = new AbortController();
    const pending = feed.waitUntilReady(30_000, controller.signal);
    expect(vi.getTimerCount()).toBe(timersBeforeWait + 1);

    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(vi.getTimerCount()).toBe(timersBeforeWait);
  });

  it("waits for the built-in reconnect before taking the final trade snapshot", async () => {
    const events: FeedEvent[] = [];
    const fetchRecentTrades = vi.fn().mockResolvedValue([]);
    const fetchOpenOrders = vi.fn().mockResolvedValue([]);
    const feed = runUserFeed((event) => events.push(event), {
      creds:{key:"test",secret:"test",passphrase:"test"}, conditionId:"market",
      upToken:"up", downToken:"down", isOurOrder:()=>false, fetchRecentTrades,
      fetchOpenOrders,
    }, Date.now()/1000+60);
    stop = feed.stop;
    const first = await openSocket();
    first.emit("message", "authenticated");
    expect(feed.isHealthy()).toBe(true);

    first.emit("close");
    const snapshot = feed.reconcileRecentTrades(Date.now()/1000 - 10);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(mocks.sockets).toHaveLength(2));
    const second = mocks.sockets[1];
    second.emit("open");
    await vi.advanceTimersByTimeAsync(500);
    second.emit("message", "authenticated");
    await vi.waitFor(() => expect(feed.isHealthy()).toBe(true));
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(snapshot).resolves.toEqual([]);
    expect(fetchRecentTrades).toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({kind:"userStatus",healthy:false}));
    expect(events).toContainEqual(expect.objectContaining({kind:"userStatus",healthy:true}));
  });

  it("accepts a successful signed account read when WS omits an auth confirmation", async () => {
    const events: FeedEvent[] = [];
    const verifyAuthenticated = vi.fn().mockResolvedValue(true);
    const feed = runUserFeed((event) => events.push(event), {
      creds:{key:"test",secret:"test",passphrase:"test"}, conditionId:"market",
      upToken:"up", downToken:"down", isOurOrder:()=>false,
      fetchOpenOrders: vi.fn().mockResolvedValue([]),
      fetchRecentTrades: vi.fn().mockResolvedValue([]),
      verifyAuthenticated,
    }, Date.now()/1000+60);
    stop = feed.stop;
    const socket = await openSocket();
    socket.emit("message", JSON.stringify({ event_type: "order", type: "PLACEMENT", id: "order-1", asset_id: "up", market: "market" }));
    await vi.waitFor(() => expect(feed.isHealthy()).toBe(true));
    expect(verifyAuthenticated).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({kind:"userStatus", healthy:true}));
  });

  it("marks malformed authenticated frames discontinuous and runs reconnect compensation", async () => {
    const events: FeedEvent[]=[];
    const fetchRecentTrades=vi.fn().mockResolvedValue([]);
    const fetchOpenOrders=vi.fn().mockResolvedValue([]);
    const reconcileAfterReconnect=vi.fn().mockResolvedValue(undefined);
    const feed=runUserFeed((event)=>events.push(event),{
      creds:{key:"test",secret:"test",passphrase:"test"},conditionId:"market",
      upToken:"up",downToken:"down",isOurOrder:()=>false,fetchRecentTrades,fetchOpenOrders,reconcileAfterReconnect,
    },Date.now()/1000+60);
    stop=feed.stop;
    const first=await openSocket();
    first.emit("message","authenticated");
    expect(feed.isHealthy()).toBe(true);

    first.emit("message","{malformed");

    expect(feed.isHealthy()).toBe(false);
    expect(feed.isContinuous?.()).toBe(false);
    expect(first.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.sockets).toHaveLength(2);
    const second=mocks.sockets[1];
    second.emit("open");
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(()=>expect(reconcileAfterReconnect).toHaveBeenCalledOnce());
    second.emit("message","authenticated");
    expect(feed.isContinuous?.()).toBe(true);
    expect(fetchRecentTrades).toHaveBeenCalledTimes(2);
    expect(fetchOpenOrders).toHaveBeenCalledTimes(2);
  });

  it("does not leave a failed reconnect compensation socket permanently locked", async () => {
    const fetchRecentTrades = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("temporary REST failure"));
    const fetchOpenOrders = vi.fn().mockResolvedValue([]);
    const feed = runUserFeed(() => {}, {
      creds:{key:"test",secret:"test",passphrase:"test"}, conditionId:"market",
      upToken:"up", downToken:"down", isOurOrder:()=>false, fetchRecentTrades, fetchOpenOrders,
    }, Date.now()/1000+60);
    stop = feed.stop;
    const first = await openSocket();
    first.emit("message", "authenticated");
    expect(feed.isHealthy()).toBe(true);
    first.emit("close");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.sockets).toHaveLength(2);
    mocks.sockets[1].emit("open");
    await vi.advanceTimersByTimeAsync(2_250);
    expect(mocks.sockets).toHaveLength(3);
    expect(feed.isContinuous?.()).toBe(false);
  });

  it("passes the venue order status separately from the user event type", async () => {
    const onOrderEvent = vi.fn();
    const feed = runUserFeed(() => {}, {
      creds:{key:"test",secret:"test",passphrase:"test"}, conditionId:"market",
      upToken:"up", downToken:"down", isOurOrder:id=>id === "order-1", onOrderEvent,
    }, Date.now()/1000+60);
    stop = feed.stop;
    const socket = await openSocket();
    socket.emit("message", "authenticated");
    socket.emit("message", JSON.stringify({ event_type:"order", type:"UPDATE", status:"LIVE", id:"order-1", size_matched:"0" }));
    expect(onOrderEvent).toHaveBeenCalledWith(expect.objectContaining({ orderId:"order-1", type:"UPDATE", venueStatus:"LIVE" }));
  });
});
