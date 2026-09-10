import {afterEach, describe, expect, it, vi} from "vitest";
const mocks = vi.hoisted(() => ({resolve: vi.fn(), write: vi.fn(), read: vi.fn()}));
vi.mock("viem", async original => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: vi.fn(() => ({readContract: mocks.read})),
  createWalletClient: vi.fn(() => ({writeContract: mocks.write})),
}));
vi.mock("./clob/wallet.js", async original => ({
  ...await original<typeof import("./clob/wallet.js")>(), resolveWallet: mocks.resolve,
}));
import {approve, settle, wrap} from "./onchain.js";

afterEach(() => {vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks();});
describe("legacy EOA approval command", () => {
  it.each([0, 1, 2, 3])("cannot approve a different funder from its owner (type %s)", async signatureType => {
    vi.stubEnv("POLYMARKET_OWNER_PRIVATE_KEY", `0x${"11".repeat(32)}`);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.resolve.mockResolvedValue({signatureType, funder: "0x0000000000000000000000000000000000000001"});
    await expect(approve(true)).rejects.toThrow("仅支持普通 EOA 钱包");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("cannot redeem Deposit Wallet positions from the owner EOA", async () => {
    vi.stubEnv("POLYMARKET_OWNER_PRIVATE_KEY", `0x${"11".repeat(32)}`);
    mocks.resolve.mockResolvedValue({signatureType: 3, funder: "0x0000000000000000000000000000000000000001"});
    await expect(settle([`0x${"22".repeat(32)}`], undefined, true)).rejects.toThrow("平台资金钱包的持仓");
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("deduplicates settlement conditions", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const condition = `0x${"22".repeat(32)}`;
    await settle([condition, condition], undefined, false);
    expect(log.mock.calls.filter(([line]) => String(line).startsWith("condition "))).toHaveLength(1);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -Infinity, 0, -1])("rejects an invalid wrap amount %s without network or signing", async amount => {
    await expect(wrap(amount, true)).rejects.toThrow("amount must be finite");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
