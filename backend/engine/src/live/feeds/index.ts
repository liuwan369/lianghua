/** Shared feed types + queue for orchestrator. */

import type { UserFeedEvent } from "./user.js";

export interface BookSnapshot {
  /** Stable market identity shared by the strategy and public projection. */
  marketId?: string;
  roundId?: string;
  /** Local monotonic sequence for accepted bilateral snapshots. */
  sequence?: number;
  /** Newest venue timestamp represented by this snapshot. */
  sourceAt?: number;
  /** Unix time after which this snapshot must not be used for trading. */
  expiresAt?: number;
  /** Paired normalized asset quotes consumed by new clients. */
  YES?: MarketAssetSnapshot;
  NO?: MarketAssetSnapshot;
  tsUnix: number;
  receivedAtUnix?: number;
  receivedAtMonoMs?: number;
  processedAtMonoMs?: number;
  marketAgeMs?: number;
  source?: "polymarket-ws" | "clob-rest" | "collector-rest";
  /** Exchange timestamps for ordering; local receive age is checked separately. */
  upExchangeTsUnix?: number;
  downExchangeTsUnix?: number;
  upReceivedAtUnix?: number;
  downReceivedAtUnix?: number;
  upReceivedAtMonoMs?: number;
  downReceivedAtMonoMs?: number;
  upProcessedAtMonoMs?: number;
  downProcessedAtMonoMs?: number;
  upMarketAgeMs?: number;
  downMarketAgeMs?: number;
  upBid?: number;
  upAsk?: number;
  downBid?: number;
  downAsk?: number;
  upBidSz?: number;
  upAskSz?: number;
  downBidSz?: number;
  downAskSz?: number;
  upBidLevels?: [number, number][];
  upAskLevels?: [number, number][];
  downBidLevels?: [number, number][];
  downAskLevels?: [number, number][];
  upSellTradeRate?: number;
  downSellTradeRate?: number;
  tickSize?: number;
  upTickSize?: number;
  downTickSize?: number;
}

export interface MarketAssetSnapshot {
  assetId: string;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  bids?: [number, number][];
  asks?: [number, number][];
  sourceAt?: number;
  expiresAt?: number;
  sequence?: number;
}

export interface FeedMarketIdentity {
  marketId?: string;
  roundId?: string;
  yesAssetId?: string;
  noAssetId?: string;
}

export type FeedEvent =
  | { kind: "btc"; asset?: string; tsUnix: number; price: number }
  | { kind: "oracle"; asset?: string; tsUnix: number; price: number }
  | { kind: "book"; snapshot: BookSnapshot }
  | { kind: "tickSize"; token: string; tickSize: number; tsUnix: number }
  | {
      kind: "marketTrade";
      token: string;
      price: number;
      shares: number;
      takerSide: string;
      tsUnix: number;
    }
  | {
      kind: "venue";
      venue: number;
      tsUnix: number;
      bid: number;
      ask: number;
      bidSz: number;
      askSz: number;
    }
  | { kind: "user"; event: UserFeedEvent; receivedAtMonoMs?: number }
  | { kind: "userStatus"; healthy: boolean; tsUnix: number }
  | ({ kind: "bookStatus"; healthy: boolean; connected?: boolean;
      reason?: "connected_waiting_book" | "complete_book" | "incomplete_book" | "stale_book" | "transport_disconnected"; tsUnix: number } & FeedMarketIdentity);

