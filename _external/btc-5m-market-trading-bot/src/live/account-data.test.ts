import { describe, expect, it } from "vitest";
import { cursorPages, offsetPages, sanitize, OrderHistoryReader, type Section } from "./account-data.js";
const wallet = "0x1111111111111111111111111111111111111111";

describe("read-only account pagination", () => {
  it("reads all cursor pages and deduplicates overlap", async () => {
    const cursors: string[] = [];
    const data = await cursorPages(async (_, params) => {
      cursors.push(params!.next_cursor);
      return params!.next_cursor === "MA==" ? { data: [{ id: "a", secret: "hidden" }], next_cursor: "next" }
        : { data: [{ id: "a" }, { id: "b" }], next_cursor: "LTE=" };
    }, "/data/orders", "orders", wallet);
    expect(cursors).toEqual(["MA==", "next"]);
    expect(data.complete).toBe(false);
    expect(data.error_code).toBe("pagination_overlap");
    expect(data.items).toEqual([{ id: "a" }, { id: "b" }]);
  });
  it("reports loop, fetch failure and max pages as partial, never complete", async () => {
    const looping = await cursorPages(async () => ({ data: [{ id: "a" }], next_cursor: "MA==" }), "/data/trades", "trades", wallet);
    expect(looping).toMatchObject({ available: true, complete: false, error_code: "fetch_or_pagination_failed" });
    const failed = await cursorPages(async () => { throw new Error("secret response"); }, "/data/orders", "orders", wallet);
    expect(failed).toMatchObject({ available: false, complete: false });
    expect(JSON.stringify(failed)).not.toContain("secret response");
    const capped = await cursorPages(async () => ({ data: [{ id: "a" }], next_cursor: "next" }), "/data/orders", "orders", wallet, 1);
    expect(capped).toMatchObject({ available: true, complete: false, error_code: "page_limit" });
  });
  it("retains zero-size positions and follows offsets until exhaustion", async () => {
    const queries: unknown[] = [];
    const result = await offsetPages(async (_, params) => {
      queries.push(params);
      return params?.offset === "0" ? [{ proxyWallet: wallet, asset: "a", size: 0 }, { proxyWallet: wallet, asset: "b", size: 1 }] : [];
    }, "/positions", "positions", wallet, 2);
    expect(result.complete).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(queries).toEqual([{ user: wallet, limit: "2", offset: "0", sizeThreshold: "0" }, { user: wallet, limit: "2", offset: "2", sizeThreshold: "0" }]);
  });
  it("rejects another wallet and repeated offset pages", async () => {
    const wrong = await offsetPages(async () => [{ proxyWallet: "wrong", asset: "a" }], "/positions", "positions", wallet);
    expect(wrong.available).toBe(false);
    expect(wrong.items).toEqual([]);
    const repeated = await offsetPages(async () => [{ proxyWallet: wallet, asset: "a" }], "/positions", "positions", wallet, 1);
    expect(repeated.complete).toBe(false);
    expect(repeated.items).toHaveLength(1);
  });
  it("keeps only allowlisted fields and own maker fills without secrets", () => {
    expect(sanitize({ id: "t", secret: "secret", maker_orders: [{ maker_address: wallet, order_id: "own", matched_amount: "2", api_key: "secret" }, { maker_address: "other", order_id: "other" }] }, "trades", wallet)).toEqual({ id: "t", maker_orders: [{ order_id: "own", matched_amount: "2" }] });
    expect(sanitize({ fee_rate_bps: "100", fee: 99, reward: 999 }, "trades", wallet)).toEqual({ fee_rate_bps: "100" });
  });
  it("marks moving offset overlap incomplete without double-counting positions or activity", async () => {
    const positions = await offsetPages(async (_, params) => params?.offset === "0"
      ? [{ asset: "a", size: 1 }, { asset: "b", size: 2 }]
      : [{ asset: "b", size: 3 }], "/positions", "positions", wallet, 2);
    expect(positions).toMatchObject({ complete: false, error_code: "pagination_overlap" });
    expect(positions.items).toEqual([{ asset: "a", size: 1 }, { asset: "b", size: 2 }]);
    const activity = await offsetPages(async (_, params) => params?.offset === "0"
      ? [{ transactionHash: "a", usdcSize: 1 }, { transactionHash: "b", usdcSize: 2 }]
      : [{ transactionHash: "b", usdcSize: 2 }], "/activity", "activity", wallet, 2);
    expect(activity).toMatchObject({ complete: false, error_code: "pagination_overlap" });
    expect(activity.items).toHaveLength(2);
  });
});

