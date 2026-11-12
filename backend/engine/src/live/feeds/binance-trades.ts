/** The lead-signal detector (the frozen rule, E:/pm-backup/forward-binance-agg.py
 * signals()). One detector runs per venue on that venue's deduplicated trades
 * (lead-trades.ts); its window, open price and 60 s mean are that venue's own. */
import type { LeadLine, LeadVenue } from "../../platform/contracts.js";

/** One delivered trade of one venue. */
export interface AggTrade {
  venue: LeadVenue;
  /** Per venue, increasing in delivery order. Binance: aggregate trade id `a`;
   * OKX: tradeId; Bybit: the trade's position in our delivery order (its venue
   * id is a UUID). */
  id: number;
  price: number;
  /** Trade time, milliseconds. */
  tradeTimeMs: number;
  /** The line it reached us on first. */
  line: LeadLine;
  /** Tokyo relay receive time (ms), for a relayed trade. */
  relayRecvMs?: number;
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
  /** Mean lead price over the 60 whole seconds (R-60, R], each second the last
   * trade at or before it: the window of the official price to beat (Chainlink
   * 60 s TWAP; E:/pm-backup/research-1104/target_basis.py, after the hour's
   * basis |error| p50 0.47 bp vs 1.44 bp for openPrice). Absent unless the
   * history covers the whole window. */
  openMean60?: number;
  venue: LeadVenue;
  line: LeadLine;
  relayRecvMs?: number;
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

/** Seconds of per-second history kept for openMean60: it reads back to R - 59,
 * at most 359 s before a trade in the round; 512 leaves a margin. */
const SEC_RING = 512;
/** No trade for longer than this is a dead feed, not a quiet market (Bybit perp
 * 10-18/25, 11-01: longest quiet gap 29 s): the history restarts. */
const MAX_HISTORY_GAP_MS = 60_000;

/** Mean of price(g) for g = R-59..R (the 60 s before the open R, unix seconds). */
export function leadOpenMean60(price: (g: number) => number | undefined, R: number): number | undefined {
  let sum = 0;
  for (let g = R - 59; g <= R; g += 1) {
    const p = price(g); if (p === undefined) return undefined;
    sum += p;
  }
  return sum / 60;
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
  // Per-second lead price for openMean60, as the backtest's grid:
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
    const openMean60 = leadOpenMean60(g => this.secondPrice(g), roundMs / 1000);
    return { direction, price: p, refPrice, moveBp: move * 1e4, tradeId: trade.id, tradeTimeMs: t,
      ...(this.openPrice !== undefined ? { openPrice: this.openPrice } : {}),
      ...(openMean60 !== undefined ? { openMean60 } : {}),
      venue: trade.venue, line: trade.line, ...(trade.relayRecvMs !== undefined ? { relayRecvMs: trade.relayRecvMs } : {}),
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
