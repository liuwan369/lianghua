// Paper "simulated trading" (模拟交易) for the reversal strategy.
//
// Goal (user): from REAL market data, compare what live does today with the
// user's rung rules, for all seven coins, per 5-minute round. Three variants:
//
// A  实盘现状 (live as-is). One real BtcReversalStrategy per round on RAW frames
//    (no filter, no dwell): triggerPrice .67, confirmationPrice .70, maxBuyPrice
//    .70, fixed ladder [5,20,60,140, then 140…], maxStages 1000, no budgets. Each
//    submit is a GTC limit BUY at 0.70 that rests to round end (fill model
//    below). The rung is consumed at submit even with 0 fill. The strategy gets
//    OPEN at submit, PARTIAL/FILLED as fills happen and CANCELLED with
//    filledShares at round end; the instance is dropped then.
// C  新规则·立即 / C2 新规则·停1秒. A small pure state machine on CLEAN frames
//    (upAsk + downAsk <= 1.05). The first clean frame only sets prev asks. C
//    fires on prevAsk < .67 <= ask; C2 once per excursion after a true cross
//    stayed >= .67 for 1.0 s. Rung 1 is FOK 5 @ <= .70 on the first clean frame
//    in [t+0.2, t+1.2]: fewer than 5 unused there is `skipped`, not counted
//    (no frame: gap; at/after round end: too_late), and the next cross is rung 1
//    again. Hedge (a cross of the side not leading by held shares; tie: the last
//    counted rung's side): rung k = ladder[k] as a GTC 0.70 that counts once
//    placed and rests (fill model below). One live hedge per side: a cross of a
//    side whose hedge still rests is ignored.
//
// Fill model (A and C*). An order decided at t reaches the venue at t+0.2
// (measured live 0.12–0.28 s): on the first frame in [t+0.2, t+1.2] it takes
// that side's unused asks <= 0.70 cheapest first (taker; each level's size is
// used once per round). The rest rests: a SELL trade print at <= 0.70 fills it
// by the print's size, oldest order first (maker, fee 0). A round without trade
// prints (all older recordings) uses a proxy: a frame whose bid >= 0.70, or
// whose best ask <= 0.70 shows new size, fills the oldest resting order of that
// side in full at 0.70 (maker). Queue position is ignored: optimistic for size.
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
const CRASHED_SUM = 1.05, DWELL_SEC = 1.0, ORDER_DELAY_SEC = 0.2, ARRIVAL_WINDOW_SEC = 1.0, START_GRACE_SEC = 10;
/** Recorded depth before this time is known bad. */
const DEPTH_FROM = 1_790_878_037;
const SCHEMA_VERSION = 4;
const EPS = 1e-9;
const TIME_EPS = 1e-6;                    // unix seconds near 1.8e9 only carry ~2e-7 s
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

export type SimStatus = "full" | "partial" | "none" | "skipped" | "gap" | "too_late" | "no_depth";
/** One market trade print (last_trade_price) of a round's side; `side` is the taker side. */
export interface SimTrade { marketId: string; roundId: string; dir: Dir; price: number; shares: number; side: string }
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
  schemaVersion: 4; asset: string; roundId: string; marketId: string; startsAt: number;
  depthOk: boolean; winner: Dir | null; variants: { A: SimVariant; C: SimVariant; C2: SimVariant };
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

// ---------- the venue: arrival and resting fills, shared by A and C* ----------

/** A frame's venue time: the newest exchange time it reflects (receive time if none). */
const venueTime = (book: SimBook, clock: number) => {
  const at = Math.max(book.upSourceAt ?? -Infinity, book.downSourceAt ?? -Infinity);
  return Number.isFinite(at) ? at : clock;
};

/** One simulated order. A FOK (C rung 1) never rests. */
export interface SimOrder {
  dir: Dir; want: number; fok: boolean; arriveAt: number; event: SimEvent;
  state: "flight" | "resting" | "done";
  filled: number; notional: number; fee: number; maker: number;
  record?: OrderRecord;                                       // A: what the strategy sees
}

/** Order matching for one variant of one round. Once the round has trade
 * prints (`tape.trades`), resting orders fill only from them; before that the
 * bid / new-size proxy is used. */
export class SimVenue {
  readonly orders: SimOrder[] = [];
  private readonly consumed: Record<Dir, Map<number, number>> = { UP: new Map(), DOWN: new Map() };   // depth used per price
  private lastSizes: Record<Dir, Map<number, number>> = { UP: new Map(), DOWN: new Map() };           // previous frame's asks
  private lastBook?: SimBook;
  constructor(private readonly tape: { trades: boolean } = { trades: false }) {}

