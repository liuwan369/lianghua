/** Lead trades on two public lines each, deduplicated, and the 250 ms
 * lead-signal detector that runs on them: Binance spot aggTrade (the frozen
 * rule, E:/pm-backup/forward-binance-agg.py signals()) or Bybit USDT perpetual
 * publicTrade (user 2026-10-29: same rule, earlier in Dublin at signals;
 * backtest E:/pm-backup/research-1028/bybit_vs_binance.py). */
import WebSocket from "ws";
import type { FeedEvent } from "./index.js";

export interface AggTrade {
  /** Binance: aggregate trade id `a`, strictly increasing per symbol. Bybit:
   * the trade's position in our delivery order (its venue id is a UUID). */
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
  /** The round's opening price: the last trade at or before the round start
   * (trade time), as the backtest (E:/pm-backup/research-1101/band.py). Absent
   * when the feed started inside the round. */
  openPrice?: number;
  /** Fair-value model P(the round settles UP) with trades up to this one
   * (leadFairUp). Absent without the history it needs (about 6 minutes). */
  fairUp?: number;
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
/** Seconds of per-second history kept for the fair-value model: it reads back
 * to R - 59 (the price to beat) and floor(T) - 300 (volatility), at most 325 s. */
const SEC_RING = 1024;
/** No trade for longer than this is a dead feed, not a quiet market (Bybit perp
 * 10-18/25, 11-01: longest quiet gap 29 s): the history restarts. */
const MAX_HISTORY_GAP_MS = 60_000;

/** Fair-value model of the lead venue's settlement (E:/pm-backup/research-1103
 * fv_trade.py p_up, fitted fv_calib.py): the round settles on the mean of the
 * last 60 s, (R+240, R+300], against the mean of the 60 s before the open,
 * (R-60, R]. With price(g) the last trade at or before whole second g:
 *   O = mean price(R-59..R); sigma = std (ddof 0) of the 1 s log returns ending
 *   at floor(T)-299..floor(T); e = seconds of the closing window already past,
 *   A their mean; E[F] = (e A + n S) / 60 with n = 60 - e, S the trade's price;
 *   sd(F) = (n/60) S sigma sqrt(sum_ij min(t_i, t_j)) / n, t_i = seconds from
 *   floor(T - R) to each future second of the window;
 *   P(UP) = Phi(C (E[F] - O) / sd(F)), C = 0.859 (fitted in-sample).
 * Information cutoff is the trade time T (ms). undefined when a second it needs
 * is outside the history. */
export function leadFairUp(price: (g: number) => number | undefined, tradeTimeMs: number, tradePrice: number): number | undefined {
  const R = Math.floor(tradeTimeMs / 300_000) * 300;
  const gv = Math.floor(tradeTimeMs / 1000);
  let open = 0;
  for (let g = R - 59; g <= R; g += 1) {
    const p = price(g); if (p === undefined) return undefined;
    open += p;
  }
  open /= 60;
  let previous = price(gv - 300);
  if (previous === undefined) return undefined;
  let sum = 0, sumSq = 0;
  for (let g = gv - 299; g <= gv; g += 1) {
    const p = price(g); if (p === undefined) return undefined;
    const r = Math.log(p / previous); sum += r; sumSq += r * r; previous = p;
  }
  const mean = sum / 300;
  const sigma = Math.sqrt(Math.max(0, sumSq / 300 - mean * mean));
  const e = Math.max(0, Math.min(60, gv - (R + 240)));
  let past = 0;
  for (let g = R + 241; g <= R + 240 + e; g += 1) {
    const p = price(g); if (p === undefined) return undefined;
    past += p;
  }
  const n = 60 - e;
  const expected = (past + n * tradePrice) / 60;
  const sd = (n / 60) * tradePrice * sigma * windowFactor(Math.floor(tradeTimeMs / 1000 - R), n);
  // sd 0 (no move in 300 s: a stuck feed, not BTC) or NaN: no estimate, so the
  // order keeps the base size instead of a certain 1/0 buying the top tier.
  if (!(sd > 0)) return undefined;
  const p = normalCdf(FAIR_C * (expected - open) / sd);
  return Number.isFinite(p) ? p : undefined;
}
const FAIR_C = 0.859;

/** sqrt(sum_ij min(t_i, t_j)) / n for the last n seconds of (R+240, R+300]
 * seen from second k (fv_calib.py vfactor). Ascending t: sum = sum_i t_i (2(n-i)+1). */
function windowFactor(k: number, n: number): number {
  if (n <= 0) return 0;
  const first = Math.max(241, k + 1) + Math.max(0, 301 - Math.max(241, k + 1) - n);
  let total = 0;
  for (let i = 0; i < n; i += 1) total += (first + i - k) * (2 * (n - 1 - i) + 1);
  return Math.sqrt(total) / n;
}

/** Phi(x) via erfc (Numerical Recipes erfcc, fractional error < 1.2e-7). */
function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

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

type LineIngest = ((raw: unknown, receivedAtUnix: number, receivedAtMonoMs: number) => boolean) & { lastWasCurrent: () => boolean };

async function lineLoop(url: string, line: number, ingest: LineIngest,
  lastMessageAt: number[], signal: AbortSignal, sockets: Set<WebSocket>, subscribe?: string): Promise<void> {
  while (!signal.aborted) {
    let ws: WebSocket | undefined;
    try {
      ws = await connect(url, sockets, signal);
      const socket = ws;
      if (subscribe) socket.send(subscribe);
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
  return runLines(urls, createAggTradeIngest(onTrade));
}

function runLines(urls: readonly string[], ingest: LineIngest, subscribe?: string): { stop: () => void; isHealthy: () => boolean } {
  const controller = new AbortController();
  const sockets = new Set<WebSocket>();
  const lastMessageAt = urls.map(() => 0);
  urls.forEach((url, line) => { void lineLoop(url, line, ingest, lastMessageAt, controller.signal, sockets, subscribe); });
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
  // The last trade's time and price, and the opening price of the round the
  // latest trade is in (the last trade before that round's start).
  private lastTradeMs?: number;
  private lastPrice?: number;
  private openRoundMs?: number;
  private openPrice?: number;
  // Per-second lead price for the fair-value model, as the backtest's grid:
  // the price of second g is the last trade at or before g (whole seconds).
  // secPrice[g % SEC_RING] holds it once a later trade closed the second, with
  // secTag = g; historyStartSec is the first second covered since the feed
  // started or last went silent.
  private readonly secPrice = new Float64Array(SEC_RING);
  private readonly secTag = new Float64Array(SEC_RING).fill(-1);
  private historyStartSec?: number;

  constructor(params: LeadSignalParams) { this.params = LeadSignalDetector.check(params); }

  /** Takes effect from the next trade. */
  update(params: LeadSignalParams): void { this.params = LeadSignalDetector.check(params); }

  push(trade: AggTrade, seenAtUnix: number): LeadSignal | undefined {
    const { windowMs, thresholdBp, fromSec, toSec } = this.params;
    const t = trade.tradeTimeMs, p = trade.price;
    // First trade at or after a round start: the trade before it opened the
    // round. Without one (the feed started mid-round), the round has no open.
    const roundMs = Math.floor(t / 300_000) * 300_000;
    if (this.openRoundMs !== roundMs) {
      this.openRoundMs = roundMs;
      this.openPrice = t === roundMs ? p
        : this.lastTradeMs !== undefined && this.lastTradeMs <= roundMs && this.lastTradeMs > roundMs - 300_000
          ? this.lastPrice : undefined;
    }
    this.recordSeconds(t);
    this.lastTradeMs = t; this.lastPrice = p;
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
    const fairUp = leadFairUp(g => this.secondPrice(g), t, p);
    return { direction, price: p, refPrice, moveBp: move * 1e4, tradeId: trade.id, tradeTimeMs: t,
      ...(this.openPrice !== undefined ? { openPrice: this.openPrice } : {}),
      ...(fairUp !== undefined ? { fairUp } : {}),
      receivedAtUnix: trade.receivedAtUnix, receivedAtMonoMs: trade.receivedAtMonoMs };
  }

  /** Close the seconds g with lastTradeMs <= g*1000 < t on the previous trade's
   * price. A gap over MAX_HISTORY_GAP_MS (feed down: trades were missed) starts
   * the history again at this trade. */
  private recordSeconds(t: number): void {
    const prevMs = this.lastTradeMs, prevPrice = this.lastPrice;
    if (prevMs === undefined || prevPrice === undefined || t - prevMs > MAX_HISTORY_GAP_MS) {
      this.historyStartSec = Math.ceil(t / 1000);
      return;
    }
    const last = Math.ceil(t / 1000) - 1;
    for (let g = Math.max(Math.ceil(prevMs / 1000), last - SEC_RING + 1); g <= last; g += 1) {
      this.secPrice[g % SEC_RING] = prevPrice; this.secTag[g % SEC_RING] = g;
    }
  }

  /** The last trade at or before second g, or undefined outside the history. */
  private secondPrice(g: number): number | undefined {
    if (this.historyStartSec === undefined || this.lastTradeMs === undefined || g < this.historyStartSec) return undefined;
    // Not closed yet: no later trade so far, so the latest trade is the last at or before g.
    if (g * 1000 >= this.lastTradeMs) return this.lastPrice;
    return this.secTag[g % SEC_RING] === g ? this.secPrice[g % SEC_RING] : undefined;
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

/** Bybit v5 public linear (USDT perpetual) trades. Two CloudFront hosts carry
 * the same stream (390/390 trades, either first, measured 2026-10-29). */
export const bybitTradeUrls = (): string[] => [
  "wss://stream.bybit.com/v5/public/linear",
  "wss://stream.bytick.com/v5/public/linear",
];
const bybitSubscribe = (symbol: string) => JSON.stringify({ op: "subscribe", args: [`publicTrade.${symbol}`] });

/** Parse one Bybit `publicTrade.<symbol>` frame and pass on each trade not yet
 * delivered, in the venue's order. Bybit's `seq` is the match sequence: one
 * sweep is many trades sharing a seq and a time (59 of 66 multi-trade frames),
 * so a trade is identified by its id `i` (a UUID) and a frame is new when its
 * seq is above the last delivered one, or equal with ids not seen yet. Both
 * lines share one ingest; whichever is first wins. Same age and lead bounds as
 * Binance (MAX_TRADE_AGE_MS / MAX_TRADE_LEAD_MS).
 *
 * seq is the contract's whole match sequence (~9,000-22,000 a second against
 * ~90 trades), so it is no clock: two minutes down puts it 1e6+ ahead, and a
 * renumbering would put it behind. A copy of a delivered trade is never later
 * than the latest delivered trade time, so a later trade is new whatever its
 * seq; the seq checks only order trades within one millisecond (review
 * 2026-10-29: the Binance-sized jump guard dropped every trade after an
 * outage, for good). */
export function createBybitTradeIngest(onTrade: (trade: AggTrade) => void, symbol = "BTCUSDT") {
  let lastSeq = -1;
  let lastTimeMs = -Infinity;
  let delivered = 0;
  // Trade ids delivered at the current top seq: a later frame may carry the
  // rest of that seq's sweep, or a duplicate from the other line.
  let atTop = new Set<string>();
  let current = false;
  const topic = `publicTrade.${symbol}`;
  const ingest = (raw: unknown, receivedAtUnix: number, receivedAtMonoMs: number): boolean => {
    current = false;
    let message: { topic?: unknown; data?: unknown };
    try { message = JSON.parse(String(raw)); } catch { return false; }
    if (message?.topic !== topic || !Array.isArray(message.data)) return false;
    let any = false;
    for (const item of message.data as Array<Record<string, unknown>>) {
      const id = item?.i, seq = item?.seq, tradeTimeMs = item?.T, price = Number(item?.p);
      if (typeof id !== "string" || !id || typeof seq !== "number" || !Number.isFinite(seq) || typeof tradeTimeMs !== "number"
        || !(price > 0) || price === Infinity || item?.s !== symbol) continue;
      const ageMs = receivedAtUnix * 1000 - tradeTimeMs;
      if (!(ageMs <= MAX_TRADE_AGE_MS && ageMs >= -MAX_TRADE_LEAD_MS)) continue;
      if (tradeTimeMs < lastTimeMs) { current = true; continue; }
      if (tradeTimeMs === lastTimeMs) {
        if (seq < lastSeq || (seq === lastSeq && atTop.has(id))) { current = true; continue; }
        if (seq - lastSeq > MAX_ID_JUMP) continue;
      }
      if (seq !== lastSeq) { lastSeq = seq; atTop = new Set(); }
      lastTimeMs = tradeTimeMs;
      atTop.add(id);
      current = true; any = true;
      onTrade({ id: ++delivered, price, tradeTimeMs, receivedAtUnix, receivedAtMonoMs });
    }
    return any;
  };
  return Object.assign(ingest, { lastWasCurrent: () => current });
}

/** Two Bybit linear lines for one symbol; each trade is delivered once. */
export function runBybitTrades(onTrade: (trade: AggTrade) => void, symbol = "BTCUSDT",
  urls: readonly string[] = bybitTradeUrls()): { stop: () => void; isHealthy: () => boolean } {
  return runLines(urls, createBybitTradeIngest(onTrade, symbol), bybitSubscribe(symbol));
}

/** binanceLeadFeed on Bybit USDT perpetual trades. */
export function bybitLeadFeed(detector: LeadSignalDetector, symbol = "BTCUSDT") {
  return (sink: (event: FeedEvent) => void): { stop: () => void; isHealthy: () => boolean } =>
    runBybitTrades(trade => {
      const signal = detector.push(trade, trade.receivedAtUnix);
      if (signal) sink({ kind: "lead", ...signal });
    }, symbol);
}
