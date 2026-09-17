import { describe, expect, it } from "vitest";
import type { AccountSnapshot, Instrument, OrderGateway } from "./contracts.js";
import { TradingPlatform } from "./platform.js";

const instrument: Instrument = { tokenId: "up", marketId: "m", outcome: "UP", tickSize: 0.01, minOrderSize: 1 };
const downInstrument: Instrument = { tokenId: "down", marketId: "m", outcome: "DOWN", tickSize: 0.01, minOrderSize: 1 };
const account: AccountSnapshot = { accountId: "paper", at: 100, cashUsd: 20, positions: [], openOrders: [], complete: true };
const gateway: OrderGateway = { mode: "paper", async submit() { return { status: "accepted", orderId: "venue-1" }; }, async cancel() { return true; } };

describe("strategy boundary", () => {
  it("reserves external as an imported-order namespace", () => {
    const platform = new TradingPlatform({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: 30, maxOrderUsd: 10, maxOpenOrders: 10,
    }, adapters: { gateway } });
    expect(() => platform.attach({ id: "external", onEvent: () => [] })).toThrow("strategy ID unavailable");
  });

  it("applies a bilateral venue frame before invoking a strategy exactly once", () => {
    const platform = new TradingPlatform({ account, instruments: [instrument, downInstrument], limits: {
      capitalUsd: 20, dailyLossUsd: null, maxOrderUsd: 10, maxOpenOrders: 10,
    }, adapters: { gateway } });
    const observations: Array<Array<{ tokenId: string; ask?: number }>> = [];
    platform.attach({ id: "paired", onEvent(event, context) {
      if (event.kind === "book") observations.push(context.books.map(book => ({ tokenId: book.tokenId, ask: book.ask })));
      return [];
    } });
    platform.ingestBooks([
      { tokenId: "up", ts: 100, bid: 0.65, ask: 0.67 },
      { tokenId: "down", ts: 100, bid: 0.68, ask: 0.70 },
    ]);
    expect(observations).toEqual([[
      { tokenId: "up", ask: 0.67 },
      { tokenId: "down", ask: 0.7 },
    ]]);
  });
});
