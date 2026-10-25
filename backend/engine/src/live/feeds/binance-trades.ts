/** Binance aggregated trades (aggTrade) on two public lines, deduplicated by
 * the aggregate id, and the 250 ms lead-signal detector that runs on them.
 * The rule is frozen in E:/pm-backup/forward-binance-agg.py (signals()). */
import WebSocket from "ws";
import type { FeedEvent } from "./index.js";

export interface AggTrade {
  /** Aggregate trade id `a`; strictly increasing per symbol. */
  id: number;
  price: number;
  /** Binance trade time `T`, milliseconds. */
  tradeTimeMs: number;
  /** Local wall clock when the frame reached us (seconds). */
  receivedAtUnix: number;
  receivedAtMonoMs: number;
}

export type LeadDirection = "UP" | "DOWN";
export interface LeadSignal {
  direction: LeadDirection;
  price: number;
  /** Window low (UP) or high (DOWN) the move is measured from. */
  refPrice: number;
  /** ln(price / refPrice) × 1e4: positive for UP, negative for DOWN. */
  moveBp: number;
  tradeId: number;
  tradeTimeMs: number;
  receivedAtUnix: number;
  receivedAtMonoMs: number;
}
export interface LeadSignalParams {
  windowMs: number;
  thresholdBp: number;
  /** Valid seconds after the round open: S - R in [fromSec, toSec). */
  fromSec: number;
  toSec: number;
}

export const binanceTradeUrls = (symbol: string): string[] => [
  `wss://stream.binance.com:9443/ws/${symbol}@aggTrade`,
  `wss://data-stream.binance.vision/ws/${symbol}@aggTrade`,
];
const IDLE_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** The rule was measured with a trade seen ~125 ms after it happened (p90
 * ~360 ms). A copy older than this, e.g. the lagging line after the leading one
 * dropped, would be a stale signal at today's book. */
const MAX_TRADE_AGE_MS = 1_000;
/** Trade time ahead of our clock (chrony keeps it under 1 ms). */
const MAX_TRADE_LEAD_MS = 1_000;
/** BTCUSDT runs ~10 aggregate trades a second; a bigger id jump is a bad frame. */
const MAX_ID_JUMP = 1_000_000;

/** Parse one aggTrade frame and pass it on only if its id is newer than every
 * id already delivered and it happened within MAX_TRADE_AGE_MS. Both lines
 * share one ingest, so whichever line is first wins and the later copy is
 * dropped; delivery order follows the id. */
export function createAggTradeIngest(onTrade: (trade: AggTrade) => void) {
  let lastId = -1;
  // Whether the last frame was a current trade (delivered, or a fresh copy the
  // other line already delivered): what keeps a line counted as alive.
  let current = false;
  const ingest = (raw: unknown, receivedAtUnix: number, receivedAtMonoMs: number): boolean => {
    current = false;
    let message: { a?: unknown; p?: unknown; T?: unknown };
    try { message = JSON.parse(String(raw)); } catch { return false; }
    const id = message?.a;
    const price = Number(message?.p), tradeTimeMs = message?.T;
    if (typeof id !== "number" || !(price > 0) || price === Infinity || typeof tradeTimeMs !== "number") return false;
    const ageMs = receivedAtUnix * 1000 - tradeTimeMs;
    if (!(ageMs <= MAX_TRADE_AGE_MS && ageMs >= -MAX_TRADE_LEAD_MS)) return false;
    if (!(id > lastId)) { current = true; return false; }
    if (lastId >= 0 && id - lastId > MAX_ID_JUMP) return false;
    lastId = id;
    current = true;
    onTrade({ id, price, tradeTimeMs, receivedAtUnix, receivedAtMonoMs });
    return true;
  };
  return Object.assign(ingest, { lastWasCurrent: () => current });
}

