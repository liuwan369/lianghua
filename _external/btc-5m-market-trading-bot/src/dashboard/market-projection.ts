/** Public, read-only market quote projection for the dashboard. */
import { mkdirSync, openSync, closeSync, renameSync, writeFileSync, fsyncSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { BookSnapshot } from "../live/feeds/index.js";

export const DEFAULT_STALE_AFTER_MS = 2_000;
const MAX_CLOCK_SKEW_MS = 1_000;

export interface MarketProjectionConfig {
  upToken: string;
  downToken: string;
  slug?: string;
  conditionId?: string;
  start?: number;
  end?: number;
  staleAfterMs?: number;
}

export interface MarketProjectionRow {
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
  readonly start: number | null;
  readonly end: number | null;
  readonly staleAfterMs: number;
  private connected = false;
  private up: BookSnapshot | undefined;
  private down: BookSnapshot | undefined;
  private upReceivedAt = 0;
  private downReceivedAt = 0;

  constructor(config: MarketProjectionConfig) {
    if (!config.upToken || !config.downToken || config.upToken === config.downToken) throw new Error("upToken and downToken must be distinct");
    const stale = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isFinite(stale) || stale < 0) throw new Error("staleAfterMs must be non-negative");
    this.upToken = config.upToken; this.downToken = config.downToken;
    this.slug = config.slug ?? ""; this.conditionId = config.conditionId ?? "";
    this.start = config.start ?? null; this.end = config.end ?? null; this.staleAfterMs = stale;
  }

  markConnected(value = true): void { this.connected = value; }
  invalidateBook(): void {
    this.up = undefined;
    this.down = undefined;
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
    const prices = [snapshot.upBid, snapshot.upAsk, snapshot.downBid, snapshot.downAsk];
    const upAt = snapshot.upReceivedAtUnix ?? receivedAt;
    const downAt = snapshot.downReceivedAtUnix ?? receivedAt;
    const clocks = [upAt, downAt, snapshot.upExchangeTsUnix, snapshot.downExchangeTsUnix];
    if (prices.some(price => price == null || !Number.isFinite(price) || price <= 0 || price >= 1)
      || clocks.some(clock => clock == null || !Number.isFinite(clock) || clock <= 0)
      || snapshot.upBid! > snapshot.upAsk! || snapshot.downBid! > snapshot.downAsk!) {
      this.disconnect();
      return false;
    }
    // Bound exchange/local clock skew. The raw exchange clock remains in the
    // snapshot, so a dashboard heartbeat still cannot refresh an old quote.
    if (clocks.some(clock => clock != null && clock * 1_000 > receivedAt * 1_000 + MAX_CLOCK_SKEW_MS)) {
      this.disconnect();
      return false;
    }
    if ((this.up?.upExchangeTsUnix ?? 0) > snapshot.upExchangeTsUnix!
      || (this.down?.downExchangeTsUnix ?? 0) > snapshot.downExchangeTsUnix!) return false;
    this.connected = true;
    // The feed has already applied the entire frame. Store its paired state
    // together, rather than merging independently observed half-books.
    this.up = this.down = copy(snapshot);
    this.upReceivedAt = upAt;
    this.downReceivedAt = downAt;
    return true;
  }

  private row(now: number): MarketProjectionRow {
    const up = this.up; const down = this.down;
    const upReceiveAge = up && this.upReceivedAt ? (now - this.upReceivedAt) * 1000 : null;
    const downReceiveAge = down && this.downReceivedAt ? (now - this.downReceivedAt) * 1000 : null;
    const upExchangeAge = up?.upExchangeTsUnix != null ? (now - up.upExchangeTsUnix) * 1000 : null;
    const downExchangeAge = down?.downExchangeTsUnix != null ? (now - down.downExchangeTsUnix) * 1000 : null;
    // Both clocks participate in freshness.  A delayed old frame cannot extend
    // the quote merely because it was received moments ago.
    const upAge = upReceiveAge != null ? Math.max(0, upReceiveAge, upExchangeAge ?? 0) : null;
    const downAge = downReceiveAge != null ? Math.max(0, downReceiveAge, downExchangeAge ?? 0) : null;
    const ready = up?.upBid != null && up.upAsk != null && down?.downBid != null && down.downAsk != null;
    const ages = [upReceiveAge, downReceiveAge, upExchangeAge, downExchangeAge];
    const fresh = ready && ages.every(age => age != null && age >= -MAX_CLOCK_SKEW_MS && age <= this.staleAfterMs);
    const quoteAt = ready && up?.upExchangeTsUnix != null && down?.downExchangeTsUnix != null
      ? Math.min(up.upExchangeTsUnix, down.downExchangeTsUnix) : 0;
    return {
      slug: this.slug, condition_id: this.conditionId, up_token: this.upToken, down_token: this.downToken,
      start: this.start, end: this.end,
      up_bid: finite(up?.upBid), up_ask: finite(up?.upAsk), down_bid: finite(down?.downBid), down_ask: finite(down?.downAsk),
      up_bid_size: finite(up?.upBidSz), up_ask_size: finite(up?.upAskSz), down_bid_size: finite(down?.downBidSz), down_ask_size: finite(down?.downAskSz),
      up_bid_levels: up?.upBidLevels ? copy(up.upBidLevels) : null, up_ask_levels: up?.upAskLevels ? copy(up.upAskLevels) : null,
      down_bid_levels: down?.downBidLevels ? copy(down.downBidLevels) : null, down_ask_levels: down?.downAskLevels ? copy(down.downAskLevels) : null,
      tick_size: finite(up?.tickSize ?? down?.tickSize), up_tick_size: finite(up?.upTickSize), down_tick_size: finite(down?.downTickSize),
      ask_sum: up?.upAsk != null && down?.downAsk != null ? up.upAsk + down.downAsk : null,
      quote_at: quoteAt ? iso(quoteAt) : null,
      up_exchange_at: up?.upExchangeTsUnix ? iso(up.upExchangeTsUnix) : null,
      down_exchange_at: down?.downExchangeTsUnix ? iso(down.downExchangeTsUnix) : null,
      up_quote_age_ms: upAge, down_quote_age_ms: downAge, book_depth_ready: Boolean(up?.upBidLevels && up?.upAskLevels && down?.downBidLevels && down?.downAskLevels),
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
    else if (!row.quote_fresh) result.stale_reason = row.quote_at ? "CLOB Market WebSocket 行情过期" : "等待完整 UP/DOWN 双边盘口";
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
