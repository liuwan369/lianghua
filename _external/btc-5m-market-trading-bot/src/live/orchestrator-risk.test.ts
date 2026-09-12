import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RiskStore } from "../risk-store.js";
import { DailyMode } from "../risk.js";
import { run, type RunConfig } from "./orchestrator.js";
import { findMarket } from "./discovery.js";
import { runBtcFeed } from "./feeds/btc.js";

vi.mock("./feeds/btc.js", () => ({ runBtcFeed: vi.fn(() => ({ stop: vi.fn() })) }));
vi.mock("./discovery.js", () => ({ findMarket: vi.fn(async () => undefined),
  marketToken: vi.fn() }));

let root: string;
const account = "0x3333333333333333333333333333333333333333";
const now = Date.parse("2026-09-13T02:00:00Z");
function config(): RunConfig {
  return { live: false, engine: {}, orderUsd: 1, maxOrders: 10, maxTotalUsd: 10,
    heartbeatMs: 50, btcMoveBps: 0, bookPollHz: 0, oracle: false,
    logPath: join(root, "run.jsonl"), tradedPath: join(root, "traded.jsonl"), durationMin: 0.1,
    riskStateDirectory: root };
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "pm-run-risk-test-"));
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks();
  vi.stubEnv("POLYMARKET_WALLET_ADDRESS", account);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  vi.mocked(findMarket).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("run entry risk gate", () => {
  it("requires a stable public live wallet before reading a signer or contacting the exchange", async () => {
    vi.stubEnv("POLYMARKET_WALLET_ADDRESS", ""); vi.stubEnv("POLY_FUNDER", "");
    await expect(run({ ...config(), live: true })).rejects.toThrow(/explicit public trading wallet/);
    expect(fetch).not.toHaveBeenCalled(); expect(runBtcFeed).not.toHaveBeenCalled();
  });

  it("rejects a persisted daily stop before health requests or feeds start", async () => {
    const store = new RiskStore(root, account, "paper"); const risk = store.restore();
    risk.dailyDate = "2026-09-13"; risk.dailyPnl = -30; risk.dailyMode = DailyMode.Halted;
    store.finish(risk, null); store.close();
    await expect(run(config())).rejects.toThrow(/persisted risk halt/);
    expect(fetch).not.toHaveBeenCalled(); expect(runBtcFeed).not.toHaveBeenCalled();
  });

  it("finishes a flat run and releases the account lock", async () => {
    const running = run(config()); await vi.advanceTimersByTimeAsync(11000); await running;
    const next = new RiskStore(root, account, "paper");
    expect(next.restore().dailyPnl).toBe(0); next.close();
  });

  it("retains an error stop across runs even when no fills were observed", async () => {
    vi.mocked(findMarket).mockRejectedValueOnce(new Error("injected discovery failure"));
    await expect(run(config())).rejects.toThrow(/injected discovery failure/);
    vi.mocked(fetch).mockClear();
    await expect(run(config())).rejects.toThrow(/unreconciled/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
