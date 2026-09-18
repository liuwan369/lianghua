import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StrategyContext } from "../platform/contracts.js";
import { createBtcReversalStrategy, type BtcReversalStrategy } from "../strategies/btc-reversal.js";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), discover: vi.fn(), load: vi.fn(), save: vi.fn(), close: vi.fn(),
  setStrategyState: vi.fn(), updateLimits: vi.fn(), addMarkets: vi.fn(), open: vi.fn(), start: vi.fn(), stop: vi.fn(), attach: vi.fn(), ingest: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), settle: vi.fn() }));
vi.mock("../platform/polymarket.js", () => ({ connectPolymarketPlatform: mocks.connect, discoverBtcMarket: mocks.discover }));
vi.mock("../platform/live-settlement.js", () => ({ createLiveSettlementAdapter: async () => mocks.settle }));
vi.mock("../platform/store.js", () => ({ PlatformStore: class {
  constructor(path: string) { mocks.open(path); }
  load = mocks.load;
  save = mocks.save;
  close = mocks.close;
} }));

import { loadStrategyModule, parsePlatformOptions, runPlatformCli, validateMarkets } from "./platform.js";

const market = { id: "condition", name: "Binary market", startsAt: Date.now() / 1000 - 60, endsAt: Date.now() / 1000 + 300,
  instruments: [{ tokenId: "yes", marketId: "condition", outcome: "YES", tickSize: 0.01, minOrderSize: 5 },
    { tokenId: "no", marketId: "condition", outcome: "NO", tickSize: 0.01, minOrderSize: 5 }] };
let temporary: string;
let output: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function freshTrigger(strategy: BtcReversalStrategy) {
  const now = Math.floor(Date.now() / 1000);
  const current = { ...market, name: `btc-updown-5m-${now}`, startsAt: now, endsAt: now + 300,
    instruments: market.instruments.map((instrument, index) => ({ ...instrument, outcome: index ? "DOWN" : "UP" })) };
  const context: StrategyContext = { mode: "live", now, markets: [current], books: [
    { tokenId: "yes", ask: 0.68, ts: now, receivedAt: now, exchangeTs: now },
    { tokenId: "no", ask: 0.33, ts: now, receivedAt: now, exchangeTs: now },
  ], account: { schemaVersion: 1, accountId: "test", mode: "live", cashUsd: 1000, positions: [], orders: [],
    risk: { halted: false, day: "2026-09-18", baselineAt: now, baselineEquityUsd: 1000,
      equityUsd: 1000, dailyPnlUsd: 0, occupiedUsd: 0, availableUsd: 1000 } } };
  return strategy.onEvent({ kind: "book", book: context.books[0] }, context);
}
beforeEach(() => {
  vi.resetAllMocks();
  temporary = mkdtempSync(join(tmpdir(), "platform-cli-"));
  mocks.discover.mockResolvedValue([market]);
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  mocks.connect.mockResolvedValue({ start: mocks.start, stop: mocks.stop, addMarkets: mocks.addMarkets,
    platform: { core: { setStrategyState: mocks.setStrategyState, updateLimits: mocks.updateLimits }, attach: mocks.attach, ingest: mocks.ingest, subscribe: mocks.subscribe,
      account: { current: () => ({ cashUsd: 1000, positions: [], orders: [], fills: [], risk: { halted: false } }) },
      market: { list: () => [market], books: () => [] }, orders: { get: () => undefined },
      telemetry: { snapshot: () => ({ events: 0 }) },
      capabilities: () => ({ buy: true, sell: true }) } });
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(temporary, { recursive: true, force: true }); });

