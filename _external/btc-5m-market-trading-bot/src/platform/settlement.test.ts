import { describe, expect, it } from "vitest";
import { redemptionPlan } from "./settlement.js";
import { COLLATERAL_ADAPTER, NEG_RISK_COLLATERAL_ADAPTER } from "./settlement.js";

const conditionId = `0x${"1".repeat(64)}`;

describe("binary settlement adapter", () => {
  it("requires exactly two distinct token IDs", () => {
    expect(() => redemptionPlan({ marketId: conditionId, tokenIds: ["up"] })).toThrow("binary");
    expect(() => redemptionPlan({ marketId: conditionId, tokenIds: ["up", "up"] })).toThrow("binary");
  });

  it("builds a binary redemption transaction", () => {
    const plan = redemptionPlan({ marketId: conditionId, tokenIds: ["up", "down"] });
    expect(plan.value).toBe(0n);
    expect(plan.to).toBe(COLLATERAL_ADAPTER);
    expect(plan.data).toMatch(/^0x/);
  });

  it("routes neg-risk calldata to the pUSD neg-risk collateral adapter", () => {
    expect(redemptionPlan({ marketId: conditionId, tokenIds: ["up", "down"] }, { negRisk: true }).to)
      .toBe(NEG_RISK_COLLATERAL_ADAPTER);
  });
});
