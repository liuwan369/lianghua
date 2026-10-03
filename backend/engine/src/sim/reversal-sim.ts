// Paper "simulated trading" (模拟交易) for the reversal strategy.
//
// Goal (user): from REAL market data, compare what live does today with the
// agreed rung rules, for all seven coins, per 5-minute round. Three variants:
//
// A  实盘现状 (live as-is). One real BtcReversalStrategy per round on RAW frames
//    (no filter, no dwell): triggerPrice .67, confirmationPrice .70, maxBuyPrice
//    .70, fixed ladder [5,20,60,140, then 140…], maxStages 1000, no budgets. Each
//    submit is a GTC limit BUY at 0.70 decided at t that reaches the venue at
//    t+0.3: on the first frame in [t+0.3, t+1.3] it takes that side's asks <= 0.70
//    cheapest first (taker). The remainder RESTS to round end: on every later
//    frame, ask size at a level <= 0.70 that is NEW versus the previous frame
//    (more size at that price, or a new level) fills the oldest resting order of
//    that side (maker, fee 0). The rung is consumed at submit even with 0 fill.
//    The strategy gets OPEN at submit, PARTIAL/FILLED as fills happen and
//    CANCELLED with filledShares at round end; the instance is dropped then.
// B1 建议·立即 / B2 建议·停1秒. A small pure state machine on CLEAN frames
//    (upAsk + downAsk <= 1.05). The first clean frame only sets prev asks. B1
//    fires on prevAsk < .67 <= ask; B2 once per excursion after a true cross
//    stayed >= .67 for 1.0 s. FAK only: on the first clean frame in [t+0.3,
//    t+1.3] (none: gap; at/after round end: too_late) walk that side's asks
//    <= cap; each level's size is used once per round; the rest is dropped.
//    Rung 1: 5 @ .70; 0 filled is not counted. Hedge (cross of the side not
//    leading by held shares): rung k sized from the ladder, cap = the highest
//    cent p with held[X] + S >= cost + S·(p + fee(p)); best ask above it:
//    over_cap. A partial hedge whose side still trails is topped up (same rung).
//
// Taker fee polymarketFillFee at the crypto rate 0.07. Depth before DEPTH_FROM
// is known bad: no_depth, PnL null. Winner: last clean frame, side ask or bid
// >= 0.9. PnL = held[winner] - cost (cost includes fees). Never touches the live
// order path, the ledger or live config.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { polymarketFillFee } from "../models.js";
import { createStrategy, type BtcReversalStrategy } from "../strategies/btc-reversal.js";
import type { AssetId, Instrument, MarketBookSnapshot, MarketInfo, OrderRecord,
  StrategyContext } from "../platform/contracts.js";

const WINDOW_SEC = 300;
const CRYPTO_FEE_RATE = 0.07;
const LADDER_LENGTH = 1000;
const TRIGGER_PRICE = 0.67, CONFIRMATION_PRICE = 0.70, MAX_BUY_PRICE = 0.70;
const CRASHED_SUM = 1.05, DWELL_SEC = 1.0, ORDER_DELAY_SEC = 0.3, ARRIVAL_WINDOW_SEC = 1.0, START_GRACE_SEC = 10;
/** Recorded depth before this time is known bad. */
const DEPTH_FROM = 1_790_878_037;
const SCHEMA_VERSION = 3;
const EPS = 1e-9;
const LADDER = [5, 20, 60, 140];
const stageShares = (index: number) => LADDER[Math.min(index, LADDER.length - 1)]!;

type Level = [number, number];
type Dir = "UP" | "DOWN";
const DIRS: Dir[] = ["UP", "DOWN"];
/** A minimal paired book the simulator can consume: what the strategy's quote
 * gate reads plus each side's ask levels. Both the live collector feed and the
 * replayed recordings are reduced to this shape. */
export interface SimBook {
  marketId: string;
  roundId: string;
  upTokenId: string;
  downTokenId: string;
  upAsk?: number; upBid?: number;
  downAsk?: number; downBid?: number;
  upAskLevels?: Level[]; downAskLevels?: Level[];
  upSourceAt?: number; downSourceAt?: number;
  expiresAt?: number;
  marketAgeMs?: number;
  sequence?: number;
}

