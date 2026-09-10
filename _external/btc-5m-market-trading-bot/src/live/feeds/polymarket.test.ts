import { describe, expect, it } from "vitest";
import { OrderBook } from "../orderbook.js";
import { applyMessage, bookFeedHealthy, marketTrades, tickSizeChanges } from "./polymarket.js";

describe("Polymarket market feed metadata", () => {
  it("loads initial tick metadata from each token's book snapshot", () => {
    expect(tickSizeChanges([
      {event_type:"book",asset_id:"up",tick_size:"0.01"},
      {event_type:"book",asset_id:"down",tick_size:"0.001"},
    ])).toEqual([{token:"up",tickSize:0.01},{token:"down",tickSize:0.001}]);
  });
  it("parses tick-size changes used by live order rounding", () => {
    expect(
      tickSizeChanges({
        event_type: "tick_size_change",
        asset_id: "token-1",
        old_tick_size: "0.01",
        new_tick_size: "0.001",
      }),
    ).toEqual([{ token: "token-1", tickSize: 0.001 }]);
  });

  it("ignores unrelated or malformed events", () => {
    expect(tickSizeChanges({ event_type: "price_change", asset_id: "token-1" })).toEqual([]);
    expect(tickSizeChanges({ event_type: "tick_size_change", asset_id: "token-1" })).toEqual([]);
  });
});

describe("Polymarket public trade flow", () => {
  it("parses sell flow that can consume our passive bid queue", () => {
    expect(marketTrades({
      event_type: "last_trade_price",
      asset_id: "up-token",
      price: "0.42",
      size: "12.5",
      side: "SELL",
      timestamp: "2000",
    })).toEqual([{
      token: "up-token",
      price: 0.42,
      shares: 12.5,
      takerSide: "SELL",
      tsUnix: 2000,
    }]);
  });

  it("rejects malformed trade flow", () => {
    expect(marketTrades({ event_type: "last_trade_price", asset_id: "x", side: "SELL" })).toEqual([]);
  });
});

describe("Polymarket websocket health", () => {
  it("clears old liquidity when an empty book snapshot arrives", () => {
    const up = new OrderBook();
    const down = new OrderBook();
    up.applySnapshot([[0.4, 10]], [[0.41, 10]]);
    const updated = applyMessage({ event_type: "book", asset_id: "up", bids: [], asks: [] }, "up", "down", up, down);
    expect(updated.upUpdated).toBe(true);
    expect(up.bestBid()).toBeUndefined();
    expect(up.bestAsk()).toBeUndefined();
  });
  it("requires both Up and Down books to be fresh", () => {
    expect(bookFeedHealthy(true, true, 9_900, 9_800, 10_000, 500)).toBe(true);
    expect(bookFeedHealthy(true, true, 9_900, 9_000, 10_000, 500)).toBe(false);
    expect(bookFeedHealthy(true, false, 9_900, 9_900, 10_000, 500)).toBe(false);
  });

  it("does not roll a fresh snapshot back with an older buffered delta", () => {
    const up = new OrderBook();
    const down = new OrderBook();
    const applied = { upMs: 0, downMs: 0 };
    applyMessage(
      {
        event_type: "book",
        asset_id: "up",
        timestamp: "2000",
        bids: [{ price: "0.40", size: "10" }],
        asks: [{ price: "0.41", size: "10" }],
      },
      "up",
      "down",
      up,
      down,
      applied,
    );
    applyMessage(
      {
        event_type: "price_change",
        timestamp: "1500",
        price_changes: [{ asset_id: "up", side: "BUY", price: "0.40", size: "999" }],
      },
      "up",
      "down",
      up,
      down,
      applied,
    );

    expect(up.bestBid()).toEqual([0.4, 10]);
  });
});
