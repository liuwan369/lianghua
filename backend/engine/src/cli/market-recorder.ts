// Full market recording for replay and backtests (user decision 2026-10-01).
//
// Runs inside the market-snapshot collector, a separate process from the
// trading engine, so recording can never slow an order. Every book event the
// collector receives is one gzip'd JSON line in <dir>/<asset>/<YYYY-MM-DD>.jsonl.gz
// (Beijing day, the same day boundary as the loss stop). Files older than
// retentionDays are deleted. Compression runs in libuv's thread pool; the
// collector's event loop only formats a line. If the disk falls behind, lines
// are dropped and counted rather than buffered without limit.
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { constants, createGzip, type Gzip } from "node:zlib";
import { accountDayKey } from "../live/account-day.js";

/** One recorded book event. Short keys keep ~100 events/s affordable. */
export interface RecordedBook {
  /** collector receive time, unix seconds */ t: number;
  a: string; m: string; r: string; q?: number;
  /** venue exchange time per side, unix seconds */ ue?: number; de?: number;
  /** best bid/ask per side */ ub?: number; ua?: number; db?: number; da?: number;
  /** depth levels [price, size] per side */ ubl?: [number, number][]; ual?: [number, number][];
  dbl?: [number, number][]; dal?: [number, number][];
}

/** One recorded market trade print (last_trade_price): k "t", side tok u|d,
 * price p, size s, taker side BUY|SELL. Same file as the books. */
export interface RecordedTrade {
  t: number; a: string; m: string; r: string; k: "t"; tok: "u" | "d"; p: number; s: number; side: string;
}

/** A one-sided top of book (k "o"), venue time e; absent fields = empty side. */
export interface RecordedTop {
  t: number; a: string; m: string; r: string; k: "o"; e: number;
  ub?: number; ua?: number; db?: number; da?: number;
  ubl?: [number, number][]; ual?: [number, number][]; dbl?: [number, number][]; dal?: [number, number][];
}

export interface MarketRecorderOptions {
  directory: string;
  retentionDays: number;
  /** stop accepting lines while this many bytes wait for the disk */
  maxPendingBytes?: number;
  now?: () => number;
}


export class MarketRecorder {
  private readonly streams = new Map<string, { day: string; gzip: Gzip; file: WriteStream }>();
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private readonly pruneTimer: ReturnType<typeof setInterval>;
  private readonly maxPendingBytes: number;
  private readonly now: () => number;
  dropped = 0;
  written = 0;

  constructor(private readonly options: MarketRecorderOptions) {
    this.maxPendingBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
    this.now = options.now ?? (() => Date.now() / 1000);
    mkdirSync(options.directory, { recursive: true });
    // A sync flush each second bounds what a crash can lose to ~1 s per file.
    this.flushTimer = setInterval(() => { for (const { gzip } of this.streams.values()) gzip.flush(constants.Z_SYNC_FLUSH); }, 1000);
    this.pruneTimer = setInterval(() => this.prune(), 3600_000);
    this.flushTimer.unref?.(); this.pruneTimer.unref?.();
    this.prune();
  }

  record(book: RecordedBook | RecordedTrade | RecordedTop): void {
    const day = accountDayKey(book.t);
    let entry = this.streams.get(book.a);
    if (!entry || entry.day !== day) {
      entry?.gzip.end();
      const dir = join(this.options.directory, book.a.replace(/[^a-z0-9_-]/gi, ""));
      mkdirSync(dir, { recursive: true });
      // Append: a collector restart within the day adds a gzip member, which
      // zcat and gunzip read as one stream.
      const file = createWriteStream(join(dir, `${day}.jsonl.gz`), { flags: "a" });
      const gzip = createGzip({ level: 6 });
      gzip.pipe(file);
      gzip.on("error", () => { this.dropped += 1; });
      file.on("error", () => { this.dropped += 1; });
      entry = { day, gzip, file };
      this.streams.set(book.a, entry);
    }
    if (entry.gzip.writableLength + entry.file.writableLength > this.maxPendingBytes) { this.dropped += 1; return; }
    entry.gzip.write(`${JSON.stringify(book)}\n`);
    this.written += 1;
  }

