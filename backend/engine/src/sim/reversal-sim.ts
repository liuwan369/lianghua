// Paper "simulated trading" (模拟交易) for the reversal strategy.
//
// Goal (user): a single page that shows, from REAL market data, how many times
// the live strategy would fire per 5-minute round (first trigger + every
// reversal), uncapped, for all seven coins — the max could be ~67. The count is
// the point: it tells the operator how to size the ladder.
//
// This NEVER touches the live order path, the ledger or live config. It runs one
// real BtcReversalStrategy per asset with a fixed, documented config:
//   triggerPrice .67, confirmationPrice .70, maxBuyPrice .70, maxQuoteAgeSeconds 2,
//   maxQuoteSkewSeconds 1.5, and an uncapped ladder (maxStages 1000, stageShares
//   [5,20,60,140, then 140 repeated]). No budgets/loss caps — we want every fire.
//
// Every strategy `submit` is one firing. We immediately feed back a synthetic
// FILLED order so the strategy sees the rung consumed and advances its direction
// (consumedRung() true, lastLiveDirection flips), exactly as a real fill would.
//
// Assumptions for the published PnL (documented on the page too): each firing is
// assumed to fill at the crossing side's ask when ask <= maxBuyPrice (.70), else
// it is marked unfilled (the real GTC limit at .70 would not fill). No slippage,
// no queue — live will be worse. Fee uses the venue formula polymarketFillFee at
// the crypto taker rate 0.07 (models.ts / polymarket.ts default). Winner is read
// from the last quote: the side whose ask or bid >= 0.9 wins; null if unclear.
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

/** A minimal paired book the simulator can consume, carrying only what the
 * strategy's quote gate reads. Both the live collector feed and the replayed
 * recordings are reduced to this shape. */
export interface SimBook {
  marketId: string;
  roundId: string;
  upTokenId: string;
  downTokenId: string;
  upAsk?: number; upBid?: number;
  downAsk?: number; downBid?: number;
  upSourceAt?: number; downSourceAt?: number;
  expiresAt?: number;
  marketAgeMs?: number;
  sequence?: number;
}

export interface SimFiring { i: number; t: number; dir: "UP" | "DOWN"; ask: number; shares: number; }
export interface SimRoundResult {
  asset: string; roundId: string; marketId: string; startsAt: number;
  firings: number; reversals: number; events: SimFiring[];
  winner: "UP" | "DOWN" | null; simPnl4: number; simPnlAll: number;
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
    upSourceAt: num(yes?.sourceAt), downSourceAt: num(no?.sourceAt),
    expiresAt: num(snapshot.expiresAt), sequence: num(snapshot.sequence) };
}

function ladder(): number[] {
  const base = [5, 20, 60, 140];
  const out = base.slice();
  while (out.length < LADDER_LENGTH) out.push(140);
  return out;
}

/** Round state the simulator tracks alongside the strategy's own state. */
interface SimRound {
  asset: string; marketId: string; roundId: string; startsAt: number; endsAt: number;
  firings: SimFiring[];
  lastUpAsk?: number; lastUpBid?: number; lastDownAsk?: number; lastDownBid?: number;
  finalized: boolean;
}

const fee = (shares: number, price: number): number =>
  Math.round(polymarketFillFee(shares, price, false, CRYPTO_FEE_RATE, 0, 1) * 100_000) / 100_000;

/** One real strategy per asset, fed real quotes, producing per-round firing counts. */
export class ReversalSim {
  private readonly strategies = new Map<string, BtcReversalStrategy>();
  private readonly markets = new Map<string, MarketInfo[]>();       // asset -> known markets
  private readonly rounds = new Map<string, SimRound>();            // asset:marketId -> round
  private readonly written = new Set<string>();                    // asset:roundId already on disk
  private readonly now: () => number;
  private readonly retentionDays: number;
  dropped = 0; wroteRounds = 0;

  constructor(private readonly simDir: string, options: { now?: () => number; retentionDays?: number } = {}) {
    this.now = options.now ?? (() => Date.now() / 1000);
    this.retentionDays = options.retentionDays ?? 10;
    mkdirSync(simDir, { recursive: true });
    this.pruneAndIndex();
  }

