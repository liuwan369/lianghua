import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { targetClone } from "./config.js";
import { DailyMode, RiskState, riskDayKey } from "./risk.js";
import { RiskStore, type RiskExposure } from "./risk-store.js";
import { Engine } from "./live/engine.js";
import { Side } from "./models.js";

const account = "0x1111111111111111111111111111111111111111";
const now = Date.parse("2026-09-13T01:00:00Z") / 1000;
const roots: string[] = [];
const stores: RiskStore[] = [];
const directory = () => {
  const root = fs.mkdtempSync(join(tmpdir(), "pm-risk-test-"));
  roots.push(root);
  return root;
};
const open = (root: string, mode: "paper" | "live" = "paper", identity = account) => {
  const store = new RiskStore(root, identity, mode);
  stores.push(store);
  return store;
};
const exposure: RiskExposure = { marketStart: now, marketEnd: now + 300,
  upShares: 5, downShares: 0, cost: 2, fees: 0, pendingOrders: 0, settled: false };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now * 1000); });
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Beijing risk day", () => {
  it("changes at 16:00 UTC and preserves the stop before local midnight", () => {
    const risk = new RiskState(); const cfg = { ...targetClone(), dailyHardLossUsd: 30 };
    const boundary = Date.parse("2026-09-12T16:00:00Z") / 1000;
    risk.onMarketStart(boundary - 300, cfg); risk.onMarketEnd(-30, boundary - 300, cfg);
    expect(riskDayKey(boundary - 1)).toBe("2026-09-12");
    expect(riskDayKey(boundary)).toBe("2026-09-13");
    risk.onMarketStart(boundary - 1, cfg); expect(risk.canTrade(cfg)).toBe(false);
    risk.onMarketStart(boundary, cfg); expect(risk.canTrade(cfg)).toBe(true);
    expect(risk.dailyPnl).toBe(0);
  });

  it("does not let backwards clock/day inputs erase a loss", () => {
    const risk = new RiskState(); const cfg = targetClone();
    risk.onMarketStart(now, cfg); risk.onMarketEnd(-20, now, cfg);
    expect(() => risk.onMarketEnd(10, now - 86400, cfg)).toThrow(/earlier day/);
    expect(risk.dailyPnl).toBe(-20); expect(risk.sessionPnl).toBe(-20);
  });

  it("attributes resolved PnL to the market end risk day", () => {
    const boundary = Date.parse("2026-09-12T16:00:00Z") / 1000;
    const engine = new Engine({ dailyLossLimitUsd: 30 });
    engine.reset(boundary - 300, boundary);
    engine.confirmExchangeFill({ side: Side.Up, price: 0.4, shares: 5, isMaker: true, tsUnix: boundary - 1 });
    engine.resolve(Side.Down);
    expect(engine.session.strat.risk.dailyDate).toBe("2026-09-13");
    expect(engine.session.strat.risk.dailyPnl).toBe(-2);
  });
});

