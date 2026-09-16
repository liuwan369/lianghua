import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Executor } from "./executor.js";
import { run, type RunConfig } from "./orchestrator.js";

let root: string;
const account = "0x3333333333333333333333333333333333333333";

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "pm-strategy-entry-"));
  vi.stubEnv("POLYMARKET_WALLET_ADDRESS", account);
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(Executor, "newLive");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function config(strategyId: string): RunConfig {
  return {
    live: true, engine: { strategyId }, orderUsd: 1, maxOrders: 10, maxTotalUsd: 10,
    heartbeatMs: 50, btcMoveBps: 0, bookPollHz: 0, oracle: false,
    logPath: join(root, "run.jsonl"), tradedPath: join(root, "traded.jsonl"),
    durationMin: 0.1, riskStateDirectory: root, accountStateDirectory: root,
  };
}

describe("strategy selection at run entry", () => {
  it.each([
    ["observe", "paper-only"],
    ["unregistered", "Unknown strategy"],
  ])("rejects %s before creating a real order executor or contacting the venue", async (id, message) => {
    await expect(run(config(id))).rejects.toThrow(message);
    expect(Executor.newLive).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
