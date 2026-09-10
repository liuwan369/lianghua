import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, production } from "@polymarket/client";
import { checkPublicAccount } from "./account.js";
import { CTF, CTF_EXCHANGE, PUSD } from "./contracts.js";

const mocks = vi.hoisted(() => ({ approvals: vi.fn(), inspect: vi.fn() }));
vi.mock("@polymarket/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@polymarket/client")>(),
  createPublicClient: vi.fn(() => ({ fetchTradingApprovalsState: mocks.approvals })),
}));
vi.mock("./clob/wallet.js", () => ({ inspectWalletAddress: mocks.inspect }));

beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok: true, json: async () => ({version: 2})})));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("account approvals RPC", () => {
  it("uses the configured RPC and production contracts across provider retries", async () => {
    const wallet = "0x0000000000000000000000000000000000000001";
    mocks.inspect.mockResolvedValue({ walletKind: "EOA" });
    mocks.approvals.mockResolvedValue({ isFullyApproved: false, missing: { erc20: [{tokenAddress: PUSD, spenderAddress: CTF_EXCHANGE, amount: 1n}], erc1155: [] } });
    for (const rpc of ["https://primary.invalid", "https://fallback.invalid"]) {
      vi.stubEnv("POLYGON_RPC", rpc);
      const result = await checkPublicAccount(wallet);
      const options = vi.mocked(createPublicClient).mock.calls.at(-1)?.[0];
      expect(options?.environment).toMatchObject({ rpc });
      // EnvironmentConfig intentionally hides SDK internals in its public type;
      // compare all runtime defaults so contracts/endpoints cannot drift.
      const configuredDefaults = { ...options?.environment } as Record<string, unknown>;
      const productionDefaults = { ...production } as Record<string, unknown>;
      for (const key of ["name", "rpc"]) {
        delete configuredDefaults[key];
        delete productionDefaults[key];
      }
      expect(configuredDefaults).toEqual(productionDefaults);
      expect(options?.environment?.chainId).toBe(production.chainId);
      expect(result.approvalsFullyReady).toBe(false);
      expect(result.missingErc20Approvals).toBe(1);
    }
    expect(mocks.approvals).toHaveBeenLastCalledWith({ user: wallet });
  });

  it("never puts credential-bearing provider errors in the account report", async () => {
    mocks.inspect.mockResolvedValue({ walletKind: "EOA" });
    mocks.approvals.mockRejectedValue(new Error("https://rpc.invalid/private-api-key"));
    const result = await checkPublicAccount("0x0000000000000000000000000000000000000001");
    expect(result.approvalsFullyReady).toBeNull();
    expect(result.approvalsError).toContain("Polygon RPC");
    expect(JSON.stringify(result)).not.toContain("private-api-key");
  });

  it("does not demand unrelated Perps and protocol V3 approvals for V2 trading", async () => {
    mocks.inspect.mockResolvedValue({walletKind: "DEPOSIT_WALLET"});
    mocks.approvals.mockResolvedValue({isFullyApproved: false, missing: {
      erc20: [{tokenAddress: PUSD, spenderAddress: "0xDCa4af75705dbB50f62437045afF9921947917d2", amount: 1n}],
      erc1155: ["0x1000008dD9001B968442c1000017eaE6E0dA00Ba", "0x200000900045e3B6259600682756002200028933"]
        .map(operatorAddress => ({tokenAddress: CTF, operatorAddress})),
    }});
    const report = await checkPublicAccount("0x0000000000000000000000000000000000000001");
    expect(report).toMatchObject({approvalsFullyReady: true, missingErc20Approvals: 0, missingErc1155Approvals: 0, otherApprovalsMissing: 3});
  });

  it("still blocks missing V2 position operator approval", async () => {
    mocks.inspect.mockResolvedValue({walletKind: "EOA"});
    mocks.approvals.mockResolvedValue({isFullyApproved: false, missing: {
      erc20: [], erc1155: [{tokenAddress: CTF, operatorAddress: CTF_EXCHANGE}],
    }});
    expect(await checkPublicAccount("0x0000000000000000000000000000000000000001"))
      .toMatchObject({approvalsFullyReady: false, missingErc1155Approvals: 1});
  });

  it("fails closed on an unknown platform protocol", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok: true, json: async () => ({version: 3})}));
    mocks.inspect.mockResolvedValue({walletKind: "EOA"});
    expect((await checkPublicAccount("0x0000000000000000000000000000000000000001")).approvalsFullyReady).toBeNull();
    expect(mocks.approvals).not.toHaveBeenCalled();
  });

  it("does not silently discard malformed approval rows", async () => {
    mocks.inspect.mockResolvedValue({walletKind: "EOA"});
    mocks.approvals.mockResolvedValue({isFullyApproved: false, missing: {erc20: [1], erc1155: []}});
    expect((await checkPublicAccount("0x0000000000000000000000000000000000000001")).approvalsFullyReady).toBeNull();
  });
});