export type SimStatus = "full" | "partial" | "none" | "over_cap" | "topup" | "gap" | "too_late" | "no_depth";
export interface SimEvent {
  rung: number; t: number; dir: Dir; ask: number; want: number; cap: number;
  avail: number | null; filled: number | null; avgPrice: number | null; cost: number | null; fee: number | null;
  maker?: number; status: SimStatus;
}
export interface SimVariant {
  firings: number; rawSeconds: number[]; events: SimEvent[];
  held: Record<Dir, number>; cost: number; pnl: number | null;
}
export interface SimRoundResult {
  schemaVersion: 3; asset: string; roundId: string; marketId: string; startsAt: number;
  depthOk: boolean; winner: Dir | null; variants: { A: SimVariant; B1: SimVariant; B2: SimVariant };
}

/** [price, size] levels from PriceLevel tuples or {price,size} objects; bad entries dropped. */
export function simLevels(value: unknown): Level[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Level[] = [];
  for (const level of value) {
    const price = Number(Array.isArray(level) ? level[0] : (level as { price?: unknown })?.price);
    const size = Number(Array.isArray(level) ? level[1] : (level as { size?: unknown })?.size);
    if (price > 0 && size > 0) out.push([price, size]);
  }
  return out;
}

/** Reduce a live collector BookSnapshot (feeds/index.ts shape: YES/NO asset
 * objects plus marketId/roundId/sequence/expiresAt) to a SimBook. Returns
 * undefined for an incomplete frame. The collector passes `receivedAt` as the
 * clock, so marketAgeMs is left for the strategy's own freshness window. */
export function simBookFromSnapshot(snapshot: Record<string, unknown>): SimBook | undefined {
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const yes = snapshot.YES as Record<string, unknown> | undefined;
  const no = snapshot.NO as Record<string, unknown> | undefined;
  const marketId = typeof snapshot.marketId === "string" ? snapshot.marketId : undefined;
  const roundId = typeof snapshot.roundId === "string" ? snapshot.roundId : undefined;
  const upTokenId = yes && typeof yes.assetId === "string" ? yes.assetId : undefined;
  const downTokenId = no && typeof no.assetId === "string" ? no.assetId : undefined;
  if (!marketId || !roundId || !upTokenId || !downTokenId) return undefined;
  return { marketId, roundId, upTokenId, downTokenId,
    upAsk: num(yes?.ask), upBid: num(yes?.bid), downAsk: num(no?.ask), downBid: num(no?.bid),
    upAskLevels: simLevels(yes?.asks), downAskLevels: simLevels(no?.asks),
    upSourceAt: num(yes?.sourceAt), downSourceAt: num(no?.sourceAt),
    expiresAt: num(snapshot.expiresAt), sequence: num(snapshot.sequence) };
}

const fee = (shares: number, price: number): number => polymarketFillFee(shares, price, false, CRYPTO_FEE_RATE, 0, 1);
const r5 = (value: number) => Math.round(value * 100_000) / 100_000;
const levelsOf = (book: SimBook, dir: Dir) => dir === "UP" ? book.upAskLevels : book.downAskLevels;
const askOf = (book: SimBook, dir: Dir) => dir === "UP" ? book.upAsk : book.downAsk;
const depthMissing = (levels: Level[] | undefined, clock: number) => !levels?.length || clock < DEPTH_FROM;

/** Take up to `want` from [price, available] levels, cheapest first, as taker. */
function take(levels: Level[], want: number): { avail: number; filled: number; notional: number; fee: number; at: Level[] } {
  let left = want, avail = 0, notional = 0, paid = 0;
  const at: Level[] = [];
  for (const [price, size] of [...levels].sort((a, b) => a[0] - b[0])) {
    avail += size;
    const qty = Math.min(left, size);
    if (qty <= EPS) continue;
    left -= qty; notional += price * qty; paid += fee(qty, price); at.push([price, qty]);
  }
  return { avail, filled: want - left, notional, fee: paid, at };
}

// ---------- B1 / B2: the agreed rung rules, a pure state machine ----------

