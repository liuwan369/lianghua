import { describe, expect, it } from "vitest";
import { redemptionPlan } from "./settlement.js";

const conditionId = `0x${"1".repeat(64)}`;

describe("binary settlement adapter", () => {
  it("requires exactly two distinct token IDs", () => {
    expect(() => redemptionPlan({ marketId: conditionId, tokenIds: ["up"] })).toThrow("binary");
    expect(() => redemptionPlan({ marketId: conditionId, tokenIds: ["up", "up"] })).toThrow("binary");
  });

  it("builds a binary redemption transaction", () => {
    const plan = redemptionPlan({ marketId: conditionId, tokenIds: ["up", "down"] });
    expect(plan.value).toBe(0n);
    expect(plan.data).toMatch(/^0x/);
  });
});
