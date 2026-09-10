import { SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envWalletOverrides, signatureTypeLabel } from "./wallet.js";

afterEach(() => vi.unstubAllEnvs());

describe("configured trading wallet", () => {
  it("uses the saved canonical wallet rather than a stale legacy funder", () => {
    vi.stubEnv("POLYMARKET_WALLET_ADDRESS", "0x0000000000000000000000000000000000000001");
    vi.stubEnv("POLY_FUNDER", "0x0000000000000000000000000000000000000002");
    expect(envWalletOverrides().funder).toBe("0x0000000000000000000000000000000000000001");
  });
  it("rejects a malformed configured wallet instead of selecting another account", () => {
    vi.stubEnv("POLYMARKET_WALLET_ADDRESS", "0xbroken");
    expect(() => envWalletOverrides()).toThrow(/address is invalid/);
  });
});

describe("signatureTypeLabel", () => {
  it("maps known types", () => {
    expect(signatureTypeLabel(SignatureTypeV2.EOA)).toContain("EOA");
    expect(signatureTypeLabel(SignatureTypeV2.POLY_GNOSIS_SAFE)).toContain("GNOSIS");
    expect(signatureTypeLabel(SignatureTypeV2.POLY_1271)).toContain("1271");
  });
});
