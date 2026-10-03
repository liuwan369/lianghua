// Paper "simulated trading" (模拟交易) for the reversal strategy.
//
// Goal (user): from REAL market data, how many times the live strategy would
// fire per 5-minute round (first trigger + every reversal), uncapped, for all
// seven coins, and how much of each firing the book could really have filled.
//
// This NEVER touches the live order path, the ledger or live config. It runs two
// real BtcReversalStrategy instances per asset with a fixed, documented config:
//   triggerPrice .67, confirmationPrice .70, maxBuyPrice .70, maxQuoteAgeSeconds 2,
//   maxQuoteSkewSeconds 1.5, and an uncapped ladder (maxStages 1000, stageShares
//   [5,20,60,140, then 140 repeated]). No budgets/loss caps — we want every fire.
//   RAW      every frame, raw asks: the live rule verbatim (firingsRaw).
//   FILTERED the main number. A frame with upAsk + downAsk > 1.05 (book swept)
//            is dropped entirely; and a side's ask only reaches the strategy as
//            >= 0.67 after it stayed >= 0.67 for 1 s (until then 0.669), so
//            millisecond flicker is not a crossing. Falling below is seen at once.
//
// Every strategy `submit` is one firing; a synthetic FILLED order is fed back so
// the strategy advances its direction exactly as a real fill would.
//
// Fill model (FILTERED only): the order reaches the venue 0.3 s after the
// decision and is matched against the first accepted frame at t >= fire + 0.3
// (none before the round ends: too_late). It takes that side's ask levels
// priced <= 0.70, cheapest first, minus what earlier firings of the round took
// at each price (each level's size is usable once). The unfilled remainder
// never fills, so this is a lower bound. Taker fee per level at the crypto rate
// 0.07. Depth before DEPTH_FROM is known bad: no_depth, filled/cost/PnL null.
// Winner is read from the last accepted frame: the side whose ask or bid >= 0.9.
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
const CRASHED_SUM = 1.05, DWELL_SEC = 1.0, ORDER_DELAY_SEC = 0.3, START_GRACE_SEC = 10;
const BELOW_TRIGGER = 0.669;
/** Recorded depth before this time is known bad. */
const DEPTH_FROM = 1_790_878_037;
const SCHEMA_VERSION = 2;

type Level = [number, number];
type Dir = "UP" | "DOWN";
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

export type SimFillStatus = "full" | "partial" | "none" | "too_late" | "no_depth";
export interface SimFiring {
  i: number; t: number; dir: Dir; ask: number; shares: number;
  avail: number | null; filled: number | null; cost: number | null; fee: number | null; status: SimFillStatus;
}
export interface SimRoundResult {
  schemaVersion: 2; asset: string; roundId: string; marketId: string; startsAt: number;
  firingsRaw: number; firings: number; reversals: number; rawSeconds: number[]; events: SimFiring[];
  depthOk: boolean; winner: Dir | null; simPnl4: number | null; simPnlAll: number | null;
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

function ladder(): number[] {
  const base = [5, 20, 60, 140];
  const out = base.slice();
  while (out.length < LADDER_LENGTH) out.push(140);
  return out;
}

/** Round state the simulator tracks alongside the strategies' own state. */
interface SimRound {
  asset: string; marketId: string; roundId: string; startsAt: number; endsAt: number;
  rawSeconds: number[];
  firings: SimFiring[];
  pending: { firing: SimFiring; at: number }[];
  consumed: Record<Dir, Map<number, number>>;      // price -> shares already taken this round
  aboveSince: Record<Dir, number | undefined>;     // FILTERED 1 s dwell per side
  firstAccepted?: number;
  last?: SimBook;                                  // last accepted (not crashed) frame
  finalized: boolean;
}

const fee = (shares: number, price: number): number =>
  Math.round(polymarketFillFee(shares, price, false, CRYPTO_FEE_RATE, 0, 1) * 100_000) / 100_000;
const r5 = (value: number) => Math.round(value * 100_000) / 100_000;
/** Two real strategies per asset (RAW, FILTERED), fed real quotes, producing per-round counts and fills. */
export class ReversalSim {
  private readonly strategies = new Map<string, BtcReversalStrategy>();  // `${asset}:raw|filtered`
  private readonly markets = new Map<string, MarketInfo[]>();       // asset -> known markets
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

  private strategy(asset: string, kind: "raw" | "filtered"): BtcReversalStrategy {
    const key = `${asset}:${kind}`;
    let strategy = this.strategies.get(key);
    if (!strategy) {
      strategy = createStrategy({ assetId: asset as AssetId, stageShares: ladder(), maxStages: LADDER_LENGTH,
        triggerPrice: TRIGGER_PRICE, confirmationPrice: CONFIRMATION_PRICE, maxBuyPrice: MAX_BUY_PRICE,
        maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 });
      this.strategies.set(key, strategy);
      if (!this.markets.has(asset)) this.markets.set(asset, []);
    }
    return strategy;
  }

