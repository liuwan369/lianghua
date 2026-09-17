import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { createLiveSettlementAdapter, RetryableSettlement, UnsupportedSettlement, type LiveSettlementBackend, type LiveSettlementState, type SettlementReceipt } from "./live-settlement.js";

const wallet = `0x${"1".repeat(40)}` as const;
const marketId = `0x${"2".repeat(64)}`;
const hash = `0x${"3".repeat(64)}` as Hex;
const request = { marketId, tokenIds: ["111", "222"] };
function fixture() {
  let saved: LiveSettlementState | undefined;
  const backend: LiveSettlementBackend = {
    wallet,
    market: vi.fn(async () => ({ tokenIds: request.tokenIds, denominator: 1n, numerators: [1n, 0n], negRisk: false })),
    balances: vi.fn(async (_ids, block) => block === undefined
      ? { balances: [5_000_000n, 3_000_000n], cash: 10_000_000n, block: 100n }
      : { balances: [0n, 0n], cash: 15_000_000n, block }),
    approved: vi.fn(async () => true),
    prepare: vi.fn(async () => ({ kind: "eoa" as const, rawTransaction: "0x1234" as Hex, transactionHash: hash })),
    submit: vi.fn(async () => ({ transactionHash: hash })),
    receipt: vi.fn(async (): Promise<SettlementReceipt | undefined> => ({ transactionHash: hash, status: "success", block: 101n, creditedPusd: 5_000_000n })),
  };
  const persist = vi.fn((state: LiveSettlementState) => { saved = structuredClone(state); });
  const options = { backend, restore: { schemaVersion: 1 as const, wallet, records: {} }, persist };
  return { backend, options, persist, state: () => saved! };
}

