/** Read-only account data. Only GET endpoints; no credential creation or order methods. */
import { createL1Headers, createL2Headers, type ApiKeyCreds } from "@polymarket/clob-client-v2";
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { loadAccountConfig } from "./account.js";
import { inspectWalletAddress } from "./clob/wallet.js";

type Row = Record<string, unknown>;
export interface Section { available: boolean; complete: boolean; items: Row[]; pages: number; checked_at: string; error_code?: string; value?: number; source: string }
type Getter = (path: string, params?: Record<string, string>) => Promise<unknown>;
const endCursor = "LTE=";
const scalar = (v: unknown): v is string | number | boolean | null => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const fields: Record<string, string[]> = {
  orders: ["id", "status", "market", "asset_id", "side", "original_size", "size_matched", "price", "outcome", "expiration", "order_type", "created_at"],
  trades: ["id", "taker_order_id", "market", "asset_id", "side", "size", "fee_rate_bps", "price", "status", "match_time", "last_update", "outcome", "transaction_hash", "trader_side"],
  positions: ["asset", "conditionId", "size", "avgPrice", "initialValue", "currentValue", "cashPnl", "percentPnl", "totalBought", "realizedPnl", "percentRealizedPnl", "curPrice", "redeemable", "mergeable", "title", "slug", "eventSlug", "outcome", "outcomeIndex", "oppositeOutcome", "oppositeAsset", "endDate", "negativeRisk"],
  closed_positions: ["asset", "conditionId", "avgPrice", "totalBought", "realizedPnl", "curPrice", "timestamp", "title", "slug", "eventSlug", "outcome", "outcomeIndex", "oppositeOutcome", "oppositeAsset", "endDate"],
  activity: ["timestamp", "conditionId", "type", "size", "usdcSize", "transactionHash", "price", "asset", "side", "outcomeIndex", "title", "slug", "eventSlug", "outcome"],
};
export function sanitize(row: unknown, kind: string, wallet: string): Row {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid_row");
  const input = row as Row;
  // Data API rows explicitly identify the queried account. Reject cross-account data.
  if (input.proxyWallet != null && String(input.proxyWallet).toLowerCase() !== wallet.toLowerCase()) throw new Error("account_mismatch");
  if (kind === "orders" && input.maker_address != null && String(input.maker_address).toLowerCase() !== wallet.toLowerCase()) throw new Error("account_mismatch");
  const output: Row = {};
  for (const key of fields[kind] ?? []) if (scalar(input[key])) output[key] = input[key];
  if (kind === "orders" && Array.isArray(input.associate_trades)) output.associate_trades = input.associate_trades.filter(value => typeof value === "string");
  if (kind === "trades" && Array.isArray(input.maker_orders)) {
    output.maker_orders = input.maker_orders.filter(item => item && typeof item === "object" && String(item.maker_address).toLowerCase() === wallet.toLowerCase()).map(item => {
      const safe: Row = {};
      for (const key of ["order_id", "asset_id", "matched_amount", "price", "fee_rate_bps", "outcome", "side"]) if (scalar(item[key])) safe[key] = item[key];
      return safe;
    });
  }
  return output;
}

export async function cursorPages(get: Getter, path: string, kind: string, wallet: string, maxPages = 100): Promise<Section> {
  const result: Section = { available: false, complete: false, items: [], pages: 0, checked_at: new Date().toISOString(), source: "clob-v2" };
  let cursor = "MA==";
  const seen = new Set<string>();
  const ids = new Set<string>();
  const deadline = Date.now() + 60000;
  try {
    while (result.pages < maxPages) {
      if (Date.now() >= deadline) throw new Error("pagination_deadline");
      if (seen.has(cursor)) throw new Error("pagination_loop");
      seen.add(cursor);
      const page = await get(path, { next_cursor: cursor }) as Row;
      if (!page || !Array.isArray(page.data) || typeof page.next_cursor !== "string") throw new Error("invalid_page");
      for (const row of page.data) {
        const item = sanitize(row, kind, wallet);
        if (typeof item.id !== "string" || !item.id) throw new Error("invalid_id");
        if (!ids.has(item.id)) { ids.add(item.id); result.items.push(item); }
      }
      result.pages++;
      result.available = true;
      cursor = page.next_cursor;
      if (cursor === endCursor) { result.complete = true; break; }
    }
    if (!result.complete) result.error_code = "page_limit";
  } catch { result.error_code = "fetch_or_pagination_failed"; }
  result.checked_at = new Date().toISOString();
  return result;
}

