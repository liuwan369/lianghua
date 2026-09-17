import { describe, expect, it } from "vitest";
import { OrderBook } from "../orderbook.js";
import { applyMessage, bestBidAskChanges, bookFeedHealthy, marketTrades, tickSizeChanges } from "./polymarket.js";

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
  it("keeps every valid best-bid-ask update from one bilateral frame", () => {
    expect(bestBidAskChanges([
      { event_type: "best_bid_ask", asset_id: "up", best_bid: "0.65", best_ask: "0.67", timestamp: "2000" },
      { event_type: "best_bid_ask", asset_id: "down", best_bid: "0.68", best_ask: "0.70", timestamp: "2000" },
    ], "up", "down", { upMs: 1_900_000, downMs: 1_900_000 })).toEqual([
      { side: "up", bid: 0.65, ask: 0.67, exchangeMs: 2_000_000, order: 0 },
      { side: "down", bid: 0.68, ask: 0.7, exchangeMs: 2_000_000, order: 1 },
    ]);
  });

  it("rejects a buffered fast top older than the applied L2 state", () => {
    expect(bestBidAskChanges({ event_type: "best_bid_ask", asset_id: "up",
      best_bid: "0.65", best_ask: "0.67", timestamp: "1999" },
    "up", "down", { upMs: 2_000_000, downMs: 0 })).toEqual([]);
  });

  it("keeps the newest same-side fast top when a frame contains multiple updates", () => {
    expect(bestBidAskChanges([
      { event_type: "best_bid_ask", asset_id: "up", best_bid: "0.65", best_ask: "0.67", timestamp: "2001" },
      { event_type: "best_bid_ask", asset_id: "up", best_bid: "0.60", best_ask: "0.62", timestamp: "2000" },
    ], "up", "down", { upMs: 1_999_000, downMs: 0 })).toEqual([
      { side: "up", bid: 0.65, ask: 0.67, exchangeMs: 2_001_000, order: 0 },
    ]);
  });

  it("rejects fast top updates without a venue timestamp", () => {
    expect(bestBidAskChanges({ event_type: "best_bid_ask", asset_id: "up",
      best_bid: "0.65", best_ask: "0.67" }, "up", "down")).toEqual([]);
  });

  it("clears old liquidity when an empty book snapshot arrives", () => {
    const up = new OrderBook();
    const down = new OrderBook();
    up.applySnapshot([[0.4, 10]], [[0.41, 10]]);
    const updated = applyMessage({ event_type: "book", asset_id: "up", bids: [], asks: [] }, "up", "down", up, down);
    expect(updated.upUpdated).toBe(true);
    expect(up.bestBid()).toBeUndefined();
    expect(up.bestAsk()).toBeUndefined();
  });

  it("exposes sorted bid and ask depth for top-five monitoring", () => {
    const up = new OrderBook();
    up.applySnapshot([[0.40, 10], [0.39, 8], [0.38, 6]], [[0.41, 9], [0.42, 7], [0.43, 5]]);
    expect(up.levels(2)).toEqual({
      bids: [[0.4, 10], [0.39, 8]],
      asks: [[0.41, 9], [0.42, 7]],
    });
  });

  it("preserves venue prices below the legacy 0.001 precision", () => {
    const book = new OrderBook();
    book.applySnapshot([[0.4001, 10], [0.4, 8]], [[0.4025, 9], [0.403, 7]]);
    expect(book.bestBid()).toEqual([0.4001, 10]);
    expect(book.bestAsk()).toEqual([0.4025, 9]);
    expect(book.bidLevels()).toEqual([[0.4001, 10], [0.4, 8]]);
    expect(book.askLevels()).toEqual([[0.4025, 9], [0.403, 7]]);
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
