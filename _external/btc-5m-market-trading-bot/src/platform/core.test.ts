import { describe, expect, it } from "vitest";
import type { AccountSnapshot, Instrument, OrderGateway, OrderRequest } from "./contracts.js";
import { TradingCore } from "./core.js";

const instrument: Instrument = { tokenId: "up", marketId: "m", outcome: "UP", tickSize: 0.01, minOrderSize: 1 };
const account: AccountSnapshot = { accountId: "paper", at: 100, cashUsd: 20, positions: [], openOrders: [], complete: true };
const request = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({
  clientOrderId: "buy-1", strategyId: "s", tokenId: "up", direction: "BUY", price: 0.5,
  shares: 4, timeInForce: "GTC", postOnly: true, ...overrides,
});

function setup() {
  let sequence = 0;
  const gateway: OrderGateway = {
    mode: "paper",
    async submit() { return { status: "accepted", orderId: `order-${++sequence}` }; },
    async cancel() { return true; },
  };
  const core = new TradingCore({ account, instruments: [instrument], limits: {
    capitalUsd: 20, dailyLossUsd: 30, maxOrderUsd: 10, maxOpenOrders: 10,
  }, adapters: { gateway, estimateFee: () => 0.01 } });
  return core;
}

describe("strategy-independent account core", () => {
  it("accounts BUY and SELL fills by order identity and reserves shares separately", async () => {
    const core = setup();
    const buy = await core.submit(request());
    expect(buy.status).toBe("OPEN");
    expect(core.risk().availableUsd).toBeCloseTo(17.99, 8);

    expect(core.applyFill({ tradeId: "t1", orderId: buy.orderId!, tokenId: "up", direction: "BUY",
      price: 0.5, shares: 2, feeUsd: 0.01, ts: 101, isMaker: true })).toBe(true);
    expect(core.applyFill({ tradeId: "t1", orderId: buy.orderId!, tokenId: "up", direction: "BUY",
      price: 0.5, shares: 2, feeUsd: 0.01, ts: 101, isMaker: true })).toBe(false);
    const sell = await core.submit(request({ clientOrderId: "sell-1", direction: "SELL", price: 0.6, shares: 1, postOnly: true }));
    expect(sell.status).toBe("OPEN");
    expect(sell.reservedShares).toBe(1);
    expect(core.positions()[0]).toMatchObject({ shares: 2, costUsd: 1.01 });

    expect(core.applyFill({ tradeId: "t2", orderId: sell.orderId!, tokenId: "up", direction: "SELL",
      price: 0.6, shares: 1, feeUsd: 0.01, ts: 102, isMaker: true })).toBe(true);
    expect(core.positions()[0]?.realizedPnlUsd).toBeCloseTo(0.085, 8);
    expect(core.snapshot().cashUsd).toBeCloseTo(19.58, 8);
  });

  it("rejects a fill outside the submitted limit and keeps the account unchanged", async () => {
    const core = setup();
    const order = await core.submit(request({ shares: 2 }));
    expect(() => core.applyFill({ tradeId: "too-high", orderId: order.orderId!, tokenId: "up", direction: "BUY",
      price: 0.51, shares: 1, feeUsd: 0, ts: 101, isMaker: false })).toThrow("invalid or unowned fill");
    expect(core.positions()).toEqual([]);
    expect(core.order(order.orderId!)?.filledShares).toBe(0);
  });

  it("exposes sorted depth and rejects malformed depth before strategies see it", () => {
    const core = setup();
    expect(core.mark({ tokenId: "up", ts: 1, bid: 0.4, ask: 0.41,
      bids: [[0.4, 5], [0.39, 3]], asks: [[0.41, 4], [0.42, 2]], sourceAgeMs: 18, processingLatencyMs: 0.2 })).toBe(true);
    expect(core.mark({ tokenId: "up", ts: 2, bid: 0.4, ask: 0.41, bids: [[0.4, -1]] })).toBe(false);
  });
});
