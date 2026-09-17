import { describe, expect, it, vi } from "vitest";
import { classifyCashFlows, readCashFlowEvidence, type ClassifyCashFlowInput } from "./cash-flows.js";
import { COLLATERAL_OFFRAMP, COLLATERAL_ONRAMP, CTF_EXCHANGE, PUSD, USDC_E } from "../live/contracts.js";
import { COLLATERAL_ADAPTER } from "./settlement.js";

const wallet = `0x${"1".repeat(40)}`, other = `0x${"2".repeat(40)}`;
const txHash = (index: number) => `0x${index.toString(16).padStart(64, "0")}`;
const blockHash = (block: number) => `0x${(block + 1000).toString(16).padStart(64, "0")}`;
const topic = (account: string) => `0x${"0".repeat(24)}${account.slice(2)}`;
const eventTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
type Row = Record<string, unknown>;
function transfer(index: number, value = 2, outgoing = false, overrides: Row = {}): Row {
  return { transaction_hash: txHash(index), log_index: "0x0", block: 100, block_hash: blockHash(100),
    token: PUSD, from: outgoing ? wallet : other, to: outgoing ? other : wallet,
    amount: value, net_amount: outgoing ? -value : value, ...overrides };
}
function rawReceipt(transfers: Row[]): Row {
  const row = transfers[0]!;
  return { transactionHash: row.transaction_hash, blockNumber: `0x${Number(row.block).toString(16)}`, blockHash: row.block_hash,
    status: "0x1", logs: transfers.map(t => ({ transactionHash: t.transaction_hash,
      blockNumber: `0x${Number(t.block).toString(16)}`, blockHash: t.block_hash, logIndex: t.log_index, address: t.token,
      topics: [eventTopic, topic(String(t.from)), topic(String(t.to))],
      data: `0x${BigInt(Math.round(Number(t.amount) * 1e6)).toString(16).padStart(64, "0")}` })) };
}
function input(transfers: Row[], activity: Row[] = []): ClassifyCashFlowInput {
  const groups = new Map<string, Row[]>();
  for (const t of transfers) groups.set(String(t.transaction_hash), [...groups.get(String(t.transaction_hash)) ?? [], t]);
  return { wallet, scan: { source: "polygon-confirmed-transfer-logs", token_contracts: [PUSD, USDC_E],
    complete: true, from_block: 99, to_block: 101, transfers }, activity: { items: activity },
    receipts: [...groups.values()].map(rawReceipt), blockTimestamps: { 99: 198, 100: 200, 101: 202 } };
}
const activity = (index: number, type: string, amount: number, extras: Row = {}): Row => ({ transactionHash: txHash(index), type, usdcSize: amount, timestamp: 200, ...extras });

