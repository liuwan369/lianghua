import { describe, expect, it } from "vitest";
import { OrderBook } from "../orderbook.js";
import { applyMessage, bookFeedHealthy, tickSizeChanges } from "./polymarket.js";

describe("Polymarket market feed metadata", () => {
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

describe("Polymarket websocket health", () => {
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
