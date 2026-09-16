import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), discover: vi.fn(), load: vi.fn(), save: vi.fn(), close: vi.fn(),
  open: vi.fn(), start: vi.fn(), stop: vi.fn(), attach: vi.fn(), ingest: vi.fn() }));
vi.mock("../platform/polymarket.js", () => ({ connectPolymarketPlatform: mocks.connect, discoverBtcMarket: mocks.discover }));
vi.mock("../platform/store.js", () => ({ PlatformStore: class {
  constructor(path: string) { mocks.open(path); }
  load = mocks.load;
  save = mocks.save;
  close = mocks.close;
} }));

import { loadStrategyModule, parsePlatformOptions, runPlatformCli, validateMarkets } from "./platform.js";

const market = { id: "condition", name: "Binary market", startsAt: 100, endsAt: 200,
  instruments: [{ tokenId: "yes", marketId: "condition", outcome: "YES", tickSize: 0.01, minOrderSize: 5 },
    { tokenId: "no", marketId: "condition", outcome: "NO", tickSize: 0.01, minOrderSize: 5 }] };
let temporary: string;
let output: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  temporary = mkdtempSync(join(tmpdir(), "platform-cli-"));
  mocks.discover.mockResolvedValue([market]);
  mocks.connect.mockResolvedValue({ start: mocks.start, stop: mocks.stop,
    platform: { attach: mocks.attach, ingest: mocks.ingest,
      account: { current: () => ({ cashUsd: 1000, positions: [], orders: [], fills: [], risk: { halted: false } }) },
      market: { list: () => [market] }, telemetry: { snapshot: () => ({ events: 0 }) },
      capabilities: () => ({ buy: true, sell: true }) } });
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(temporary, { recursive: true, force: true }); });

describe("generic platform CLI inputs", () => {
  it("defaults to paper observation even when LIVE environment is true", () => {
    vi.stubEnv("LIVE", "true");
    expect(parsePlatformOptions([])).toMatchObject({ mode: "paper", strategyModule: undefined,
      limits: { capitalUsd: 1000, dailyLossUsd: 1000 } });
    expect(parsePlatformOptions(["--live"])).toMatchObject({ mode: "live", limits: { capitalUsd: 50, dailyLossUsd: 30 } });
  });

  it.each([["--duration-sec", "0"], ["--duration-sec", "NaN"], ["--duration-sec", "Infinity"],
    ["--timer-ms", "0"], ["--status-sec", "-1"], ["--capital-usd", "NaN"], ["--max-open-orders", "1.5"],
    ["--live", "--paper"], ["--live", "--capital-usd", "51"], ["--live", "--daily-loss-usd", "31"],
    ["--capital-usd", "10", "--order-usd", "11"]])("rejects invalid options before connections: %j", (...args) => {
    expect(() => parsePlatformOptions(args)).toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("allows larger paper research capital without increasing live budgets", () => {
    expect(parsePlatformOptions(["--capital-usd", "25000", "--daily-loss-usd", "25000"])).toMatchObject({
      mode: "paper", limits: { capitalUsd: 25000, dailyLossUsd: 25000, maxOrderUsd: 25000 } });
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
    await expect(runPlatformCli(["--markets", path])).rejects.toThrow(/nonempty/);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe("generic platform CLI lifecycle", () => {
  it("runs without a strategy, emits timer events, then cancels/stops and closes durable state", async () => {
    vi.useFakeTimers();
    const running = runPlatformCli(["--duration-sec", "2", "--timer-ms", "500"]);
    await vi.advanceTimersByTimeAsync(2001);
    await running;
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ mode: "paper", paperCashUsd: 1000, persist: expect.any(Function) }));
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ kind: "timer" }));
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledWith("duration_elapsed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(output.mock.calls.map(args => JSON.parse(String(args[0])))).toEqual([
      expect.objectContaining({ status: "running", strategy: null }), expect.objectContaining({ status: "stopped" })]);
  });

  it("uses supplied markets and attaches only the requested plugin", async () => {
    vi.useFakeTimers();
    const marketsPath = join(temporary, "markets.json"), strategyPath = join(temporary, "observe.mjs");
    writeFileSync(marketsPath, JSON.stringify([market]));
    writeFileSync(strategyPath, 'export default { id: "explicit", onEvent: () => [] };');
    const running = runPlatformCli(["--markets", marketsPath, "--strategy-module", strategyPath, "--duration-sec", "1"]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1001);
    await running;
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ id: "explicit" }));
  });

  it("cleans up failed startup and suppresses provider error secrets", async () => {
    mocks.start.mockRejectedValue(new Error("secret-provider-token"));
    await expect(runPlatformCli([])).rejects.toThrow(/platform run failed/);
    expect(mocks.stop).toHaveBeenCalledWith("run_failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("secret-provider-token");
  });

  it("closes the state lock when connection setup fails", async () => {
    mocks.connect.mockRejectedValue(new Error("connect failed"));
    await expect(runPlatformCli([])).rejects.toThrow(/platform run failed/);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("handles SIGTERM through one cleanup path and removes listeners", async () => {
    vi.useFakeTimers();
    const before = process.listenerCount("SIGTERM");
    const running = runPlatformCli(["--duration-sec", "10"]);
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
    const completed = runPlatformCli(["--duration-sec", "1"]).catch(error => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await completed).toBeInstanceOf(Error);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