export function nowUnix(): number {
  return Date.now() / 1000;
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export type FeedSink = (event: FeedEvent) => void;

function roundEnd(roundId: string | undefined): number | undefined {
  if (!roundId || !/^\d+$/.test(roundId)) return undefined;
  const value = Number(roundId);
  return Number.isSafeInteger(value) && value % 300 === 0 ? value + 300 : undefined;
}

function bookExpiry(snapshot: BookSnapshot): number {
  let expiresAt = roundEnd(snapshot.roundId) ?? Infinity;
  for (const value of [snapshot.expiresAt, snapshot.YES?.expiresAt, snapshot.NO?.expiresAt]) {
    if (value == null) continue;
    if (!Number.isFinite(value)) return -Infinity;
    expiresAt = Math.min(expiresAt, value);
  }
  return expiresAt;
}

function bookKey(identity: FeedMarketIdentity): string {
  // Both the condition id and outcome tokens change at each five-minute round.
  // Prefer the complete token pair so resolving marketId does not split a stream.
  if (identity.yesAssetId && identity.noAssetId) {
    return JSON.stringify(["book", identity.roundId, identity.yesAssetId, identity.noAssetId]);
  }
  return JSON.stringify(["book", identity.roundId, identity.marketId ?? "legacy"]);
}

function snapshotKey(snapshot: BookSnapshot): string {
  return bookKey({ marketId: snapshot.marketId, roundId: snapshot.roundId,
    yesAssetId: snapshot.YES?.assetId, noAssetId: snapshot.NO?.assetId });
}

interface BookWatermark {
  marketId?: string;
  sequence?: number;
  sourceAt?: number;
  yesAt?: number;
  noAt?: number;
  tsUnix: number;
  retainUntil: number;
}

function regressed(next: number | undefined, previous: number | undefined): boolean {
  return previous != null && (next == null || next < previous);
}

/** Async queue feeds push into; orchestrator drains. */
export class FeedQueue {
  private priority: FeedEvent[] = [];
  private decisions = new Map<string, FeedEvent>();
  private config = new Map<string, Extract<FeedEvent, { kind: "tickSize" }>>();
  private telemetry: FeedEvent[] = [];
  private waiters: Array<() => void> = [];
  private readonly acceptedBooks = new Map<string, BookWatermark>();
  private nextPruneAt = 0;
  private static readonly MAX_TELEMETRY_EVENTS = 256;

  push(event: FeedEvent): void {
    const now = nowUnix();
    this.prune(now);
    if (
      event.kind === "user" ||
      event.kind === "userStatus" ||
      event.kind === "bookStatus"
    ) {
      if (event.kind === "bookStatus" && !event.healthy) {
        // Invalidate only this feed's pending decision, even before marketId is known.
        this.decisions.delete(bookKey(event));
      }
      this.priority.push(event);
    } else if (event.kind === "tickSize") {
      const previous = this.config.get(event.token);
      if (previous && event.tsUnix <= previous.tsUnix) return;
      this.config.set(event.token, event);
    } else if (event.kind === "venue") {
      // Already consumed by the BTC aggregator. Do not add unused queue load.
      return;
    } else if (event.kind === "book") {
      // Decisions only need the newest unprocessed market state. Keeping every
      // stale quote after an HTTP ACK pause creates avoidable reaction lag.
      const snapshot = event.snapshot;
      if (bookExpiry(snapshot) <= now) return;
      const key = snapshotKey(snapshot);
      const previous = this.acceptedBooks.get(key);
      const next: BookWatermark = {
        marketId: snapshot.marketId ?? previous?.marketId,
        sequence: snapshot.sequence,
        sourceAt: snapshot.sourceAt,
        yesAt: snapshot.YES?.sourceAt ?? snapshot.upExchangeTsUnix,
        noAt: snapshot.NO?.sourceAt ?? snapshot.downExchangeTsUnix,
        tsUnix: snapshot.tsUnix,
        retainUntil: roundEnd(snapshot.roundId) ?? now + 300,
      };
      if ([next.sourceAt, next.yesAt, next.noAt, next.tsUnix].some(value =>
        value != null && (!Number.isFinite(value) || value < 0))) return;
      if (next.sequence != null && (!Number.isSafeInteger(next.sequence) || next.sequence < 0)) return;
      if (previous) {
        if (previous.marketId && snapshot.marketId && previous.marketId !== snapshot.marketId) return;
        if (previous.sequence != null && (next.sequence == null || next.sequence <= previous.sequence)) return;
        if (regressed(next.sourceAt, previous.sourceAt) || regressed(next.yesAt, previous.yesAt)
          || regressed(next.noAt, previous.noAt)) return;
        if (next.sequence == null && next.tsUnix <= previous.tsUnix) return;
      }
      this.acceptedBooks.set(key, next);
      // Map replacement keeps a busy market's place instead of starving others.
      this.decisions.set(key, event);
    } else if (event.kind === "btc" || event.kind === "oracle") {
      const key = JSON.stringify([event.kind, event.asset?.trim().toLowerCase() || "btc"]);
      const previous = this.decisions.get(key);
      if (previous && (previous.kind === "btc" || previous.kind === "oracle")
        && event.tsUnix < previous.tsUnix) return;
      this.decisions.set(key, event);
    } else {
      // Trades are useful telemetry, but they must never delay a decision
      // snapshot after a slow consumer pauses the queue.
      if (this.telemetry.length >= FeedQueue.MAX_TELEMETRY_EVENTS) this.telemetry.shift();
      this.telemetry.push(event);
    }
    const w = this.waiters.shift();
    if (w) w();
  }

  tryPop(): FeedEvent | undefined {
    const now = nowUnix();
    this.prune(now);
    const priority = this.priority.shift();
    if (priority) return priority;
    for (const [key, event] of this.decisions) {
      this.decisions.delete(key);
      if (event.kind !== "book" || bookExpiry(event.snapshot) > now) return event;
    }
    for (const [key, event] of this.config) {
      this.config.delete(key);
      return event;
    }
    return this.telemetry.shift();
  }

  private prune(now: number): void {
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + 1;
    for (const [key, watermark] of this.acceptedBooks) {
      if (watermark.retainUntil <= now) this.acceptedBooks.delete(key);
    }
    for (const [key, event] of this.decisions) {
      if (event.kind === "book" && bookExpiry(event.snapshot) <= now) this.decisions.delete(key);
    }
  }

  pop(timeoutMs: number): Promise<FeedEvent | null> {
    const immediate = this.tryPop();
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const i = this.waiters.indexOf(onWake);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(this.tryPop() ?? null);
      }, timeoutMs);

      const onWake = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(this.tryPop() ?? null);
      };

      this.waiters.push(onWake);
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
