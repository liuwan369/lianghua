/** Confirmed external funding for the pUSD ledger; never infer deposits from a balance change. */
import { receiptEvidence, scanConfirmedTransfers } from "../live/account-finance.js";
import { COLLATERAL_OFFRAMP, COLLATERAL_ONRAMP, CTF, CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE, PUSD, USDC_E } from "../live/contracts.js";
import type { CashFlowCoverage, ExternalCashFlow } from "./contracts.js";
import { COLLATERAL_ADAPTER, NEG_RISK_COLLATERAL_ADAPTER } from "./settlement.js";

type Row = Record<string, unknown>;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type Kind = "deposit" | "withdrawal" | "trade" | "redemption" | "reward" | "conversion" | "self";
export interface ClassifiedCashTransfer {
  id: string; transactionHash: string; token: string; block: number; at: number;
  from: string; to: string; amountUsd: number; netAmountUsd: number; kind: Kind;
  evidence: "official-activity-and-receipt" | "protocol-counterparty-and-receipt" | "self-transfer";
}
export interface CashFlowClassification {
  cashFlowCoverage: CashFlowCoverage;
  /** Only pUSD enters the current trading cash ledger. USDC.e is reported separately. */
  externalFlows: ExternalCashFlow[];
  netExternalUsd: number;
  netExternalByToken: Record<string, number>;
  classified: ClassifiedCashTransfer[];
  unknown: Array<{ id: string; transactionHash?: string; reason: string }>;
  activityWindow?: { source: "polymarket-data-api"; fromAt: number; toAt: number; pages: number; items: number; complete: boolean; reason: string };
}
export interface ClassifyCashFlowInput {
  wallet: string;
  scan: unknown;
  /** Official account-scoped API arrays or their existing {items:[...]} sections. */
  trades?: unknown;
  activity?: unknown;
  /** Successful RPC receipts or receiptEvidence() results, indexed by transaction or in an array. */
  receipts?: unknown;
  blockTimestamps?: Record<string, number>;
}
const address = (v: unknown): string | undefined => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : undefined;
const hash = (v: unknown): string | undefined => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : undefined;
const object = (v: unknown): Row | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v : Array.isArray(object(v)?.items) ? object(v)!.items as unknown[] : []).flatMap(v => object(v) ? [v as Row] : []);
const integer = (v: unknown): number | undefined => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const cashUnits = (v: unknown): bigint | undefined => {
  if (typeof v !== "number" && typeof v !== "string" || typeof v === "string" && !v.trim()) return undefined;
  const n = Number(v), scaled = n * 1e6, rounded = Math.round(scaled);
  return Number.isFinite(n) && n >= 0 && Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 0.00001 ? BigInt(rounded) : undefined;
};
const txOf = (row: Row): string | undefined => hash(row.transaction_hash ?? row.transactionHash);
const indexOf = (v: unknown): string | undefined => typeof v === "string" && /^(0x[0-9a-f]+|\d+)$/i.test(v) ? BigInt(v).toString() : integer(v)?.toString();
const usd = (n: bigint): number => Number(n) / 1e6;
const timeAt = (input: ClassifyCashFlowInput, block: number): number | undefined => {
  const time = input.blockTimestamps?.[String(block)] ?? input.blockTimestamps?.[`0x${block.toString(16)}`];
  return integer(time);
};
const tokens = new Set([PUSD.toLowerCase(), USDC_E.toLowerCase()]);
const exchangeAddresses = new Set([CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE].map(a => a.toLowerCase()));
const redeemAddresses = new Set([CTF, COLLATERAL_ADAPTER, NEG_RISK_COLLATERAL_ADAPTER].map(a => a.toLowerCase()));
const convertAddresses = new Set([COLLATERAL_ONRAMP, COLLATERAL_OFFRAMP].map(a => a.toLowerCase()));
const activityKinds: Record<string, Kind> = {
  DEPOSIT: "deposit", WITHDRAWAL: "withdrawal", TRADE: "trade", REDEEM: "redemption", MERGE: "redemption",
  SPLIT: "conversion", CONVERSION: "conversion", REWARD: "reward", MAKER_REBATE: "reward", TAKER_REBATE: "reward", REFERRAL_REWARD: "reward", YIELD: "reward",
};
const activityAmount = (row: Row): unknown => row.usdcSize ?? row.amount ?? (String(row.type).toUpperCase() !== "TRADE" ? row.size : undefined);
const activityKey = (row: Row): string => JSON.stringify([txOf(row), String(row.type).toUpperCase(), row.timestamp,
  activityAmount(row), row.side, row.asset ?? row.assetId ?? row.tokenId, row.conditionId]);