  /** Submit at `clock`; an order that cannot reach the venue before round end is too_late. */
  place(event: SimEvent, clock: number, endsAt: number, fok = false): SimOrder {
    const order: SimOrder = { dir: event.dir, want: event.want, fok, arriveAt: clock + ORDER_DELAY_SEC, event,
      state: "flight", filled: 0, notional: 0, fee: 0, maker: 0 };
    if (order.arriveAt >= endsAt) { order.state = "done"; event.status = "too_late"; }
    this.orders.push(order);
    return order;
  }

  /** An order of this side still in flight or resting. */
  live(dir: Dir): boolean { return this.orders.some(order => order.dir === dir && order.state !== "done"); }

  held(): Record<Dir, number> {
    const held = { UP: 0, DOWN: 0 };
    for (const order of this.orders) held[order.dir] += order.filled;
    return held;
  }

  /** One frame (raw: the venue sees every book). An order in flight arrives
   * once a frame's venue time passes its arrival time, and matches the book in
   * force then, the previous frame: the frame after it may already show our own
   * fill (calibration: a real 0.67 taker fill emptied that level). Then resting
   * orders fill from the proxy. Returns the orders that changed. */
  frame(book: SimBook, clock: number): SimOrder[] {
    const touched = new Set<SimOrder>();
    const at = venueTime(book, clock);
    for (const order of this.orders) {
      if (order.state !== "flight" || at < order.arriveAt - TIME_EPS) continue;
      touched.add(order);
      if (at <= order.arriveAt + ARRIVAL_WINDOW_SEC + TIME_EPS) this.arrive(order, this.lastBook ?? book, clock);
      else if (order.fok) { order.state = "done"; order.event.status = "gap"; }   // no frame in the window
      else order.state = "resting";                                                  // a GTC just rests
    }
    this.lastBook = book;
    for (const dir of DIRS) {
      const levels = levelsOf(book, dir);
      const best = levels?.length ? levels.reduce((low, level) => level[0] < low[0] ? level : low) : undefined;
      const fresh = best !== undefined && best[0] <= MAX_BUY_PRICE + EPS
        && best[1] > (this.lastSizes[dir].get(best[0]) ?? 0) + EPS;
      if (levels) this.lastSizes[dir] = new Map(levels);
      // A resting 0.70 bid fills when sellers trade at our price: new size
      // offered at <= 0.70, or the book's bid reaching 0.70 while the ask is
      // still at most one tick above it (we sit in that bid queue; calibration
      // 1790889000). A bid that only gets above 0.70 after the ask gapped away
      // is not a fill (1790878800: ask 0.70 -> 0.93 in 0.5 s, nobody sold at 0.70).
      const ask = askOf(book, dir), bid = dir === "UP" ? book.upBid : book.downBid;
      const queued = bid !== undefined && ask !== undefined && bid >= MAX_BUY_PRICE - EPS && ask <= MAX_BUY_PRICE + 0.01 + EPS;
      if (this.tape.trades || clock < DEPTH_FROM || !(fresh || queued)) continue;
      // The oldest resting order of this side fills.
      const order = this.orders.find(item => item.dir === dir && item.state === "resting");
      if (order) { this.fill(order, order.want - order.filled); touched.add(order); }
    }
    return [...touched];
  }

  /** A trade print: a SELL taker at <= 0.70 sold through our bid; oldest resting orders first, by size. */
  trade(dir: Dir, price: number, shares: number, side: string): SimOrder[] {
    if (side !== "SELL" || price > MAX_BUY_PRICE + EPS) return [];
    const touched: SimOrder[] = [];
    let left = shares;
    for (const order of this.orders) {
      if (left <= EPS) break;
      if (order.dir !== dir || order.state !== "resting") continue;
      const qty = Math.min(left, order.want - order.filled);
      left -= qty; this.fill(order, qty); touched.push(order);
    }
    return touched;
  }

  /** Round end: an order no frame confirmed reaching the venue is too_late; resting ones are cancelled. */
  close(): SimOrder[] {
    const touched: SimOrder[] = [];
    for (const order of this.orders) {
      if (order.state === "flight") { order.event.status = "too_late"; touched.push(order); }
      order.state = "done";
    }
    return touched;
  }

