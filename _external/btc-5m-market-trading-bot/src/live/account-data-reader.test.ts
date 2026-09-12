import { afterEach, describe, expect, it, vi } from "vitest";
const wallet = "0x1111111111111111111111111111111111111111";
vi.mock("./account.js", () => ({ loadAccountConfig: () => ({ depositWallet: wallet, ownerPrivateKey: "0x"+"1".repeat(64), errors: [] }) }));
vi.mock("viem/accounts", () => ({ privateKeyToAccount: () => ({ address: wallet }) }));
vi.mock("./clob/wallet.js", () => ({ inspectWalletAddress: async () => ({ walletKind: "EOA" }) }));
vi.mock("@polymarket/clob-client-v2", () => ({ createL1Headers: async () => ({ POLY_SIGNATURE: "secret-signature" }), createL2Headers: async () => ({ POLY_API_KEY: "secret-key" }) }));
import { connectAccountReader } from "./account-data.js";

afterEach(() => vi.unstubAllGlobals());
describe("authenticated account reader", () => {
  it("only derives existing credentials and uses GET for all wallet data", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      const url = new URL(input); calls.push(url);
      expect(options.method).toBe("GET");
      const payload = url.pathname === "/version" ? { version: 2 }
        : url.pathname === "/auth/derive-api-key" ? { apiKey: "secret-key", secret: "secret", passphrase: "passphrase" }
        : url.pathname === "/balance-allowance" ? { balance: "108728676", allowances: { contract: "9999" } }
        : ["/data/orders", "/data/trades"].includes(url.pathname) ? { data: [], next_cursor: "LTE=" } : [];
      return { ok: true, json: async () => payload };
    }));
    const read = await connectAccountReader();
    const result = await read();
    expect(result.collateral.value).toBe(108.728676);
    expect(result.open_orders.complete).toBe(true);
    expect(result.positions.complete).toBe(true);
    expect(result.occupancy).toMatchObject({ complete: false, spendable_balance: null,
      observed: { position_cost_usd: 0, capital_occupied_estimate_usd: 0 } });
    expect(result.risk_contract).toMatchObject({ capital_limit_usd: 50, daily_loss_limit_usd: 30,
      read_only: true, execution_ready: false });
    expect(result.fees.available).toBe(false);
    expect(result.rewards.available).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/secret|passphrase|allowances/);
    await read();
    expect(calls.filter(url => url.pathname === "/auth/derive-api-key")).toHaveLength(1);
    for (const url of calls.filter(url => url.hostname === "data-api.polymarket.com")) expect(url.searchParams.get("user")).toBe(wallet);
    expect(calls.some(url => /update|create|cancel|heartbeat/.test(url.pathname))).toBe(false);
  });
  it("rejects unsupported protocol without requesting credentials", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ version: 3 }) }));
    vi.stubGlobal("fetch", fetcher);
    await expect(connectAccountReader()).rejects.toThrow("unsupported_protocol");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['9007199254740993', '-1', 'invalid', null])('keeps malformed or imprecise collateral %s unknown', async balance => {
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input);
      const payload = url.pathname === '/version' ? { version: 2 }
        : url.pathname === '/auth/derive-api-key' ? { apiKey: 'test-key', secret: 'test-secret', passphrase: 'test-passphrase' }
        : url.pathname === '/balance-allowance' ? { balance }
        : ['/data/orders', '/data/trades'].includes(url.pathname) ? { data: [], next_cursor: 'LTE=' } : [];
      return { ok: true, json: async () => payload };
    }));
    const result = await (await connectAccountReader())();
    expect(result.collateral).toMatchObject({ available: false, complete: false, error_code: 'balance_fetch_failed' });
    expect(result.collateral.value).toBeUndefined();
    expect(result.occupancy).toMatchObject({ available: false, spendable_balance: null,
      balance_after_open_buy_notional: null, observed: { collateral_balance_usd: null, estimate_inputs_complete: false } });
  });
});