  /** Delete day files older than retentionDays (by the date in the name). */
  prune(): void {
    const keepFrom = accountDayKey(this.now() - this.options.retentionDays * 86400);
    let assets: string[];
    try { assets = readdirSync(this.options.directory); } catch { return; }
    for (const asset of assets) {
      const dir = join(this.options.directory, asset);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      for (const name of readdirSync(dir)) {
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(name);
        if (match && match[1]! < keepFrom) {
          try { unlinkSync(join(dir, name)); } catch { /* next hour */ }
        }
      }
    }
  }

  close(): Promise<void> {
    clearInterval(this.flushTimer); clearInterval(this.pruneTimer);
    const done = [...this.streams.values()].map(({ gzip, file }) => new Promise<void>(resolve => {
      file.once("close", () => resolve()); file.once("error", () => resolve()); gzip.end();
    }));
    this.streams.clear();
    return Promise.all(done).then(() => undefined);
  }
}

/** A feed marketTrade of this round's up or down token as a recorded row. */
export function recordedTrade(asset: string, market: { marketId: string; roundId: string; upToken: string; downToken: string },
  trade: { token: string; price: number; shares: number; takerSide: string }, receivedAt: number): RecordedTrade | undefined {
  const tok = trade.token === market.upToken ? "u" : trade.token === market.downToken ? "d" : undefined;
  if (!tok) return undefined;
  return { t: Math.round(receivedAt * 1000) / 1000, a: asset, m: market.marketId, r: market.roundId, k: "t", tok,
    p: trade.price, s: trade.shares, side: trade.takerSide };
}

/** The fields worth keeping from a collector book snapshot. */
/** A one-sided top of book (one side has no bid or no ask, e.g. the winner at
 * 0.99 near the close). Row kind "o"; empty sides are simply absent. */
export function recordedTop(asset: string, event: { marketId?: string; roundId?: string; tsUnix: number;
  upBid?: number; upAsk?: number; downBid?: number; downAsk?: number;
  upAskLevels?: [number, number][]; downAskLevels?: [number, number][];
  upBidLevels?: [number, number][]; downBidLevels?: [number, number][] }, receivedAt: number): RecordedTop {
  const five = (levels?: [number, number][]) => levels?.length ? levels.slice(0, 5) : undefined;
  return { t: Math.round(receivedAt * 1000) / 1000, a: asset, m: String(event.marketId ?? ""), r: String(event.roundId ?? ""),
    k: "o", e: event.tsUnix, ub: event.upBid, ua: event.upAsk, db: event.downBid, da: event.downAsk,
    ubl: five(event.upBidLevels), ual: five(event.upAskLevels), dbl: five(event.downBidLevels), dal: five(event.downAskLevels) };
}

export function recordedBook(asset: string, snapshot: Record<string, unknown>, receivedAt: number): RecordedBook {
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const levels = (value: unknown) => Array.isArray(value)
    ? value.slice(0, 5).map(level => Array.isArray(level) ? [Number(level[0]), Number(level[1])] as [number, number]
      : [Number((level as { price?: unknown }).price), Number((level as { size?: unknown }).size)] as [number, number])
    : undefined;
  return {
    t: Math.round(receivedAt * 1000) / 1000, a: asset,
    m: String(snapshot.marketId ?? ""), r: String(snapshot.roundId ?? ""), q: num(snapshot.sequence),
    ue: num(snapshot.upExchangeTsUnix), de: num(snapshot.downExchangeTsUnix),
    ub: num(snapshot.upBid), ua: num(snapshot.upAsk), db: num(snapshot.downBid), da: num(snapshot.downAsk),
    ubl: levels(snapshot.upBidLevels), ual: levels(snapshot.upAskLevels),
    dbl: levels(snapshot.downBidLevels), dal: levels(snapshot.downAskLevels),
  };
}
