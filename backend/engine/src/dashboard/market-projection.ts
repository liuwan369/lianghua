/** Public, read-only market quote projection for the dashboard. */
import { mkdirSync, openSync, closeSync, renameSync, writeFileSync, fsyncSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { BookSnapshot, MarketAssetSnapshot } from "../live/feeds/index.js";

export const DEFAULT_STALE_AFTER_MS = 2_000;
const MAX_CLOCK_SKEW_MS = 1_000;

export interface MarketProjectionConfig {
  upToken: string;
  downToken: string;
  slug?: string;
  conditionId?: string;
  roundId?: string;
  start?: number;
  end?: number;
  staleAfterMs?: number;
}

export interface MarketProjectionRow {
  paired_snapshot?: {
    marketId: string;
    roundId: string;
    sequence: number;
    sourceAt: number;
    expiresAt: number;
    YES: MarketAssetSnapshot;
    NO: MarketAssetSnapshot;
  };
  healthy: boolean;
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
  stale_after_ms: number;
  source: "polymarket-ws";
  current_markets: MarketProjectionRow[];
  stale_reason?: string;
}

function iso(unixSeconds: number): string { return new Date(unixSeconds * 1000).toISOString(); }
function finite(value: number | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/**
 * Maintains one atomic quote for the two public outcome tokens.  A snapshot is
 * visible only when both sides have complete, fresh WebSocket data.
 */
export class ClobMarketProjection {
  readonly upToken: string;
  readonly downToken: string;
  readonly slug: string;
  readonly conditionId: string;
  readonly roundId: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly staleAfterMs: number;
  private connected = false;
  private accepted: BookSnapshot | undefined;
  private upReceivedAt = 0;
  private downReceivedAt = 0;

  constructor(config: MarketProjectionConfig) {
    if (!config.upToken || !config.downToken || config.upToken === config.downToken) throw new Error("upToken and downToken must be distinct");
    const stale = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isFinite(stale) || stale < 0) throw new Error("staleAfterMs must be non-negative");
    this.upToken = config.upToken; this.downToken = config.downToken;
    this.slug = config.slug ?? ""; this.conditionId = config.conditionId ?? "";
    this.roundId = config.roundId ?? "";
    this.start = config.start ?? null; this.end = config.end ?? null; this.staleAfterMs = stale;
  }

  markConnected(value = true): void { this.connected = value; }
  invalidateBook(): void {
    this.accepted = undefined;
    this.upReceivedAt = 0;
    this.downReceivedAt = 0;
  }
  disconnect(): void {
    // A reconnect must wait for a fresh bilateral snapshot. Retaining the
    // previous book would make a silent socket look live after reconnect.
    this.connected = false;
    this.invalidateBook();
  }
  isConnected(): boolean { return this.connected; }

  /** Accept only the paired snapshot produced by the public Market WS feed. */
  applySnapshot(snapshot: BookSnapshot, receivedAt = snapshot.receivedAtUnix ?? snapshot.tsUnix): boolean {
    if (snapshot.source !== "polymarket-ws") return false;
    if (!Number.isFinite(receivedAt)) return false;
    const yes = snapshot.YES;
    const no = snapshot.NO;
    if (!yes || !no || !snapshot.marketId || !snapshot.roundId
      || (this.conditionId && snapshot.marketId !== this.conditionId)
      || (this.roundId && snapshot.roundId !== this.roundId)
      || yes.assetId !== this.upToken || no.assetId !== this.downToken
      || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence! < 0
      || !Number.isFinite(snapshot.sourceAt) || !Number.isFinite(snapshot.expiresAt)
      || (this.end != null && snapshot.expiresAt! > this.end)) return false;
    const prices = [yes.bid, yes.ask, no.bid, no.ask];
    const upAt = snapshot.upReceivedAtUnix ?? receivedAt;
    const downAt = snapshot.downReceivedAtUnix ?? receivedAt;
    const yesAt = yes.sourceAt ?? snapshot.sourceAt!;
    const noAt = no.sourceAt ?? snapshot.sourceAt!;
    const clocks = [upAt, downAt, yesAt, noAt];
    if (prices.some(price => price == null || !Number.isFinite(price) || price <= 0 || price >= 1)
      || clocks.some(clock => clock == null || !Number.isFinite(clock) || clock <= 0)
      || yes.bid! > yes.ask! || no.bid! > no.ask!
      || snapshot.expiresAt! <= Math.min(yesAt, noAt)) {
      this.disconnect();
      return false;
    }
    // Bound exchange/local clock skew. The raw exchange clock remains in the
    // snapshot, so a dashboard heartbeat still cannot refresh an old quote.
    if (clocks.some(clock => clock != null && clock * 1_000 > receivedAt * 1_000 + MAX_CLOCK_SKEW_MS)) {
      this.disconnect();
      return false;
    }
    const previousYesAt = this.accepted?.YES?.sourceAt ?? 0;
    const previousNoAt = this.accepted?.NO?.sourceAt ?? 0;
    if (this.accepted && (snapshot.sequence! <= this.accepted.sequence!
      || yesAt < previousYesAt || noAt < previousNoAt)) return false;
    this.connected = true;
    this.accepted = copy(snapshot);
    this.upReceivedAt = upAt;
    this.downReceivedAt = downAt;
    return true;
  }

  private row(now: number): MarketProjectionRow {
    const accepted = this.accepted;
    const yes = accepted?.YES;
    const no = accepted?.NO;
    const upReceiveAge = accepted && this.upReceivedAt ? (now - this.upReceivedAt) * 1000 : null;
    const downReceiveAge = accepted && this.downReceivedAt ? (now - this.downReceivedAt) * 1000 : null;
    const upExchangeAge = yes?.sourceAt != null ? (now - yes.sourceAt) * 1000 : null;
    const downExchangeAge = no?.sourceAt != null ? (now - no.sourceAt) * 1000 : null;
    // Both clocks participate in freshness.  A delayed old frame cannot extend
    // the quote merely because it was received moments ago.
    const upAge = upReceiveAge != null ? Math.max(0, upReceiveAge, upExchangeAge ?? 0) : null;
    const downAge = downReceiveAge != null ? Math.max(0, downReceiveAge, downExchangeAge ?? 0) : null;
    const ready = yes?.bid != null && yes.ask != null && no?.bid != null && no.ask != null
      && accepted?.marketId != null && accepted.roundId != null && accepted.sequence != null
      && accepted.sourceAt != null && accepted.expiresAt != null;
    const ages = [upReceiveAge, downReceiveAge, upExchangeAge, downExchangeAge];
    const fresh = ready && accepted!.expiresAt! > now
      && accepted!.sourceAt! * 1_000 <= now * 1_000 + MAX_CLOCK_SKEW_MS
      && ages.every(age => age != null && age >= -MAX_CLOCK_SKEW_MS && age <= this.staleAfterMs);
    const quoteAt = yes?.sourceAt != null && no?.sourceAt != null
      ? Math.min(yes.sourceAt, no.sourceAt) : 0;
    const pairedSnapshot = accepted && {
      marketId: accepted.marketId!, roundId: accepted.roundId!, sequence: accepted.sequence!,
      sourceAt: accepted.sourceAt!, expiresAt: accepted.expiresAt!,
      YES: copy(yes!), NO: copy(no!),
    };
    const upBidLevels = yes?.bids ? copy(yes.bids) : null;
    const upAskLevels = yes?.asks ? copy(yes.asks) : null;
    const downBidLevels = no?.bids ? copy(no.bids) : null;
    const downAskLevels = no?.asks ? copy(no.asks) : null;
    return {
      paired_snapshot: pairedSnapshot,
      healthy: Boolean(this.connected && fresh),
      slug: this.slug, condition_id: this.conditionId, up_token: this.upToken, down_token: this.downToken,
      start: this.start, end: this.end,
      up_bid: finite(yes?.bid), up_ask: finite(yes?.ask), down_bid: finite(no?.bid), down_ask: finite(no?.ask),
      up_bid_size: finite(yes?.bidSize), up_ask_size: finite(yes?.askSize), down_bid_size: finite(no?.bidSize), down_ask_size: finite(no?.askSize),
      up_bid_levels: upBidLevels, up_ask_levels: upAskLevels,
      down_bid_levels: downBidLevels, down_ask_levels: downAskLevels,
      tick_size: finite(accepted?.tickSize), up_tick_size: finite(accepted?.upTickSize), down_tick_size: finite(accepted?.downTickSize),
      ask_sum: yes?.ask != null && no?.ask != null ? yes.ask + no.ask : null,
      quote_at: quoteAt ? iso(quoteAt) : null,
      up_exchange_at: yes?.sourceAt ? iso(yes.sourceAt) : null,
      down_exchange_at: no?.sourceAt ? iso(no.sourceAt) : null,
      up_quote_age_ms: upAge, down_quote_age_ms: downAge,
      book_depth_ready: Boolean(upBidLevels?.length === 5 && upAskLevels?.length === 5
        && downBidLevels?.length === 5 && downAskLevels?.length === 5),
      quote_fresh: fresh, source: "polymarket-ws",
    };
  }

  snapshot(now = Date.now() / 1000): MarketProjectionSnapshot {
    if (!Number.isFinite(now)) throw new Error("now must be finite");
    const inWindow = (this.start == null || now >= this.start) && (this.end == null || now < this.end);
    const row = this.row(now); const online = this.connected && inWindow && row.quote_fresh;
    const result: MarketProjectionSnapshot = {
      checked_at: iso(now), collector_online: online, collector_connected: this.connected,
      stale_after_ms: this.staleAfterMs, source: "polymarket-ws", current_markets: online ? [row] : [],
    };
    if (!this.connected) result.stale_reason = "CLOB Market WebSocket 未连接";
    else if (!inWindow) result.stale_reason = "当前市场窗口已结束";
    else if (!row.quote_fresh) result.stale_reason = row.quote_at ? "CLOB Market WebSocket 行情过期" : "等待完整 YES/NO 双边盘口";
    return copy(result);
  }
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