interface RungState {
  dwell: boolean;                                   // B2: fire after 1 s above the trigger
  prev: Partial<Record<Dir, number>>;
  armedAt: Partial<Record<Dir, number>>;            // B2: time of the true cross from below
  fired: Record<Dir, boolean>;                      // B2: once per excursion
  pending?: { event: SimEvent; at: number };
  consumed: Record<Dir, Map<number, number>>;       // price -> shares used this round
  held: Record<Dir, number>; cost: number;
  rungs: number;                                    // counted rungs (bought >= 1 share)
  last?: { dir: Dir; size: number; bought: number }; // the latest counted rung
  events: SimEvent[];
}
const rungState = (dwell: boolean): RungState => ({ dwell, prev: {}, armedAt: {}, fired: { UP: false, DOWN: false },
  consumed: { UP: new Map(), DOWN: new Map() }, held: { UP: 0, DOWN: 0 }, cost: 0, rungs: 0, events: [] });

/** Highest cent price p <= 0.99 at which buying `shares` more of a side still
 * breaks even if that side wins: held + shares >= cost + shares·(p + fee(p)). */
function breakEvenCap(held: number, cost: number, shares: number): number {
  for (let cents = 99; cents >= 1; cents -= 1) {
    const p = cents / 100;
    if (held + shares + EPS >= cost + shares * p + fee(shares, p)) return p;
  }
  return 0;
}

/** One clean frame through B1/B2: execute a due order, then look for a cross. */
function stepRungs(state: RungState, book: SimBook, clock: number, t: number, endsAt: number): void {
  const pending = state.pending;
  if (pending && clock >= pending.at) {
    state.pending = undefined;
    if (clock > pending.at + ARRIVAL_WINDOW_SEC + EPS) Object.assign(pending.event, { status: "gap", filled: 0, cost: 0, fee: 0 });
    else executeRung(state, pending.event, levelsOf(book, pending.event.dir), clock);
  }
  for (const dir of DIRS) {
    const ask = askOf(book, dir);
    const prev = state.prev[dir];
    if (ask === undefined) continue;
    state.prev[dir] = ask;
    if (ask < TRIGGER_PRICE) { state.armedAt[dir] = undefined; state.fired[dir] = false; continue; }
    if (prev === undefined) continue;                          // the baseline frame only sets prev
    if (prev < TRIGGER_PRICE) state.armedAt[dir] = clock;     // a true cross from below
    const armed = state.armedAt[dir];
    const fire = !state.dwell ? prev < TRIGGER_PRICE
      : armed !== undefined && !state.fired[dir] && clock - armed + EPS >= DWELL_SEC;
    if (!fire) continue;
    state.fired[dir] = true;
    decideRung(state, dir, ask, clock, t, endsAt);
  }
}

function decideRung(state: RungState, dir: Dir, ask: number, clock: number, t: number, endsAt: number): void {
  if (state.pending) return;                                  // one order in flight at a time
  let rung = 1, want = stageShares(0), cap = MAX_BUY_PRICE;
  if (state.rungs) {
    const leader: Dir = state.held.UP > state.held.DOWN + EPS ? "UP"
      : state.held.DOWN > state.held.UP + EPS ? "DOWN" : state.last!.dir;
    if (dir === leader) return;                               // a cross of the leader is ignored
    const last = state.last!;
    const topup = last.dir === dir && last.bought < last.size - EPS;
    rung = topup ? state.rungs : state.rungs + 1;
    want = topup ? r5(last.size - last.bought) : stageShares(rung - 1);
    cap = breakEvenCap(state.held[dir], state.cost, want);
  }
  const event: SimEvent = { rung, t, dir, ask, want, cap, avail: null, filled: 0, avgPrice: null, cost: 0, fee: 0,
    status: "too_late" };
  state.events.push(event);
  if (clock + ORDER_DELAY_SEC < endsAt) state.pending = { event, at: clock + ORDER_DELAY_SEC };
}