describe("generic platform CLI inputs", () => {
  it("requires explicit live mode and ignores LIVE environment defaults", () => {
    vi.stubEnv("LIVE", "true");
    expect(() => parsePlatformOptions([])).toThrow(/--live is required/);
    expect(parsePlatformOptions(["--live"])).toMatchObject({ mode: "live", strategyModule: undefined,
      limits: { capitalUsd: Number.MAX_SAFE_INTEGER, dailyLossUsd: null } });
  });

  it.each([["--duration-sec", "-1"], ["--duration-sec", "NaN"], ["--duration-sec", "Infinity"],
    ["--timer-ms", "0"], ["--status-sec", "-1"], ["--capital-usd", "NaN"], ["--max-open-orders", "1.5"],
    ["--paper"], ["--live", "--capital-usd", "0"], ["--live", "--daily-loss-usd", "0"],
    ["--capital-usd", "10", "--order-usd", "11"]])("rejects invalid options before connections: %j", (...args) => {
    expect(() => parsePlatformOptions(args)).toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("accepts user configured live budgets without historical constants", () => {
    expect(parsePlatformOptions(["--live", "--capital-usd", "148", "--daily-loss-usd", "60"])).toMatchObject({
      mode: "live", limits: { capitalUsd: 148, dailyLossUsd: 60 } });
    expect(parsePlatformOptions(["--live", "--capital-usd", "25000", "--daily-loss-usd", "25000"])).toMatchObject({
      mode: "live", limits: { capitalUsd: 25000, dailyLossUsd: 25000, maxOrderUsd: 25000 } });
  });

  it.each(["state.json", "state.json.lock", "state.json.next"])("rejects journal overlap with %s", filename => {
    expect(() => parsePlatformOptions(["--live", "--state-file", join(temporary, "state.json"),
      "--journal-file", join(temporary, filename)])).toThrow(/separate/);
  });

  it.each(["state.json", "state.json.lock", "state.json.next", "journal.jsonl"])("rejects stop file overlap with %s", filename => {
    expect(() => parsePlatformOptions(["--live", "--state-file", join(temporary, "state.json"),
      "--journal-file", join(temporary, "journal.jsonl"), "--stop-file", join(temporary, filename)])).toThrow(/separate/);
  });

  it("checks market identity, binary feed shape and venue rules", () => {
    expect(validateMarkets([market])).toEqual([market]);
    expect(() => validateMarkets([])).toThrow();
    expect(() => validateMarkets([market, market])).toThrow(/unique/);
    expect(() => validateMarkets([{ ...market, endsAt: 99 }])).toThrow(/timestamps/);
    expect(() => validateMarkets([{ ...market, instruments: [market.instruments[0]] }])).toThrow(/two instruments/);
    expect(() => validateMarkets([{ ...market, instruments: [market.instruments[0], market.instruments[0]] }])).toThrow(/unique token/);
    expect(() => validateMarkets([{ ...market, instruments: [{ ...market.instruments[0], tickSize: 0 }, market.instruments[1]] }])).toThrow(/venue rules/);
  });

  it("loads a default plugin and a factory module, and rejects malformed plugins", async () => {
    const defaultModule = join(temporary, "default.mjs"), factoryModule = join(temporary, "factory.mjs"), invalidModule = join(temporary, "invalid.mjs");
    writeFileSync(defaultModule, 'export default { id: "observe-default", onEvent: () => [] };');
    writeFileSync(factoryModule, 'export function createStrategy() { return { id: "observe-factory", onEvent: () => [] }; }');
    writeFileSync(invalidModule, 'export default { id: "missing-handler" };');
    expect((await loadStrategyModule(defaultModule)).id).toBe("observe-default");
    expect((await loadStrategyModule(factoryModule)).id).toBe("observe-factory");
    await expect(loadStrategyModule(invalidModule)).rejects.toThrow(/onEvent/);
    await expect(loadStrategyModule(join(temporary, "missing.mjs"))).rejects.toThrow(/could not be loaded/);
  });

  it("rejects malformed local inputs before creating a store or using network discovery", async () => {
    const path = join(temporary, "bad.json");
    writeFileSync(path, "{}");
    await expect(runPlatformCli(["--live", "--markets", path])).rejects.toThrow(/nonempty/);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe("generic platform CLI lifecycle", () => {
  it("loads the built-in strategy, persists state and reads pause control without sending orders", async () => {
    vi.useFakeTimers();
    const configPath = join(temporary, "reversal.json"), controlPath = join(temporary, "control.json");
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", savedRevision: 1,
      config: { instanceId: "test", revision: "1", totalBudgetUsd: null, roundBudgetUsd: null, dailyLossUsd: null } }));
    const running = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath,
      "--duration-sec", "2", "--control-file", controlPath]);
    await flush();
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ id: "btc-reversal" }));
    expect(mocks.setStrategyState).toHaveBeenCalledWith("btc-reversal", expect.objectContaining({ instanceId: "test" }));
    writeFileSync(controlPath, JSON.stringify({ paused: true }));
    await vi.advanceTimersByTimeAsync(1001);
    expect(mocks.setStrategyState).toHaveBeenLastCalledWith("btc-reversal", expect.objectContaining({ paused: true }));
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", savedRevision: 2,
      config: { instanceId: "test", revision: "2", triggerPrice: 0.68 } }));
    await vi.advanceTimersByTimeAsync(1001);
    await running;
    expect(mocks.attach.mock.calls[0][0].exportState().config.revision).toBe("2");
    expect(mocks.stop).toHaveBeenCalledWith("duration_elapsed");
  });

  it.each(["duration", "controller_stop"])("can restart the same strategy state after %s without inheriting a pause", async (end) => {
    vi.useFakeTimers();
    const configPath = join(temporary, "reversal.json"), stopPath = join(temporary, "stop");
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", config: {} }));
    const running = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath,
      "--duration-sec", end === "duration" ? "1" : "0", "--stop-file", stopPath]);
    await flush();
    if (end === "controller_stop") writeFileSync(stopPath, "stop");
    await vi.advanceTimersByTimeAsync(1001);
    await running;

    const saved = mocks.setStrategyState.mock.calls
      .map(([id, state]) => id === "btc-reversal" ? state : undefined)
      .filter(Boolean)
      .at(-1);
    expect(saved).toEqual(expect.objectContaining({ paused: false }));
    rmSync(stopPath, { force: true });
    mocks.load.mockReturnValue({ strategyStates: { "btc-reversal": saved } });
    const next = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath,
      "--duration-sec", "1"]);
    await flush();
    const attached = mocks.attach.mock.lastCall![0] as BtcReversalStrategy;
    expect(freshTrigger(attached)).toContainEqual(expect.objectContaining({ kind: "submit" }));
    await vi.advanceTimersByTimeAsync(1001);
    await next;
  });

  it.each([false, true])("honors the new run's explicit pause control (paused=%s)", async (paused) => {
    vi.useFakeTimers();
    const configPath = join(temporary, "reversal.json"), controlPath = join(temporary, "new-run.control.json");
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", config: {} }));
    const previous = createBtcReversalStrategy();
    previous.setPaused(true);
    mocks.load.mockReturnValue({ strategyStates: { "btc-reversal": previous.exportState() } });
    // Missing per-run control means a new dashboard Start, while a pause
    // written for this run must survive startup/recovery.
    if (paused) writeFileSync(controlPath, JSON.stringify({ paused: true }));
    const running = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath,
      "--duration-sec", "1", "--control-file", controlPath]);
    await flush();
    const attached = mocks.attach.mock.lastCall![0] as BtcReversalStrategy;
    expect(attached.exportState().paused).toBe(paused);
    expect(freshTrigger(attached).some(action => action.kind === "submit")).toBe(!paused);
    await vi.advanceTimersByTimeAsync(1001);
    await running;
    expect(attached.exportState().paused).toBe(paused);
  });

  it("blocks new triggers immediately after stop without persisting a pause", async () => {
    vi.useFakeTimers();
    const configPath = join(temporary, "reversal.json");
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", config: {} }));
    let finishStop!: () => void;
    mocks.stop.mockReturnValue(new Promise<void>(resolve => { finishStop = resolve; }));
    const running = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath,
      "--duration-sec", "0"]);
    await flush();
    const attached = mocks.attach.mock.lastCall![0] as BtcReversalStrategy;
    process.emit("SIGTERM");
    await flush();
    expect(mocks.stop).toHaveBeenCalledWith("SIGTERM");
    expect(freshTrigger(attached)).toEqual([]);
    expect(attached.exportState()).toMatchObject({ paused: false, rounds: [] });
    finishStop();
    await running;
  });

  it("continues beyond a round boundary and discovers future markets for the built-in strategy", async () => {
    vi.useFakeTimers();
    const configPath = join(temporary, "reversal.json");
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", config: {} }));
    const now = Date.now() / 1000;
    mocks.discover.mockResolvedValueOnce([{ ...market, startsAt: now - 60, endsAt: now + 1 }])
      .mockResolvedValue([{ ...market, id: "next", startsAt: now + 1, endsAt: now + 301,
        instruments: market.instruments.map(instrument => ({ ...instrument, marketId: "next", tokenId: `next-${instrument.tokenId}` })) }]);
    const running = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath, "--duration-sec", "0"]);
    await flush();
    expect(mocks.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.addMarkets).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "next" })]),
      expect.anything(),
    );
    process.emit("SIGTERM"); await running;
  });

  it("emits one exact market-end timer independently of the maintenance interval", async () => {
    vi.useFakeTimers();
    const configPath = join(temporary, "reversal.json");
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", config: {} }));
    const now = Date.now() / 1000;
    mocks.discover.mockResolvedValue([{ ...market, startsAt: now - 299, endsAt: now + 1 }]);
    const running = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath,
      "--duration-sec", "0", "--timer-ms", "60000"]);
    await flush();
    expect(mocks.ingest.mock.calls.filter(([event]) => event.kind === "timer")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.ingest.mock.calls.filter(([event]) => event.kind === "timer")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.ingest.mock.calls.filter(([event]) => event.kind === "timer")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.ingest.mock.calls.filter(([event]) => event.kind === "timer")).toHaveLength(1);

    process.emit("SIGTERM"); await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prewarms a newly published market before the exact five-minute boundary", async () => {
    vi.useFakeTimers(); vi.setSystemTime(589_000);
    const configPath = join(temporary, "reversal.json");
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", config: {} }));
    const makeMarket = (start: number) => ({ ...market, id: `condition-${start}`, name: `btc-updown-5m-${start}`,
      startsAt: start, endsAt: start + 300, instruments: market.instruments.map(instrument => ({ ...instrument,
        marketId: `condition-${start}`, tokenId: `${instrument.tokenId}-${start}` })) });
    const current = makeMarket(300), next = makeMarket(600);
    mocks.discover.mockImplementation(async (at?: number) => {
      if (at == null || at < 600) return [current];
      return Date.now() >= 599_250 ? [next] : [];
    });
    const running = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath,
      "--duration-sec", "0", "--timer-ms", "60000"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.addMarkets.mock.calls.flat(2)).not.toContainEqual(expect.objectContaining({ id: next.id }));

    await vi.advanceTimersByTimeAsync(10_250);

    expect(mocks.addMarkets).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: next.id })]),
      expect.anything(),
    );
    expect(Date.now()).toBeLessThan(600_000);
    process.emit("SIGTERM"); await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs without a strategy, emits timer events, then cancels/stops and closes durable state", async () => {
    vi.useFakeTimers();
    const running = runPlatformCli(["--live", "--duration-sec", "2", "--timer-ms", "500"]);
    await vi.advanceTimersByTimeAsync(2001);
    await running;
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ mode: "live",
      persist: expect.any(Function) }));
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ kind: "timer" }));
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledWith("duration_elapsed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(output.mock.calls.map(args => JSON.parse(String(args[0])))).toEqual([
      expect.objectContaining({ status: "starting", cashUsd: null }),
      expect.objectContaining({ status: "running", strategy: null }), expect.objectContaining({ status: "stopped" })]);
  });

  it("does not add a market when pending discovery completes after shutdown", async () => {
    vi.useFakeTimers();
    const configPath = join(temporary, "reversal.json");
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", config: {} }));
    let finishDiscovery!: (markets: typeof market[]) => void;
    const pending = new Promise<typeof market[]>(resolve => { finishDiscovery = resolve; });
    mocks.discover.mockResolvedValueOnce([market]).mockImplementation(() => pending);
    const running = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath, "--duration-sec", "0"]);
    await flush();
    process.emit("SIGTERM");
    finishDiscovery([{ ...market, id: "next-condition", instruments: market.instruments.map(instrument => ({ ...instrument, marketId: "next-condition" })) }]);
    await running;
    expect(mocks.addMarkets).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts platform shutdown before waiting for hanging discovery", async () => {
    vi.useFakeTimers();
    const configPath = join(temporary, "reversal.json");
    writeFileSync(configPath, JSON.stringify({ strategyId: "btc-reversal", config: {} }));
    const discoverySignals: AbortSignal[] = [];
    let finishDiscovery!: () => void;
    const pending = new Promise<typeof market[]>(resolve => { finishDiscovery = () => resolve([]); });
    mocks.discover.mockResolvedValueOnce([market]).mockImplementation(
      (_at?: number, _directOnly?: boolean, signal?: AbortSignal) => {
        if (signal) discoverySignals.push(signal);
        return pending;
      },
    );
    const running = runPlatformCli(["--live", "--strategy", "btc-reversal", "--strategy-config", configPath,
      "--duration-sec", "0"]);
    await flush();
    expect(discoverySignals.length).toBeGreaterThan(0);

    process.emit("SIGTERM");

    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledWith("SIGTERM"));
    finishDiscovery();
    await running;
    expect(discoverySignals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses supplied markets and attaches only the requested plugin", async () => {
    vi.useFakeTimers();
    const marketsPath = join(temporary, "markets.json"), strategyPath = join(temporary, "observe.mjs");
    writeFileSync(marketsPath, JSON.stringify([market]));
    writeFileSync(strategyPath, 'export default { id: "explicit", onEvent: () => [] };');
    const running = runPlatformCli(["--live", "--markets", marketsPath, "--strategy-module", strategyPath, "--duration-sec", "1"]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1001);
    await running;
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ id: "explicit" }));
  });

  it("cleans up failed startup and suppresses provider error secrets", async () => {
    mocks.start.mockRejectedValue(new Error("secret-provider-token"));
    await expect(runPlatformCli(["--live"])).rejects.toThrow(/platform run failed/);
    expect(mocks.stop).toHaveBeenCalledWith("run_failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("secret-provider-token");
  });

  it("closes the state lock when connection setup fails", async () => {
    mocks.connect.mockRejectedValue(new Error("connect failed"));
    await expect(runPlatformCli(["--live"])).rejects.toThrow(/platform run failed/);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("handles SIGTERM through one cleanup path and removes listeners", async () => {
    vi.useFakeTimers();
    const before = process.listenerCount("SIGTERM");
    const running = runPlatformCli(["--live", "--duration-sec", "10"]);
    await vi.advanceTimersByTimeAsync(0);
    process.emit("SIGTERM");
    await running;
    expect(mocks.stop).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still closes state and reports failure when shutdown fails", async () => {
    vi.useFakeTimers();
    mocks.stop.mockRejectedValue(new Error("cancel failed"));
    const completed = runPlatformCli(["--live", "--duration-sec", "1"]).catch(error => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await completed).toBeInstanceOf(Error);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each(["SIGTERM", "SIGINT", "SIGBREAK"] as const)("keeps duration 0 observation running until %s", async signal => {
    vi.useFakeTimers();
    const before = process.listenerCount(signal);
    const running = runPlatformCli(["--live", "--duration-sec", "0", "--status-sec", "5"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ mode: "live", durationSec: Infinity }));
    expect(mocks.ingest.mock.calls.every(([event]) => event.kind === "timer")).toBe(true);
    process.emit(signal);
    await running;
    expect(mocks.stop).toHaveBeenCalledWith(signal);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(process.listenerCount(signal)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes isolated versioned JSONL, bounded depth and stable fill identity in event order", async () => {
    const journalFile = join(temporary, "events.jsonl");
    const connection = await mocks.connect();
    const levels = Array.from({ length: 8 }, (_, index) => [0.4 - index * 0.01, index + 1]);
    connection.platform.market.books = () => [{ tokenId: "yes", ts: 123, bids: levels, asks: levels }];
    const order = { clientOrderId: "client", orderId: "venue", strategyId: "manual", tokenId: "yes",
      status: "OPEN", venueStatus: "delayed", direction: "BUY", price: 0.4, shares: 5, filledShares: 0, reservedUsd: 2,
      reservedShares: 0, cancelRequestedAt: 122.75, cancelAckAt: 123, cancelAckLatencyMs: 250, updatedAt: 123 };
    mocks.start.mockImplementation(() => {
      const record = mocks.subscribe.mock.calls.at(-1)![0];
      const adapterRecord = mocks.connect.mock.calls.at(-1)![0].record;
      console.info("diagnostic stdout must not enter the journal");
      adapterRecord({ kind: "order", order });
      record({ kind: "order", order });
      record({ kind: "fill", fill: { tradeId: "trade", orderId: "venue", tokenId: "yes",
        direction: "BUY", price: 0.4, shares: 2, feeUsd: 0, isMaker: true, ts: 124 } });
      record({ kind: "order", order: { ...order, status: "PARTIAL", filledShares: 2 } });
      record({ kind: "book", book: { tokenId: "yes", ts: 124 } });
      record({ kind: "timer", ts: 124 });
      record({ kind: "error", message: "secret-provider-token" });
      record({ kind: "settlement", result: { marketId: "condition", state: "confirmed", transactionId: "tx",
        payoutVerified: true, creditedUsd: 5, expectedPayoutUsd: 5, cashBeforeUsd: 10, cashAfterUsd: 15 } });
    });
    const running = runPlatformCli(["--live", "--duration-sec", "0", "--journal-file", journalFile]);
    await vi.waitFor(() => expect(output).toHaveBeenCalledWith(expect.stringContaining('"status":"running"')));
    process.emit("SIGTERM");
    await running;
    const rows = readFileSync(journalFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.event)).toEqual([
      "platform_status", "order", "fill", "order", "platform_error", "platform_settlement", "platform_status", "platform_status",
    ]);
    expect(rows[0].runtime).toMatchObject({ schemaVersion: 1, engine: "platform", execution: "observation",
      strategy_id: null, status: "starting", cash_usd: null, risk: null });
    expect(rows.at(-1).runtime).toMatchObject({ status: "stopped", mode: "live", cash_usd: 1000 });
    expect(rows.at(-1).runtime.books[0].bids).toHaveLength(8);
    expect(rows.at(-1).runtime.books[0].asks).toHaveLength(8);
    expect(rows.at(-1).runtime.books[0].stale).toBe(true);
    expect(rows.at(-1).runtime.books[0].received_age_ms).toBeGreaterThan(10_000);
    expect(rows[1]).toMatchObject({ event: "order", order_id: "venue", strategy_id: "manual",
      direction: "BUY", side: "YES", market_slug: "Binary market", venue_status: "delayed",
      sign_latency_ms: null, ack_latency_ms: null,
      cancel_requested_at: 122.75, cancel_ack_at: 123, cancel_ack_latency_ms: 250 });
    expect(rows[2]).toMatchObject({ event_id: 'fill:["trade","venue"]', strategy_id: "manual",
      fee: 0, is_maker: true, engine_ts: 124 });
    expect(rows[5]).toMatchObject({ event: "platform_settlement", market_id: "condition", state: "confirmed",
      transaction_id: "tx", payout_verified: true, credited_usd: 5, expected_payout_usd: 5,
      cash_before_usd: 10, cash_after_usd: 15 });
    expect(rows.every(row => Number.isFinite(row.recv_ts) && typeof row.event_id === "string")).toBe(true);
    expect(new Set(rows.map(row => row.event_id)).size).toBe(rows.length);
    expect(readFileSync(journalFile, "utf8")).not.toMatch(/secret-provider-token|diagnostic stdout/);
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it("records a failed terminal status when durable state close fails", async () => {
    const journalFile = join(temporary, "failed.jsonl");
    mocks.close.mockImplementation(() => { throw new Error("secret-filesystem-path"); });
    const completed = runPlatformCli(["--live", "--duration-sec", "0", "--journal-file", journalFile]).catch(error => error);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    process.emit("SIGINT");
    expect(await completed).toBeInstanceOf(Error);
    const raw = readFileSync(journalFile, "utf8");
    const rows = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.at(-1).runtime.status).toBe("failed");
    expect(raw).toContain('"platform_state_close_failed"');
    expect(raw).not.toContain("secret-filesystem-path");
  });

  it("stops an indefinite observation when journal writes fail asynchronously", async () => {
    await expect(runPlatformCli(["--live", "--duration-sec", "0", "--journal-file", temporary])).rejects.toThrow(/platform run failed/);
    expect(mocks.stop).toHaveBeenCalledWith("journal_failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(errors.mock.calls.flat().join(" ")).not.toContain(temporary);
    expect(output.mock.calls.some(([value]) => JSON.parse(String(value)).status === "failed")).toBe(true);
  });

  it("stops duration 0 when the last selected market expires", async () => {
    vi.useFakeTimers();
    const now = Date.now() / 1000;
    mocks.discover.mockResolvedValue([{ ...market, startsAt: now - 60, endsAt: now + 1 }]);
    const running = runPlatformCli(["--live", "--duration-sec", "0"]);
    await vi.advanceTimersByTimeAsync(1001);
    await running;
    expect(mocks.stop).toHaveBeenCalledWith("markets_expired");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(output.mock.calls.some(([value]) => JSON.parse(String(value)).status === "stopped")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not connect an already expired selected market", async () => {
    const now = Date.now() / 1000;
    mocks.discover.mockResolvedValue([{ ...market, startsAt: now - 60, endsAt: now - 1 }]);
    await runPlatformCli(["--live", "--duration-sec", "0"]);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(output.mock.calls.some(([value]) => JSON.parse(String(value)).reason === "markets_expired")).toBe(true);
  });

  it("accepts a file stop request without console signals and clears every timer", async () => {
    vi.useFakeTimers();
    const stopFile = join(temporary, "controller.stop");
    const running = runPlatformCli(["--live", "--duration-sec", "0", "--stop-file", stopFile]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.start).toHaveBeenCalledOnce();
    writeFileSync(stopFile, "");
    await vi.advanceTimersByTimeAsync(151);
    await running;
    expect(mocks.stop).toHaveBeenCalledWith("controller_stop");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