describe("confirmed external cash-flow classification", () => {
  it("counts only receipt-matched official deposits and withdrawals, preserving positive event amounts", () => {
    const result = classifyCashFlows(input([transfer(1, 12), transfer(2, 3, true)], [activity(1, "DEPOSIT", 12), activity(2, "WITHDRAWAL", 3)]));
    expect(result.cashFlowCoverage).toMatchObject({ complete: true, fromBlock: 99, toBlock: 101, fromAt: 198, toAt: 202 });
    expect(result.netExternalUsd).toBe(9);
    expect(result.externalFlows).toEqual([
      { id: `${txHash(1)}:0`, kind: "deposit", amountUsd: 12, block: 100, at: 200, transactionHash: txHash(1) },
      { id: `${txHash(2)}:0`, kind: "withdrawal", amountUsd: 3, block: 100, at: 200, transactionHash: txHash(2) },
    ]);
  });
  it("excludes trades, redeems, rewards and internal collateral splits from external funding", () => {
    const result = classifyCashFlows(input([
      transfer(1, 4, true, { to: CTF_EXCHANGE }), transfer(2, 7, false, { from: COLLATERAL_ADAPTER }),
      transfer(3, 1), transfer(4, 3, true),
    ], [activity(1, "TRADE", 4, { side: "BUY" }), activity(2, "REDEEM", 7), activity(3, "MAKER_REBATE", 1), activity(4, "SPLIT", 3)]));
    expect(result.cashFlowCoverage.complete).toBe(true);
    expect(result.externalFlows).toEqual([]);
    expect(result.netExternalUsd).toBe(0);
    expect(result.classified.map(row => row.kind)).toEqual(["trade", "redemption", "reward", "conversion"]);
  });
  it("keeps an unknown incoming transfer unknown even when its value looks like a deposit", () => {
    const result = classifyCashFlows(input([transfer(1, 10)]));
    expect(result.externalFlows).toEqual([]);
    expect(result.cashFlowCoverage.complete).toBe(false);
    expect(result.unknown[0]?.reason).toBe("external_funding_evidence_missing");
  });
  it.each([
    ["amount mismatch", activity(1, "DEPOSIT", 3)],
    ["wrong direction", activity(1, "WITHDRAWAL", 2)],
    ["wrong account", activity(1, "DEPOSIT", 2, { wallet: other })],
    ["unknown type", activity(1, "AIRDROP", 2)],
  ])("does not accept %s as external funding", (_name, claim) => {
    const result = classifyCashFlows(input([transfer(1)], [claim as Row]));
    expect(result.cashFlowCoverage.complete).toBe(false);
    expect(result.externalFlows).toEqual([]);
  });
  it("refuses mixed trade/deposit labels and protocol-address conflicts", () => {
    const mixed = classifyCashFlows(input([transfer(1)], [activity(1, "DEPOSIT", 2), activity(1, "REWARD", 2)]));
    expect(mixed.cashFlowCoverage.complete).toBe(false);
    const protocol = classifyCashFlows(input([transfer(1, 2, false, { from: COLLATERAL_ADAPTER })], [activity(1, "DEPOSIT", 2)]));
    expect(protocol.cashFlowCoverage.complete).toBe(false);
    expect(protocol.externalFlows).toEqual([]);
  });
  it("requires confirmed receipt proof and exact block identity", () => {
    const fixture = input([transfer(1)], [activity(1, "DEPOSIT", 2)]);
    for (const receipts of [[], [{ ...rawReceipt([transfer(1)]), status: "0x0" }], [{ ...rawReceipt([transfer(1)]), blockHash: txHash(999) }]]) {
      const result = classifyCashFlows({ ...fixture, receipts });
      expect(result.cashFlowCoverage.complete).toBe(false);
      expect(result.externalFlows).toEqual([]);
    }
  });
  it("de-duplicates identical transfer logs, but flags conflicting logs and ambiguous duplicate activity", () => {
    const row = transfer(1), fixture = input([row], [activity(1, "DEPOSIT", 2)]);
    expect(classifyCashFlows({ ...fixture, scan: { ...fixture.scan as Row, transfers: [row, row] } }).netExternalUsd).toBe(2);
    const conflict = classifyCashFlows({ ...fixture, scan: { ...fixture.scan as Row, transfers: [row, { ...row, amount: 3, net_amount: 3 }] } });
    expect(conflict.externalFlows).toEqual([]); expect(conflict.cashFlowCoverage.complete).toBe(false);
    expect(classifyCashFlows({ ...fixture, activity: [activity(1, "DEPOSIT", 1), activity(1, "DEPOSIT", 1)] }).cashFlowCoverage.complete).toBe(false);
  });
  it("retains pUSD and USDC.e funding separately and excludes a self-transfer", () => {
    const result = classifyCashFlows(input([transfer(1, 5), transfer(2, 9, false, { token: USDC_E }),
      transfer(3, 4, false, { from: wallet, to: wallet, net_amount: 0 })], [activity(1, "DEPOSIT", 5), activity(2, "DEPOSIT", 9)]));
    expect(result.cashFlowCoverage.complete).toBe(true);
    expect(result.netExternalUsd).toBe(5);
    expect(result.netExternalByToken[USDC_E.toLowerCase()]).toBe(9);
    expect(result.externalFlows).toHaveLength(1);
    expect(result.classified[2]?.kind).toBe("self");
  });
  it("counts a proven onramp once on its pUSD mint leg, excluding the USDC.e leg", () => {
    const result = classifyCashFlows(input([transfer(1, 2, true, { to: COLLATERAL_ONRAMP, token: USDC_E }),
      transfer(1, 2, false, { from: `0x${"0".repeat(40)}`, log_index: "0x1" })], [activity(1, "DEPOSIT", 2)]));
    expect(result.cashFlowCoverage.complete).toBe(true);
    expect(result.netExternalUsd).toBe(2);
    expect(result.netExternalByToken[USDC_E.toLowerCase()]).toBeUndefined();
    expect(result.externalFlows).toEqual([{ id: `${txHash(1)}:1`, kind: "deposit", amountUsd: 2,
      block: 100, at: 200, transactionHash: txHash(1) }]);
  });
  it("counts a proven offramp once on its pUSD burn leg without requiring recent activity", () => {
    const result = classifyCashFlows(input([
      transfer(1, 2, true, { to: `0x${"0".repeat(40)}` }),
      transfer(1, 2, false, { from: COLLATERAL_OFFRAMP, token: USDC_E, log_index: "0x1" }),
    ]));
    expect(result.cashFlowCoverage.complete).toBe(true);
    expect(result.netExternalUsd).toBe(-2);
    expect(result.externalFlows).toEqual([{ id: `${txHash(1)}:0`, kind: "withdrawal", amountUsd: 2,
      block: 100, at: 200, transactionHash: txHash(1) }]);
  });
  it("counts direct pUSD ramp transfers as funding but does not infer an unmatched mint", () => {
    const direct = classifyCashFlows(input([transfer(1, 7, false, { from: COLLATERAL_ONRAMP }),
      transfer(2, 3, true, { to: COLLATERAL_OFFRAMP })]));
    expect(direct.cashFlowCoverage.complete).toBe(true);
    expect(direct.netExternalUsd).toBe(4);
    const unmatched = classifyCashFlows(input([transfer(1, 3, true, { to: COLLATERAL_ONRAMP, token: USDC_E }),
      transfer(1, 2, false, { from: `0x${"0".repeat(40)}`, log_index: "0x1" })]));
    expect(unmatched.cashFlowCoverage.complete).toBe(false);
    expect(unmatched.externalFlows).toEqual([]);
  });
  it("accepts official non-trade size fallback but never mistakes trade shares for dollars", () => {
    const funding = classifyCashFlows(input([transfer(1), transfer(2, 1, true)], [
      { transactionHash: txHash(1), type: "DEPOSIT", size: 2, timestamp: 200 },
      { transactionHash: txHash(2), type: "WITHDRAWAL", usdcSize: null, size: 1, timestamp: 200 },
    ]));
    expect(funding.cashFlowCoverage.complete).toBe(true);
    expect(funding.netExternalUsd).toBe(1);
    const sharesOnly = classifyCashFlows(input([transfer(1, 2, true)], [
      { transactionHash: txHash(1), type: "TRADE", side: "BUY", size: 2, timestamp: 200 },
    ]));
    expect(sharesOnly.cashFlowCoverage.complete).toBe(false);
    expect(sharesOnly.externalFlows).toEqual([]);
  });
  it("reports a complete confirmed empty window and incomplete scans/timestamps explicitly", () => {
    const fixture = input([]);
    expect(classifyCashFlows(fixture).cashFlowCoverage.complete).toBe(true);
    expect(classifyCashFlows({ ...fixture, scan: { ...fixture.scan as Row, complete: false, reason: "rpc_failed" } }).cashFlowCoverage.complete).toBe(false);
    expect(classifyCashFlows({ ...fixture, blockTimestamps: {} }).cashFlowCoverage.complete).toBe(false);
  });
  it("does not equate a confirmed trade hash to attribution for every cash transfer", () => {
    const result = classifyCashFlows({ ...input([transfer(1)]), trades: [{ transaction_hash: txHash(1), status: "CONFIRMED" }] });
    expect(result.externalFlows).toEqual([]);
    expect(result.unknown[0]?.reason).toBe("trade_receipt_transfer_attribution_incomplete");
  });
});