function executeRung(state: RungState, event: SimEvent, levels: Level[] | undefined, clock: number): void {
  if (depthMissing(levels, clock)) { Object.assign(event, { status: "no_depth", filled: null, cost: null, fee: null }); return; }
  const consumed = state.consumed[event.dir];
  const usable = levels!.filter(([price]) => price <= event.cap + EPS)
    .map(([price, size]) => [price, Math.max(0, size - (consumed.get(price) ?? 0))] as Level);
  const best = Math.min(...levels!.map(([price]) => price));
  const got = take(usable, event.want);
  for (const [price, qty] of got.at) consumed.set(price, (consumed.get(price) ?? 0) + qty);
  const filled = r5(got.filled);
  Object.assign(event, { avail: r5(got.avail), filled, cost: r5(got.notional), fee: r5(got.fee),
    avgPrice: filled > 0 ? r5(got.notional / filled) : null });
  const last = state.last;
  const topup = state.rungs > 0 && event.rung === state.rungs && last?.dir === event.dir;
  if (filled <= 0) {
    event.status = topup ? "topup" : event.rung > 1 && best > event.cap + EPS ? "over_cap" : "none";
    return;
  }
  state.held[event.dir] += got.filled;
  state.cost += got.notional + got.fee;
  if (topup) { last!.bought += got.filled; event.status = "topup"; return; }
  state.rungs = event.rung;
  state.last = { dir: event.dir, size: event.want, bought: got.filled };
  event.status = got.filled >= event.want - EPS ? "full" : "partial";
}

// ---------- A: the real strategy, live as-is ----------

interface LiveOrder {
  record: OrderRecord; event: SimEvent; arriveAt: number;
  arrived: boolean; filled: number; notional: number; fee: number; maker: number;
}
interface LevelMark { seen: number; used: number }           // last-seen size, and how much of it was ours

/** Round state: one strategy instance (A) and two rung machines (B1, B2). */
interface SimRound {
  asset: string; marketId: string; roundId: string; startsAt: number; endsAt: number; firstSeen: number;
  market: MarketInfo; strategy: BtcReversalStrategy;
  rawSeconds: number[]; orders: LiveOrder[]; marks: Record<Dir, Map<number, LevelMark>>;
  b1: RungState; b2: RungState;
  last?: SimBook;                                              // last clean frame
}

/** Per round: the real strategy (A) on raw frames and the agreed rung rules (B1, B2) on clean frames. */
export class ReversalSim {
  private readonly rounds = new Map<string, SimRound>();            // asset:marketId -> round
  private readonly written = new Set<string>();                    // asset:roundId on disk or dropped
  private readonly now: () => number;
  private readonly retentionDays: number;
  dropped = 0; wroteRounds = 0;

  constructor(private readonly simDir: string, options: { now?: () => number; retentionDays?: number } = {}) {
    this.now = options.now ?? (() => Date.now() / 1000);
    this.retentionDays = options.retentionDays ?? 10;
    mkdirSync(simDir, { recursive: true });
    this.pruneAndIndex();
  }

  /** Strategy instances alive: one per open round. */
  liveStrategies(): number { return this.rounds.size; }

  private marketInfo(asset: string, book: SimBook): MarketInfo {
    const startsAt = Number(book.roundId);
    const instrument = (tokenId: string, outcome: string): Instrument =>
      ({ tokenId, marketId: book.marketId, outcome, tickSize: 0.01, minOrderSize: 5 });
    return { id: book.marketId, assetId: asset as AssetId, roundId: book.roundId,
      name: `${asset}-updown-5m-${startsAt}`, startsAt, endsAt: startsAt + WINDOW_SEC,
      instruments: [instrument(book.upTokenId, "Up"), instrument(book.downTokenId, "Down")] };
  }

  private context(round: SimRound, clock: number): StrategyContext {
    return { mode: "live", now: clock, markets: [round.market], books: [],
      account: { schemaVersion: 1, accountId: "sim", mode: "live", cashUsd: 1e9,
        positions: [], orders: [], quarantinedOrderIds: [],
        risk: { halted: false, day: "", baselineAt: 0, baselineEquityUsd: 0, equityUsd: 1e9,
          dailyPnlUsd: 0, occupiedUsd: 0, availableUsd: 1e9 } },
      estimateFee: order => fee(order.shares, 0.5) };
  }