  /** Arrival: take this side's unused asks <= 0.70 cheapest first (taker). A FOK needs all of it. */
  private arrive(order: SimOrder, book: SimBook, clock: number): void {
    const levels = levelsOf(book, order.dir);
    if (depthMissing(levels, clock)) {
      order.state = "done";
      Object.assign(order.event, { status: "no_depth", filled: null, avgPrice: null, cost: null, fee: null });
      return;
    }
    const consumed = this.consumed[order.dir];
    const usable = levels!.filter(([price]) => price <= MAX_BUY_PRICE + EPS)
      .map(([price, size]) => [price, Math.max(0, size - (consumed.get(price) ?? 0))] as Level);
    const got = take(usable, order.want);
    order.event.avail = r5(got.avail);
    if (order.fok && got.filled < order.want - EPS) { order.state = "done"; order.event.status = "skipped"; return; }
    for (const [price, qty] of got.at) consumed.set(price, (consumed.get(price) ?? 0) + qty);
    order.filled += got.filled; order.notional += got.notional; order.fee += got.fee;
    order.state = order.fok || order.filled >= order.want - EPS ? "done" : "resting";
    this.settle(order);
  }

  /** A resting fill at our limit (maker, fee 0). */
  private fill(order: SimOrder, qty: number): void {
    order.filled += qty; order.notional += MAX_BUY_PRICE * qty; order.maker += qty;
    if (order.filled >= order.want - EPS) order.state = "done";
    this.settle(order);
  }

  /** Copy an order's fills into its event. */
  private settle(order: SimOrder): void {
    const filled = r5(order.filled);
    Object.assign(order.event, { filled, cost: r5(order.notional), fee: r5(order.fee), maker: r5(order.maker),
      avgPrice: filled > 0 ? r5(order.notional / filled) : null,
      status: filled >= order.want - EPS ? "full" : filled > 0 ? "partial" : "none" });
  }
}

// ---------- C / C2: the user's rung rules, a pure state machine ----------

interface RungState {
  dwell: boolean;                                   // C2: fire after 1 s above the trigger
  prev: Partial<Record<Dir, number>>;
  armedAt: Partial<Record<Dir, number>>;            // C2: time of the true cross from below
  fired: Record<Dir, boolean>;                      // C2: once per excursion
  venue: SimVenue;
  events: SimEvent[];
}
const rungState = (dwell: boolean, tape: { trades: boolean }): RungState => ({ dwell, prev: {}, armedAt: {},
  fired: { UP: false, DOWN: false }, venue: new SimVenue(tape), events: [] });
/** Rung 1 counts once its 5 shares are bought; a hedge once it is placed. */
const countsAsRung = (event: SimEvent) => event.rung === 1 ? event.status === "full" : event.status !== "too_late";

/** One clean frame through C/C2: the venue first, then look for a cross. */
function stepRungs(state: RungState, book: SimBook, clock: number, t: number, endsAt: number): void {
  state.venue.frame(book, clock);
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
  const counted = state.events.filter(countsAsRung);
  const venue = state.venue;
  const rung = counted.length + 1;
  if (counted.length) {
    const held = venue.held();
    const leader: Dir = held.UP > held.DOWN + EPS ? "UP" : held.DOWN > held.UP + EPS ? "DOWN" : counted.at(-1)!.dir;
    if (dir === leader || venue.live(dir)) return;            // the leader, or this side's hedge still rests
  } else if (venue.orders.some(order => order.state !== "done")) return;   // rung 1 still in flight
  const event: SimEvent = { rung, t, dir, ask, want: stageShares(rung - 1), cap: MAX_BUY_PRICE, avail: null,
    filled: 0, avgPrice: null, cost: 0, fee: 0, maker: 0, status: "none" };
  state.events.push(event);
  venue.place(event, clock, endsAt, rung === 1);
}

/** Round state: one strategy instance (A) and two rung machines (C, C2). */
interface SimRound {
  asset: string; marketId: string; roundId: string; startsAt: number; endsAt: number; firstSeen: number;
  market: MarketInfo; strategy: BtcReversalStrategy;
  rawSeconds: number[]; venue: SimVenue; tape: { trades: boolean };
  c: RungState; c2: RungState;
  last?: SimBook;                                              // last clean frame
}