const section = (items: Record<string, unknown>[] = []): Section => ({ available: true, complete: true, items, pages: 1, checked_at: "2026-09-10T00:00:00Z", source: "clob-v2" });
describe("observed order history", () => {
  it("reports a successful HTTP null detail as unavailable rather than canceled or still unqueried", async () => {
    const reader = new OrderHistoryReader(wallet);
    const result = await reader.read(async()=>null, section(), section([{trader_side:"TAKER",taker_order_id:"gone"}]), 1_000_000);
    expect(result).toMatchObject({complete:false,items:[],pending_order_count:1,unavailable_order_count:1,error_code:"order_details_unavailable"});
  });
  it("queries disappeared orders and caches official terminal status, never infers cancellation", async () => {
    const reader = new OrderHistoryReader(wallet);
    const calls: string[] = [];
    const get = async (path: string) => { calls.push(path); return { id: "a", maker_address: wallet, status: "CANCELED", price: "0.4", secret: "hidden" }; };
    const initial = await reader.read(get, section([{ id: "a" }]), section(), 1_000_000);
    expect(initial.items).toEqual([]);
    expect(calls).toEqual([]);
    const disappeared = await reader.read(get, section(), section(), 1_030_000);
    expect(calls).toEqual(["/data/order/a"]);
    expect(disappeared).toMatchObject({ historical_complete: false, coverage: "observed_order_ids", persistence: "reader_session", complete: true });
    expect(disappeared.items[0]).toMatchObject({ id: "a", status: "CANCELED", status_stale: false });
    expect(JSON.stringify(disappeared)).not.toContain("hidden");
    await reader.read(get, section(), section(), 1_060_000);
    expect(calls).toHaveLength(1);
  });
  it("recovers only own taker and maker order IDs and rejects cross-account detail", async () => {
    const reader = new OrderHistoryReader(wallet);
    const calls: string[] = [];
    const trades = section([
      sanitize({ trader_side: "MAKER", taker_order_id: "foreign", maker_orders: [{ order_id: "own", maker_address: wallet }, { order_id: "other", maker_address: "other" }] }, "trades", wallet),
      { trader_side: "TAKER", taker_order_id: "own-taker" }, { taker_order_id: "unknown" },
    ]);
    const result = await reader.read(async path => { calls.push(path); return { id: path.split("/").pop(), maker_address: "wrong", status: "CANCELED" }; }, section(), trades, 1_000_000);
    expect(calls.sort()).toEqual(["/data/order/own", "/data/order/own-taker"]);
    expect(result).toMatchObject({ complete: false, pending_order_count: 2, items: [] });
  });
  it("bounds queries and retries, preserves unresolved orders without cancellation fabrication", async () => {
    const reader = new OrderHistoryReader(wallet, 3, 2);
    const calls: string[] = [];
    const trades = section(["a", "b", "c", "d"].map(id => ({ trader_side: "TAKER", taker_order_id: id })));
    const get = async (path: string) => { calls.push(path); throw new Error("private server response"); };
    const first = await reader.read(get, section(), trades, 1_000_000);
    expect(calls).toHaveLength(2);
    expect(first).toMatchObject({ complete: false, known_order_count: 3, pending_order_count: 3, truncated: true, items: [] });
    const second = await reader.read(get, section(), trades, 1_030_000);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(second)).not.toContain("private server response");
    const otherAccount = new OrderHistoryReader("other");
    expect((await otherAccount.read(get, section(), section(), 1_030_000)).known_order_count).toBe(0);
  });
});