  /** Feed one real paired quote at `clock` seconds. */
  observe(asset: string, book: SimBook, clock: number): void {
    this.finalizeExpired(asset, clock);
    const startsAt = Number(book.roundId);
    if (!book.marketId || !book.roundId || !Number.isSafeInteger(startsAt) || startsAt % WINDOW_SEC !== 0
      || !book.upTokenId || !book.downTokenId || book.upTokenId === book.downTokenId) return;
    if (clock >= startsAt + WINDOW_SEC) return;    // a late frame of a closed round
    if (this.written.has(`${asset}:${book.roundId}`)) return;   // already recorded (dedupe live vs replay)
    const roundKey = `${asset}:${book.marketId}`;
    let round = this.rounds.get(roundKey);
    if (!round) {
      const strategy = createStrategy({ assetId: asset as AssetId, stageShares: this.ladder(), maxStages: LADDER_LENGTH,
        triggerPrice: TRIGGER_PRICE, confirmationPrice: CONFIRMATION_PRICE, maxBuyPrice: MAX_BUY_PRICE,
        maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 });
      round = { asset, marketId: book.marketId, roundId: book.roundId, startsAt, endsAt: startsAt + WINDOW_SEC,
        firstSeen: clock, market: this.marketInfo(asset, book), strategy, rawSeconds: [], orders: [],
        marks: { UP: new Map(), DOWN: new Map() }, b1: rungState(false), b2: rungState(true) };
      this.rounds.set(roundKey, round);
      // The strategy only trades a round it discovered while now <= startsAt
      // (btc-reversal.discover). Books always arrive during the round, so prime
      // discovery with a pre-start timer first; without it every round would be
      // parked as waiting_next_round and never fire.
      strategy.onEvent({ kind: "timer", ts: startsAt - 1 }, this.context(round, startsAt - 1));
    }
    const t = Math.round((clock - startsAt) * 10) / 10;

    // A: every frame, raw asks.
    this.stepLive(round, book, clock, t);

    // B: a crashed book reaches nothing — not the rung machines or the winner.
    if ((book.upAsk ?? 0) + (book.downAsk ?? 0) > CRASHED_SUM) return;
    round.last = book;
    stepRungs(round.b1, book, clock, t, round.endsAt);
    stepRungs(round.b2, book, clock, t, round.endsAt);
  }

