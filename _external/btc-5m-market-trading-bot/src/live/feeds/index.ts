/** Shared feed types + queue for orchestrator. */

import type { UserFeedEvent } from "./user.js";

export interface BookSnapshot {
  tsUnix: number;
  source?: "polymarket-ws" | "clob-rest" | "tokyo-rest";
  /** Exchange timestamps for each side; receive time is not a live freshness signal. */
  upExchangeTsUnix?: number;
  downExchangeTsUnix?: number;
  upBid?: number;
  upAsk?: number;
  downBid?: number;
  downAsk?: number;
  upBidSz?: number;
  upAskSz?: number;
  downBidSz?: number;
  downAskSz?: number;
  upBidLevels?: [number, number][];
  downBidLevels?: [number, number][];
  upSellTradeRate?: number;
  downSellTradeRate?: number;
  tickSize?: number;
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
  | { kind: "user"; event: UserFeedEvent }
  | { kind: "userStatus"; healthy: boolean; tsUnix: number }
  | { kind: "bookStatus"; healthy: boolean; tsUnix: number };

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

/** Async queue feeds push into; orchestrator drains. */
export class FeedQueue {
  private priority: FeedEvent[] = [];
  private events: FeedEvent[] = [];
  private waiters: Array<() => void> = [];

  push(event: FeedEvent): void {
    if (
      event.kind === "user" ||
      event.kind === "userStatus" ||
      event.kind === "bookStatus"
    ) {
      this.priority.push(event);
    } else if (event.kind === "venue") {
      // Already consumed by the BTC aggregator. Do not add unused queue load.
      return;
    } else if (event.kind === "book" || event.kind === "btc" || event.kind === "oracle") {
      // Decisions only need the newest unprocessed market state. Keeping every
      // stale quote after an HTTP ACK pause creates avoidable reaction lag.
      const existing = this.events.findIndex((queued) => queued.kind === event.kind);
      if (existing >= 0) this.events.splice(existing, 1);
      this.events.push(event);
    } else {
      this.events.push(event);
    }
    const w = this.waiters.shift();
    if (w) w();
  }

  tryPop(): FeedEvent | undefined {
    return this.priority.shift() ?? this.events.shift();
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
