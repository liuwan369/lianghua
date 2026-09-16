import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlatformStore } from "./store.js";
import type { CoreState } from "./contracts.js";

const state = (cashUsd: number): CoreState => ({
  schemaVersion: 1, accountId: "paper", mode: "paper", cashUsd, positions: [], orders: [], fills: [],
  risk: { halted: false, day: "2026-09-16", baselineAt: 1, baselineEquityUsd: cashUsd,
    equityUsd: cashUsd, dailyPnlUsd: 0, occupiedUsd: 0, availableUsd: cashUsd },
});

describe("platform store recovery", () => {
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
});
