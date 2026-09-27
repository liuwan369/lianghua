/** Public, read-only market quote projection for the dashboard. */
import { mkdirSync, openSync, closeSync, renameSync, writeFileSync, fsyncSync, unlinkSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BookSnapshot, MarketAssetSnapshot } from "../live/feeds/index.js";

export const DEFAULT_STALE_AFTER_MS = 2_000;
const MAX_CLOCK_SKEW_MS = 1_000;

export interface MarketProjectionConfig {
  asset?: string;
  upToken: string;
  downToken: string;
  slug?: string;
  conditionId?: string;
  start?: number;
  end?: number;
  staleAfterMs?: number;
}

export interface MarketProjectionRow {
  assetId?: string;
  marketId: string;
  roundId: string;
  snapshot: PairedMarketSnapshot;
  healthy: boolean;
  strategyEligible: false;
  slug: string;
  condition_id: string;
  up_token: string;
  down_token: string;
  start: number | null;
  end: number | null;
  up_bid: number | null;
  up_ask: number | null;
  down_bid: number | null;
  down_ask: number | null;
  up_bid_size: number | null;
  up_ask_size: number | null;
  down_bid_size: number | null;
  down_ask_size: number | null;
  up_bid_levels: Array<[number, number]> | null;
  up_ask_levels: Array<[number, number]> | null;
  down_bid_levels: Array<[number, number]> | null;
  down_ask_levels: Array<[number, number]> | null;
  tick_size: number | null;
  up_tick_size: number | null;
  down_tick_size: number | null;
  ask_sum: number | null;
  quote_at: string | null;
  up_exchange_at: string | null;
  down_exchange_at: string | null;
  up_quote_age_ms: number | null;
  down_quote_age_ms: number | null;
  book_depth_ready: boolean;
  quote_fresh: boolean;
  source: "polymarket-ws";
}

export interface MarketProjectionSnapshot {
  checked_at: string;
  collector_online: boolean;
  collector_connected: boolean;
  strategyEligible: false;
  stale_after_ms: number;
  source: "polymarket-ws";
  current_markets: MarketProjectionRow[];
  stale_reason?: string;
}

export interface PairedMarketSnapshot {
  marketId: string;
  roundId: string;
  sequence: number;
  sourceAt: number;
  expiresAt: number;
  YES: MarketAssetSnapshot;
  NO: MarketAssetSnapshot;
}

