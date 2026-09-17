import { describe, expect, it } from "vitest";
import type { AccountSnapshot, CoreState, ExternalCashFlow, GatewayAck, OrderGateway } from "./contracts.js";
import { TradingCore } from "./core.js";

const gateway: OrderGateway = { mode: "live", submit: async () => ({ status: "accepted", orderId: "order" }), cancel: async () => true };
const snapshot = (cashUsd: number, at: number, externalFlows: ExternalCashFlow[] = [], complete = true): AccountSnapshot => ({
  accountId: "wallet", at, cashUsd, positions: [], openOrders: [], complete: true,
  cashFlowCoverage: { fromBlock: 100, toBlock: at, fromAt: 100, toAt: at, complete }, externalFlows,
});
const flow = (id: string, kind: ExternalCashFlow["kind"], amountUsd: number, at = 105): ExternalCashFlow => ({
  id, kind, amountUsd, at, block: at, transactionHash: `0x${"1".repeat(64)}`,
});
function setup(restored?: CoreState) {
  let now = 100;
  const persisted: CoreState[] = [];
  const core = new TradingCore({ account: snapshot(20, 100), restored, instruments: [{ tokenId: "up", marketId: "m",
    outcome: "UP", tickSize: 0.01, minOrderSize: 1 }], limits: { capitalUsd: 200, dailyLossUsd: 5, maxOrderUsd: 200, maxOpenOrders: 10 },
    adapters: { gateway, persist: state => persisted.push(structuredClone(state)) }, now: () => now });
  return { core, persisted, at: (value: number) => { now = value; } };
}