describe("cash-flow evidence reader", () => {
  const rpcFixture = () => {
    const calls: string[] = [];
    const rpc = vi.fn(async (method: string, params: unknown[]): Promise<unknown> => {
      calls.push(method);
      if (method === "eth_blockNumber") return "0x66"; // head 102; depth 1 => block 101
      if (method === "eth_getBlockByNumber") {
        const number = Number(BigInt(String(params[0])));
        return { number: `0x${number.toString(16)}`, hash: blockHash(number), timestamp: `0x${(number * 2).toString(16)}` };
      }
      if (method === "eth_getLogs") {
        const filter = params[0] as Row;
        if (Number(BigInt(String(filter.fromBlock))) <= 100 && Number(BigInt(String(filter.toBlock))) >= 100) return (rawReceipt([transfer(1)])!.logs as Row[]);
        return [];
      }
      if (method === "eth_getTransactionReceipt") return rawReceipt([transfer(1)]);
      throw new Error(`unexpected read method ${method}`);
    });
    return { rpc, calls };
  };
  it("finds a start block no later than the requested baseline and reads only chain evidence", async () => {
    const f = rpcFixture();
    const result = await readCashFlowEvidence({ wallet, fromAt: 199, rpc: f.rpc, confirmations: 1, raw: { activity: [activity(1, "DEPOSIT", 2)] } });
    expect(result.cashFlowCoverage).toMatchObject({ complete: true, fromBlock: 99, fromAt: 198, toBlock: 101, toAt: 202 });
    expect(result.netExternalUsd).toBe(2);
    expect(f.calls.every(method => ["eth_blockNumber", "eth_getLogs", "eth_getBlockByNumber", "eth_getTransactionReceipt"].includes(method))).toBe(true);
  });
  it("uses an explicit incremental cursor and returns gaps instead of throwing on failed reads", async () => {
    const f = rpcFixture();
    const result = await readCashFlowEvidence({ wallet, fromBlock: 101, fromAt: 198, rpc: f.rpc, confirmations: 1 });
    expect(result.cashFlowCoverage).toMatchObject({ complete: true, fromBlock: 101, toBlock: 101 });
    expect(result.externalFlows).toEqual([]);
    const failed = await readCashFlowEvidence({ wallet, fromBlock: 99, fromAt: 198, rpc: async () => { throw new Error("rpc unavailable"); } });
    expect(failed.cashFlowCoverage.complete).toBe(false);
    expect(failed.externalFlows).toEqual([]);
  });
  it("represents an unchanged confirmed head as a legal incomplete point without reading a future block", async () => {
    const f = rpcFixture();
    const result = await readCashFlowEvidence({ wallet, fromBlock: 103, fromAt: 204, rpc: f.rpc, confirmations: 1 });
    expect(result.cashFlowCoverage).toEqual({ fromBlock: 101, toBlock: 101, fromAt: 202, toAt: 202,
      complete: false, reason: "confirmation_window_empty" });
    expect(result.externalFlows).toEqual([]);
    expect(f.rpc.mock.calls.filter(([method]) => method === "eth_getBlockByNumber").map(([, params]) => params[0])).toEqual(["0x65"]);
    expect(f.calls).not.toContain("eth_getLogs");
  });
  it("caps confirmed funding at the earliest account observation", async () => {
    const f = rpcFixture();
    const result = await readCashFlowEvidence({ wallet, fromBlock: 99, fromAt: 198, rpc: f.rpc, confirmations: 1,
      raw: { checked_at: new Date(202_000).toISOString(), collateral: { checked_at: new Date(201_000).toISOString() },
        activity: [activity(1, "DEPOSIT", 2)] } });
    expect(result.cashFlowCoverage).toMatchObject({ complete: true, toBlock: 100, toAt: 200 });
  });
  it("fetches all pages for the scanned historical window to classify funding missing from recent activity", async () => {
    const f = rpcFixture();
    const getActivity = vi.fn(async (params: Record<string, string>) => params.offset === "0"
      ? [activity(2, "REWARD", 1, { timestamp: 198 }), activity(3, "REWARD", 1, { timestamp: 199 })]
      : [activity(1, "DEPOSIT", 2, { proxyWallet: wallet })]);
    const result = await readCashFlowEvidence({ wallet, fromAt: 198, rpc: f.rpc, confirmations: 1,
      raw: { activity: [] }, getActivity, activityPageSize: 2 });
    expect(result.cashFlowCoverage.complete).toBe(true);
    expect(result.netExternalUsd).toBe(2);
    expect(getActivity.mock.calls.map(([params]) => params)).toEqual(["0", "2"].map(offset => ({
      user: wallet, start: "198", end: "202", limit: "2", offset, sortBy: "TIMESTAMP", sortDirection: "ASC",
    })));
    expect(result.activityWindow).toMatchObject({ complete: true, pages: 2, items: 3 });
  });
  it("does not query activity when chain protocol evidence already explains every transfer", async () => {
    const f = rpcFixture();
    const getActivity = vi.fn(async () => { throw new Error("unneeded request"); });
    const result = await readCashFlowEvidence({ wallet, fromBlock: 101, fromAt: 198, rpc: f.rpc, confirmations: 1, getActivity });
    expect(result.cashFlowCoverage.complete).toBe(true);
    expect(getActivity).not.toHaveBeenCalled();
  });
  it.each([
    ["overlapping pages", async () => [activity(1, "DEPOSIT", 2)], "activity_pagination_overlap"],
    ["wrong account", async () => [activity(1, "DEPOSIT", 2, { proxyWallet: other })], "activity_row_outside_account_or_window"],
    ["wrong time window", async () => [activity(1, "DEPOSIT", 2, { timestamp: 50 })], "activity_row_outside_account_or_window"],
    ["HTTP failure", async () => { throw new Error("http_403"); }, "http_403"],
  ])("keeps %s incomplete without inventing an external flow", async (_label, getActivity, reason) => {
    const f = rpcFixture();
    const result = await readCashFlowEvidence({ wallet, fromAt: 198, rpc: f.rpc, confirmations: 1,
      getActivity: getActivity as () => Promise<unknown>, activityPageSize: 1 });
    expect(result.cashFlowCoverage.complete).toBe(false);
    expect(result.activityWindow).toMatchObject({ complete: false, reason });
    // A successfully matched first page may already prove a flow, but the
    // classifier must never mark the remaining pagination window complete.
    if (reason !== "activity_pagination_overlap") expect(result.externalFlows).toEqual([]);
  });
  it("reports page exhaustion instead of pretending the historical activity window was covered", async () => {
    const f = rpcFixture();
    const result = await readCashFlowEvidence({ wallet, fromAt: 198, rpc: f.rpc, confirmations: 1,
      getActivity: async () => [activity(1, "DEPOSIT", 2)], activityPageSize: 1, activityMaxPages: 1 });
    expect(result.cashFlowCoverage.complete).toBe(false);
    expect(result.activityWindow).toMatchObject({ complete: false, pages: 1, reason: "activity_page_limit" });
    expect(result.netExternalUsd).toBe(2);
  });
});
