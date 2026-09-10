import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { snapshotsToTimeline, type SnapshotRow } from "./backtest-snapshots.js";

const row = (side: string, tick?: number | string): SnapshotRow => ({
  ts: "2026-09-10 05:10:20", slug: "btc-updown-5m-1789020600", token_type: side,
  bid: side === "Up" ? 0.23 : 0.76, ask: side === "Up" ? 0.24 : 0.77,
  ...(tick === undefined ? {} : { tick_size: tick }),
});

describe("historical token tick metadata", () => {
  it("exits the historical CLI with an error before printing a zero-fill summary", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-backtest-tick-"));
    try {
      writeFileSync(join(directory, "2026-09-10.json"), JSON.stringify([{
        market: { slug: "btc-updown-5m-1789020600" },
        window: { start_unix: 1789020600, end_unix: 1789020900 },
        snapshots: [row("Up"), row("Down")],
      }]));
      const result = spawnSync(process.execPath,
        ["--import", "tsx", fileURLToPath(new URL("./backtest.ts", import.meta.url)),
          "--data-dir", directory, "--dates", "2026-09-10"],
        { encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("provide recorded tick_size/tickSize");
      expect(result.stdout).not.toContain("=== SUMMARY ===");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("refuses legacy rows rather than silently producing a zero-fill backtest", () => {
    expect(() => snapshotsToTimeline([row("Up"),row("Down")])).toThrow("provide recorded tick_size/tickSize");
    expect(() => snapshotsToTimeline([row("Up",0.01),row("Down")])).toThrow("No tick default");
  });
  it("preserves different token ticks and their recorded changes", () => {
    const timeline=snapshotsToTimeline([row("Up",0.01),row("Down","0.001"),
      {...row("Up",0.001),ts:"2026-09-10 05:10:21"},
      {...row("Down",0.01),ts:"2026-09-10 05:10:21"}]);
    expect(timeline.map(books => [books.up.tickSize,books.down.tickSize])).toEqual([[0.01,0.001],[0.001,0.01]]);
  });
  it("accepts explicitly recorded camelCase metadata", () => {
    const timeline=snapshotsToTimeline([{...row("Up"),tickSize:0.01},{...row("Down"),tickSize:0.001}]);
    expect(timeline[0].down.tickSize).toBe(0.001);
  });
  it.each([0,-0.01,1,NaN,Infinity,"", "invalid"])("rejects invalid tick %s", tick => {
    expect(() => snapshotsToTimeline([row("Up",tick),row("Down",0.01)])).toThrow("valid token tick metadata");
  });
  it("rejects conflicting metadata aliases instead of silently choosing one", () => {
    expect(() => snapshotsToTimeline([{...row("Up",0.01),tickSize:0.001},row("Down",0.01)])).toThrow();
  });
  it.each(["2026-09-10 05:10:20", "2026-09-10T05:10:20Z",
    "2026-09-10T13:10:20+08:00", "2026-09-10T13:10:20+0800"])
    ("preserves the same recorded UTC instant for %s", ts => {
      const timeline=snapshotsToTimeline([{...row("Up",0.01),ts},{...row("Down",0.01),ts}]);
      expect(timeline[0].tsUnix).toBe(Date.UTC(2026,8,10,5,10,20)/1000);
    });
  it.each(["", "not-a-date", "2026-99-99T25:00:00Z"])
    ("rejects invalid timestamp %s instead of inventing epoch zero", ts => {
      expect(() => snapshotsToTimeline([{...row("Up",0.01),ts},row("Down",0.01)]))
        .toThrow("Invalid historical snapshot timestamp");
    });
});
