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

export interface BookSnapshotMethods {
  prices(): [number, number, number, number] | undefined;
  isComplete(): boolean;
}

export function bookPrices(
  b: BookSnapshot,
): [number, number, number, number] | undefined {
  if (
    b.upBid == null ||
    b.upAsk == null ||
    b.downBid == null ||
    b.downAsk == null
  ) {
    return undefined;
  }
  return [b.upBid, b.upAsk, b.downBid, b.downAsk];
}

export function bookIsComplete(b: BookSnapshot): boolean {
  return bookPrices(b) != null;
}

export type FeedEvent =
  | { kind: "btc"; tsUnix: number; price: number }
  | { kind: "oracle"; tsUnix: number; price: number }
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
  | { kind: "bookStatus"; healthy: boolean; connected?: boolean;
      reason?: "connected_waiting_book" | "complete_book" | "incomplete_book" | "transport_disconnected"; tsUnix: number };

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

function expiredBook(event: FeedEvent): boolean {
  return event.kind === "book" && event.snapshot.expiresAt != null
    && event.snapshot.expiresAt <= nowUnix();
}

/** Async queue feeds push into; orchestrator drains. */
export class FeedQueue {
  private priority: FeedEvent[] = [];
  private decisions: FeedEvent[] = [];
  private config: FeedEvent[] = [];
  private telemetry: FeedEvent[] = [];
  private waiters: Array<() => void> = [];
  private static readonly MAX_TELEMETRY_EVENTS = 256;

  push(event: FeedEvent): void {
    if (
      event.kind === "user" ||
      event.kind === "userStatus" ||
      event.kind === "bookStatus"
    ) {
      this.priority.push(event);
    } else if (event.kind === "tickSize") {
      const existing = this.config.findIndex((queued) =>
        queued.kind === "tickSize" && queued.token === event.token);
      if (existing >= 0) this.config.splice(existing, 1);
      this.config.push(event);
    } else if (event.kind === "venue") {
      // Already consumed by the BTC aggregator. Do not add unused queue load.
      return;
    } else if (event.kind === "book" || event.kind === "btc" || event.kind === "oracle") {
      // Decisions only need the newest unprocessed market state. Keeping every
      // stale quote after an HTTP ACK pause creates avoidable reaction lag.
      const existing = this.decisions.findIndex((queued) => queued.kind === event.kind);
      if (existing >= 0) this.decisions.splice(existing, 1);
      this.decisions.push(event);
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
    const priority = this.priority.shift();
    if (priority) return priority;
    while (this.decisions.length > 0) {
      const event = this.decisions.shift()!;
      if (!expiredBook(event)) return event;
    }
    const config = this.config.shift();
    if (config) return config;
    while (this.telemetry.length > 0) {
      const event = this.telemetry.shift()!;
      if (!expiredBook(event)) return event;
    }
    return undefined;
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
