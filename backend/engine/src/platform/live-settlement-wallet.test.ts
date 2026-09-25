import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createLiveSettlementAdapter } from "./live-settlement.js";

test("settlement adapter uses the Gamma-resolved funder when no explicit funder is configured", async t => {
  const envNames = ["POLYGON_RPC", "POLYMARKET_OWNER_PRIVATE_KEY", "POLYMARKET_PRIVATE_KEY",
    "POLYMARKET_WALLET_ADDRESS", "POLY_FUNDER", "POLY_BUILDER_API_KEY", "POLY_BUILDER_SECRET",
    "POLY_BUILDER_PASSPHRASE", "POLY_SIGNATURE_TYPE"] as const;
  const previous = new Map(envNames.map(name => [name, process.env[name]]));
  t.after(() => {
    mock.restoreAll();
    for (const name of envNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const ownerKey = generatePrivateKey();
  const signer = privateKeyToAccount(ownerKey).address;
  const proxyWallet = "0x1111111111111111111111111111111111111111" as const;
  process.env.POLYGON_RPC = "http://127.0.0.1:8545";
  process.env.POLYMARKET_OWNER_PRIVATE_KEY = ownerKey;
  delete process.env.POLYMARKET_PRIVATE_KEY;
  delete process.env.POLYMARKET_WALLET_ADDRESS;
  delete process.env.POLY_FUNDER;
  delete process.env.POLY_SIGNATURE_TYPE;
  process.env.POLY_BUILDER_API_KEY = "test-only";
  process.env.POLY_BUILDER_SECRET = "test-only";
  process.env.POLY_BUILDER_PASSPHRASE = "test-only";

  let gammaLookups = 0;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://gamma-api.polymarket.com/public-profile?")) {
      gammaLookups += 1;
      return Response.json({ proxyWallet });
    }

    const body = typeof init?.body === "string" ? init.body
      : input instanceof Request ? await input.clone().text() : "";
    const request = JSON.parse(body) as { id?: number; method?: string; params?: Array<Record<string, string>> };
    let result: string;
    if (request.method === "eth_getCode") {
      result = "0x60006000";
    } else if (request.method === "eth_call") {
      const data = request.params?.[0]?.data ?? "";
      result = data.startsWith("0xa0e67e2b")
        ? "0x"
        : `0x${signer.slice(2).toLowerCase().padStart(64, "0")}`;
    } else {
      throw new Error(`unexpected read-only RPC method: ${request.method ?? "unknown"}`);
    }
    return Response.json({ jsonrpc: "2.0", id: request.id ?? 1, result });
  });

  const settlement = await createLiveSettlementAdapter({
    restore: { schemaVersion: 1, wallet: proxyWallet, records: {} },
    persist: () => {},
  });
  assert.equal(typeof settlement, "function");
  assert.equal(gammaLookups, 1, "settlement shares CLOB's default Gamma funder resolution");
});
