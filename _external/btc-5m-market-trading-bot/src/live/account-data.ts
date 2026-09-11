/** Read-only account data: GET and receipt RPC; no credential creation or order methods. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AccountFinanceReader, balanceOccupancy } from './account-finance.js';
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
  let overlap = false;
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
        else overlap = true;
      }
      result.pages++;
      result.available = true;
      cursor = page.next_cursor;
      if (cursor === endCursor) { result.complete = !overlap; if (overlap) result.error_code = "pagination_overlap"; break; }
    }
    if (!result.complete && !result.error_code) result.error_code = "page_limit";
  } catch { result.error_code = "fetch_or_pagination_failed"; }
  result.checked_at = new Date().toISOString();
  return result;
}

export async function offsetPages(get: Getter, path: string, kind: string, wallet: string, limit = 100, maxOffset = 10000): Promise<Section> {
  const result: Section = { available: false, complete: false, items: [], pages: 0, checked_at: new Date().toISOString(), source: "polymarket-data-api" };
  const seen = new Set<string>();
  const rows = new Set<string>();
  let overlap = false;
  const deadline = Date.now() + 60000;
  try {
    for (let offset = 0; offset <= maxOffset; offset += limit) {
      if (Date.now() >= deadline) throw new Error("pagination_deadline");
      const data = await get(path, { user: wallet, limit: String(limit), offset: String(offset), ...(kind === "positions" ? { sizeThreshold: "0" } : {}) });
      if (!Array.isArray(data)) throw new Error("invalid_page");
      const signature = JSON.stringify(data);
      if (data.length && seen.has(signature)) throw new Error("pagination_loop");
      seen.add(signature);
      for (const row of data) {
        const item = sanitize(row, kind, wallet);
        // Position identity survives price/PnL changes between offset requests.
        // Activity has no stable event index; identical records are ambiguous,
        // so retain one and mark incomplete rather than double-count amounts.
        const identity = kind === "positions" || kind === "closed_positions"
          ? JSON.stringify([item.asset, item.conditionId]) : JSON.stringify(item);
        if (rows.has(identity)) { overlap = true; continue; }
        rows.add(identity);
        result.items.push(item);
      }
      result.available = true;
      result.pages++;
      if (data.length < limit) { result.complete = !overlap; if (overlap) result.error_code = "pagination_overlap"; break; }
    }
    if (!result.complete && !result.error_code) result.error_code = "page_limit";
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

interface ObservedOrder { item?: Row; checked: number; attempted: number; failed: boolean; unavailable?: boolean; }
export interface OrderHistorySection extends Section {
  coverage: "observed_order_ids"; historical_complete: false; persistence: "reader_session" | "account_file";
  known_order_count: number; pending_order_count: number; unavailable_order_count: number; truncated: boolean;
}
/** Account-bound, bounded observations; absence from /data/orders is never a cancellation. */
export class OrderHistoryReader {
  private readonly known = new Map<string, ObservedOrder>();
  private truncated = false;
  private persistenceError = false;
  constructor(private readonly wallet: string, private readonly maxKnown = 2000, private readonly maxQueries = 8, private readonly file?: string) {
    if (!file) return;
    try {
      const raw = readFileSync(file);
      if (raw.length > 8_000_000) throw new Error('oversized_history');
      const saved = JSON.parse(raw.toString('utf8'));
      if (saved.version !== 1 || saved.wallet !== wallet.toLowerCase() || !Array.isArray(saved.entries) || saved.entries.length > maxKnown) throw new Error('invalid_history');
      const entries = new Map<string, ObservedOrder>();
      for (const [id, entry] of saved.entries) {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id) || !entry || !Number.isFinite(entry.checked)) throw new Error('invalid_history');
        entries.set(id, { checked: entry.checked, attempted: 0, failed: true,
          ...(entry.item ? { item: sanitize(entry.item, 'orders', wallet) } : {}) });
      }
      for (const [id, entry] of entries) this.known.set(id, entry);
      this.truncated = saved.truncated === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.persistenceError = true;
    }
  }

  private persist() {
    if (!this.file || this.persistenceError) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, wallet: this.wallet.toLowerCase(), truncated: this.truncated,
        entries: [...this.known] }), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch { this.persistenceError = true; }
  }

  async read(get: Getter, open: Section, trades: Section, now = Date.now()): Promise<OrderHistorySection> {
    const current = new Set<string>();
    const remember = (id: unknown) => {
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(id)) return;
      if (!this.known.has(id)) {
        if (this.known.size >= this.maxKnown) { this.truncated = true; return; }
        this.known.set(id, { checked: 0, attempted: 0, failed: false });
      }
    };
    for (const item of open.items) {
      remember(item.id);
      if (typeof item.id === "string") {
        current.add(item.id);
        const entry = this.known.get(item.id);
        if (entry) { entry.item = item; entry.checked = now; entry.failed = false; entry.unavailable = false; }
      }
    }
    for (const trade of trades.items) {
      // A maker trade's taker order belongs to another account.
      if (trade.trader_side === "TAKER") remember(trade.taker_order_id);
      if (trade.trader_side === "MAKER" && Array.isArray(trade.maker_orders)) {
        for (const maker of trade.maker_orders as Row[]) remember(maker.order_id);
      }
    }
    const terminal = (entry: ObservedOrder) => ["CANCELED", "CANCELLED", "MATCHED", "EXPIRED"].includes(String(entry.item?.status).toUpperCase());
    const due = [...this.known].filter(([id, entry]) => {
      if (current.has(id)) return false;
      const cooldown = entry.failed ? 300_000 : terminal(entry) ? 86_400_000 : 60_000;
      return !entry.attempted || now - entry.attempted >= cooldown;
    }).sort((a, b) => a[1].attempted - b[1].attempted).slice(0, this.maxQueries);
    // At most two waves of four requests (8s HTTP timeout each), preserving
    // the bridge's total 90s budget after the paginated snapshot's 60s budget.
    for (let offset = 0; offset < due.length; offset += 4) {
      await Promise.all(due.slice(offset, offset + 4).map(async ([id, entry]) => {
        entry.attempted = now;
        try {
          const raw = await get(`/data/order/${encodeURIComponent(id)}`) as Row;
          entry.unavailable = raw === null;
          if (entry.unavailable) throw new Error("order_detail_not_returned");
          if (!raw || raw.id !== id || typeof raw.maker_address !== "string" || raw.maker_address.toLowerCase() !== this.wallet.toLowerCase()) throw new Error("order_identity_mismatch");
          const item = sanitize(raw, "orders", this.wallet);
          if (typeof item.status !== "string" || !item.status) throw new Error("invalid_order_status");
          entry.item = { ...item, status_checked_at: new Date(now).toISOString() };
          entry.checked = now;
          entry.failed = false;
        } catch { entry.failed = true; }
      }));
    }
    const stale = (entry: ObservedOrder) => entry.failed || now - entry.checked > (terminal(entry) ? 86_400_000 : 120_000);
    const pending = [...this.known].filter(([id, entry]) => !current.has(id) && (!entry.item || stale(entry))).length;
    const unavailable = [...this.known].filter(([id, entry]) => !current.has(id) && entry.unavailable).length;
    const items = [...this.known].flatMap(([id, entry]) => entry.item && !current.has(id) ? [{ ...entry.item, status_stale: stale(entry) }] : []);
    this.persist();
    return {
      available: open.available || trades.available || items.length > 0, complete: pending === 0 && !this.truncated && !this.persistenceError && open.complete && trades.complete,
      items, pages: due.length, checked_at: new Date(now).toISOString(), source: "clob-v2-order-detail",
      coverage: "observed_order_ids", historical_complete: false, persistence: this.file && !this.persistenceError ? "account_file" : "reader_session",
      known_order_count: this.known.size, pending_order_count: pending, unavailable_order_count: unavailable, truncated: this.truncated,
      ...(this.persistenceError ? { error_code: 'order_history_persistence_failed' } : pending ? { error_code: unavailable ? "order_details_unavailable" : "order_details_pending" } : {}),
    };
  }
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
  const historyReader = new OrderHistoryReader(wallet, 2000, 8,
    join(process.env.PM_ACCOUNT_HISTORY_DIR || 'results/account-history', `${wallet.toLowerCase()}.json`));
  const financeReader = new AccountFinanceReader(wallet);
  const receiptRpc = async (method: string, params: unknown[]) => {
    const response = await fetch(process.env.POLYGON_RPC || 'https://polygon.drpc.org', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('rpc_failed');
    const data = await response.json() as Row;
    if (data.error || data.result == null) throw new Error('rpc_result_invalid');
    return data.result;
  };
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
    const order_history = await historyReader.read(get, open_orders, trades);
    const finance = await financeReader.read(receiptRpc, trades, activity);
    return { schemaVersion: 1, wallet, checked_at: new Date().toISOString(), read_only: true, duration_ms: Date.now()-began, collateral, open_orders, trades, positions, closed_positions, activity, order_history,
      pagination_atomic: false,
      occupancy: balanceOccupancy(collateral, open_orders), ...finance };
  };
}
