import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedSink } from "../live/feeds/index.js";
import type { MarketInfo, OrderRequest } from "./contracts.js";

const mocks = vi.hoisted(() => ({ reader: vi.fn(), warm: vi.fn(), submit: vi.fn(), books: vi.fn(), users: vi.fn(),
  cancel: vi.fn(), trades: vi.fn(), open: vi.fn(), getOrder: vi.fn(), replay: vi.fn(), cashFlows: vi.fn(), stopHeartbeat: vi.fn() }));
vi.mock("./cash-flows.js", () => ({ readCashFlowEvidence: mocks.cashFlows }));
vi.mock("../live/clob/client.js", () => ({ geocheck: async () => {}, ClobWrapper: { connect: async () => ({
  warmMarket: mocks.warm, submitOrder: mocks.submit, cancel: mocks.cancel, getRecentTrades: mocks.trades,
  getOpenOrders: mocks.open, getOrder: mocks.getOrder, resubmitPrepared: mocks.replay,
  getTradesByIds: async () => [], feeRule: () => ({ rate: 0.07, exponent: 1 }),
  startHeartbeat: () => mocks.stopHeartbeat, stopHeartbeat: mocks.stopHeartbeat,
  funder: "wallet", creds: { key: "k", secret: "s", passphrase: "p" },
}) } }));
vi.mock("../live/account-data.js", () => ({ connectAccountReader: async () => mocks.reader }));
vi.mock("../live/account.js", () => ({ ownerSignerPrivateKey: () => "test-key" }));
vi.mock("../live/feeds/polymarket.js", () => ({ runPolymarketFeed: mocks.books }));
vi.mock("../live/feeds/user.js", async original => ({
  ...await original<typeof import("../live/feeds/user.js")>(), runUserFeed: mocks.users,
}));
import { accountSnapshot, connectPolymarketPlatform } from "./polymarket.js";

function market(id: string, start: number, end: number): MarketInfo {
  return { id, name: id, startsAt: start, endsAt: end, instruments: ["UP", "DOWN"].map(outcome => ({
    tokenId: `${id}-${outcome}`, marketId: id, outcome, tickSize: 0.01, minOrderSize: 5,
  })) };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.cashFlows.mockImplementation(async ({ fromAt }) => ({ cashFlowCoverage: { fromBlock: 100, toBlock: 100,
    fromAt, toAt: fromAt, complete: true }, externalFlows: [] }));
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
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("continuous market platform adapter", () => {
  it("uses the configured account RPC before the public fallback", async () => {
    vi.stubEnv("POLYGON_RPC", ""); vi.stubEnv("PM_ACCOUNT_RPC_URL", "https://primary.example/rpc");
    vi.stubEnv("PM_ACCOUNT_RPC_FALLBACK_URL", "https://fallback.example/rpc");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: "0x123" }) });
    vi.stubGlobal("fetch", fetch);
    mocks.cashFlows.mockImplementation(async ({ rpc, fromAt }) => {
      await rpc("eth_blockNumber", []);
      return { cashFlowCoverage: { fromBlock: 100, toBlock: 100, fromAt, toAt: fromAt, complete: true }, externalFlows: [] };
    });
    const now = Date.now() / 1000, current = market("current", now - 5, now + 295);
    const connection = await connectPolymarketPlatform({ mode: "live", markets: [current],
      limits: { capitalUsd: 148, dailyLossUsd: null, maxOrderUsd: 148, maxOpenOrders: 10 }, persist: () => {} });
    await connection.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch.mock.calls[0][0]).toBe("https://primary.example/rpc");
    await connection.stop();
  });

  it("preserves the collateral observation time separately from aggregate completion", () => {
    const result = accountSnapshot({ wallet: "wallet", checked_at: "2026-09-17T12:00:03.000Z",
      collateral: { available: true, complete: true, value: 200, checked_at: "2026-09-17T12:00:01.000Z" },
      positions: { available: true, complete: true, items: [] }, open_orders: { available: true, complete: true, items: [] } });
    expect(result.cashAt).toBe(Date.parse("2026-09-17T12:00:01.000Z") / 1000);
    expect(result.at).toBe(Date.parse("2026-09-17T12:00:03.000Z") / 1000);
  });

  it("does not wait for a background funding scan before cancelling on stop", async () => {
    const now = Date.now() / 1000, current = market("current", now - 5, now + 295);
    let finishScan!: () => void;
    mocks.cashFlows.mockImplementation(() => new Promise(resolve => { finishScan = () => resolve({ cashFlowCoverage: {
      fromBlock: 100, toBlock: 100, fromAt: now, toAt: now, complete: true }, externalFlows: [] }); }));
    const connection = await connectPolymarketPlatform({ mode: "live", markets: [current],
      limits: { capitalUsd: 148, dailyLossUsd: null, maxOrderUsd: 148, maxOpenOrders: 10 }, persist: () => {} });
    await connection.start();
    const order = await connection.platform.orders.submit({ clientOrderId: "stop-stage", strategyId: "btc-reversal",
      tokenId: "current-UP", direction: "BUY", price: 0.7, shares: 5, postOnly: false, timeInForce: "GTC" });
    const stopped = connection.stop();
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(order.orderId));
    connection.platform.core.confirmCancelled(order.orderId!, true);
    await stopped;
    finishScan();
  });

  it("replays the original signature when the SDK returns a nonthrowing 404", async () => {
    const now = Date.now() / 1000, current = market("current", now - 5, now + 295);
    const connection = await connectPolymarketPlatform({ mode: "live", markets: [current],
      limits: { capitalUsd: 148, dailyLossUsd: null, maxOrderUsd: 148, maxOpenOrders: 10 }, persist: () => {} });
    await connection.start();
    const prepared = { orderHash: "persisted-hash", signedPayload: { signature: "same-signature", salt: "same-salt" }, preparedAt: now };
    mocks.submit.mockImplementation(async args => { args.onPrepared(prepared); return { success: false, stateUnknown: true }; });
    const order = await connection.platform.orders.submit({ clientOrderId: "stage", strategyId: "btc-reversal", tokenId: "current-UP",
      direction: "BUY", price: 0.7, shares: 5, postOnly: false, timeInForce: "GTC" });
    expect(order.status).toBe("UNKNOWN");
    mocks.getOrder.mockResolvedValue({ error: "Not Found", status: 404 });
    mocks.replay.mockImplementation(async () => {
      mocks.reader.mockImplementation(async () => ({ wallet: "wallet", checked_at: new Date().toISOString(),
        collateral: { available: true, complete: true, value: 200 }, positions: { available: true, complete: true, items: [] },
        open_orders: { available: true, complete: true, items: [{ id: "persisted-hash", asset_id: "current-UP",
          side: "BUY", original_size: "5", size_matched: "0", price: "0.7" }] } }));
      return { success: true, orderId: "persisted-hash" };
    });
    await connection.recoverAccount();
    expect(mocks.replay).toHaveBeenCalledExactlyOnceWith(prepared, expect.objectContaining({ orderId: "persisted-hash" }));
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(connection.platform.orders.get(order.orderId!)?.status).toBe("OPEN");
    await connection.platform.orders.cancel(order.orderId!);
    connection.platform.core.confirmCancelled(order.orderId!, true);
    await connection.stop();
  });
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