  private strategy(asset: string): BtcReversalStrategy {
    let strategy = this.strategies.get(asset);
    if (!strategy) {
      strategy = createStrategy({ assetId: asset as AssetId, stageShares: ladder(), maxStages: LADDER_LENGTH,
        triggerPrice: TRIGGER_PRICE, confirmationPrice: CONFIRMATION_PRICE, maxBuyPrice: MAX_BUY_PRICE,
        maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 });
      this.strategies.set(asset, strategy);
      this.markets.set(asset, []);
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

  /** Feed one real paired quote at `clock` seconds. Returns firings produced. */
  observe(asset: string, book: SimBook, clock: number): void {
    this.finalizeExpired(asset, clock);
    const startsAt = Number(book.roundId);
    if (!book.marketId || !book.roundId || !Number.isSafeInteger(startsAt) || startsAt % WINDOW_SEC !== 0
      || !book.upTokenId || !book.downTokenId || book.upTokenId === book.downTokenId) return;
    const key = `${asset}:${book.roundId}`;
    if (this.written.has(key)) return;             // already recorded (dedupe live vs replay)
    const strategy = this.strategy(asset);
    const markets = this.markets.get(asset)!;
    if (!markets.some(market => market.id === book.marketId)) markets.push(this.marketInfo(asset, book));
    const roundKey = `${asset}:${book.marketId}`;
    if (!this.rounds.has(roundKey)) {
      this.rounds.set(roundKey, { asset, marketId: book.marketId, roundId: book.roundId,
        startsAt, endsAt: startsAt + WINDOW_SEC, firings: [], finalized: false });
      // The strategy only trades a round it discovered while now <= startsAt
      // (btc-reversal.discover). Books always arrive during the round, so prime
      // discovery with a pre-start timer first; without it every round would be
      // parked as waiting_next_round and never fire.
      strategy.onEvent({ kind: "timer", ts: startsAt - 1 }, this.withNow(asset, startsAt - 1));
    }
    const round = this.rounds.get(roundKey)!;
    round.lastUpAsk = book.upAsk; round.lastUpBid = book.upBid;
    round.lastDownAsk = book.downAsk; round.lastDownBid = book.downBid;

    const snapshot = this.snapshot(asset, book, clock);
    const actions = strategy.onEvent({ kind: "book", snapshot, marketId: book.marketId,
      roundId: book.roundId, assetId: asset as AssetId }, this.withNow(asset, clock));
    for (const action of actions) {
      if (action.kind !== "submit") continue;
      const order = action.order;
      const dir: "UP" | "DOWN" = order.tokenId === book.upTokenId ? "UP" : "DOWN";
      const ask = dir === "UP" ? Number(book.upAsk) : Number(book.downAsk);
      round.firings.push({ i: round.firings.length + 1, t: Math.round((clock - startsAt) * 10) / 10,
        dir, ask: Number.isFinite(ask) ? ask : 0, shares: order.shares });
      // Feed back a synthetic FILLED order so the rung is consumed and the live
      // direction advances, exactly as a real fill would (consumedRung()).
      strategy.onEvent({ kind: "order", order: this.filledOrder(order), marketId: book.marketId,
        roundId: book.roundId, assetId: asset as AssetId }, this.withNow(asset, clock));
    }
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
    const result = this.result(round);
    try {
      appendFileSync(join(this.simDir, `${round.asset}.jsonl`), `${JSON.stringify(result)}\n`);
      this.wroteRounds += 1;
    } catch { this.dropped += 1; }
  }

  private result(round: SimRound): SimRoundResult {
    const upWin = (round.lastUpAsk ?? 0) >= 0.9 || (round.lastUpBid ?? 0) >= 0.9;
    const downWin = (round.lastDownAsk ?? 0) >= 0.9 || (round.lastDownBid ?? 0) >= 0.9;
    const winner: "UP" | "DOWN" | null = upWin === downWin ? null : upWin ? "UP" : "DOWN";
    const pnl = (firing: SimFiring): number => {
      if (!(firing.ask > 0 && firing.ask <= MAX_BUY_PRICE)) return 0;   // limit 0.70 would not fill
      const cost = firing.shares * firing.ask + fee(firing.shares, firing.ask);
      const payout = winner === firing.dir ? firing.shares : 0;
      return Math.round((payout - cost) * 1_000) / 1_000;
    };
    const sum = (firings: SimFiring[]) => Math.round(firings.reduce((total, f) => total + pnl(f), 0) * 1_000) / 1_000;
    return { asset: round.asset, roundId: round.roundId, marketId: round.marketId, startsAt: round.startsAt,
      firings: round.firings.length, reversals: Math.max(0, round.firings.length - 1), events: round.firings,
      winner, simPnl4: sum(round.firings.slice(0, 4)), simPnlAll: sum(round.firings) };
  }

  /** Finalize every open round (end of a replay, or collector shutdown). */
  flush(): void {
    for (const round of [...this.rounds.values()]) if (!round.finalized) this.finalize(round);
  }

  /** Prune lines older than retentionDays and index what remains for dedupe. */
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
          this.written.add(`${asset}:${row.roundId}`);
        }
      } catch { continue; }
      try { writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : ""); } catch { this.dropped += 1; }
    }
  }
}
