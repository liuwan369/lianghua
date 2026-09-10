import { describe, expect, it } from "vitest";
import {
  assertLockedProduction,
  isLockedProduction,
  stableLive,
  targetClone,
  targetCloneV2,
  targetCloneActive,
} from "./config.js";

describe("locked config", () => {
  it("default stable_live is locked production", () => {
    const c = stableLive();
    assertLockedProduction(c);
    expect(isLockedProduction(c)).toBe(true);
  });

  it("target_clone is not locked production", () => {
    expect(isLockedProduction(targetClone())).toBe(false);
  });

  it("fair rules off in locked on in v2", () => {
    const locked = stableLive();
    expect(locked.leadHighProbOpen).toBe(false);
    expect(locked.fairValueGate).toBe(false);
    const v2 = targetCloneV2();
    expect(v2.leadHighProbOpen).toBe(true);
    expect(v2.fairValueGate).toBe(true);
    const act = targetCloneActive();
    expect(act.activeCross).toBe(true);
    expect(act.closeToParity).toBe(true);
  });
});


describe("locked preset validation", () => {
  it("rejects non-finite spending limits instead of treating NaN as equal", () => {
    const invalid = { ...stableLive(), maxTotalCost: Number.NaN };
    expect(isLockedProduction(invalid)).toBe(false);
    expect(() => assertLockedProduction(invalid)).toThrow();
  });
  it("uses the same urgent pacing check for inspection and assertion", () => {
    const invalid = { ...stableLive(), burstIntervalSec: 30 };
    expect(isLockedProduction(invalid)).toBe(false);
    expect(() => assertLockedProduction(invalid)).toThrow();
  });
});