/** Per round: the real strategy (A) on raw frames and the user's rung rules (C, C2) on clean frames. */
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
      const tape = { trades: false };
      const strategy = createStrategy({ assetId: asset as AssetId, stageShares: this.ladder(), maxStages: LADDER_LENGTH,
        triggerPrice: TRIGGER_PRICE, confirmationPrice: CONFIRMATION_PRICE, maxBuyPrice: MAX_BUY_PRICE,
        maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 });
      round = { asset, marketId: book.marketId, roundId: book.roundId, startsAt, endsAt: startsAt + WINDOW_SEC,
        firstSeen: clock, market: this.marketInfo(asset, book), strategy, rawSeconds: [], venue: new SimVenue(tape), tape,
        c: rungState(false, tape), c2: rungState(true, tape) };
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

    // C: a crashed book reaches nothing — not the rung machines or the winner.
    if ((book.upAsk ?? 0) + (book.downAsk ?? 0) > CRASHED_SUM) return;
    round.last = book;
    stepRungs(round.c, book, clock, t, round.endsAt);
    stepRungs(round.c2, book, clock, t, round.endsAt);
  }

  /** Feed one market trade print (last_trade_price) of a round's side. From
   * the first print on, that round's resting orders fill only from prints. */
  observeTrade(asset: string, trade: SimTrade, clock: number): void {
    const round = this.rounds.get(`${asset}:${trade.marketId}`);
    if (!round || round.roundId !== trade.roundId || clock >= round.endsAt) return;
    round.tape.trades = true;
    for (const order of round.venue.trade(trade.dir, trade.price, trade.shares, trade.side)) this.feedOrder(round, order, clock);
    round.c.venue.trade(trade.dir, trade.price, trade.shares, trade.side);
    round.c2.venue.trade(trade.dir, trade.price, trade.shares, trade.side);
  }

  private ladder(): number[] {
    return Array.from({ length: LADDER_LENGTH }, (_, index) => stageShares(index));
  }
  /** A on one raw frame: the venue (arrivals, resting fills), then the strategy. */
  private stepLive(round: SimRound, book: SimBook, clock: number, t: number): void {
    for (const order of round.venue.frame(book, clock)) this.feedOrder(round, order, clock);
    const snapshot = this.snapshot(round.asset, book, clock);
    const actions = round.strategy.onEvent({ kind: "book", snapshot, marketId: book.marketId,
      roundId: book.roundId, assetId: round.asset as AssetId }, this.context(round, clock));
    for (const action of actions) {
      if (action.kind !== "submit") continue;
      const dir: Dir = action.order.tokenId === book.upTokenId ? "UP" : "DOWN";
      round.rawSeconds.push(t);
      const event: SimEvent = { rung: round.venue.orders.length + 1, t, dir, ask: Number(askOf(book, dir) ?? 0),
        want: action.order.shares, cap: MAX_BUY_PRICE, avail: null, filled: 0, avgPrice: null, cost: 0, fee: 0,
        maker: 0, status: "none" };
      const order = round.venue.place(event, clock, round.endsAt);
      order.record = { ...action.order, strategyId: "btc-reversal", orderId: `${action.order.clientOrderId}:sim`,
        status: "OPEN", filledShares: 0, reservedUsd: 0, reservedShares: 0, createdAt: clock, updatedAt: clock };
      // OPEN at submit: the rung is consumed now, even if nothing ever fills (live).
      this.feedOrder(round, order, clock);
    }
  }

  private feedOrder(round: SimRound, order: SimOrder, clock: number, cancelled = false): void {
    if (!order.record) return;
    const real = order.event.status === "no_depth" || order.event.status === "too_late" ? 0 : order.filled;
    const full = real >= order.want - EPS;
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

  /** Close a round: cancel resting remainders, drop the strategy, write one line. */
  private finalize(round: SimRound, clock: number): void {
    this.rounds.delete(`${round.asset}:${round.marketId}`);   // the strategy instance goes with it
    const key = `${round.asset}:${round.roundId}`;
    if (this.written.has(key)) return;
    this.written.add(key);
    round.venue.close(); round.c.venue.close(); round.c2.venue.close();
    for (const order of round.venue.orders) {
      if (order.record?.status !== "FILLED") this.feedOrder(round, order, clock, true);
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
    const rungs = (state: RungState) => variant(state.events, state.events.filter(countsAsRung).length,
      state.events.map(event => event.t));
    const orders = round.venue.orders;
    const variants = { A: variant(orders.map(order => order.event), orders.length, round.rawSeconds),
      C: rungs(round.c), C2: rungs(round.c2) };
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