import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPolymarketFeed } from "./polymarket.js";
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
  });

  it.each(["INVALID AUTH", JSON.stringify({type:"user",status:"unauthorized"})])(
    "disables authenticated feed on explicit rejection: %s", async (rejection) => {
      const events: FeedEvent[] = [];
      const feed = runUserFeed((event) => events.push(event), {
        creds:{key:"test",secret:"test",passphrase:"test"},conditionId:"market",upToken:"up",downToken:"down",isOurOrder:()=>false,
      }, Date.now()/1000+60);
      stop = feed.stop;
      const socket = await openSocket();
      expect(feed.isHealthy()).toBe(true);
      socket.emit("message", rejection);
      expect(feed.isHealthy()).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({kind:"userStatus",healthy:false}));
    },
  );
});