export async function offsetPages(get: Getter, path: string, kind: string, wallet: string, limit = 100, maxOffset = 10000): Promise<Section> {
  const result: Section = { available: false, complete: false, items: [], pages: 0, checked_at: new Date().toISOString(), source: "polymarket-data-api" };
  const seen = new Set<string>();
  const deadline = Date.now() + 60000;
  try {
    for (let offset = 0; offset <= maxOffset; offset += limit) {
      if (Date.now() >= deadline) throw new Error("pagination_deadline");
      const data = await get(path, { user: wallet, limit: String(limit), offset: String(offset), ...(kind === "positions" ? { sizeThreshold: "0" } : {}) });
      if (!Array.isArray(data)) throw new Error("invalid_page");
      const signature = JSON.stringify(data);
      if (data.length && seen.has(signature)) throw new Error("pagination_loop");
      seen.add(signature);
      result.items.push(...data.map(row => sanitize(row, kind, wallet)));
      result.available = true;
      result.pages++;
      if (data.length < limit) { result.complete = true; break; }
    }
    if (!result.complete) result.error_code = "page_limit";
  } catch { result.error_code = "fetch_or_pagination_failed"; }
  result.checked_at = new Date().toISOString();
  return result;
}

async function getJson(host: string, path: string, params: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(path, host);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("http_failed");
  return response.json();
}

export async function connectAccountReader() {
  const config = loadAccountConfig();
  if (!config.depositWallet || !config.ownerPrivateKey || config.errors.length) throw new Error("invalid_account");
  const wallet = config.depositWallet;
  const account = privateKeyToAccount(config.ownerPrivateKey);
  const inspected = await inspectWalletAddress(wallet);
  const matches = inspected.walletKind === "EOA" ? account.address.toLowerCase() === wallet.toLowerCase() : inspected.walletKind === "DEPOSIT_WALLET" && inspected.owner?.toLowerCase() === account.address.toLowerCase();
  if (!matches) throw new Error("account_mismatch");
  const signatureType = inspected.walletKind === "EOA" ? 0 : 3;
  const signer = createWalletClient({ account, chain: polygon, transport: http(process.env.POLYGON_RPC) }) as WalletClient;
  const host = process.env.CLOB_HOST ?? "https://clob.polymarket.com";
  const version = await getJson(host, "/version") as Row;
  if (version?.version !== 2) throw new Error("unsupported_protocol");
  // GET derives already-existing credentials; never call createOrDeriveApiKey.
  const l1 = await createL1Headers(signer, polygon.id);
  const raw = await getJson(host, "/auth/derive-api-key", {}, l1 as unknown as Record<string, string>) as Row;
  if (![raw?.apiKey, raw?.secret, raw?.passphrase].every(v => typeof v === "string" && v.length > 0)) throw new Error("existing_credentials_unavailable");
  const creds: ApiKeyCreds = { key: raw.apiKey as string, secret: raw.secret as string, passphrase: raw.passphrase as string };
  const get: Getter = async (path, params = {}) => {
    const headers = await createL2Headers(signer, creds, { method: "GET", requestPath: path });
    return getJson(host, path, params, headers as unknown as Record<string, string>);
  };
  const publicGet: Getter = (path, params) => getJson("https://data-api.polymarket.com", path, params);
  return async () => {
    const began = Date.now();
    const balance = (async (): Promise<Section> => {
      const output: Section = { source: "clob-v2", available: false, complete: false, items: [], pages: 0, checked_at: new Date().toISOString() };
      try {
        const data = await get("/balance-allowance", { asset_type: "COLLATERAL", signature_type: String(signatureType) }) as Row;
        if (typeof data?.balance !== "string" || !/^\d+$/.test(data.balance)) throw new Error("invalid_balance");
        const value = Number(data.balance) / 1e6;
        if (!Number.isFinite(value)) throw new Error("invalid_balance");
        return { ...output, available: true, complete: true, value, pages: 1, checked_at: new Date().toISOString() };
      } catch { return { ...output, error_code: "balance_fetch_failed" }; }
    })();
    const [collateral, open_orders, trades, positions, closed_positions, activity] = await Promise.all([
      balance, cursorPages(get, "/data/orders", "orders", wallet), cursorPages(get, "/data/trades", "trades", wallet),
      offsetPages(publicGet, "/positions", "positions", wallet), offsetPages(publicGet, "/closed-positions", "closed_positions", wallet, 50), offsetPages(publicGet, "/activity", "activity", wallet),
    ]);
    return { schemaVersion: 1, wallet, checked_at: new Date().toISOString(), read_only: true, duration_ms: Date.now()-began, collateral, open_orders, trades, positions, closed_positions, activity,
      pagination_atomic: false,
      fees: { available: false, reason: "成交费率不是实际扣费到账凭证" }, rewards: { available: false, reason: "尚无奖励到账凭证来源" } };
  };
}
