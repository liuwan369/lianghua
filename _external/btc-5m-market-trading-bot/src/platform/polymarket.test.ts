import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedSink } from "../live/feeds/index.js";
import type { MarketInfo, OrderRequest } from "./contracts.js";

const mocks = vi.hoisted(() => ({ reader: vi.fn(), warm: vi.fn(), submit: vi.fn(), books: vi.fn(), users: vi.fn(),
  cancel: vi.fn(), trades: vi.fn(), open: vi.fn(), getOrder: vi.fn(), stopHeartbeat: vi.fn() }));
vi.mock("../live/clob/client.js", () => ({ geocheck: async () => {}, ClobWrapper: { connect: async () => ({
  warmMarket: mocks.warm, submitOrder: mocks.submit, cancel: mocks.cancel, getRecentTrades: mocks.trades,
  getOpenOrders: mocks.open, getOrder: mocks.getOrder, getTradesByIds: async () => [], feeRule: () => ({ rate: 0.07, exponent: 1 }),
  startHeartbeat: () => mocks.stopHeartbeat, stopHeartbeat: mocks.stopHeartbeat,
  funder: "wallet", creds: { key: "k", secret: "s", passphrase: "p" },
}) } }));
vi.mock("../live/account-data.js", () => ({ connectAccountReader: async () => mocks.reader }));
vi.mock("../live/account.js", () => ({ ownerSignerPrivateKey: () => "test-key" }));
vi.mock("../live/feeds/polymarket.js", () => ({ runPolymarketFeed: mocks.books }));
vi.mock("../live/feeds/user.js", async original => ({
  ...await original<typeof import("../live/feeds/user.js")>(), runUserFeed: mocks.users,
}));
import { connectPolymarketPlatform } from "./polymarket.js";

function market(id: string, start: number, end: number): MarketInfo {
  return { id, name: id, startsAt: start, endsAt: end, instruments: ["UP", "DOWN"].map(outcome => ({
    tokenId: `${id}-${outcome}`, marketId: id, outcome, tickSize: 0.01, minOrderSize: 5,
  })) };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.reader.mockImplementation(async () => ({ wallet: "wallet", checked_at: new Date().toISOString(),
    collateral: { available: true, complete: true, value: 200 },
    positions: { available: true, complete: true, items: [] },
    open_orders: { available: true, complete: true, items: [] } }));
  mocks.submit.mockResolvedValue({ success: true, orderId: "venue-one" });
  mocks.cancel.mockResolvedValue(true); mocks.open.mockResolvedValue([]); mocks.trades.mockResolvedValue([]);
  mocks.books.mockImplementation((sink: FeedSink) => {
    sink({ kind: "bookStatus", healthy: true, tsUnix: Date.now() / 1000 });
    return { stop: vi.fn(), isHealthy: () => true };
  });
  mocks.users.mockImplementation((sink: FeedSink) => {
    sink({ kind: "userStatus", healthy: true, tsUnix: Date.now() / 1000 });
    return { stop: vi.fn(), registerOrder: vi.fn(), waitUntilReady: async () => {},
      isHealthy: () => true, isContinuous: () => true };
  });
});
describe("continuous market platform adapter", () => {
  it("registers new ACK trade IDs after a signed identity was registered before POST", async () => {
    const now = Date.now() / 1000, current = market("current", now - 5, now + 295);
    const connection = await connectPolymarketPlatform({ mode: "live", markets: [current],
      limits: { capitalUsd: 148, dailyLossUsd: null, maxOrderUsd: 148, maxOpenOrders: 10 }, persist: () => {} });
    await connection.start();
    mocks.submit.mockImplementation(async args => {
      args.onPrepared({ orderHash: "prepared-hash", signedPayload: { signature: "signed" }, preparedAt: now });
      return { success: true, orderId: "prepared-hash", tradeIds: ["ack-trade"] };
    });
    const order = await connection.platform.orders.submit({ clientOrderId: "stage", strategyId: "btc-reversal", tokenId: "current-UP",
      direction: "BUY", price: 0.7, shares: 5, postOnly: false, timeInForce: "GTC" });
    const register = mocks.users.mock.results[0].value.registerOrder;
    expect(register).toHaveBeenNthCalledWith(1, "prepared-hash", []);
    expect(register).toHaveBeenNthCalledWith(2, "prepared-hash", ["ack-trade"]);
    await connection.platform.orders.cancel(order.orderId!);
    connection.platform.core.confirmCancelled(order.orderId!, true);
    await connection.stop();
  });
  it("allows current-market orders after old books expire and closes finished feed controls", async () => {
    const now = Date.now() / 1000, old = market("old", now - 600, now - 300), current = market("current", now - 5, now + 295);
    const connection = await connectPolymarketPlatform({ mode: "live", markets: [old, current],
      limits: { capitalUsd: 148, dailyLossUsd: null, maxOrderUsd: 148, maxOpenOrders: 10 }, persist: () => {} });
    await connection.start();
    expect(mocks.books).toHaveBeenCalledTimes(1);
    expect(mocks.users.mock.results[0].value.stop).toHaveBeenCalledOnce();
    const request: OrderRequest = { clientOrderId: "stage-one", strategyId: "btc-reversal", tokenId: "current-UP",
      direction: "BUY", price: 0.7, shares: 5, postOnly: false, timeInForce: "GTC" };
    const order = await connection.platform.orders.submit(request);
    expect(order.status).toBe("OPEN");
    expect(mocks.submit).toHaveBeenCalledOnce();
    await connection.platform.orders.cancel(order.orderId!);
    connection.platform.core.confirmCancelled(order.orderId!, true);
    await connection.stop();
  });

  it("does not classify an order missing from open listings as cancelled without terminal evidence", async () => {
    const now = Date.now() / 1000, current = market("current", now - 5, now + 295);
    const connection = await connectPolymarketPlatform({ mode: "live", markets: [current],
      limits: { capitalUsd: 148, dailyLossUsd: null, maxOrderUsd: 148, maxOpenOrders: 10 }, persist: () => {} });
    await connection.start();
    const order = await connection.platform.orders.submit({ clientOrderId: "stage", strategyId: "btc-reversal", tokenId: "current-UP",
      direction: "BUY", price: 0.7, shares: 5, postOnly: false, timeInForce: "GTC" });
    mocks.getOrder.mockResolvedValue({ status: "LIVE" });
    await expect(connection.recoverAccount()).rejects.toThrow("missing order needs trade/cancel evidence");
    expect(connection.platform.orders.get(order.orderId!)?.status).toBe("OPEN");
    await connection.platform.orders.cancel(order.orderId!);
    connection.platform.core.confirmCancelled(order.orderId!, true);
    await connection.stop();
  });
});