  private ladder(): number[] {
    return Array.from({ length: LADDER_LENGTH }, (_, index) => stageShares(index));
  }
  /** A on one raw frame: resting fills from new size, arrivals, then the strategy. */
  private stepLive(round: SimRound, book: SimBook, clock: number, t: number): void {
    const touched = new Set<LiveOrder>();
    for (const dir of DIRS) {
      const levels = levelsOf(book, dir);
      if (!levels) continue;
      const marks = round.marks[dir];
      const sizes = new Map(levels.map(([price, size]) => [price, size]));
      for (const price of [...marks.keys()]) if (!sizes.has(price)) marks.delete(price);
      for (const [price, size] of [...sizes].sort((a, b) => a[0] - b[0])) {
        const mark = marks.get(price) ?? { seen: 0, used: 0 };
        let fresh = Math.max(0, size - mark.seen);
        mark.used = Math.min(mark.used, size - fresh);             // a shrink took someone's size, keep ours bounded
        mark.seen = size; marks.set(price, mark);
        if (price > MAX_BUY_PRICE + EPS || clock < DEPTH_FROM) continue;
        // New size at a level <= 0.70 fills the oldest resting order of this side (maker, fee 0).
        for (const order of round.orders) {
          if (fresh <= EPS) break;
          if (order.event.dir !== dir || !order.arrived || order.filled >= order.event.want - EPS) continue;
          const qty = Math.min(fresh, order.event.want - order.filled);
          fresh -= qty; mark.used += qty;
          order.filled += qty; order.notional += price * qty; order.maker += qty;
          touched.add(order);
        }
      }
    }
    for (const order of round.orders) {
      if (order.arrived || clock < order.arriveAt) continue;
      order.arrived = true;
      if (clock > order.arriveAt + ARRIVAL_WINDOW_SEC + EPS) continue;   // no frame in the window: it just rests
      const levels = levelsOf(book, order.event.dir);
      if (depthMissing(levels, clock)) {
        Object.assign(order.event, { status: "no_depth", filled: null, avgPrice: null, cost: null, fee: null });
        order.filled = order.event.want;                          // a no_depth order never rests
        continue;
      }
      const marks = round.marks[order.event.dir];
      const usable = levels!.filter(([price]) => price <= MAX_BUY_PRICE + EPS)
        .map(([price, size]) => [price, Math.max(0, size - (marks.get(price)?.used ?? 0))] as Level);
      const got = take(usable, order.event.want - order.filled);
      for (const [price, qty] of got.at) { const mark = marks.get(price); if (mark) mark.used += qty; }
      order.event.avail = r5(got.avail);
      order.filled += got.filled; order.notional += got.notional; order.fee += got.fee;
      touched.add(order);
    }
    for (const order of touched) { this.settleLive(order); this.feedOrder(round, order, clock); }

    const snapshot = this.snapshot(round.asset, book, clock);
    const actions = round.strategy.onEvent({ kind: "book", snapshot, marketId: book.marketId,
      roundId: book.roundId, assetId: round.asset as AssetId }, this.context(round, clock));
    for (const action of actions) {
      if (action.kind !== "submit") continue;
      const dir: Dir = action.order.tokenId === book.upTokenId ? "UP" : "DOWN";
      round.rawSeconds.push(t);
      const event: SimEvent = { rung: round.orders.length + 1, t, dir, ask: Number(askOf(book, dir) ?? 0),
        want: action.order.shares, cap: MAX_BUY_PRICE, avail: null, filled: 0, avgPrice: null, cost: 0, fee: 0,
        maker: 0, status: "none" };
      const order: LiveOrder = { event, arriveAt: clock + ORDER_DELAY_SEC, arrived: false,
        filled: 0, notional: 0, fee: 0, maker: 0,
        record: { ...action.order, strategyId: "btc-reversal", orderId: `${action.order.clientOrderId}:sim`,
          status: "OPEN", filledShares: 0, reservedUsd: 0, reservedShares: 0, createdAt: clock, updatedAt: clock } };
      if (order.arriveAt >= round.endsAt) { event.status = "too_late"; order.arrived = true; order.filled = event.want; }
      round.orders.push(order);
      // OPEN at submit: the rung is consumed now, even if nothing ever fills (live).
      this.feedOrder(round, order, clock);
    }
  }

  /** Copy an order's fills into its event. */
  private settleLive(order: LiveOrder): void {
    const event = order.event;
    if (event.status === "no_depth" || event.status === "too_late") return;
    const filled = r5(order.filled);
    Object.assign(event, { filled, cost: r5(order.notional), fee: r5(order.fee), maker: r5(order.maker),
      avgPrice: filled > 0 ? r5(order.notional / filled) : null,
      status: filled >= event.want - EPS ? "full" : filled > 0 ? "partial" : "none" });
  }

  private feedOrder(round: SimRound, order: LiveOrder, clock: number, cancelled = false): void {
    const real = order.event.status === "no_depth" || order.event.status === "too_late" ? 0 : order.filled;
    const full = real >= order.event.want - EPS;
    order.record = { ...order.record, filledShares: r5(real), updatedAt: clock,
      status: full ? "FILLED" : cancelled ? "CANCELLED" : real > EPS ? "PARTIAL" : "OPEN" };
    round.strategy.onEvent({ kind: "order", order: order.record, marketId: round.marketId,
      roundId: round.roundId, assetId: round.asset as AssetId }, this.context(round, clock));
  }
  private snapshot(asset: string, book: SimBook, clock: number): MarketBookSnapshot {
    const side = (tokenId: string, ask?: number, bid?: number, sourceAt?: number) => ({
      assetId: tokenId, bid: Number(bid), ask: Number(ask), sourceAt, expiresAt: book.expiresAt });
    return { assetId: asset as AssetId, marketId: book.marketId, roundId: book.roundId,
      sequence: book.sequence, sourceAt: Math.max(book.upSourceAt ?? clock, book.downSourceAt ?? clock),
      expiresAt: book.expiresAt, marketAgeMs: book.marketAgeMs, tsUnix: clock,
      YES: side(book.upTokenId, book.upAsk, book.upBid, book.upSourceAt),
      NO: side(book.downTokenId, book.downAsk, book.downBid, book.downSourceAt) };
  }

