import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformStore } from "./store.js";
import type { CoreState } from "./contracts.js";

const state = (cashUsd: number): CoreState => ({
  schemaVersion: 1, accountId: "paper", mode: "paper", cashUsd, positions: [], orders: [], fills: [],
  risk: { halted: false, day: "2026-09-16", baselineAt: 1, baselineEquityUsd: cashUsd,
    equityUsd: cashUsd, dailyPnlUsd: 0, occupiedUsd: 0, availableUsd: cashUsd },
});

describe("platform store recovery", () => {
  afterEach(() => vi.useRealTimers());
  it("loads a complete recovery snapshot left beside the primary file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pm-store-")), "state.json");
    const store = new PlatformStore(path);
    store.save(state(20), true);
    store.close();
    writeFileSync(`${path}.next`, JSON.stringify(state(19)));
    const recovered = new PlatformStore(path);
    expect(recovered.load()?.cashUsd).toBe(19);
    recovered.close();
  });

  it("can hold a background snapshot for one later durable commit", () => {
    vi.useFakeTimers();
    const path = join(mkdtempSync(join(tmpdir(), "pm-store-defer-")), "state.json");
    const store = new PlatformStore(path);
    store.save(state(20), false);
    store.defer();
    store.save(state(18), false);
    vi.advanceTimersByTime(100);
    expect(existsSync(path)).toBe(false);
    store.save(state(19), true);
    expect(store.load()?.cashUsd).toBe(19);
    store.close();
  });
});