interface Transfer { id: string; transactionHash: string; token: string; block: number; blockHash: string; at: number; from: string; to: string; amount: bigint; net: bigint }

/** Classification is complete for the scanned confirmed window only, not the current unconfirmed head. */
export function classifyCashFlows(input: ClassifyCashFlowInput): CashFlowClassification {
  const wallet = address(input.wallet), scan = object(input.scan);
  if (!wallet) throw new Error("cash_flow_wallet_invalid");
  const from = integer(scan?.from_block), to = integer(scan?.to_block);
  const unknown: CashFlowClassification["unknown"] = [];
  const classified: ClassifiedCashTransfer[] = [];
  const gap = (id: string, reason: string, transactionHash?: string) => unknown.push({ id, reason, transactionHash });
  const fromAt = from === undefined ? undefined : timeAt(input, from), toAt = to === undefined ? undefined : timeAt(input, to);
  const coverageRange = { fromBlock: from ?? 0, toBlock: Math.max(from ?? 0, to ?? from ?? 0),
    fromAt: fromAt ?? 0, toAt: Math.max(fromAt ?? 0, toAt ?? fromAt ?? 0) };
  // An incremental cursor can be one block ahead of the unchanged confirmed
  // head. Describe the last confirmed point, not a reversed or future range.
  const emptyRange = to !== undefined && toAt !== undefined
    ? { fromBlock: to, toBlock: to, fromAt: toAt, toAt } : coverageRange;
  if (scan?.reason === "confirmation_window_empty") return { cashFlowCoverage: { ...emptyRange, complete: false, reason: "confirmation_window_empty" },
    externalFlows: [], netExternalUsd: 0, netExternalByToken: {}, classified: [], unknown: [{ id: "scan", reason: "confirmation_window_empty" }] };
  if (scan?.source !== "polygon-confirmed-transfer-logs" || scan.complete !== true) gap("scan", `transfer_scan_incomplete:${String(scan?.reason ?? "missing_scan")}`);
  if (from === undefined || to === undefined || to < from) gap("range", "confirmed_block_range_invalid");
  if (fromAt === undefined || toAt === undefined || toAt < fromAt) gap("time", "block_timestamps_missing_or_invalid");
  if (!Array.isArray(scan?.token_contracts) || ![...tokens].every(token => (scan.token_contracts as unknown[]).some(v => address(v) === token))) gap("tokens", "scanned_token_scope_incomplete");
  if (!Array.isArray(scan?.transfers) || scan.transfers.some(value => !object(value))) gap("transfers", "transfer_rows_invalid");
  const transfers = new Map<string, Transfer>();
  const conflicted = new Set<string>();
  for (const [i, row] of (unknown.length ? [] : rows(scan?.transfers)).entries()) {
    const tx = txOf(row), index = indexOf(row.log_index), token = address(row.token), sender = address(row.from), receiver = address(row.to);
    const block = integer(row.block), blockHash = hash(row.block_hash), amount = cashUnits(row.amount);
    const id = tx && index !== undefined ? `${tx}:${index}` : `invalid-${i}`;
    const at = block === undefined ? undefined : timeAt(input, block);
    if (!tx || index === undefined || !token || !tokens.has(token) || !sender || !receiver || !blockHash
      || block === undefined || from === undefined || to === undefined || block < from || block > to || amount === undefined
      || at === undefined || sender !== wallet && receiver !== wallet) { gap(id, "confirmed_transfer_invalid_or_time_missing", tx); continue; }
    const net = (receiver === wallet ? amount : 0n) - (sender === wallet ? amount : 0n);
    if (row.net_amount !== undefined && Number(row.net_amount) !== usd(net)) { gap(id, "transfer_direction_amount_mismatch", tx); continue; }
    const transfer = { id, transactionHash: tx, token, block, blockHash, at, from: sender, to: receiver, amount, net };
    const old = transfers.get(id);
    if (old && JSON.stringify(old, (_key, value) => typeof value === "bigint" ? String(value) : value)
      !== JSON.stringify(transfer, (_key, value) => typeof value === "bigint" ? String(value) : value)) {
      gap(id, "duplicate_transfer_conflict", tx); conflicted.add(id);
    } else transfers.set(id, transfer);
  }
  for (const id of conflicted) transfers.delete(id);
  const receipts = Array.isArray(input.receipts) ? rows(input.receipts) : Object.values(object(input.receipts) ?? {}).flatMap(v => object(v) ? [v as Row] : []);
  const activities = rows(input.activity).filter(row => {
    const identity = row.wallet ?? row.proxyWallet;
    return identity === undefined || address(identity) === wallet;
  });
  const tradeRows = rows(input.trades).filter(row => row.status === "CONFIRMED");
  const txGroups = new Map<string, Transfer[]>();
  for (const transfer of transfers.values()) txGroups.set(transfer.transactionHash, [...txGroups.get(transfer.transactionHash) ?? [], transfer]);
  const classify = (transfer: Transfer, kind: Kind, evidence: ClassifiedCashTransfer["evidence"]) => classified.push({
    id: transfer.id, transactionHash: transfer.transactionHash, token: transfer.token, block: transfer.block, at: transfer.at,
    from: transfer.from, to: transfer.to, amountUsd: usd(transfer.amount), netAmountUsd: usd(transfer.net), kind, evidence,
  });
  for (const [tx, group] of txGroups) {
    const rawReceipt = receipts.find(row => txOf(row) === tx);
    let receipt: Row | undefined;
    try {
      receipt = rawReceipt?.status !== undefined ? receiptEvidence(rawReceipt, wallet, tx, to ?? -1) : rawReceipt;
    } catch { /* The exact reason is represented by the missing confirmed receipt below. */ }
    const receiptTransfers = rows(receipt?.transfers);
    const validReceipt = receipt && integer(receipt.block) === group[0]!.block && hash(receipt.block_hash) === group[0]!.blockHash
      && group.every(t => receiptTransfers.some(r => indexOf(r.log_index) === t.id.split(":")[1] && address(r.token) === t.token
        && address(r.from) === t.from && address(r.to) === t.to && cashUnits(r.amount) === t.amount));
    const receiptScopeMatches = receiptTransfers.length === group.length
      && new Set(receiptTransfers.map(row => indexOf(row.log_index))).size === receiptTransfers.length;
    if (!validReceipt || !receiptScopeMatches) { group.forEach(t => gap(t.id, "confirmed_receipt_missing_or_transfer_mismatch", tx)); continue; }
    const active = group.filter(t => {
      if (t.net === 0n) { classify(t, "self", "self-transfer"); return false; }
      return true;
    });
    if (!active.length) continue;
    const claims = activities.filter(row => txOf(row) === tx);
    const types = new Set(claims.map(row => String(row.type).toUpperCase()));
    const kinds = new Set<Kind | "unknown">([...types].map(type => activityKinds[type] ?? "unknown"));
    const protocolKind = (transfer: Transfer): Kind | undefined => {
      const counterparty = transfer.from === wallet ? transfer.to : transfer.from;
      if (exchangeAddresses.has(counterparty)) return "trade";
      if (redeemAddresses.has(counterparty)) return "redemption";
      if (convertAddresses.has(counterparty)) return "conversion";
      // Some on/off ramps mint or burn pUSD rather than transferring it from
      // their contract. The opposite USDC.e leg in this same successful receipt
      // must prove that one-to-one conversion before attributing a zero address.
      if (transfer.token === PUSD.toLowerCase() && counterparty === `0x${"0".repeat(40)}` && group.some(other =>
        other.token === USDC_E.toLowerCase() && other.amount === transfer.amount && (
          transfer.net > 0n && other.net < 0n && other.to === COLLATERAL_ONRAMP.toLowerCase()
          || transfer.net < 0n && other.net > 0n && other.from === COLLATERAL_OFFRAMP.toLowerCase()))) return "conversion";
      return undefined;
    };
    // Account-level activity labels must match the confirmed asset, sign and
    // amount; a label or an unclassified incoming transfer alone proves nothing.
    if (kinds.size === 1 && !kinds.has("unknown") && new Set(active.map(t => t.token)).size === 1) {
      const kind = [...kinds][0] as Kind;
      let expected = 0n, claimsValid = true;
      const seenClaims = new Set<string>();
      for (const row of claims) {
        const amount = cashUnits(activityAmount(row)), side = String(row.side).toUpperCase();
        const key = activityKey(row);
        if (seenClaims.has(key) || amount === undefined || kind === "trade" && side !== "BUY" && side !== "SELL") { claimsValid = false; break; }
        seenClaims.add(key);
        const outgoing = kind === "withdrawal" || String(row.type).toUpperCase() === "SPLIT" || kind === "trade" && side === "BUY";
        expected += outgoing ? -amount : amount;
      }
      const actual = active.reduce((n, t) => n + t.net, 0n);
      const directionsValid = kind === "deposit" ? active.every(t => t.net > 0n) : kind === "withdrawal" ? active.every(t => t.net < 0n) : true;
      const noConflictingProtocol = active.every(t => !protocolKind(t) || protocolKind(t) === kind);
      if (claimsValid && actual === expected && directionsValid && noConflictingProtocol) {
        active.forEach(t => classify(t, kind, "official-activity-and-receipt")); continue;
      }
    }
    for (const transfer of active) {
      const kind = protocolKind(transfer);
      if (kind && (kind === "conversion" || !kinds.has("deposit") && !kinds.has("withdrawal"))) classify(transfer, kind, "protocol-counterparty-and-receipt");
      else gap(transfer.id, claims.length ? "activity_amount_direction_asset_or_type_ambiguous"
        : tradeRows.some(row => txOf(row) === tx) ? "trade_receipt_transfer_attribution_incomplete" : "external_funding_evidence_missing", tx);
    }
  }
  const totals = new Map<string, bigint>();
  const externalFlows: ExternalCashFlow[] = [];
  for (const entry of classified) {
    // Equity tracks pUSD cash, not USDC.e held outside the trading ledger.
    // Conversion crosses that boundary once on the pUSD leg; its USDC.e leg
    // remains classified evidence and must not be added a second time.
    const fundingKind = entry.kind === "deposit" || entry.kind === "withdrawal" ? entry.kind
      : entry.kind === "conversion" && entry.token === PUSD.toLowerCase()
        && (convertAddresses.has(entry.from) || convertAddresses.has(entry.to) || entry.evidence === "protocol-counterparty-and-receipt")
        ? entry.netAmountUsd > 0 ? "deposit" : "withdrawal" : undefined;
    if (!fundingKind || entry.amountUsd <= 0) continue;
    const value = cashUnits(entry.amountUsd)! * (fundingKind === "deposit" ? 1n : -1n);
    totals.set(entry.token, (totals.get(entry.token) ?? 0n) + value);
    if (entry.token === PUSD.toLowerCase()) externalFlows.push({ id: entry.id, kind: fundingKind, amountUsd: entry.amountUsd,
      block: entry.block, at: entry.at, transactionHash: entry.transactionHash });
  }
  if ([...totals.values()].some(total => total > BigInt(Number.MAX_SAFE_INTEGER) || total < -BigInt(Number.MAX_SAFE_INTEGER))) gap("totals", "external_cash_flow_total_overflow");
  const complete = unknown.length === 0;
  return { cashFlowCoverage: { ...coverageRange, complete,
    reason: complete ? "classified_through_confirmed_block" : [...new Set(unknown.map(gap => gap.reason))].join(";") },
    externalFlows, netExternalUsd: usd(totals.get(PUSD.toLowerCase()) ?? 0n), netExternalByToken: Object.fromEntries([...totals].map(([token, n]) => [token, usd(n)])), classified, unknown };
}

