import { describe, expect, it } from "vitest";
import { cursorPages, offsetPages, sanitize } from "./account-data.js";
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
    expect(data.complete).toBe(true);
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
});
