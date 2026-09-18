import { describe, expect, it } from "vitest";
import { accountDayKey } from "./account-day.js";

describe("accountDayKey", () => {
  it("changes day at Beijing midnight", () => {
    const boundary = Date.parse("2026-09-13T00:00:00+08:00") / 1000;
    expect(accountDayKey(boundary - 1)).toBe("2026-09-12");
    expect(accountDayKey(boundary)).toBe("2026-09-13");
  });

  it("rejects invalid timestamps", () => {
    expect(() => accountDayKey(Number.NaN)).toThrow("invalid account timestamp");
  });
});
