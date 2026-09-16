import { describe, expect, it } from "vitest";
import type { AccountSnapshot, Instrument, OrderGateway } from "./contracts.js";
import { TradingPlatform } from "./platform.js";

const instrument: Instrument = { tokenId: "up", marketId: "m", outcome: "UP", tickSize: 0.01, minOrderSize: 1 };
const account: AccountSnapshot = { accountId: "paper", at: 100, cashUsd: 20, positions: [], openOrders: [], complete: true };
const gateway: OrderGateway = { mode: "paper", async submit() { return { status: "accepted", orderId: "venue-1" }; }, async cancel() { return true; } };

describe("strategy boundary", () => {
  it("reserves external as an imported-order namespace", () => {
    const platform = new TradingPlatform({ account, instruments: [instrument], limits: {
      capitalUsd: 20, dailyLossUsd: 30, maxOrderUsd: 10, maxOpenOrders: 10,
    }, adapters: { gateway } });
    expect(() => platform.attach({ id: "external", onEvent: () => [] })).toThrow("strategy ID unavailable");
  });
});