  private marketInfo(asset: string, book: SimBook): MarketInfo {
    const startsAt = Number(book.roundId);
    const instrument = (tokenId: string, outcome: string): Instrument =>
      ({ tokenId, marketId: book.marketId, outcome, tickSize: 0.01, minOrderSize: 5 });
    return { id: book.marketId, assetId: asset as AssetId, roundId: book.roundId,
      name: `${asset}-updown-5m-${startsAt}`, startsAt, endsAt: startsAt + WINDOW_SEC,
      instruments: [instrument(book.upTokenId, "Up"), instrument(book.downTokenId, "Down")] };
  }

  private context(asset: string): StrategyContext {
    const now = this.now();
    return { mode: "live", now, markets: this.markets.get(asset) ?? [], books: [],
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
    const key = `${asset}:${book.roundId}`;
    if (this.written.has(key)) return;             // already recorded (dedupe live vs replay)
    const raw = this.strategy(asset, "raw");
    const filtered = this.strategy(asset, "filtered");
    const markets = this.markets.get(asset)!;
    if (!markets.some(market => market.id === book.marketId)) markets.push(this.marketInfo(asset, book));
    const roundKey = `${asset}:${book.marketId}`;
    if (!this.rounds.has(roundKey)) {
      this.rounds.set(roundKey, { asset, marketId: book.marketId, roundId: book.roundId,
        startsAt, endsAt: startsAt + WINDOW_SEC, rawSeconds: [], firings: [], pending: [],
        consumed: { UP: new Map(), DOWN: new Map() }, aboveSince: { UP: undefined, DOWN: undefined },
        finalized: false });
      // The strategy only trades a round it discovered while now <= startsAt
      // (btc-reversal.discover). Books always arrive during the round, so prime
      // discovery with a pre-start timer first; without it every round would be
      // parked as waiting_next_round and never fire.
      for (const strategy of [raw, filtered]) {
        strategy.onEvent({ kind: "timer", ts: startsAt - 1 }, this.withNow(asset, startsAt - 1));
      }
    }
    const round = this.rounds.get(roundKey)!;
    const t = (at: number) => Math.round((at - startsAt) * 10) / 10;

    // RAW: every frame, raw asks — only counted.
    this.fire(raw, asset, book, book.upAsk, book.downAsk, clock, () => { round.rawSeconds.push(t(clock)); });

    // FILTERED: a crashed book reaches nothing — not the strategy, the dwell or the winner.
    if ((book.upAsk ?? 0) + (book.downAsk ?? 0) > CRASHED_SUM) return;
    round.firstAccepted ??= clock;
    round.last = book;
    this.resolvePending(round, book, clock);
    const upAsk = this.dwell(round, "UP", book.upAsk, clock);
    const downAsk = this.dwell(round, "DOWN", book.downAsk, clock);
    this.fire(filtered, asset, book, upAsk, downAsk, clock, (tokenId, shares) => {
      const dir: Dir = tokenId === book.upTokenId ? "UP" : "DOWN";
      const ask = Number(dir === "UP" ? book.upAsk : book.downAsk);
      const firing: SimFiring = { i: round.firings.length + 1, t: t(clock), dir, ask: Number.isFinite(ask) ? ask : 0,
        shares, avail: null, filled: null, cost: null, fee: null, status: "too_late" };
      round.firings.push(firing);
      round.pending.push({ firing, at: clock + ORDER_DELAY_SEC });
    });
  }
  /** Run one strategy on this frame with the given asks; call `onFire` per submit and feed back a fill. */
  private fire(strategy: BtcReversalStrategy, asset: string, book: SimBook, upAsk: number | undefined,
    downAsk: number | undefined, clock: number, onFire: (tokenId: string, shares: number) => void): void {
    const snapshot = this.snapshot(asset, { ...book, upAsk, downAsk }, clock);
    const actions = strategy.onEvent({ kind: "book", snapshot, marketId: book.marketId,
      roundId: book.roundId, assetId: asset as AssetId }, this.withNow(asset, clock));
    for (const action of actions) {
      if (action.kind !== "submit") continue;
      onFire(action.order.tokenId, action.order.shares);
      // Feed back a synthetic FILLED order so the rung is consumed and the live
      // direction advances, exactly as a real fill would (consumedRung()).
      strategy.onEvent({ kind: "order", order: this.filledOrder(action.order), marketId: book.marketId,
        roundId: book.roundId, assetId: asset as AssetId }, this.withNow(asset, clock));
    }
  }

  /** 1 s dwell: the ask only shows as >= 0.67 once it has stayed there 1 s. */
  private dwell(round: SimRound, side: Dir, ask: number | undefined, clock: number): number | undefined {
    if (ask === undefined) return undefined;
    if (ask < TRIGGER_PRICE) { round.aboveSince[side] = undefined; return ask; }
    const since = round.aboveSince[side] ??= clock;
    return clock - since >= DWELL_SEC ? ask : Math.min(ask, BELOW_TRIGGER);
  }

  /** Fill every firing whose order has reached the venue by this accepted frame. */
  private resolvePending(round: SimRound, book: SimBook, clock: number): void {
    const due = round.pending.filter(item => clock >= item.at);
    if (!due.length) return;
    round.pending = round.pending.filter(item => clock < item.at);
    for (const { firing } of due) this.fill(round, firing, firing.dir === "UP" ? book.upAskLevels : book.downAskLevels, clock);
  }

  private fill(round: SimRound, firing: SimFiring, levels: Level[] | undefined, clock: number): void {
    if (!levels?.length || clock < DEPTH_FROM) { firing.status = "no_depth"; return; }
    const consumed = round.consumed[firing.dir];
    const usable = levels.filter(([price]) => price <= MAX_BUY_PRICE + 1e-9)
      .map(([price, size]) => [price, Math.max(0, size - (consumed.get(price) ?? 0))] as Level)
      .sort((a, b) => a[0] - b[0]);
    let left = firing.shares, cost = 0, paid = 0, avail = 0;
    for (const [price, size] of usable) {
      avail += size;
      const qty = Math.min(left, size);
      if (qty <= 0) continue;
      left -= qty; cost += price * qty; paid += fee(qty, price);
      consumed.set(price, (consumed.get(price) ?? 0) + qty);
    }
    const filled = r5(firing.shares - left);
    firing.avail = r5(avail); firing.filled = filled; firing.cost = r5(cost); firing.fee = r5(paid);
    firing.status = filled >= firing.shares - 1e-9 ? "full" : filled > 0 ? "partial" : "none";
  }

  private withNow(asset: string, clock: number): StrategyContext {
    return { ...this.context(asset), now: clock };
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

  private filledOrder(order: Omit<OrderRecord, "strategyId" | "status" | "filledShares" | "reservedUsd"
    | "reservedShares" | "createdAt" | "updatedAt"> & { clientOrderId: string }): OrderRecord {
    const now = this.now();
    return { ...order, strategyId: "btc-reversal", orderId: `${order.clientOrderId}:sim`, status: "FILLED",
      filledShares: order.shares, reservedUsd: 0, reservedShares: 0, createdAt: now, updatedAt: now };
  }

  private finalizeExpired(asset: string, clock: number): void {
    for (const round of [...this.rounds.values()]) {
      if (round.asset === asset && !round.finalized && clock >= round.endsAt) this.finalize(round);
    }
    // Bound memory: drop a market long past its close from the discovery list.
    const markets = this.markets.get(asset);
    if (markets) this.markets.set(asset, markets.filter(market => market.endsAt > clock - 2 * WINDOW_SEC));
  }

  private finalize(round: SimRound): void {
    round.finalized = true;
    const key = `${round.asset}:${round.roundId}`;
    this.rounds.delete(`${round.asset}:${round.marketId}`);
    if (this.written.has(key)) return;
    this.written.add(key);
    // No accepted frame >= +0.3 s before the round ended: the order came too late.
    for (const { firing } of round.pending) Object.assign(firing, { status: "too_late", filled: 0, cost: 0, fee: 0 });
    // Only a round watched from its start: one first seen mid-round (restart)
    // would undercount, so it is dropped.
    if (round.firstAccepted === undefined || round.firstAccepted > round.startsAt + START_GRACE_SEC) return;
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
    const depthOk = round.firings.every(firing => firing.status !== "no_depth");
    const sum = (firings: SimFiring[]) => depthOk ? Math.round(firings.reduce((total, f) =>
      total + (f.dir === winner ? f.filled ?? 0 : 0) - (f.cost ?? 0) - (f.fee ?? 0), 0) * 1_000) / 1_000 : null;
    const firings = round.firings.length;
    return { schemaVersion: SCHEMA_VERSION, asset: round.asset, roundId: round.roundId, marketId: round.marketId,
      startsAt: round.startsAt, firingsRaw: round.rawSeconds.length, firings, reversals: Math.max(0, firings - 1),
      rawSeconds: round.rawSeconds, events: round.firings, depthOk, winner,
      simPnl4: sum(round.firings.slice(0, 4)), simPnlAll: sum(round.firings) };
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
