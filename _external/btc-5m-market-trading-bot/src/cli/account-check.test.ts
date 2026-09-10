import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), preflight: vi.fn() }));
vi.mock("../live/account.js", () => ({ loadAccountConfig: mocks.load }));
vi.mock("../live/onchain.js", () => ({ preflightReport: mocks.preflight }));
const previousExitCode = process.exitCode;

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); process.exitCode = 0; });
afterEach(() => { process.exitCode = previousExitCode; vi.restoreAllMocks(); });

describe("account-check machine readable failures", () => {
  it("identifies invalid local configuration without calling RPC", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.load.mockReturnValue({ errors: [] });
    await import("./account-check.js");
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ error_code: "invalid_account_config" });
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("distinguishes RPC failures and suppresses raw exception secrets", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.load.mockReturnValue({ depositWallet: "0x0000000000000000000000000000000000000001", errors: [] });
    mocks.preflight.mockRejectedValue(new Error("provider URL contains secret-api-token"));
    await import("./account-check.js");
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ error_code: "account_rpc_failed" });
    expect(log.mock.calls[0][0]).not.toContain("secret-api-token");
    expect(process.exitCode).toBe(1);
  });

  it("retains successful incomplete account checks without classifying them as RPC errors", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.load.mockReturnValue({ depositWallet: "0x0000000000000000000000000000000000000001", errors: [] });
    mocks.preflight.mockResolvedValue({ collateralWallet: "0x0000000000000000000000000000000000000001", signatureType: 0,
      ownerSignerPresent: false, ownerMatchesSigner: false, pusdOnChain: 0, polGas: 0,
      approvalsFullyReady: false, missingErc20Approvals: 1, missingErc1155Approvals: 1, ready: false });
    await import("./account-check.js");
    const payload = JSON.parse(log.mock.calls[0][0]);
    expect(payload).toMatchObject({ account_ready: false, approvals_ready: false, balance: 0, read_only: true });
    expect(payload.error_code).toBeUndefined();
    expect(payload.checks).toHaveLength(6);
    expect(process.exitCode).toBe(0);
  });
});