export interface ReadCashFlowOptions {
  wallet: string; fromBlock?: number; fromAt: number; rpc: Rpc; raw?: unknown;
  confirmations?: number; chunkSize?: number;
  /** Read-only official /activity query. Omit to use the public Data API. */
  getActivity?: (params: Record<string, string>) => Promise<unknown>;
  activityPageSize?: number; activityMaxPages?: number;
}

async function officialActivity(params: Record<string, string>): Promise<unknown> {
  const url = new URL("https://data-api.polymarket.com/activity");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

/** Fetch only when receipt-proven cash transfers need activity attribution.
 * A full chain scan plus receipt coverage needs no extra query for known trades. */
async function activityWindow(options: ReadCashFlowOptions, fromAt: number, toAt: number): Promise<{
  items: Row[]; evidence: NonNullable<CashFlowClassification["activityWindow"]>;
}> {
  const items: Row[] = [], seen = new Set<string>();
  const evidence: NonNullable<CashFlowClassification["activityWindow"]> = { source: "polymarket-data-api", fromAt, toAt,
    pages: 0, items: 0, complete: false, reason: "activity_page_limit" };
  const limit = integer(options.activityPageSize) && options.activityPageSize! > 0 ? Math.min(options.activityPageSize!, 500) : 100;
  const maxPages = integer(options.activityMaxPages) && options.activityMaxPages! > 0 ? Math.min(options.activityMaxPages!, 101) : 101;
  const get = options.getActivity ?? officialActivity;
  try {
    for (let page = 0; page < maxPages && page * limit <= 10_000; page++) {
      const data = await get({ user: options.wallet, start: String(fromAt), end: String(toAt), limit: String(limit),
        offset: String(page * limit), sortBy: "TIMESTAMP", sortDirection: "ASC" });
      if (!Array.isArray(data) || data.length > limit) throw new Error("activity_page_invalid");
      evidence.pages++;
      for (const value of data) {
        const row = object(value), identity = row?.proxyWallet ?? row?.wallet;
        const timestamp = integer(row?.timestamp);
        if (!row || !txOf(row) || timestamp === undefined || timestamp < fromAt || timestamp > toAt
          || identity !== undefined && address(identity) !== address(options.wallet)) throw new Error("activity_row_outside_account_or_window");
        const key = activityKey(row);
        if (seen.has(key)) throw new Error("activity_pagination_overlap");
        seen.add(key); items.push(row);
      }
      if (data.length < limit) { evidence.complete = true; evidence.reason = "official_activity_window_complete"; break; }
    }
  } catch (error) { evidence.reason = error instanceof Error ? error.message : "activity_window_fetch_failed"; }
  evidence.items = items.length;
  return { items, evidence };
}

/** Read-only incremental inputs. The caller persists its contiguous cursor and passes cursorBlock+1.
 * Missing fromBlock includes the block at/before fromAt; the core filters flows at/before its baseline. */
export async function readCashFlowEvidence(options: ReadCashFlowOptions): Promise<CashFlowClassification> {
  const times: Record<string, number> = {};
  const blocks = new Map<number, Row>();
  async function getBlock(number: number): Promise<Row> {
    if (blocks.has(number)) return blocks.get(number)!;
    const row = object(await options.rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]));
    const timestamp = typeof row?.timestamp === "string" && /^0x[0-9a-f]+$/i.test(row.timestamp) ? Number(BigInt(row.timestamp)) : undefined;
    if (!row || integer(timestamp) === undefined || Number(BigInt(String(row.number))) !== number || !hash(row.hash)) throw new Error("cash_flow_block_invalid");
    times[String(number)] = timestamp!; blocks.set(number, row); return row;
  }
  let fromBlock = options.fromBlock;
  let scan: unknown;
  const receipts: Row[] = [];
  const raw = object(options.raw);
  try {
    if (!Number.isFinite(options.fromAt) || options.fromAt < 0) throw new Error("cash_flow_start_time_invalid");
    const headRaw = await options.rpc("eth_blockNumber", []);
    if (typeof headRaw !== "string" || !/^0x[0-9a-f]+$/i.test(headRaw)) throw new Error("cash_flow_head_invalid");
    const head = Number(BigInt(headRaw));
    if (integer(head) === undefined) throw new Error("cash_flow_head_invalid");
    async function floorBlock(at: number): Promise<number> {
      await getBlock(head);
      if (times[String(head)]! <= at) return head;
      let low = 0, high = head;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        await getBlock(mid);
        if (times[String(mid)]! <= at) low = mid; else high = mid - 1;
      }
      return low;
    }
    if (fromBlock === undefined) fromBlock = await floorBlock(options.fromAt);
    if (integer(fromBlock) === undefined) throw new Error("cash_flow_start_block_invalid");
    // Account sections finish at different times. Do not attach later funding
    // to an earlier cash balance merely because scanning the chain took time.
    const observationTimes = [raw?.checked_at, object(raw?.collateral)?.checked_at].flatMap(value => {
      const at = typeof value === "string" ? Date.parse(value) / 1000 : NaN;
      return Number.isFinite(at) && at >= 0 ? [at] : [];
    });
    const confirmations = integer(options.confirmations) && options.confirmations! >= 1 ? options.confirmations! : 12;
    const cutoffBlock = observationTimes.length ? await floorBlock(Math.min(...observationTimes)) : head;
    const cappedHead = Math.min(head, cutoffBlock + confirmations);
    const cappedRpc: Rpc = (method, params) => method === "eth_blockNumber" ? Promise.resolve(`0x${cappedHead.toString(16)}`) : options.rpc(method, params);
    scan = await scanConfirmedTransfers(cappedRpc, options.wallet, { fromBlock, confirmations, chunkSize: options.chunkSize });
    const scanned = object(scan)!;
    const blockNumbers = new Set<number>([
      ...(scanned.reason === "confirmation_window_empty" ? [] : [fromBlock]),
      ...(integer(scanned.to_block) !== undefined ? [scanned.to_block as number] : []),
      ...rows(scanned.transfers).map(row => row.block as number),
    ]);
    const jobs = [...blockNumbers].filter(number => integer(number) !== undefined).map(number => async () => { await getBlock(number); });
    for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(job => job()));
    const hashes = [...new Set(rows(scanned.transfers).map(txOf).filter((tx): tx is string => !!tx))];
    for (let i = 0; i < hashes.length; i += 4) await Promise.all(hashes.slice(i, i + 4).map(async tx => {
      try { const receipt = object(await options.rpc("eth_getTransactionReceipt", [tx])); if (receipt) receipts.push(receipt); }
      catch { /* Classifier records the exact transaction missing its receipt. */ }
    }));
  } catch (error) {
    scan = { ...object(scan), source: "polygon-confirmed-transfer-logs", token_contracts: [...tokens],
      from_block: fromBlock ?? null, transfers: [], complete: false,
      reason: error instanceof Error && error.message.startsWith("cash_flow_") ? error.message : "cash_flow_block_or_rpc_read_incomplete" };
  }
  const input = { wallet: options.wallet, scan, trades: raw?.trades, activity: raw?.activity, receipts, blockTimestamps: times };
  let result = classifyCashFlows(input);
  const needsActivity = result.unknown.some(row => ["external_funding_evidence_missing", "trade_receipt_transfer_attribution_incomplete", "activity_amount_direction_asset_or_type_ambiguous"].includes(row.reason));
  if (needsActivity && object(scan)?.complete === true) {
    const window = await activityWindow(options, result.cashFlowCoverage.fromAt, result.cashFlowCoverage.toAt);
    const existing = rows(raw?.activity), existingKeys = new Set(existing.map(activityKey));
    result = classifyCashFlows({ ...input, activity: [...existing, ...window.items.filter(row => !existingKeys.has(activityKey(row)))] });
    result.activityWindow = window.evidence;
    if (!window.evidence.complete) result.unknown.push({ id: "activity-window", reason: `official_activity_window_incomplete:${window.evidence.reason}` });
    if (window.evidence.complete) for (const gap of result.unknown) if (gap.reason === "external_funding_evidence_missing") gap.reason = "external_funding_evidence_missing_after_activity_window";
    result.cashFlowCoverage.complete = result.unknown.length === 0;
    result.cashFlowCoverage.reason = result.cashFlowCoverage.complete ? "classified_through_confirmed_block" : [...new Set(result.unknown.map(row => row.reason))].join(";");
  }
  return result;
}