  private finalizeExpired(asset: string, clock: number): void {
    for (const round of [...this.rounds.values()]) {
      if (round.asset === asset && clock >= round.endsAt) this.finalize(round, clock);
    }
  }

  /** Close a round: cancel A's resting remainders, drop the strategy, write one line. */
  private finalize(round: SimRound, clock: number): void {
    this.rounds.delete(`${round.asset}:${round.marketId}`);   // the strategy instance goes with it
    const key = `${round.asset}:${round.roundId}`;
    if (this.written.has(key)) return;
    this.written.add(key);
    for (const order of round.orders) {
      if (!order.arrived) { order.event.status = "too_late"; order.arrived = true; }
      if (order.record.status !== "FILLED") this.feedOrder(round, order, clock, true);
    }
    // Only a round watched from its start: one first seen mid-round (restart)
    // would undercount, so it is dropped.
    if (round.firstSeen > round.startsAt + START_GRACE_SEC) return;
    try {
      appendFileSync(join(this.simDir, `${round.asset}.jsonl`), `${JSON.stringify(this.result(round))}\n`);
      this.wroteRounds += 1;
    } catch { this.dropped += 1; }
  }

  private result(round: SimRound): SimRoundResult {
    const last = round.last;
    const upWin = (last?.upAsk ?? 0) >= 0.9 || (last?.upBid ?? 0) >= 0.9;
    const downWin = (last?.downAsk ?? 0) >= 0.9 || (last?.downBid ?? 0) >= 0.9;
    const winner: Dir | null = upWin === downWin ? null : upWin ? "UP" : "DOWN";
    const variant = (events: SimEvent[], firings: number, rawSeconds: number[]): SimVariant => {
      const held = { UP: 0, DOWN: 0 };
      let cost = 0;
      for (const event of events) {
        held[event.dir] += event.filled ?? 0;
        cost += (event.cost ?? 0) + (event.fee ?? 0);
      }
      const ok = winner !== null && events.every(event => event.status !== "no_depth");
      return { firings, rawSeconds, events, held: { UP: r5(held.UP), DOWN: r5(held.DOWN) }, cost: r5(cost),
        pnl: ok ? Math.round((held[winner!] - cost) * 1_000) / 1_000 : null };
    };
    const rungs = (state: RungState) => variant(state.events, state.rungs, state.events.map(event => event.t));
    const variants = { A: variant(round.orders.map(order => order.event), round.orders.length, round.rawSeconds),
      B1: rungs(round.b1), B2: rungs(round.b2) };
    const depthOk = Object.values(variants).every(v => v.events.every(event => event.status !== "no_depth"));
    return { schemaVersion: SCHEMA_VERSION, asset: round.asset, roundId: round.roundId, marketId: round.marketId,
      startsAt: round.startsAt, depthOk, winner, variants };
  }

  /** End of a replay or collector shutdown. A round is only written once a
   * later frame proves it ended, so every round still open here is in progress
   * and is dropped (a later run sees it whole). */
  flush(): void {
    this.rounds.clear();
  }

  /** Prune lines older than retentionDays and index the current-schema rows for
   * dedupe. Old-schema lines are kept but not indexed, so their rounds are
   * regenerated; the API ignores them. */
  private pruneAndIndex(): void {
    const cutoff = this.now() - this.retentionDays * 86_400;
    let files: string[];
    try { files = readdirSync(this.simDir); } catch { return; }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const asset = name.slice(0, -".jsonl".length);
      const path = join(this.simDir, name);
      let kept: string[] = [];
      try {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.trim()) continue;
          let row: SimRoundResult;
          try { row = JSON.parse(line); } catch { continue; }
          if (!row || typeof row.roundId !== "string" || Number(row.startsAt) < cutoff) continue;
          kept.push(line);
          if (row.schemaVersion === SCHEMA_VERSION) this.written.add(`${asset}:${row.roundId}`);
        }
      } catch { continue; }
      try { writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : ""); } catch { this.dropped += 1; }
    }
  }
}