describe("live settlement adapter", () => {
  it("persists the signed request before submission and confirms only a receipt with exact holdings/cash proof", async () => {
    const f = fixture();
    vi.mocked(f.backend.submit).mockImplementation(async () => {
      expect(f.state().records[marketId]?.status).toBe("prepared");
      return { transactionHash: hash };
    });
    const settle = await createLiveSettlementAdapter(f.options);
    expect(await settle(request)).toMatchObject({ state: "pending", payoutVerified: false });
    expect(await settle(request)).toMatchObject({ state: "confirmed", payoutVerified: true,
      creditedUsd: 5, expectedPayoutUsd: 5, cashBeforeUsd: 10, cashAfterUsd: 15 });
    expect((await settle(request)).state).toBe("confirmed");
    expect(f.backend.submit).toHaveBeenCalledTimes(1);
    expect(f.state().records[marketId]).toMatchObject({ creditedPusd: "5000000", cashBefore: "10000000", cashAfter: "15000000", status: "confirmed" });
  });
  it("never invents a payout when a market has no remaining holdings", async () => {
    const f = fixture();
    vi.mocked(f.backend.balances).mockResolvedValue({ balances: [0n, 0n], cash: 10_000_000n, block: 100n });
    const settle = await createLiveSettlementAdapter(f.options);
    const result = await settle(request);
    expect(result).toMatchObject({ state: "confirmed", payoutVerified: false });
    expect(result.creditedUsd).toBeUndefined();
    expect(f.backend.submit).not.toHaveBeenCalled();
  });
  it("keeps verified receipt credit distinct from concurrent wallet balance changes after restart", async () => {
    const f = fixture();
    vi.mocked(f.backend.balances).mockImplementation(async (_ids, block) => block === undefined
      ? { balances: [5_000_000n, 3_000_000n], cash: 10_000_000n, block: 100n }
      : { balances: [0n, 0n], cash: 25_000_000n, block });
    const settle = await createLiveSettlementAdapter(f.options);
    await settle(request);
    await settle(request);
    const restored = await createLiveSettlementAdapter({ ...f.options, restore: f.state() });
    expect(await restored(request)).toMatchObject({ state: "confirmed", payoutVerified: true,
      creditedUsd: 5, cashBeforeUsd: 10, cashAfterUsd: 25 });
  });
  it("polls an unmined transaction repeatedly without resubmission, including after restart", async () => {
    const f = fixture();
    vi.mocked(f.backend.receipt).mockResolvedValue(undefined);
    const first = await createLiveSettlementAdapter(f.options);
    await first(request);
    const restarted = await createLiveSettlementAdapter({ ...f.options, restore: f.state() });
    expect((await restarted(request)).state).toBe("pending");
    expect((await restarted(request)).state).toBe("pending");
    expect(f.backend.submit).toHaveBeenCalledTimes(1);
  });
  it("retains unknown submission for receipt recovery without sending another economic request", async () => {
    const f = fixture();
    vi.mocked(f.backend.submit).mockRejectedValue(new Error("network dropped after POST"));
    const settle = await createLiveSettlementAdapter(f.options);
    expect((await settle(request)).state).toBe("pending");
    expect(f.state().records[marketId]?.reason).toBe("settlement_submit_result_unknown");
    const restarted = await createLiveSettlementAdapter({ ...f.options, restore: f.state() });
    expect((await restarted(request)).state).toBe("confirmed");
    expect(f.backend.submit).toHaveBeenCalledTimes(1);
  });
  it("recovers a crash between signed-intent persistence and broadcast by replaying exactly the saved request", async () => {
    const f = fixture();
    const first = await createLiveSettlementAdapter(f.options);
    await first(request);
    const crashed = f.state();
    crashed.records[marketId]!.status = "prepared";
    delete crashed.records[marketId]!.lastSubmittedAt;
    vi.mocked(f.backend.receipt).mockResolvedValueOnce(undefined);
    const resumed = await createLiveSettlementAdapter({ ...f.options, restore: crashed });
    expect((await resumed(request)).state).toBe("pending");
    expect(f.backend.submit).toHaveBeenNthCalledWith(2, crashed.records[marketId]!.prepared);
    expect(f.backend.prepare).toHaveBeenCalledTimes(1);
    expect((await resumed(request)).state).toBe("confirmed");
  });
  it("queries the original request before a bounded retry after a lost ACK", async () => {
    const f = fixture();
    vi.mocked(f.backend.submit).mockRejectedValueOnce(new Error("lost ACK"));
    vi.mocked(f.backend.receipt).mockResolvedValue(undefined);
    const first = await createLiveSettlementAdapter(f.options);
    await first(request);
    const restored = f.state();
    restored.records[marketId]!.lastSubmittedAt = Date.now() - 31_000;
    const resumed = await createLiveSettlementAdapter({ ...f.options, restore: restored });
    await resumed(request);
    expect(f.backend.receipt).toHaveBeenCalledTimes(1);
    expect(f.backend.submit).toHaveBeenCalledTimes(2);
    expect(f.backend.prepare).toHaveBeenCalledTimes(1);
    await resumed(request);
    expect(f.backend.submit).toHaveBeenCalledTimes(2);
  });
  it("clears an unconfirmed deposit batch only after the chain proves its deadline expired", async () => {
    const f = fixture();
    f.backend.expired = vi.fn(async () => true);
    vi.mocked(f.backend.receipt).mockResolvedValue(undefined);
    const settle = await createLiveSettlementAdapter(f.options);
    await settle(request);
    expect((await settle(request)).reason).toContain("已过期");
    expect(f.state().records[marketId]).toBeUndefined();
    expect(f.backend.submit).toHaveBeenCalledTimes(1);
    await settle(request);
    expect(f.backend.prepare).toHaveBeenCalledTimes(2);
  });
  it("does not call prepare or submit before the oracle resolves", async () => {
    const f = fixture();
    vi.mocked(f.backend.market).mockResolvedValue({ tokenIds: request.tokenIds, denominator: 0n, numerators: [0n, 0n], negRisk: false });
    const settle = await createLiveSettlementAdapter(f.options);
    expect((await settle(request)).state).toBe("pending");
    expect(f.backend.submit).not.toHaveBeenCalled();
  });
  it("persists relayer terminal failure and does not block settlement of the next market", async () => {
    const f = fixture();
    vi.mocked(f.backend.receipt).mockRejectedValue(new UnsupportedSettlement("settlement_relayer_state_failed"));
    const settle = await createLiveSettlementAdapter(f.options);
    await settle(request);
    expect((await settle(request)).state).toBe("unsupported");
    expect(f.state().records[marketId]?.status).toBe("failed");
    const resumed = await createLiveSettlementAdapter({ ...f.options, restore: f.state() });
    expect((await resumed(request)).state).toBe("unsupported");
    expect((await resumed({ ...request, marketId: `0x${"4".repeat(64)}` })).state).toBe("pending");
    expect(f.backend.submit).toHaveBeenCalledTimes(2);
  });
  it("retries a definite relayer busy/rate-limit rejection without permanently stranding that market", async () => {
    const f = fixture();
    vi.mocked(f.backend.submit).mockRejectedValueOnce(new RetryableSettlement("rate limited"));
    const settle = await createLiveSettlementAdapter(f.options);
    expect((await settle(request)).state).toBe("pending");
    expect(f.state().records[marketId]).toBeUndefined();
    expect((await settle(request)).state).toBe("pending");
    expect(f.backend.submit).toHaveBeenCalledTimes(2);
    expect((await settle(request)).state).toBe("confirmed");
  });
  it.each(["revert", "insufficient_payout", "remaining_balance"])("does not report success on %s", async failure => {
    const f = fixture();
    if (failure === "revert") vi.mocked(f.backend.receipt).mockResolvedValue({ transactionHash: hash, status: "reverted", block: 101n, creditedPusd: 0n });
    if (failure === "insufficient_payout") vi.mocked(f.backend.receipt).mockResolvedValue({ transactionHash: hash, status: "success", block: 101n, creditedPusd: 4_999_999n });
    if (failure === "remaining_balance") vi.mocked(f.backend.balances).mockResolvedValue({ balances: [5_000_000n, 0n], cash: 15_000_000n, block: 101n });
    const settle = await createLiveSettlementAdapter(f.options);
    await settle(request);
    expect((await settle(request)).state).toBe("unsupported");
    expect((await settle(request)).state).toBe("unsupported");
    expect(f.backend.submit).toHaveBeenCalledTimes(1);
  });
  it("confirms loser tokens burned with a real zero-return receipt", async () => {
    const f = fixture();
    vi.mocked(f.backend.balances).mockImplementation(async (_ids, block) => ({ balances: block === undefined ? [0n, 3_000_000n] : [0n, 0n], cash: 10_000_000n, block: block ?? 100n }));
    vi.mocked(f.backend.receipt).mockResolvedValue({ transactionHash: hash, status: "success", block: 101n, creditedPusd: 0n });
    const settle = await createLiveSettlementAdapter(f.options);
    await settle(request);
    expect(await settle(request)).toMatchObject({ state: "confirmed", payoutVerified: true, creditedUsd: 0 });
    expect(f.state().records[marketId]?.creditedPusd).toBe("0");
  });
  it("confirms approval before preparing the redemption", async () => {
    const f = fixture();
    vi.mocked(f.backend.approved).mockResolvedValueOnce(false).mockResolvedValue(true);
    const settle = await createLiveSettlementAdapter(f.options);
    expect((await settle(request)).state).toBe("pending");
    expect(f.state().records[marketId]?.operation).toBe("approval");
    expect((await settle(request)).state).toBe("pending");
    expect(f.state().records[marketId]?.operation).toBe("redeem");
    expect((await settle(request)).state).toBe("confirmed");
    expect(f.backend.submit).toHaveBeenCalledTimes(2);
  });
  it("serializes parallel calls and waits before sending a different market with the same wallet nonce", async () => {
    const f = fixture();
    vi.mocked(f.backend.receipt).mockResolvedValue(undefined);
    const settle = await createLiveSettlementAdapter(f.options);
    await Promise.all([settle(request), settle(request), settle({ ...request, marketId: `0x${"4".repeat(64)}` })]);
    expect(f.backend.submit).toHaveBeenCalledTimes(1);
  });
  it("does not strand an unsent intent after a persistence failure", async () => {
    const f = fixture();
    f.persist.mockImplementationOnce(() => { throw new Error("disk failure"); });
    const settle = await createLiveSettlementAdapter(f.options);
    expect((await settle(request)).state).toBe("pending");
    expect(f.backend.submit).not.toHaveBeenCalled();
    expect((await settle(request)).state).toBe("pending");
    expect(f.backend.submit).toHaveBeenCalledTimes(1);
  });
  it("returns a concrete unsupported reason for neg-risk and rejects cross-wallet restore", async () => {
    const f = fixture();
    vi.mocked(f.backend.market).mockResolvedValue({ tokenIds: request.tokenIds, denominator: 1n, numerators: [1n, 0n], negRisk: true });
    const settle = await createLiveSettlementAdapter(f.options);
    expect(await settle(request)).toMatchObject({ state: "unsupported", reason: "neg_risk_redemption_not_supported_by_this_sender" });
    expect(f.backend.submit).not.toHaveBeenCalled();
    await expect(createLiveSettlementAdapter({ ...f.options, restore: { ...f.options.restore, wallet: `0x${"5".repeat(40)}` } })).rejects.toThrow("wallet/schema");
  });
});
