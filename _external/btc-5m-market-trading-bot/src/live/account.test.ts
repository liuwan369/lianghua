import { afterEach, describe, expect, it } from "vitest";
import { loadAccountConfig } from "./account.js";

const NAMES = [
  "POLYMARKET_WALLET_ADDRESS",
  "POLY_FUNDER",
  "POLYMARKET_OWNER_PRIVATE_KEY",
  "POLYMARKET_PRIVATE_KEY",
  "POLYMARKET_SESSION_PRIVATE_KEY",
  "RELAYER_API_KEY",
  "RELAYER_API_KEY_ADDRESS",
  "POLY_BUILDER_API_KEY",
  "POLY_BUILDER_SECRET",
  "POLY_BUILDER_PASSPHRASE",
] as const;

const before = new Map(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    const old = before.get(name);
    if (old == null) delete process.env[name];
    else process.env[name] = old;
  }
});

describe("strict account configuration", () => {
  it("does not count placeholders as credentials", () => {
    process.env.POLYMARKET_WALLET_ADDRESS = "<已隐藏>";
    process.env.RELAYER_API_KEY = "真实值";
    const status = loadAccountConfig();
    expect(status.depositWallet).toBeUndefined();
    expect(status.relayerApiKeyPresent).toBe(false);
  });

  it("keeps deposit wallet, owner, session, relayer and builder identities separate", () => {
    process.env.POLYMARKET_WALLET_ADDRESS = "0x0000000000000000000000000000000000000001";
    process.env.POLYMARKET_OWNER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    process.env.POLYMARKET_SESSION_PRIVATE_KEY = `0x${"22".repeat(32)}`;
    process.env.RELAYER_API_KEY = "relayer-key";
    process.env.RELAYER_API_KEY_ADDRESS = "0x0000000000000000000000000000000000000002";
    process.env.POLY_BUILDER_API_KEY = "builder-key";
    process.env.POLY_BUILDER_SECRET = "builder-secret";
    process.env.POLY_BUILDER_PASSPHRASE = "builder-passphrase";
    const status = loadAccountConfig();
    expect(status.depositWallet).toBe("0x0000000000000000000000000000000000000001");
    expect(status.ownerSigner).not.toBe(status.sessionSigner);
    expect(status.relayerApiKeyPresent).toBe(true);
    expect(status.relayerApiKeyAddress).toBe("0x0000000000000000000000000000000000000002");
    expect(status.builderCredentialsPresent).toBe(true);
    expect(status.errors).toEqual([]);
  });

  it("reports malformed explicit fields", () => {
    process.env.POLYMARKET_WALLET_ADDRESS = "0x1234";
    process.env.POLYMARKET_OWNER_PRIVATE_KEY = "not-a-key";
    const status = loadAccountConfig();
    expect(status.errors).toContain("资金钱包地址格式无效");
    expect(status.errors).toContain("Owner 私钥格式无效");
  });

  it("never falls back to a legacy key when the explicit owner field is invalid", () => {
    process.env.POLYMARKET_OWNER_PRIVATE_KEY = "bad-explicit-key";
    process.env.POLYMARKET_PRIVATE_KEY = `0x${"33".repeat(32)}`;
    const status = loadAccountConfig();
    expect(status.ownerPrivateKey).toBeUndefined();
    expect(status.ownerSigner).toBeUndefined();
    expect(status.errors).toContain("Owner 私钥格式无效");
  });
});