function connect(url: string, sockets: Set<WebSocket>, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("stopped")); return; }
    const ws = new WebSocket(url);
    sockets.add(ws);
    ws.on("error", () => {});
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("open", onOpen); ws.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (error) { sockets.delete(ws); ws.terminate(); reject(error); } else resolve(ws);
    };
    const onOpen = () => finish();
    const onClose = () => finish(new Error("closed before open"));
    const onAbort = () => finish(new Error("stopped"));
    const timer = setTimeout(() => finish(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    ws.once("open", onOpen); ws.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function lineLoop(url: string, line: number, ingest: ReturnType<typeof createAggTradeIngest>,
  lastMessageAt: number[], signal: AbortSignal, sockets: Set<WebSocket>): Promise<void> {
  while (!signal.aborted) {
    let ws: WebSocket | undefined;
    try {
      ws = await connect(url, sockets, signal);
      const socket = ws;
      const connectedAt = Date.now();
      await new Promise<void>(resolve => {
        let finished = false;
        // Binance closes every connection after 24 h; silence is a dead line too.
        const idle = setInterval(() => {
          if (Date.now() - Math.max(connectedAt, lastMessageAt[line]!) >= IDLE_MS) finish();
        }, 1000);
        const finish = () => {
          if (finished) return;
          finished = true;
          clearInterval(idle);
          signal.removeEventListener("abort", finish);
          socket.off("message", onMessage); socket.off("close", finish); socket.off("error", finish);
          resolve();
        };
        const onMessage = (raw: WebSocket.RawData) => {
          const receivedAtMonoMs = performance.now();
          const receivedAtMs = Date.now();
          // Alive = this line carries current trades (its own copy or a fresh
          // duplicate); pings, garbage and stale copies do not count.
          try { ingest(raw, receivedAtMs / 1000, receivedAtMonoMs); }
          catch { /* A consumer error must not kill the line. */ }
          if (ingest.lastWasCurrent()) lastMessageAt[line] = receivedAtMs;
        };
        socket.on("message", onMessage); socket.once("close", finish); socket.once("error", finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    } catch { /* Reconnect below. */ }
    finally { if (ws) { sockets.delete(ws); ws.terminate(); } }
    if (!signal.aborted) await pause(1000 + Math.random() * 1000, signal);
  }
}

/** Two public aggTrade lines for one symbol; each trade is delivered once. */
export function runBinanceTrades(onTrade: (trade: AggTrade) => void, symbol = "btcusdt",
  urls: readonly string[] = binanceTradeUrls(symbol)): { stop: () => void; isHealthy: () => boolean } {
  const controller = new AbortController();
  const sockets = new Set<WebSocket>();
  const lastMessageAt = urls.map(() => 0);
  const ingest = createAggTradeIngest(onTrade);
  urls.forEach((url, line) => { void lineLoop(url, line, ingest, lastMessageAt, controller.signal, sockets); });
  return {
    stop: () => {
      if (controller.signal.aborted) return;
      controller.abort();
      for (const socket of sockets) socket.terminate();
      sockets.clear();
    },
    isHealthy: () => !controller.signal.aborted && lastMessageAt.some(at => at > 0 && Date.now() - at < IDLE_MS),
  };
}

/** Rule 1-3 of the frozen lead rule. A trade is a signal when its price is at
 * least thresholdBp above the lowest (UP) or below the highest (DOWN) price of
 * the trades within windowMs before it (by trade time, the boundary kept). Only
 * a trade seen at S with S - floor(S/300)*300 in [fromSec, toSec) can signal;
 * a valid signal leaves only itself in the window, an out-of-period one does
 * nothing. Window min/max are monotonic queues, O(1) amortised per trade. */
export class LeadSignalDetector {
  private params: LeadSignalParams;
  // Window trades by sequence number: index = seq - base. `head` is the oldest
  // sequence still inside the window, `next` the sequence of the next trade.
  private times: number[] = [];
  private prices: number[] = [];
  private base = 0;
  private head = 0;
  private next = 0;
  // Sequences whose prices increase (min queue) / decrease (max queue).
  private minQ: number[] = [];
  private minHead = 0;
  private maxQ: number[] = [];
  private maxHead = 0;

  constructor(params: LeadSignalParams) { this.params = LeadSignalDetector.check(params); }

  /** Takes effect from the next trade. */
  update(params: LeadSignalParams): void { this.params = LeadSignalDetector.check(params); }

  push(trade: AggTrade, seenAtUnix: number): LeadSignal | undefined {
    const { windowMs, thresholdBp, fromSec, toSec } = this.params;
    const t = trade.tradeTimeMs, p = trade.price;
    const cutoff = t - windowMs;
    while (this.head < this.next && this.times[this.head - this.base]! < cutoff) this.head += 1;
    while (this.minHead < this.minQ.length && this.minQ[this.minHead]! < this.head) this.minHead += 1;
    while (this.maxHead < this.maxQ.length && this.maxQ[this.maxHead]! < this.head) this.maxHead += 1;
    this.append(t, p);
    const open = Math.floor(seenAtUnix / 300) * 300;
    if (!(seenAtUnix >= open + fromSec && seenAtUnix < open + toSec)) return undefined;
    const threshold = thresholdBp / 1e4;
    const low = this.prices[this.minQ[this.minHead]! - this.base]!;
    const high = this.prices[this.maxQ[this.maxHead]! - this.base]!;
    let direction: LeadDirection, refPrice: number, move: number;
    const up = Math.log(p / low);
    if (up >= threshold) { direction = "UP"; refPrice = low; move = up; }
    else {
      const down = Math.log(p / high);
      if (!(down <= -threshold)) return undefined;
      direction = "DOWN"; refPrice = high; move = down;
    }
    // Python: win.clear(); win.append((t, p))
    this.times.length = 0; this.prices.length = 0; this.minQ.length = 0; this.maxQ.length = 0;
    this.minHead = 0; this.maxHead = 0;
    this.base = this.head = this.next;
    this.append(t, p);
    return { direction, price: p, refPrice, moveBp: move * 1e4, tradeId: trade.id, tradeTimeMs: t,
      receivedAtUnix: trade.receivedAtUnix, receivedAtMonoMs: trade.receivedAtMonoMs };
  }

  private append(t: number, p: number): void {
    const seq = this.next++;
    this.times.push(t); this.prices.push(p);
    while (this.minQ.length > this.minHead && this.prices[this.minQ[this.minQ.length - 1]! - this.base]! >= p) this.minQ.pop();
    this.minQ.push(seq);
    while (this.maxQ.length > this.maxHead && this.prices[this.maxQ[this.maxQ.length - 1]! - this.base]! <= p) this.maxQ.pop();
    this.maxQ.push(seq);
    // Drop consumed prefixes once they dominate the arrays.
    const dead = this.head - this.base;
    if (dead > 1024 && dead * 2 > this.times.length) {
      this.times.splice(0, dead); this.prices.splice(0, dead); this.base = this.head;
    }
    if (this.minHead > 1024 && this.minHead * 2 > this.minQ.length) { this.minQ.splice(0, this.minHead); this.minHead = 0; }
    if (this.maxHead > 1024 && this.maxHead * 2 > this.maxQ.length) { this.maxQ.splice(0, this.maxHead); this.maxHead = 0; }
  }

  private static check(params: LeadSignalParams): LeadSignalParams {
    const { windowMs, thresholdBp, fromSec, toSec } = params;
    if (!(windowMs > 0 && windowMs <= 60_000) || !(thresholdBp > 0 && thresholdBp <= 1000)
      || !(fromSec >= 0 && fromSec < toSec && toSec <= 300)) throw new Error("invalid lead signal parameters");
    return { windowMs, thresholdBp, fromSec, toSec };
  }
}

/** The ConnectOptions.leadFeed producer: Binance trades through the detector,
 * signals out as lead feed events. S is the local receive time of the trade. */
export function binanceLeadFeed(detector: LeadSignalDetector, symbol = "btcusdt") {
  return (sink: (event: FeedEvent) => void): { stop: () => void; isHealthy: () => boolean } =>
    runBinanceTrades(trade => {
      const signal = detector.push(trade, trade.receivedAtUnix);
      if (signal) sink({ kind: "lead", ...signal });
    }, symbol);
}