function iso(unixSeconds: number): string { return new Date(unixSeconds * 1000).toISOString(); }
function finite(value: number | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function isPairedSnapshot(value: unknown): value is PairedMarketSnapshot {
  if (value == null || typeof value !== "object") return false;
  const snapshot = value as Partial<PairedMarketSnapshot>;
  const yes = snapshot.YES;
  const no = snapshot.NO;
  if (typeof snapshot.marketId !== "string" || !snapshot.marketId || typeof snapshot.roundId !== "string" || !snapshot.roundId
    || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence! < 1
    || !Number.isFinite(snapshot.sourceAt) || snapshot.sourceAt! <= 0
    || !Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt! <= 0
    || !yes?.assetId || !no?.assetId || yes.assetId === no.assetId
    || !Number.isFinite(yes.bid) || !Number.isFinite(yes.ask) || !Number.isFinite(no.bid) || !Number.isFinite(no.ask)
    || yes.bid! <= 0 || yes.ask! >= 1 || no.bid! <= 0 || no.ask! >= 1
    || yes.bid! > yes.ask! || no.bid! > no.ask!
    || !Number.isFinite(yes.sourceAt) || !Number.isFinite(no.sourceAt)
    || !Number.isFinite(yes.expiresAt) || !Number.isFinite(no.expiresAt)
    || snapshot.sourceAt! < Math.max(yes.sourceAt!, no.sourceAt!)
    || snapshot.expiresAt! > Math.min(yes.expiresAt!, no.expiresAt!)
    || yes.sequence !== snapshot.sequence || no.sequence !== snapshot.sequence) return false;
  return true;
}

function pairedSnapshot(snapshot: BookSnapshot): PairedMarketSnapshot | undefined {
  const yes = snapshot.YES;
  const no = snapshot.NO;
  if (!yes || !no) return undefined;
  const candidate = {
    marketId: snapshot.marketId,
    roundId: snapshot.roundId,
    sequence: snapshot.sequence!,
    sourceAt: snapshot.sourceAt!,
    expiresAt: snapshot.expiresAt!,
    YES: copy(yes),
    NO: copy(no),
  };
  return isPairedSnapshot(candidate) ? candidate : undefined;
}

/**
 * Maintains one atomic quote for the two public outcome tokens.  A snapshot is
 * visible only when both sides have complete, fresh WebSocket data.
 */
export class ClobMarketProjection {
  readonly assetId: string | undefined;
  readonly upToken: string;
  readonly downToken: string;
  readonly slug: string;
  readonly conditionId: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly staleAfterMs: number;
  private connected = false;
  private accepted: PairedMarketSnapshot | undefined;
  private receivedAt = 0;
  private bookReady = false;
  private upTickSize: number | undefined;
  private downTickSize: number | undefined;

  constructor(config: MarketProjectionConfig) {
    if (!config.upToken || !config.downToken || config.upToken === config.downToken) throw new Error("upToken and downToken must be distinct");
    const stale = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isFinite(stale) || stale < 0) throw new Error("staleAfterMs must be non-negative");
    this.upToken = config.upToken; this.downToken = config.downToken;
    this.assetId = config.asset;
    this.slug = config.slug ?? ""; this.conditionId = config.conditionId ?? "";
    this.start = config.start ?? null; this.end = config.end ?? null; this.staleAfterMs = stale;
  }

  markConnected(value = true): void { this.connected = value; }
  invalidateBook(): void {
    this.bookReady = false;
  }
  disconnect(): void {
    // Keep the last quote for display, but require a new pair before marking it healthy.
    this.connected = false;
    this.invalidateBook();
  }
  isConnected(): boolean { return this.connected; }

  /** Accept only the paired snapshot produced by the public Market WS feed. */
  applySnapshot(snapshot: BookSnapshot, receivedAt = snapshot.receivedAtUnix ?? snapshot.tsUnix): boolean {
    if (snapshot.source !== "polymarket-ws") return false;
    const paired = pairedSnapshot(snapshot);
    if (!paired || !Number.isFinite(receivedAt) || receivedAt <= 0
      || (this.conditionId && paired.marketId !== this.conditionId)
      || (this.start != null && paired.roundId !== String(this.start))
      || paired.YES.assetId !== this.upToken || paired.NO.assetId !== this.downToken
      || paired.expiresAt <= receivedAt
      || paired.YES.expiresAt! <= receivedAt || paired.NO.expiresAt! <= receivedAt
      || paired.expiresAt > (this.end ?? Number.POSITIVE_INFINITY)
      || Math.max(paired.YES.sourceAt!, paired.NO.sourceAt!) > receivedAt + MAX_CLOCK_SKEW_MS / 1_000
      || Math.max(receivedAt - paired.YES.sourceAt!, receivedAt - paired.NO.sourceAt!) * 1_000 > this.staleAfterMs
      || this.accepted && (paired.sequence <= this.accepted.sequence
        || paired.sourceAt < this.accepted.sourceAt
        || paired.YES.sourceAt! < this.accepted.YES.sourceAt!
        || paired.NO.sourceAt! < this.accepted.NO.sourceAt!)) return false;
    this.connected = true;
    this.accepted = paired;
    this.receivedAt = receivedAt;
    this.bookReady = true;
    this.upTickSize = finite(snapshot.upTickSize) ?? undefined;
    this.downTickSize = finite(snapshot.downTickSize) ?? undefined;
    return true;
  }

  private row(now: number): MarketProjectionRow | undefined {
    const snapshot = this.accepted;
    if (!snapshot) return undefined;
    const yes = snapshot?.YES;
    const no = snapshot?.NO;
    const receiveAge = snapshot && this.receivedAt ? (now - this.receivedAt) * 1000 : null;
    const yesAge = yes ? (now - yes.sourceAt!) * 1000 : null;
    const noAge = no ? (now - no.sourceAt!) * 1000 : null;
    const yesQuoteAge = yesAge != null && receiveAge != null ? Math.max(0, yesAge, receiveAge) : null;
    const noQuoteAge = noAge != null && receiveAge != null ? Math.max(0, noAge, receiveAge) : null;
    const ages = [receiveAge, yesAge, noAge];
    const fresh = Boolean(this.bookReady && snapshot && snapshot.expiresAt > now
      && ages.every(age => age != null && age >= -MAX_CLOCK_SKEW_MS && age <= this.staleAfterMs));
    const quoteAt = yes && no ? Math.min(yes.sourceAt!, no.sourceAt!) : 0;
    const healthy = Boolean(this.connected && fresh);
    return {
      assetId: this.assetId,
      marketId: snapshot?.marketId ?? this.conditionId,
      roundId: snapshot?.roundId ?? (this.start == null ? "" : String(this.start)),
      snapshot: copy(snapshot),
      healthy,
      strategyEligible: false,
      slug: this.slug, condition_id: this.conditionId, up_token: this.upToken, down_token: this.downToken,
      start: this.start, end: this.end,
      up_bid: finite(yes?.bid), up_ask: finite(yes?.ask), down_bid: finite(no?.bid), down_ask: finite(no?.ask),
      up_bid_size: finite(yes?.bidSize), up_ask_size: finite(yes?.askSize), down_bid_size: finite(no?.bidSize), down_ask_size: finite(no?.askSize),
      up_bid_levels: yes?.bids ? copy(yes.bids) : null, up_ask_levels: yes?.asks ? copy(yes.asks) : null,
      down_bid_levels: no?.bids ? copy(no.bids) : null, down_ask_levels: no?.asks ? copy(no.asks) : null,
      tick_size: this.upTickSize ?? this.downTickSize ?? null,
      up_tick_size: this.upTickSize ?? null, down_tick_size: this.downTickSize ?? null,
      ask_sum: yes?.ask != null && no?.ask != null ? yes.ask + no.ask : null,
      quote_at: quoteAt ? iso(quoteAt) : null,
      up_exchange_at: yes ? iso(yes.sourceAt!) : null,
      down_exchange_at: no ? iso(no.sourceAt!) : null,
      up_quote_age_ms: yesQuoteAge, down_quote_age_ms: noQuoteAge,
      book_depth_ready: Boolean(yes?.bids && yes.bids.length >= 5 && yes.asks && yes.asks.length >= 5
        && no?.bids && no.bids.length >= 5 && no.asks && no.asks.length >= 5),
      quote_fresh: fresh, source: "polymarket-ws",
    };
  }

  snapshot(now = Date.now() / 1000): MarketProjectionSnapshot {
    if (!Number.isFinite(now)) throw new Error("now must be finite");
    const inWindow = (this.start == null || now >= this.start) && (this.end == null || now < this.end);
    const row = this.row(now); const online = Boolean(this.connected && inWindow && row?.quote_fresh);
    const result: MarketProjectionSnapshot = {
      checked_at: iso(now), collector_online: online, collector_connected: this.connected,
      strategyEligible: false, stale_after_ms: this.staleAfterMs, source: "polymarket-ws",
      current_markets: row ? [{ ...row, healthy: online }] : [],
    };
    if (!this.connected) result.stale_reason = "CLOB Market WebSocket 未连接";
    else if (!inWindow) result.stale_reason = "当前市场窗口已结束";
    else if (!row) result.stale_reason = "等待完整 YES/NO 双边盘口";
    else if (!row.quote_fresh) result.stale_reason = "CLOB Market WebSocket 行情过期";
    return copy(result);
  }
}