describe("persistent account risk", () => {
  it("keeps loss counters and a halt across engines and session log names", () => {
    const root = directory(); const first = open(root);
    const engine = new Engine({ dailyLossLimitUsd: 30 }, first);
    engine.reset(now, now + 300); engine.session.onMarketEnd(-30); engine.checkpoint();
    engine.finishRiskRun(); first.close();
    const second = open(root);
    expect(second.restore().dailyPnl).toBe(-30);
    expect(second.restore().dailyMode).toBe(DailyMode.Halted);
    expect(() => new Engine({ dailyLossLimitUsd: 30 }, second)).toThrow(/persisted risk halt/);
  });

  it("re-evaluates persisted losses against a tighter limit and persists the newly reached stop", () => {
    const root = directory(); const first = open(root); const risk = first.restore();
    risk.onMarketStart(now, targetClone()); risk.onMarketEnd(-40, now, targetClone());
    first.finish(risk, null); first.close();
    const second = open(root);
    expect(() => new Engine({ dailyLossLimitUsd: 30 }, second)).toThrow(/persisted risk halt/);
    expect(second.restore().dailyMode).toBe(DailyMode.Halted);
  });

  it("keeps a session stop and loss streak across risk days", () => {
    const root = directory(); const first = open(root); const risk = first.restore();
    risk.dailyDate = "2026-09-12"; risk.dailyPnl = -30; risk.dailyMode = DailyMode.Halted;
    risk.sessionPnl = -30; risk.sessionHalted = true; risk.consecutiveMarketLosses = 3;
    first.finish(risk, null); first.close();
    const second = open(root);
    expect(() => new Engine({}, second)).toThrow(/persisted risk halt/);
    expect(second.restore().dailyPnl).toBe(0);
    expect(second.restore().sessionPnl).toBe(-30);
    expect(second.restore().consecutiveMarketLosses).toBe(3);
  });

  it("blocks an incomplete run even with a flat last checkpoint", () => {
    const root = directory(); const first = open(root); first.begin(first.restore()); first.close();
    expect(() => open(root)).toThrow(/unreconciled/);
  });

  it.each([
    exposure,
    { ...exposure, downShares: 5, cost: 4.5 },
    { ...exposure, upShares: 0, cost: 0, pendingOrders: 1 },
  ])("retains unresolved inventory or pending orders across runs", (pending) => {
    const root = directory(); const first = open(root);
    first.finish(first.restore(), pending); first.close();
    vi.setSystemTime((now + 86400) * 1000);
    expect(() => open(root)).toThrow(/unreconciled/);
    expect(JSON.parse(fs.readFileSync(first.statePath, "utf8")).exposure).toEqual(pending);
  });

  it("does not let a market reset discard unresolved fills", () => {
    const first = open(directory()); const engine = new Engine({ liveMode: true }, first);
    engine.reset(now, now + 300);
    engine.confirmExchangeFill({ side: Side.Up, price: 0.4, shares: 5, isMaker: true, tsUnix: now + 1 });
    expect(() => engine.reset(now + 300, now + 600)).toThrow(/unreconciled/);
    expect(engine.session.exposure().cost).toBe(2);
    expect(JSON.parse(fs.readFileSync(first.statePath, "utf8")).reconciliationRequired).toBe(true);
  });

  it("allows a clean, settled paper run to persist PnL and move to the next market", () => {
    const first = open(directory()); const engine = new Engine({}, first);
    engine.reset(now, now + 300);
    engine.confirmExchangeFill({ side: Side.Up, price: 0.4, shares: 5, isMaker: true, tsUnix: now + 1 });
    engine.resolve(Side.Up); engine.reset(now + 300, now + 600); engine.finishRiskRun(); first.close();
    const next = open(roots.at(-1)!);
    expect(next.restore().sessionPnl).toBe(3);
  });

  it("isolates accounts and paper/live while canonicalizing address case", () => {
    const root = directory(); const first = open(root, "live");
    const paper = open(root, "paper");
    const other = open(root, "live", "0x2222222222222222222222222222222222222222");
    expect(new Set([first.statePath, paper.statePath, other.statePath]).size).toBe(3);
    expect(() => open(root, "live", account.toUpperCase())).toThrow(/EEXIST/);
  });

  it("rejects a simultaneous process for the same account and mode", () => {
    const root = directory(); open(root);
    const script = `import { RiskStore } from './src/risk-store.ts';
      try { new RiskStore(process.argv[1], process.argv[2], 'paper'); process.exitCode = 9; }
      catch (error) { if (error.code !== 'EEXIST') throw error; console.log('locked'); }`;
    const output = execFileSync(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, root, account], { encoding: "utf8" });
    expect(output.trim()).toBe("locked");
  });

  it.each(["{", '{"schemaVersion":99}', "null"])("rejects a corrupt or incompatible file: %s", (content) => {
    const root = directory(); const first = open(root); first.close();
    fs.writeFileSync(first.statePath, content);
    expect(() => open(root)).toThrow();
    expect(fs.readFileSync(first.statePath, "utf8")).toBe(content);
  });

  it("rejects deletion of previously initialized state", () => {
    const root = directory(); const first = open(root); first.close(); fs.unlinkSync(first.statePath);
    expect(() => open(root)).toThrow(/previous risk state is missing/);
  });

  it("leaves the previous atomic checkpoint intact and freezes after a failed rename", () => {
    const first = open(directory()); const engine = new Engine({}, first);
    const before = fs.readFileSync(first.statePath, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("injected disk failure"); });
    expect(() => engine.reset(now, now + 300)).toThrow(/persistence failed/);
    expect(fs.readFileSync(first.statePath, "utf8")).toBe(before);
    expect(engine.session.haltNew).toBe(true);
    expect(() => engine.checkpoint()).toThrow(/persistence is unavailable/);
  });

  it("can replace an existing checkpoint on every supported operating system", () => {
    const first = open(directory()); const engine = new Engine({}, first);
    engine.reset(now, now + 300);
    const before = fs.readFileSync(first.statePath, "utf8");
    engine.checkpoint();
    expect(fs.readFileSync(first.statePath, "utf8")).toBe(before);
  });

  it("detects corruption during an active run before any further submission", () => {
    const first = open(directory()); const engine = new Engine({}, first);
    fs.writeFileSync(first.statePath, "broken");
    expect(() => engine.prepareSubmission()).toThrow(/checkpoint is missing or changed/);
    expect(engine.session.haltNew).toBe(true);
    expect(fs.readFileSync(first.statePath, "utf8")).toBe("broken");
  });
});