describe("confirmed external cash flow accounting", () => {
  it("starts funding coverage at the cash read rather than the later aggregate completion", () => {
    const core = new TradingCore({ account: { ...snapshot(20, 110), cashAt: 100 }, instruments: [],
      limits: { capitalUsd: 200, dailyLossUsd: 5, maxOrderUsd: 200, maxOpenOrders: 10 },
      adapters: { gateway }, now: () => 120 });
    expect(core.snapshot()).toMatchObject({ cashAt: 100, cashFlowTracking: { baselineAt: 100 }, risk: { baselineAccountAt: 100 } });
    core.reconcile({ ...snapshot(30, 120, [flow("between-sections", "deposit", 10, 105)]), cashAt: 115 });
    expect(core.risk()).toMatchObject({ dailyPnlUsd: 0, netExternalFlowUsd: 10 });
  });

  it("uses the cash section at a day boundary so late section completion cannot hide funding", () => {
    const { core, at } = setup(); at(110);
    core.reconcile({ ...snapshot(20, 110), cashAt: 100 });
    at(57_601); core.risk();
    core.reconcile({ ...snapshot(30, 57_602, [flow("between-sections", "deposit", 10, 105)]), cashAt: 57_601 });
    expect(core.risk()).toMatchObject({ baselineAccountAt: 100, dailyPnlUsd: 0, netExternalFlowUsd: 10 });
  });

  it("keeps confirmed coverage when the next scan has no newly confirmed blocks", () => {
    const { core } = setup();
    const empty = snapshot(20, 110);
    empty.cashFlowCoverage = { fromBlock: 100, toBlock: 100, fromAt: 100, toAt: 100,
      complete: false, reason: "confirmation_window_empty" };
    core.reconcile(empty);
    expect(core.snapshot().cashFlowTracking).toMatchObject({ cursorBlock: 100, complete: true });
    expect(core.risk()).toMatchObject({ halted: false, cashFlowComplete: true, pnlVerified: false });
  });

  it("rejects funding newer than the cash section without changing the ledger", () => {
    const { core } = setup(), before = core.snapshot();
    expect(() => core.reconcile({ ...snapshot(20, 110, [flow("too-new", "deposit", 10, 105)]), cashAt: 104 }))
      .toThrow("invalid external cash flow evidence");
    expect(core.snapshot()).toEqual(before);
  });

  it("rejects stale cash even when the aggregate account completed later", () => {
    const { core } = setup(); core.reconcile({ ...snapshot(20, 120), cashAt: 110 });
    const before = core.snapshot();
    expect(() => core.reconcile({ ...snapshot(20, 130), cashAt: 105 })).toThrow("cash observation is older");
    expect(core.snapshot()).toEqual(before);
  });

  it("advances background coverage without replacing live ledger balances", () => {
    const { core } = setup();
    expect(core.observeCashFlowCoverage(snapshot(999, 110))).toBe(true);
    expect(core.snapshot()).toMatchObject({ cashUsd: 20, accountAt: 100, cashFlowTracking: { cursorBlock: 110 } });
  });

  it("preserves in-flight order identity while background coverage advances", async () => {
    let acknowledge!: (ack: GatewayAck) => void;
    const core = new TradingCore({ account: snapshot(20, 100), instruments: [{ tokenId: "up", marketId: "m",
      outcome: "UP", tickSize: 0.01, minOrderSize: 1 }], limits: { capitalUsd: 200, dailyLossUsd: null, maxOrderUsd: 200, maxOpenOrders: 10 },
      adapters: { gateway: { ...gateway, submit: () => new Promise(resolve => { acknowledge = resolve; }) } }, now: () => 110 });
    const pending = core.submit({ clientOrderId: "concurrent-order", strategyId: "btc-reversal", tokenId: "up",
      direction: "BUY", price: 0.5, shares: 1, timeInForce: "GTC", postOnly: false });
    await Promise.resolve();
    expect(core.observeCashFlowCoverage(snapshot(20, 110))).toBe(true);
    acknowledge({ status: "accepted", orderId: "venue-order" });
    await pending;
    expect(core.order("concurrent-order")).toMatchObject({ status: "OPEN", orderId: "venue-order" });
  });

  it("requires cash reconciliation before advancing a scan containing new external funding", () => {
    const { core } = setup(), before = core.snapshot();
    const account = snapshot(30, 110, [flow("new-funding", "deposit", 10)]);
    expect(core.observeCashFlowCoverage(account)).toBe(false);
    expect(core.snapshot()).toEqual(before);
    core.reconcile(account);
    expect(core.observeCashFlowCoverage(account)).toBe(true);
    expect(core.risk().dailyPnlUsd).toBe(0);
  });

  it("ignores an older background read after a newer reconciliation", () => {
    const { core } = setup(); core.reconcile(snapshot(20, 120));
    expect(core.observeCashFlowCoverage(snapshot(20, 110, [], false))).toBe(true);
    expect(core.snapshot().cashFlowTracking).toMatchObject({ cursorBlock: 120, complete: true });
  });
  it("adjusts deposits once in the same durable commit as cash and cursor", () => {
    const { core, persisted, at } = setup(); at(110);
    core.reconcile(snapshot(30, 110, [flow("deposit", "deposit", 10)]));
    expect(core.risk()).toMatchObject({ dailyPnlUsd: 0, netExternalFlowUsd: 10, cashFlowComplete: true, pnlVerified: true });
    expect(persisted.at(-1)).toMatchObject({ cashUsd: 30, risk: { baselineEquityUsd: 30 },
      cashFlowTracking: { cursorBlock: 110, appliedFlows: [flow("deposit", "deposit", 10)] } });
    core.reconcile(snapshot(30, 110, [flow("deposit", "deposit", 10)]));
    expect(core.risk().baselineEquityUsd).toBe(30);
  });

  it("corrects a withdrawal that previously triggered an estimated daily loss", () => {
    const { core, at } = setup(); at(110);
    core.reconcile({ ...snapshot(10, 110, [], false), cashFlowCoverage: undefined, externalFlows: undefined });
    expect(core.risk()).toMatchObject({ halted: true, dailyLossStatus: "estimated" });
    core.reconcile(snapshot(10, 110, [flow("withdraw", "withdrawal", 10)]));
    expect(core.risk()).toMatchObject({ halted: false, dailyPnlUsd: 0, netExternalFlowUsd: -10 });
  });

  it("does not remove trading, reward or redemption income that the classifier excludes", () => {
    const { core, at } = setup(); at(110);
    core.reconcile(snapshot(24, 110, []));
    expect(core.risk()).toMatchObject({ dailyPnlUsd: 4, netExternalFlowUsd: 0 });
  });

  it("retains applied identifiers across restart", () => {
    const { core, at } = setup(); at(110);
    core.reconcile(snapshot(30, 110, [flow("deposit", "deposit", 10)]));
    const restored = setup(core.snapshot()); restored.at(120);
    restored.core.reconcile(snapshot(30, 120, [flow("deposit", "deposit", 10)]));
    expect(restored.core.risk()).toMatchObject({ baselineEquityUsd: 30, dailyPnlUsd: 0 });
    expect(restored.core.snapshot().cashFlowTracking?.appliedFlows).toHaveLength(1);
  });

  it("does not subtract a prior-day deposit already included in the new day baseline", () => {
    const { core, at } = setup(); at(110);
    core.reconcile({ ...snapshot(30, 110, [], false), cashFlowCoverage: undefined, externalFlows: undefined });
    at(57_601); expect(core.risk().dailyPnlUsd).toBe(0);
    core.reconcile(snapshot(30, 57_602, [flow("late-confirmation", "deposit", 10)]));
    expect(core.risk()).toMatchObject({ baselineEquityUsd: 30, dailyPnlUsd: 0, netExternalFlowUsd: 0 });
  });

  it("corrects a deposit observed after midnight even if its chain timestamp is from the prior day", () => {
    const { core, at } = setup(); at(57_601); core.risk();
    core.reconcile(snapshot(30, 57_602, [flow("late-account-read", "deposit", 10, 57_599)]));
    expect(core.risk()).toMatchObject({ baselineEquityUsd: 30, dailyPnlUsd: 0, netExternalFlowUsd: 10 });
  });

  it("accepts individually verified flows without claiming an incomplete window is complete", () => {
    const { core, at } = setup(); at(110);
    core.reconcile(snapshot(30, 110, [flow("known", "deposit", 10)], false));
    expect(core.risk()).toMatchObject({ dailyPnlUsd: 0, cashFlowComplete: false, pnlVerified: false, dailyLossStatus: "estimated" });
    expect(core.snapshot().cashFlowTracking?.cursorBlock).toBe(100);
  });

  it("does not advance the durable cursor across a scan gap", () => {
    const { core, at } = setup(); at(110);
    const account = snapshot(20, 110);
    account.cashFlowCoverage!.fromBlock = 102; account.cashFlowCoverage!.fromAt = 102;
    core.reconcile(account);
    expect(core.snapshot().cashFlowTracking).toMatchObject({ cursorBlock: 100, complete: false, reason: "external_cash_flow_scan_gap" });
  });

  it("rejects changed flow identity without changing cash, cursor or baseline", () => {
    const { core, at } = setup(); at(110);
    core.reconcile(snapshot(30, 110, [flow("deposit", "deposit", 10)]));
    const before = core.snapshot();
    expect(() => core.reconcile(snapshot(40, 120, [flow("deposit", "deposit", 20)]))).toThrow("identity changed");
    expect(core.snapshot()).toEqual(before);
  });

  it("describes confirmed coverage separately from a newer ordinary balance observation", () => {
    const { core, at } = setup(); at(120);
    const account = snapshot(30, 120, [flow("deposit", "deposit", 10)]);
    account.cashFlowCoverage!.toBlock = 110; account.cashFlowCoverage!.toAt = 110;
    core.reconcile(account);
    expect(core.risk()).toMatchObject({ cashFlowComplete: true, cashFlowCoverageUntil: 110,
      pnlVerified: false, dailyLossStatus: "estimated", dailyPnlUsd: 0 });
  });

  it("never requires a midnight baseline to use available cash when daily loss is disabled", async () => {
    const { core } = setup(); core.updateLimits({ dailyLossUsd: null });
    core.reconcile({ accountId: "wallet", cashUsd: 30, at: 110, positions: [], openOrders: [], complete: true });
    expect(core.risk()).toMatchObject({ cashFlowComplete: false, dailyLossStatus: "disabled", halted: false });
    const order = await core.submit({ clientOrderId: "one", strategyId: "btc-reversal", tokenId: "up", direction: "BUY",
      price: 0.5, shares: 1, timeInForce: "GTC", postOnly: false });
    expect(order.status).toBe("OPEN");
  });
});