/** Reads the last collector file so a restart can keep its quote visible as stale. */
export function readPublishedSnapshot(path: string): MarketProjectionSnapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<MarketProjectionSnapshot>;
    if (!Array.isArray(value.current_markets)) return undefined;
    const current_markets = value.current_markets.filter((row): row is MarketProjectionRow =>
      row != null && typeof row === "object" && isPairedSnapshot((row as MarketProjectionRow).snapshot));
    return { ...value, current_markets } as MarketProjectionSnapshot;
  } catch {
    return undefined;
  }
}

/** Marks persisted quotes stale without changing their venue timestamps or expiry. */
export function stalePublishedSnapshot(
  value: MarketProjectionSnapshot,
  now: number,
  reason: string,
  connected = false,
): MarketProjectionSnapshot {
  return {
    ...value,
    checked_at: iso(now),
    collector_online: false,
    collector_connected: connected,
    strategyEligible: false,
    stale_reason: reason,
    current_markets: value.current_markets.map(row => ({
      ...row,
      healthy: false,
      strategyEligible: false,
      quote_fresh: false,
    })),
  };
}

/** Atomic JSON write used by the standalone dashboard collector. */
export function publishSnapshot(path: string, value: MarketProjectionSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temporary, "w", 0o644);
  try {
    writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); renameSync(temporary, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}
