import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Side } from "../models.js";
import { AccountExecutionGate } from "./account-control.js";
import { findMarket } from "./discovery.js";
import { Executor } from "./executor.js";
import { runBtcFeed } from "./feeds/btc.js";
import type { FeedSink } from "./feeds/index.js";
import { runPolymarketFeed } from "./feeds/polymarket.js";
import { runUserFeed, type UserFeedControl } from "./feeds/user.js";
import { Journal } from "./journal.js";
import { run, type RunConfig } from "./orchestrator.js";

vi.mock("./account.js", () => ({ ownerSignerPrivateKey: () => "offline-test-only" }));
vi.mock("./discovery.js", async (original) => ({
  ...await original<typeof import("./discovery.js")>(), findMarket: vi.fn(),
}));
vi.mock("./feeds/btc.js", () => ({ runBtcFeed: vi.fn() }));
vi.mock("./feeds/polymarket.js", () => ({ runPolymarketFeed: vi.fn() }));
vi.mock("./feeds/user.js", () => ({ runUserFeed: vi.fn() }));

const account = "0x3333333333333333333333333333333333333333";
const now = Date.parse("2026-09-13T02:00:10Z");
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "pm-run-reactivity-"));
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("POLYMARKET_WALLET_ADDRESS", account);
  vi.stubEnv("PM_ATOMIC_ACCOUNT_URL", "");
  vi.stubEnv("PM_MVP_LIVE_MODE", "1");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it("run submits a fill-driven hedge before the next book or heartbeat when REST is unavailable", async () => {
  const sigintListeners = process.listenerCount('SIGINT');
  const sigtermListeners = process.listenerCount('SIGTERM');
  vi.spyOn(Journal, 'open').mockReturnValue({ log: vi.fn(), logEvent: vi.fn() } as unknown as Journal);
  let pushBook: FeedSink | undefined;
  let pushUser: FeedSink | undefined;
  const stopBtc = vi.fn();
  const stopBook = vi.fn();
  const user: UserFeedControl = {
    stop: vi.fn(), waitUntilReady: vi.fn(async () => undefined),
    isHealthy: () => true, isContinuous: () => true, registerOrder: vi.fn(),
    reconcileRecentTrades: vi.fn(async () => { throw new Error("REST unavailable"); }),
  };
  vi.mocked(runBtcFeed).mockReturnValue({ stop: stopBtc });
  vi.mocked(runPolymarketFeed).mockImplementation((push) => {
    pushBook = push;
    return { stop: stopBook, isHealthy: () => true };
  });
  vi.mocked(runUserFeed).mockImplementation((push) => { pushUser = push; return user; });
  vi.mocked(findMarket).mockResolvedValue({
    slug: "offline-market", conditionId: "condition", upToken: "up", downToken: "down",
    start: now / 1000 - 10, end: now / 1000 + 290,
  });

  // Startup account bootstrap is not under test. Engine and Executor remain real.
  vi.spyOn(AccountExecutionGate.prototype, "initializeSimple").mockResolvedValue(undefined);
  const refresh = vi.spyOn(AccountExecutionGate.prototype, "refresh").mockResolvedValue(undefined);
  vi.spyOn(AccountExecutionGate.prototype, "verifyBeforeSubmissionFast").mockImplementation(() => {});
  vi.spyOn(AccountExecutionGate.prototype, "prepare").mockImplementation(() => {});
  vi.spyOn(AccountExecutionGate.prototype, "transition").mockImplementation(() => {});
  const executor = new Executor(true, 20, 20, 50);
  const submitOrder = vi.fn(async (_order: { tokenId: string; price: number; size: number }) => ({
    success: true, orderId: `order-${submitOrder.mock.calls.length}`,
  }));
  (executor as unknown as { clob: unknown }).clob = {
    funder: account, creds: { key: "test", secret: "test", passphrase: "test" },
    tickSize: async () => 0.01, minOrderSize: () => 5, warmMarket: async () => 0,
    submitOrder, cancelAll: vi.fn(async () => undefined), stopHeartbeat: vi.fn(),
  };
  vi.spyOn(Executor, "newLive").mockResolvedValue(executor);
  const openOrders = vi.spyOn(executor, "getOpenOrders").mockRejectedValue(new Error("REST unavailable"));
  const recentTrades = vi.spyOn(executor, "getRecentTrades").mockRejectedValue(new Error("REST unavailable"));
  const tradesById = vi.spyOn(executor, "getTradesByIds").mockRejectedValue(new Error("REST unavailable"));
  const accountReader = vi.fn(async () => { throw new Error("REST unavailable"); });
  const cfg: RunConfig = {
    live: true, preflight: false, orderUsd: 20, maxOrders: 20, maxTotalUsd: 50,
    engine: { decisionIntervalMs: 1000, minMakerFillProbability: 0, fullMakerSizeProbability: 0 },
    heartbeatMs: 1000, btcMoveBps: 0, bookPollHz: 0, oracle: false, durationMin: 0.01,
    logPath: join(root, "run.jsonl"), tradedPath: join(root, "traded.jsonl"),
    riskStateDirectory: root, accountStateDirectory: root, accountReader,
  };
  const running = run(cfg).then(() => undefined, (error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(pushBook).toBeTypeOf("function");
    expect(pushUser).toBeTypeOf("function");
    pushBook!({ kind: "book", snapshot: {
      source: "polymarket-ws", tsUnix: now / 1000,
      upExchangeTsUnix: now / 1000, downExchangeTsUnix: now / 1000,
      upBid: 0.45, upAsk: 0.46, downBid: 0.52, downAsk: 0.53,
    } });
    await vi.advanceTimersByTimeAsync(1);
    expect(submitOrder).toHaveBeenCalledTimes(1);
    const first = submitOrder.mock.calls[0][0];
    expect(user.registerOrder).toHaveBeenCalledWith("order-1", undefined);

    pushUser!({ kind: "user", event: {
      kind: "exchangeFill", orderId: "order-1", tradeId: "fill-1",
      fill: { side: first.tokenId === "up" ? Side.Up : Side.Down,
        shares: first.size, price: first.price, tsUnix: Date.now() / 1000, isMaker: true },
    } });
    await vi.advanceTimersByTimeAsync(0);

    // No second book, BTC tick, heartbeat or elapsed decision interval is supplied.
    expect(Date.now()).toBe(now + 1);
    expect(submitOrder).toHaveBeenCalledTimes(2);
    expect(submitOrder.mock.calls[1][0].tokenId).toBe(first.tokenId === "up" ? "down" : "up");
    expect(user.registerOrder).toHaveBeenCalledWith("order-2", undefined);
    expect(openOrders).not.toHaveBeenCalled();
    expect(recentTrades).not.toHaveBeenCalled();
    expect(tradesById).not.toHaveBeenCalled();
    expect(accountReader).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(user.reconcileRecentTrades).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    pushUser?.({ kind: "userStatus", healthy: false, tsUnix: Date.now() / 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  }
  expect(await running).toMatchObject({ message: "authenticated order/fill feed disconnected" });
  expect(stopBtc).toHaveBeenCalledOnce();
  expect(stopBook).toHaveBeenCalledOnce();
  expect(user.stop).toHaveBeenCalledOnce();
  expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  expect(vi.getTimerCount()).toBe(0);
});
