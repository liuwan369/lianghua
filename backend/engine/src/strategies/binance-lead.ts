import { LEAD_VENUES, type AssetId, type Instrument, type LeadVenue, type MarketInfo, type OrderRecord, type OrderRequest,
  type OrderStatus, type StrategyAction, type StrategyContext, type StrategyPlugin, type TradingEvent } from "../platform/contracts.js";

/** Binance lead (rule frozen 2026-10-25, E:/pm-backup/forward-binance-agg.py):
 * the round's first valid lead signal whose book in force is two-sided and was
 * fresh on arrival gets one FAK BUY on the signal's side at ask + premium, held
 * to the close. One order per round, filled or not, whichever venue's signal
 * it was. The windows live in one LeadSignalDetector per venue on the feed
 * side; this plugin only sees the rare signals. */
export type LeadDirection = "UP" | "DOWN";
export type OpenLine = "tick" | "mean60";
export const OPEN_LINES: readonly OpenLine[] = ["tick", "mean60"];
export interface BinanceLeadConfig {
  instanceId: string;
  assetId: AssetId;
  revision: string;
  shares: number;
  /** Detector parameters; the strategy also holds the round to [fromSec, toSec). */
  thresholdBp: number;
  windowMs: number;
  limitPremium: number;
  fromSec: number;
  toSec: number;
  /** Highest ask (inclusive) of the signal's side that is bought (user 2026-10-26). */
  maxAsk: number;
  /** Venues whose USDT perpetual trades signal, each with its own detector
   * (non-empty, unique). Read when the engine starts. */
  leadVenues: LeadVenue[];
  /** Also take each venue's trades relayed from Tokyo (first copy wins).
   * Read when the engine starts; needs PM_RELAY_KEY_FILE there. */
  tokyoRelay: boolean;
  /** The venues that also get an Ireland direct line (distinct, may be empty);
   * the rest come over Tokyo only. Read when the engine starts, and only with
   * the Tokyo line running: without it every venue keeps its direct line.
   * User 2026-11-21: Bybit only (OKX/Binance direct almost never arrive first),
   * to keep the burstable AWS box under its CPU baseline. */
  directVenues: LeadVenue[];
  /** Trade only a signal whose lead price is within this many bp of the round's
   * opening lead price, signed by the signal (+ = its side already ahead):
   * -openBandBp <= d < openBandBp. 0 = no filter. User 2026-11-01: 5 (backtest
   * E:/pm-backup/research-1101/band.py, fills calibrated on 169 live orders:
   * +525 vs +406 unfiltered, 16/16 days, ±4..±6 a plateau). Far from the open the
   * price has already priced the outcome (edge +4 points vs +13..16 near it). */
  openBandBp: number;
  /** What openBandBp is measured from (user 2026-11-07): "tick" the last trade at
   * or before the open (openPrice), "mean60" the mean over (R-60, R]
   * (openMean60), the window of the official price to beat. Backtest
   * E:/pm-backup/research-1107/band_width.py, 21 days, ±5: +760 vs +626 tick;
   * on unseen 11-02..06 mean60 won all 12 cells. */
  openLine: OpenLine;
  /** Rest after a miss (user 2026-11-14): when the round's FAK ends short of
   * its shares, rest ONE post-only GTC BUY at the FAK's limit for the
   * remainder, cancelled this many seconds after the venue accepted it. 0 =
   * off. Live orders 10-26..11-13 (E:/pm-backup/research-1113/missed.py D):
   * a 5 s rest would have filled 147 of 395 misses (queue ignored), won 57%,
   * +50.8 at 5 shares, positive in both halves. */
  restAfterMissSec: number;
  /** With the rest off, still record per missed FAK when a frame within
   * REST_SHADOW_SEC of its reply put that side's ask at or under the limit
   * (stage.restShadowFillAt): what a rest would have filled. No order. */
  restShadow: boolean;
  /** The round's order (user 2026-11-15). "fak": a FAK, then after a miss the
   * rest order above. "gtc": one GTC BUY at the same limit; what matches after
   * the taker delay is a taker fill, what does not rests on the book (maker,
   * no fee) from the venue's reply, cancelled restAfterMissSec after it. One
   * order: no rest order, no post-only refusal when the ask came back. */
  entryOrder: EntryOrder;
  /** Regime pause (user 2026-11-16, off by default): skip a signal that came
   * in a wild market (regimePause: more than REGIME_PAUSE_SIGNALS signals or a
   * 1 s std above REGIME_PAUSE_VOL_BP in the 300 s before it); the round waits
   * for a later signal. Off, the decision is still journalled (shadow). Live
   * 11-16 01:40-10:00: the 20 orders it would have skipped won 6, -41.97; the
   * 39 kept +3.71. */
  regimePause: boolean;
  /** Size by edge (user 2026-11-17, off by default): the signal side's fair
   * value from the distance to the 60 s pre-open mean and the time left
   * (leadFairValue), minus the limit and the taker fee, picks the shares:
   * >= EDGE_HIGH -> EDGE_SHARES_HIGH, < EDGE_LOW -> EDGE_SHARES_LOW, else
   * `shares`. Off, the edge and the shares it would pick are only recorded
   * (stage.edge, stage.edgeShares). 29-day backtest with the limit order and
   * the regime pause: +182 (t 1.96, both halves positive). */
  edgeSizing: boolean;
  /** Exit on the first reverse signal (user 2026-11-17, off by default): once
   * the round holds shares, the first opposite signal (from EXIT_AFTER_SEC
   * after the first fill) sells what it holds, FAK at the held side's bid -
   * EXIT_PREMIUM. Off, the bid in force at that signal is only recorded
   * (round.exitFirst). 29-day backtest with the limit order and the regime
   * pause: +64 (t 0.74); live 390 orders: +36. */
  exitOnReverse: boolean;
  maxQuoteAgeSeconds: number;
  maxQuoteSkewSeconds: number;
  roundBudgetUsd?: number;
  totalBudgetUsd?: number;
  dailyLossUsd?: number | null;
}
export type EntryOrder = "fak" | "gtc";
export const ENTRY_ORDERS: readonly EntryOrder[] = ["fak", "gtc"];
type LeadEvent = Extract<TradingEvent, { kind: "lead" }>;
export type LeadSignalRecord = Omit<LeadEvent, "kind" | "assetId">;
export interface LeadStage {
  /** "fak" the round's FAK (client id :1); "rest" the post-only BUY after it
   * missed (client id :rest); "gtc" the round's one GTC (client id :1,
   * entryOrder gtc). Absent in older state: "fak". */
  kind?: "fak" | "rest" | "gtc";
  direction: LeadDirection;
  tokenId: string;
  clientOrderId: string;
  /** Limit: ask at the signal + limitPremium, on tick, at most 0.99. */
  price: number;
  shares: number;
  createdAt: number;
  status: OrderStatus | "CREATED" | "ABANDONED";
  orderId?: string;
  filledShares: number;
  /** Estimate reserved before core dispatch; not an actual fill fee. */
  feeReserveUsd?: number;
  error?: string;
  cancelRequestedAt?: number;
  signal: LeadSignalRecord;
  askAtSignal: number;
  /** Receive time (wall s) of the round's first frame after the signal whose
   * ask on this side was gone or above the limit, within ASK_GONE_WATCH_SEC of
   * createdAt; askGoneVenueAt is that side's venue time (s). */
  askGoneAtUnix?: number;
  askGoneVenueAt?: number;
  /** FAK stage, shadow on: receive time of the first frame within
   * REST_SHADOW_SEC of the FAK's reply whose ask on this side was at or under
   * the limit. */
  restShadowFillAt?: number;
  /** FAK stage: when its miss was known (the venue's reply, else the update),
   * the start of the shadow window. */
  missedAt?: number;
  /** FAK stage: the rest after its miss was decided (placed or declined) once. */
  restDecided?: boolean;
  /** When this stage first held shares (the order update's time). */
  firstFillAt?: number;
  /** Rest or GTC stage: when its timed cancel is due (strategy clock), set once
   * the venue accepted it. */
  cancelAt?: number;
  /** The round's first order: its fair value (leadFairValue) and edge (fair -
   * limit - taker fee) at the decision, and the shares edgeSizing picks
   * (whether or not it is on). Absent without a fair value. */
  fair?: number;
  edge?: number;
  edgeShares?: number;
}
/** Exit on the first reverse signal (user 2026-11-17): the first opposite
 * signal after the round held shares. Recorded whether or not exitOnReverse
 * sells; kept on the round. */
export interface LeadExitFirst {
  /** Receive time (s) of the signal, the held side's bid then (null without
   * one), the shares held then, and whether a sell was sent (why not when not). */
  at: number;
  bid: number | null;
  shares: number;
  sent: boolean;
  skip?: string;
  /** Decided to sell, waiting for the round's buy to stop working (a GTC or
   * rest remainder being cancelled, a FAK still reporting). */
  waiting?: boolean;
  /** Where BTC stood against the round's 60 s pre-open mean at the signal,
   * in bp, + = on the held side's side (user 2026-11-19: "keep when it is
   * still >= 3-5 bp ours", recorded only; 29-day backtest +14 / +24 held out,
   * not significant). Absent without an open line, or on an older record. */
  leadBp?: number;
}
/** The exit sell (exitOnReverse): one FAK SELL of what the round held, client
 * id <instance>:<market>:exit. Never in `stages` (those are the round's buys). */
export interface LeadExitOrder {
  tokenId: string;
  clientOrderId: string;
  price: number;
  shares: number;
  createdAt: number;
  status: OrderStatus | "CREATED" | "ABANDONED";
  orderId?: string;
  filledShares: number;
  error?: string;
}
/** Summary of the round's latest frame; never restored across a restart. */
export interface LeadQuote {
  upAsk?: number;
  downAsk?: number;
  upBid?: number;
  downBid?: number;
  twoSided: boolean;
  freshOnArrival: boolean;
  staleReason?: string;
}
export interface LeadRound {
  assetId: AssetId;
  marketId: string;
  roundId: string;
  name: string;
  startsAt: number;
  endsAt: number;
  upTokenId: string;
  downTokenId: string;
  config: BinanceLeadConfig;
  status: "waiting_start" | "waiting_next_round" | "running" | "ended";
  reason: string;
  /** The round's FAK once placed, then at most its rest order. */
  stages: LeadStage[];
  exitFirst?: LeadExitFirst;
  exit?: LeadExitOrder;
  latest?: LeadQuote;
}
export interface BinanceLeadState {
  schemaVersion: 1;
  strategyId: "binance-lead";
  instanceId: string;
  config: BinanceLeadConfig;
  rounds: LeadRound[];
  paused: boolean;
}
export interface BinanceLeadOptions {
  persist?: (state: BinanceLeadState) => void;
  restoredState?: BinanceLeadState;
}

export const BINANCE_LEAD_DEFAULTS: Readonly<BinanceLeadConfig> = Object.freeze({
  instanceId: "binance-lead", assetId: "btc", revision: "1", shares: 5, thresholdBp: 2, windowMs: 250,
  limitPremium: 0.03, fromSec: 15, toSec: 265, maxAsk: 0.8, leadVenues: [...LEAD_VENUES], tokyoRelay: true,
  directVenues: [...LEAD_VENUES], openBandBp: 0, openLine: "tick", restAfterMissSec: 0, restShadow: true, entryOrder: "fak", regimePause: false, edgeSizing: false, exitOnReverse: false, maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5,
});
/** Every config field; anything else in a saved config (retired settings) is dropped. */
const CONFIG_KEYS = [...Object.keys(BINANCE_LEAD_DEFAULTS), "roundBudgetUsd", "totalBudgetUsd", "dailyLossUsd"];
const EPS = 1e-8;
/** A round keeps its config from this many seconds before it starts. */
const CONFIG_FREEZE_SEC = 10;
/** A frame whose two asks sum above this was not fresh on arrival (backtest `ok`). */
const WIDE_SUM = 1.05;
const MAX_LIMIT = 0.99;
/** How long after a stage's decision its side's ask is watched for going away. */
export const ASK_GONE_WATCH_SEC = 10;
/** The shadow rest window after a missed FAK's reply. */
export const REST_SHADOW_SEC = 5;
/** A rest is placed only with this much of the round left beyond its hold. */
const REST_MARGIN_SEC = 5;
/** A timed cancel not yet confirmed is re-sent after this long. */
const CANCEL_RETRY_SEC = 1;
/** An order whose cancel the venue refused is UNKNOWN until account recovery
 * settles it; its cancel is re-sent only this often (2026-11-14 19:06: a
 * partly filled rest with nothing left resting was cancelled every second for
 * 13 minutes, each refusal halting the account again). */
const UNKNOWN_CANCEL_RETRY_SEC = 30;
const cancelDue = (stage: LeadStage, now: number) => stage.cancelRequestedAt === undefined
  || now - stage.cancelRequestedAt >= (stage.status === "UNKNOWN" ? UNKNOWN_CANCEL_RETRY_SEC : CANCEL_RETRY_SEC);
/** A rest is placed within this long of the FAK's miss, or not at all. */
const REST_LATE_SEC = 2;
/** A reverse signal this soon after the fill's update is the same move, not a turn. */
const EXIT_AFTER_SEC = 0.5;
/** Exit on the first reverse signal: the sell's limit under the held side's
 * bid (it takes the bid and the levels down to this), as the backtest. */
export const EXIT_PREMIUM = 0.08;
/** No exit this close to the close (the backtest stops at R + 295). */
const EXIT_LAST_SEC = 5;
/** Shadow regime pause (user 2026-11-15, records only): a round's order whose
 * signal came with more than REGIME_PAUSE_SIGNALS of its venue's signals, or a
 * 1 s return std above REGIME_PAUSE_VOL_BP, in the 300 s before it would have
 * been skipped. Thresholds: the 90th percentile of the first 14 of 28 days
 * (E:/pm-backup/research-1115/regime.py: +48 / +64 over 28 days, t 0.5 / 0.7). */
export const REGIME_PAUSE_SIGNALS = 12;
export const REGIME_PAUSE_VOL_BP = 0.89;
/** Whether the shadow pause would have skipped this signal, and why. */
export function regimePause(signal: Pick<LeadSignalRecord, "signals300" | "vol300Bp">):
  { pause: boolean; reason: "signals" | "vol" | null } {
  if (finite(signal.signals300) && signal.signals300 > REGIME_PAUSE_SIGNALS) return { pause: true, reason: "signals" };
  if (finite(signal.vol300Bp) && signal.vol300Bp > REGIME_PAUSE_VOL_BP) return { pause: true, reason: "vol" };
  return { pause: false, reason: null };
}
/** Size by edge: the cuts are the quartiles of the 29-day backtest edge
 * (E:/pm-backup/research-1117/three.txt); the shares on each side of them
 * (combined.py: +182 over 10 shares flat, t 1.96). */
export const EDGE_HIGH = 0.07;
export const EDGE_LOW = -0.04;
export const EDGE_SHARES_HIGH = 15;
export const EDGE_SHARES_LOW = 5;
/** The close is the 60 s mean before it: the remaining variance of that mean
 * is the variance to its start plus a third of its own 60 s, i.e. the time
 * left minus 40 s. */
const TWAP_DISCOUNT_SEC = 40;
const normalCdf = (x: number): number => {
  // Abramowitz-Stegun 7.1.26 erf, |error| < 1.5e-7.
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
};
/** P(the signal's side wins) from the signal price against the 60 s pre-open
 * mean, the 1 s return std of the 300 s before (bp) and the seconds left;
 * undefined without the mean or a volatility. */
export function leadFairValue(signal: Pick<LeadSignalRecord, "price" | "openMean60" | "vol300Bp" | "direction">,
  secondsLeft: number): number | undefined {
  if (!positive(signal.openMean60) || !positive(signal.vol300Bp) || !positive(signal.price) || !finite(secondsLeft)) return undefined;
  const sigma = signal.vol300Bp / 1e4;
  const sd = sigma * Math.sqrt(Math.max(1, secondsLeft - TWAP_DISCOUNT_SEC));
  const up = normalCdf(Math.log(signal.price / signal.openMean60) / sd);
  return signal.direction === "UP" ? up : 1 - up;
}
/** The shares the edge picks (undefined edge: the configured shares). */
export function edgeShares(edge: number | undefined, configured: number): number {
  if (edge === undefined) return configured;
  return edge >= EDGE_HIGH ? EDGE_SHARES_HIGH : edge < EDGE_LOW ? EDGE_SHARES_LOW : configured;
}
/** Crypto taker fee rate (official 0.07 x p x (1 - p) per share). */
const TAKER_FEE_RATE = 0.07;
/** The venue refuses a marketable BUY under this many USD (2026-10-26 live:
 * "invalid amount for a marketable BUY order ($0.65), min size: 1"). */
const MIN_MARKETABLE_BUY_USD = 1;
const WAITING = "等待领先信号";
const clone = <T>(value: T): T => structuredClone(value);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const unitPrice = (n: unknown): n is number => positive(n) && n < 1;
/** 0.8 -> "0.80"; a finer tick keeps its digits (0.805). */
const priceText = (n: number) => Number(n.toFixed(2)) === n ? n.toFixed(2) : String(n);
const validDirection = (value: unknown): value is LeadDirection => value === "UP" || value === "DOWN";
const activeOrder = (status: string) => ["CREATED", "SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(status);
/** The stage's order may still have something on the book: active, short of
 * its shares. */
const hasRemainder = (stage: Readonly<LeadStage>) => activeOrder(stage.status) && !!stage.orderId
  && stage.filledShares < stage.shares - EPS;
const STAGE_STATUSES = ["CREATED", "SUBMITTING", "OPEN", "PARTIAL", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN", "ABANDONED"];

/** Ask + premium, rounded down to the tick (never pays more than the rule), capped at 0.99. */
export function leadLimitPrice(ask: number, premium: number, tickSize: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(tickSize) - 1e-9));
  const onTick = Math.floor((ask + premium) / tickSize + 1e-9) * tickSize;
  return Number(Math.min(MAX_LIMIT, onTick).toFixed(decimals));
}

/** The configured size, raised to the fewest whole shares worth the venue's
 * marketable-BUY minimum at the limit: a cheap side (ask 0.10, limit 0.13)
 * buys 8 shares instead of being refused. Backtest (PMData 09-15..10-04): 51
 * of 442 fills cost under 1 USD at 5 shares and made 68.6 of the 241.2. */
export function leadShares(configured: number, price: number): number {
  let shares = Math.max(configured, Math.ceil(MIN_MARKETABLE_BUY_USD / price - 1e-9));
  // A marketable BUY's USD amount (shares x price) may have 2 decimals at most
  // (live 2026-11-14, tick 0.001: 12 x 0.086 = 1.032 was refused). At a
  // 3-4 decimal price take the next whole share count whose cost is whole cents.
  for (let n = shares; n < shares + 10_000; n += 1) {
    const cents = n * price * 100;
    if (Math.abs(cents - Math.round(cents)) < 1e-6) return n;
  }
  return shares;
}

/** The FAK limits a round can send on each side, for signing ahead: every ask
 * the strategy would buy (one tick up to maxAsk) gives leadLimitPrice(ask), at
 * leadShares(shares). 0.01 tick, cap 0.80: 80 prices a side. */
export function presignPrices(config: Pick<BinanceLeadConfig, "maxAsk" | "limitPremium" | "shares"> & Partial<Pick<BinanceLeadConfig, "edgeSizing">>,
  tickSize: number) {
  if (!(tickSize > 0)) return [];
  const prices = new Set<number>();
  const decimals = Math.max(0, Math.ceil(-Math.log10(tickSize) - 1e-9));
  for (let n = 1; n * tickSize <= config.maxAsk + EPS; n += 1) {
    const ask = Number((n * tickSize).toFixed(decimals));
    const limit = leadLimitPrice(ask, config.limitPremium, tickSize);
    if (limit >= ask - EPS) prices.add(limit);
  }
  // edgeSizing buys 5 / shares / 15: sign each so none waits for a signature.
  const tiers = config.edgeSizing ? [...new Set([EDGE_SHARES_LOW, config.shares, EDGE_SHARES_HIGH])] : [config.shares];
  return [...prices].map(price => ({ price, shares: leadShares(config.shares, price),
    sizes: [...new Set(tiers.map(n => leadShares(n, price)))] }));
}

export function normalizeBinanceLeadConfig(input: Partial<BinanceLeadConfig> = {}): BinanceLeadConfig {
  const merged: Record<string, unknown> = { ...clone(BINANCE_LEAD_DEFAULTS), ...clone(input) };
  const config = Object.fromEntries(CONFIG_KEYS.filter(key => merged[key] !== undefined)
    .map(key => [key, merged[key]])) as unknown as BinanceLeadConfig;
  if (typeof config.instanceId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.instanceId)
    || typeof config.revision !== "string" || !config.revision.trim()) throw new Error("invalid strategy instance or revision");
  if (typeof config.assetId !== "string" || !/^[a-z0-9_-]{1,32}$/.test(config.assetId)) {
    throw new Error("invalid strategy asset identity");
  }
  if (!positive(config.shares) || config.shares > 10_000) throw new Error("shares must be positive");
  if (!positive(config.thresholdBp) || config.thresholdBp > 1000) throw new Error("thresholdBp must be in (0, 1000]");
  if (!positive(config.windowMs) || config.windowMs > 60_000) throw new Error("windowMs must be in (0, 60000]");
  if (!finite(config.limitPremium) || config.limitPremium < 0 || config.limitPremium >= 1) {
    throw new Error("limitPremium must be in [0, 1)");
  }
  if (!finite(config.fromSec) || !finite(config.toSec) || config.fromSec < 0 || config.fromSec >= config.toSec
    || config.toSec > 300) throw new Error("fromSec/toSec must satisfy 0 <= fromSec < toSec <= 300");
  if (!unitPrice(config.maxAsk)) throw new Error("maxAsk must be in (0, 1)");
  if (!Array.isArray(config.leadVenues) || !config.leadVenues.length
    || config.leadVenues.some((venue, k) => !LEAD_VENUES.includes(venue) || config.leadVenues.indexOf(venue) !== k)) {
    throw new Error(`leadVenues must be a non-empty list of distinct venues from ${LEAD_VENUES.join(", ")}`);
  }
  if (typeof config.tokyoRelay !== "boolean") throw new Error("tokyoRelay must be true or false");
  if (!Array.isArray(config.directVenues)
    || config.directVenues.some((venue, k) => !LEAD_VENUES.includes(venue) || config.directVenues.indexOf(venue) !== k)) {
    throw new Error(`directVenues must be a list of distinct venues from ${LEAD_VENUES.join(", ")}`);
  }
  if (!finite(config.openBandBp) || config.openBandBp < 0 || config.openBandBp > 1000) {
    throw new Error("openBandBp must be in [0, 1000]");
  }
  if (!OPEN_LINES.includes(config.openLine)) throw new Error(`openLine must be one of ${OPEN_LINES.join(", ")}`);
  if (!finite(config.restAfterMissSec) || config.restAfterMissSec < 0 || config.restAfterMissSec > 30) {
    throw new Error("restAfterMissSec must be in [0, 30]");
  }
  if (typeof config.restShadow !== "boolean") throw new Error("restShadow must be true or false");
  if (!ENTRY_ORDERS.includes(config.entryOrder)) throw new Error(`entryOrder must be one of ${ENTRY_ORDERS.join(", ")}`);
  if (typeof config.regimePause !== "boolean") throw new Error("regimePause must be true or false");
  if (typeof config.edgeSizing !== "boolean") throw new Error("edgeSizing must be true or false");
  if (typeof config.exitOnReverse !== "boolean") throw new Error("exitOnReverse must be true or false");
  // The GTC's remainder is cancelled after restAfterMissSec: 0 would rest it to the close.
  if (config.entryOrder === "gtc" && !(config.restAfterMissSec > 0)) throw new Error("entryOrder gtc needs restAfterMissSec > 0");
  for (const key of ["roundBudgetUsd", "totalBudgetUsd"] as const) {
    if (config[key] !== undefined && !positive(config[key])) throw new Error(`${key} must be positive when supplied`);
  }
  if (config.dailyLossUsd !== undefined && config.dailyLossUsd !== null && !positive(config.dailyLossUsd)) {
    throw new Error("dailyLossUsd must be positive or null");
  }
  if (!positive(config.maxQuoteAgeSeconds) || !positive(config.maxQuoteSkewSeconds)) throw new Error("invalid quote freshness limits");
  return config;
}

/** Only emits order intentions. Execution, fees, fills and settlement belong to the platform. */
export class BinanceLeadStrategy implements StrategyPlugin {
  readonly id = "binance-lead";
  private state: BinanceLeadState;
  private restoredWaitingMarkets = new Set<string>();
  private latestNow?: number;
  private readonly roundsByMarket = new Map<string, LeadRound>();
  private readonly stagesByClient = new Map<string, { round: LeadRound; stage: LeadStage }>();
  private readonly exitsByClient = new Map<string, { round: LeadRound; exit: LeadExitOrder }>();
  private readonly workingRounds = new Map<string, LeadRound>();
  private readonly createdStages = new Map<string, LeadStage>();
  /** Rounds whose reason currently shows a pause/risk block. */
  private readonly blockNoted = new Set<string>();
  /** Strategy clock of the latest event; updateConfig has no context of its own. */
  private lastNow = 0;
  private pendingSave = false;

  constructor(config: Partial<BinanceLeadConfig> = {}, private readonly options: BinanceLeadOptions = {}) {
    if (options.restoredState) {
      this.state = this.restore(options.restoredState);
      if (config.instanceId !== undefined && config.instanceId !== this.state.instanceId) throw new Error("strategy instance identity mismatch");
      if (Object.keys(config).length) this.updateConfig(config);
      for (const round of this.state.rounds) {
        if (round.status === "waiting_start") this.restoredWaitingMarkets.add(round.marketId);
        // A signal is gone by the time the process is back: never replay it.
        for (const stage of round.stages) if (stage.status === "CREATED") {
          stage.status = "ABANDONED"; stage.error = "重启时意图尚未提交，信号已过期，已放弃";
          if (round.status !== "ended") round.reason = BinanceLeadStrategy.roundReason(round);
          this.pendingSave = true;
        }
        // An exit sell not yet handed to the core is never sent late (the
        // core adopts it back if it was signed before the process died).
        if (round.exitFirst?.waiting) {
          delete round.exitFirst.waiting; round.exitFirst.skip = "restart";
          this.pendingSave = true;
        }
        if (round.exit?.status === "CREATED") {
          round.exit.status = "ABANDONED"; round.exit.error = "重启时卖单尚未提交，已放弃";
          if (round.status !== "ended") round.reason = BinanceLeadStrategy.roundReason(round);
          this.pendingSave = true;
        }
      }
    } else {
      const normalized = normalizeBinanceLeadConfig(config);
      this.state = { schemaVersion: 1, strategyId: this.id, instanceId: normalized.instanceId,
        config: normalized, rounds: [], paused: false };
    }
    for (const round of this.state.rounds) this.indexRound(round);
  }

  exportState(): BinanceLeadState { return clone(this.state); }
  /** Drop ended rounds the platform has forgotten (cli pruneSettledHistory). */
  forgetRounds(marketIds: ReadonlySet<string>): void {
    if (!marketIds.size) return;
    const kept = this.state.rounds.filter(round => !marketIds.has(round.marketId));
    if (kept.length === this.state.rounds.length) return;
    for (const round of this.state.rounds) {
      if (!marketIds.has(round.marketId)) continue;
      this.roundsByMarket.delete(round.marketId); this.workingRounds.delete(round.marketId); this.blockNoted.delete(round.marketId);
      for (const stage of round.stages) { this.stagesByClient.delete(stage.clientOrderId); this.createdStages.delete(stage.clientOrderId); }
      if (round.exit) this.exitsByClient.delete(round.exit.clientOrderId);
    }
    this.state.rounds = kept;
    this.save();
  }
  /** The round whose window holds `ts`, without cloning the state. Callers must not mutate it. */
  roundAt(ts: number): Readonly<LeadRound> | undefined {
    return this.state.rounds.find(round => round.startsAt <= ts && ts < round.endsAt);
  }
  /** Every kept round, without cloning. Callers must not mutate them. */
  roundList(): readonly Readonly<LeadRound>[] { return this.state.rounds; }
  /** The stage that placed this order and its round, without cloning. Callers must not mutate it. */
  stageFor(clientOrderId: string): Readonly<{ round: Readonly<LeadRound>; stage: Readonly<LeadStage> }> | undefined {
    return this.stagesByClient.get(clientOrderId);
  }
  /** The exit sell (exitOnReverse) with this client id and its round, without cloning. Callers must not mutate it. */
  exitFor(clientOrderId: string): Readonly<{ round: Readonly<LeadRound>; exit: Readonly<LeadExitOrder> }> | undefined {
    return this.exitsByClient.get(clientOrderId);
  }
  /** The running round's config without cloning the state. Callers must not mutate it. */
  activeRoundConfig(now: number): Readonly<BinanceLeadConfig> | undefined {
    return this.roundAt(now)?.config;
  }
  snapshot(): BinanceLeadState { return this.exportState(); }
  getStatus() {
    const state = this.exportState();
    const rounds = state.rounds.map(round => ({ ...round, configRevision: round.config.revision,
      isRunning: round.status === "running" && !state.paused, attempted: round.stages.length > 0 }));
    const currentRound = [...rounds].sort((a, b) => b.startsAt - a.startsAt).find(round =>
      (round.status === "running" || round.status === "waiting_next_round")
      && (this.latestNow === undefined || (round.startsAt <= this.latestNow && this.latestNow < round.endsAt)));
    return { ...state, rounds, savedRevision: state.config.revision, currentRound: currentRound ?? null };
  }
  updateConfig(input: Partial<BinanceLeadConfig>): void {
    const next = normalizeBinanceLeadConfig({ ...this.state.config, ...input });
    if (next.instanceId !== this.state.instanceId) throw new Error("cannot change the running strategy instance");
    this.state.config = next;
    // A round that has not started follows the live config until
    // CONFIG_FREEZE_SEC before its start, then keeps it to the end.
    for (const round of this.workingRounds.values()) {
      if (round.status === "waiting_start" && round.startsAt - this.lastNow > CONFIG_FREEZE_SEC) round.config = clone(next);
    }
    this.save();
  }
  setPaused(paused: boolean): void {
    if (this.state.paused === paused) return;
    this.state.paused = paused;
    this.save();
  }
  /** Feed disconnect/unhealthy or account recovery: the book in force is unknown. */
  resetQuoteReference(marketId?: string): void {
    for (const round of this.workingRounds.values()) {
      if (round.status !== "running" || (marketId !== undefined && round.marketId !== marketId)) continue;
      round.latest = undefined;
      if (!round.stages.length && !this.blockNoted.has(round.marketId)) round.reason = "行情恢复中，等待新盘口";
    }
  }
  onStop(): void { this.resetQuoteReference(); this.save(); }

  onEvent(event: TradingEvent, context: StrategyContext): readonly StrategyAction[] {
    if (!Number.isFinite(context.now)) return [];
    this.latestNow = context.now;
    if (event.kind === "lead" && event.assetId !== this.state.config.assetId) return [];
    this.lastNow = context.now;
    let changed = this.discover(context) || this.pendingSave;
    this.pendingSave = false;
    // A durable intent can outlive its market if the process dies between
    // persisting it and handing it to the execution layer.
    for (const [clientOrderId, stage] of this.createdStages) {
      const indexed = this.stagesByClient.get(clientOrderId);
      if (!indexed || context.now < indexed.round.endsAt) continue;
      stage.status = "ABANDONED";
      stage.error ??= "场次已结束，未提交的意图已放弃";
      this.createdStages.delete(clientOrderId);
      changed = true;
    }
    if (event.kind === "order") changed = this.recordOrder(event.order) || changed;
    // Context recovery may already contain an order before its first callback reaches the plugin.
    const knownClients = new Set<string>();
    for (const order of context.account.orders) {
      knownClients.add(order.clientOrderId);
      changed = this.recordOrder(order) || changed;
    }
    if (event.kind === "error" && event.code === "order_abandoned" && event.clientOrderId) {
      const indexed = this.stagesByClient.get(event.clientOrderId);
      if (indexed && activeOrder(indexed.stage.status)) {
        indexed.stage.status = "ABANDONED"; indexed.stage.error = event.message;
        this.createdStages.delete(indexed.stage.clientOrderId);
        this.noteAttempt(indexed.round, indexed.stage);
        changed = true;
      }
    }
    // The exit sell: refused before the core recorded it, or abandoned.
    const exitIndexed = event.kind === "error" && event.clientOrderId ? this.exitsByClient.get(event.clientOrderId) : undefined;
    if (exitIndexed && event.kind === "error") {
      const { exit } = exitIndexed;
      if (exit.error !== event.message) { exit.error = event.message; changed = true; }
      if (exit.status === "CREATED" && event.code === "order_not_submitted") { exit.status = "REJECTED"; changed = true; }
      if (event.code === "order_abandoned" && activeOrder(exit.status)) { exit.status = "ABANDONED"; changed = true; }
      if (exitIndexed.round.status !== "ended") exitIndexed.round.reason = BinanceLeadStrategy.roundReason(exitIndexed.round);
    }
    if (event.kind === "error" && event.clientOrderId) {
      const indexed = this.stagesByClient.get(event.clientOrderId);
      if (indexed && indexed.stage.error !== event.message) { indexed.stage.error = event.message; changed = true; }
      if (indexed?.stage.status === "CREATED" && event.code === "order_not_submitted") {
        indexed.stage.status = "REJECTED"; this.createdStages.delete(indexed.stage.clientOrderId);
        this.noteAttempt(indexed.round, indexed.stage);
        changed = true;
      }
    }
    const quoteGateBlocked = event.kind === "error" && (event.code === "market_feed_unhealthy" || event.code === "feed_processing_failed"
      || event.code === "market_snapshot_rejected"
      || event.message === "market_feed_disconnected"
      || event.message === "market_feed_unhealthy"
      || event.message.startsWith("market_feed_unhealthy:")
      || event.message === "account_recovery_started");
    if (quoteGateBlocked) {
      if (event.kind === "error" && event.message === "account_recovery_started" && Array.isArray(event.marketIds)) {
        for (const marketId of event.marketIds) this.resetQuoteReference(marketId);
      } else {
        this.resetQuoteReference(event.marketId);
      }
    }
    if (event.kind === "stopped") this.resetQuoteReference();

    const actions: StrategyAction[] = [];
    for (const round of this.workingRounds.values()) {
      // A rest order's or the GTC's hold is up: pull what still rests (the
      // ended branch below keeps retrying once the round is over).
      const rest = round.stages[0]?.kind === "gtc" ? round.stages[0] : round.stages[1];
      if (rest && context.now < round.endsAt && rest.cancelAt !== undefined && context.now >= rest.cancelAt
        && hasRemainder(rest) && !context.account.quarantinedOrderIds?.includes(rest.orderId!) && cancelDue(rest, context.now)) {
        rest.cancelRequestedAt = context.now; changed = true;
        actions.push({ kind: "cancel", orderId: rest.orderId! });
      }
      if (this.restoredWaitingMarkets.delete(round.marketId) && round.startsAt < context.now) {
        round.status = "waiting_next_round"; round.reason = "重启时已错过本场开始，等待下一场"; changed = true;
      }
      if (context.now >= round.endsAt) {
        // A decided exit still waiting at the close is given up.
        if (round.exitFirst?.waiting) { delete round.exitFirst.waiting; round.exitFirst.skip = "too_late"; changed = true; }
        if (round.status !== "ended") { round.status = "ended"; round.reason = "本场已结束，处理余单与结算"; round.latest = undefined; changed = true; }
        // An exit still CREATED at the close never reached the core: it is not sent late.
        if (round.exit?.status === "CREATED" && !knownClients.has(round.exit.clientOrderId)) {
          round.exit.status = "ABANDONED"; round.exit.error ??= "场次已结束，未提交的卖单已放弃"; changed = true;
        }
        let working = false;
        const quarantined = new Set(context.account.quarantinedOrderIds ?? []);
        for (const stage of round.stages) {
          if (!hasRemainder(stage)) continue;
          working = true;
          // A complete authenticated snapshot already excluded this UNKNOWN order.
          if (quarantined.has(stage.orderId!)) continue;
          // Retry an unconfirmed cancel on later timers, without recursive callback storms.
          if (!cancelDue(stage, context.now)) continue;
          stage.cancelRequestedAt = context.now; changed = true;
          actions.push({ kind: "cancel", orderId: stage.orderId! });
        }
        // Late acknowledgements or failed-fill corrections can wake this round again.
        if (!working) { this.workingRounds.delete(round.marketId); this.blockNoted.delete(round.marketId); }
        continue;
      }
      if (context.now < round.startsAt || round.status === "waiting_next_round") continue;
      if (round.status === "waiting_start") {
        // The config is frozen by updateConfig's warm-window rule.
        round.status = "running"; round.reason = WAITING; changed = true;
      }
      // The book in force is tracked while paused or blocked too.
      if (event.kind === "book") changed = this.updateLatest(round, event, context.now) || changed;
      // A decided exit waiting for the round's buy to finish, a block to lift or a bid.
      if (round.exitFirst?.waiting) {
        const exit = this.sendExit(round, context);
        if (exit.changed) changed = true;
        if (exit.order) actions.push({ kind: "submit", order: exit.order });
      }
      // Exit on the first reverse signal: recorded always; sold with exitOnReverse.
      if (event.kind === "lead") {
        const exit = this.decideExit(round, event, context);
        if (exit.changed) changed = true;
        if (exit.order) actions.push({ kind: "submit", order: exit.order });
        for (const orderId of exit.cancels ?? []) actions.push({ kind: "cancel", orderId });
      }
      const marketBlocked = context.account.risk.blockedMarketIds?.includes(round.marketId) === true;
      const blocked = this.state.paused ? "已暂停新增交易"
        : marketBlocked ? "本场订单等待交易所确认"
        : context.account.risk.halted ? context.account.risk.reason ?? "账户暂不可交易" : undefined;
      if (blocked) {
        if (!round.stages.length) { round.reason = blocked; this.blockNoted.add(round.marketId); }
        continue;
      }
      if (this.blockNoted.delete(round.marketId) && !round.stages.length) round.reason = WAITING;
      const restDecision = this.decideRest(round, context, knownClients);
      if (restDecision) {
        round.stages.push(restDecision.stage);
        round.reason = BinanceLeadStrategy.roundReason(round);
        this.indexStage(round, restDecision.stage);
        changed = true;
        actions.push({ kind: "submit", order: restDecision.order });
        continue;
      }
      if (event.kind !== "lead") continue;
      const seenAt = event.receivedAtUnix;
      if (!(round.startsAt <= seenAt && seenAt < round.endsAt)) continue;
      // One order per round, filled or not (backtest retry=False).
      if (round.stages.length) continue;
      const decision = this.decide(round, event, context, knownClients);
      if (!decision) continue;
      round.stages.push(decision.stage);
      round.reason = BinanceLeadStrategy.roundReason(round);
      this.indexStage(round, decision.stage);
      changed = true;
      actions.push({ kind: "submit", order: decision.order });
    }
    // Write the economic stage key before returning an action to the execution layer.
    if (changed) this.save();
    return actions;
  }

  /** Rules 4-5 for one signal; writes the skip reason when nothing is placed. */
  private decide(round: LeadRound, event: LeadEvent, context: StrategyContext, knownClients: ReadonlySet<string>):
    { stage: LeadStage; order: Omit<OrderRequest, "strategyId"> } | undefined {
    const config = round.config;
    const sinceOpen = event.receivedAtUnix - round.startsAt;
    if (!(sinceOpen >= config.fromSec && sinceOpen < config.toSec)) {
      round.reason = `信号在开盘后 ${sinceOpen.toFixed(1)} 秒，不在本场 [${config.fromSec}, ${config.toSec}) 秒内`;
      return undefined;
    }
    if (config.openBandBp > 0) {
      // The open must be this round's: the detector keys it by trade time.
      const mean = config.openLine === "mean60";
      const open = mean ? event.openMean60 : event.openPrice;
      const label = mean ? "开盘前 60 秒均价" : "开盘价";
      if (!positive(open) || Math.floor(event.tradeTimeMs / 300_000) * 300 !== round.startsAt) {
        round.reason = mean ? "本场开盘前 60 秒均价未知（行情不满开盘前一分钟），等下一个信号"
          : "本场开盘价未知（行情在本场中途才连上），等下一个信号";
        return undefined;
      }
      const d = Math.log(event.price / open) * 1e4 * (event.direction === "UP" ? 1 : -1);
      if (!(d >= -config.openBandBp && d < config.openBandBp)) {
        round.reason = `信号离${label} ${d >= 0 ? "领先" : "落后"} ${Math.abs(d).toFixed(1)} bp，超出 ±${config.openBandBp} bp，等下一个信号`;
        return undefined;
      }
    }
    const latest = round.latest;
    if (!latest) { round.reason = "信号到达时没有当前盘口，等下一个信号"; return undefined; }
    if (!latest.twoSided) { round.reason = "当前盘口一边没有卖价，等下一个信号"; return undefined; }
    if (!latest.freshOnArrival) {
      round.reason = `当前盘口到达时不新鲜（${latest.staleReason ?? "未知"}），等下一个信号`; return undefined;
    }
    const direction = event.direction;
    const tokenId = direction === "UP" ? round.upTokenId : round.downTokenId;
    const ask = (direction === "UP" ? latest.upAsk : latest.downAsk)!;
    // A side already this dear is near decided: backtest fills above 0.9 made
    // +0.004 a share (t 0.15). Keep the round's attempt for a later signal.
    if (ask > config.maxAsk + EPS) {
      round.reason = `卖价 ${priceText(ask)} 高于上限 ${priceText(config.maxAsk)}，等下一个信号`; return undefined;
    }
    if (config.regimePause) {
      const wild = regimePause(event);
      if (wild.pause) {
        round.reason = wild.reason === "signals"
          ? `行情太乱：前 5 分钟 ${event.signals300} 个信号（> ${REGIME_PAUSE_SIGNALS}），等下一个信号`
          : `行情太乱：前 5 分钟每秒波动 ${event.vol300Bp!.toFixed(2)} bp（> ${REGIME_PAUSE_VOL_BP}），等下一个信号`;
        return undefined;
      }
    }
    const instrument = context.markets.find(m => m.id === round.marketId)?.instruments.find(i => i.tokenId === tokenId);
    if (!instrument || !positive(instrument.tickSize) || !positive(instrument.minOrderSize)) {
      round.reason = "交易所规则暂不可用"; return undefined;
    }
    const price = leadLimitPrice(ask, config.limitPremium, instrument.tickSize);
    // A FAK under the ask cannot fill: keep the round's attempt for a later signal.
    if (price < ask - EPS) { round.reason = `卖价 ${ask} 高于最高限价 ${MAX_LIMIT}，等下一个信号`; return undefined; }
    const fair = leadFairValue(event, round.endsAt - event.receivedAtUnix);
    const edge = fair === undefined ? undefined : fair - price - TAKER_FEE_RATE * price * (1 - price);
    const sized = edgeShares(edge, config.shares);
    const shares = leadShares(config.edgeSizing ? sized : config.shares, price);
    if (!this.validSizeAndPrice(instrument, shares, price)) {
      round.reason = "数量或限价不符合交易所规则"; return undefined;
    }
    const { kind: _kind, assetId: _assetId, ...signal } = event;
    const stage: LeadStage = { ...(config.entryOrder === "gtc" ? { kind: "gtc" as const } : {}),
      direction, tokenId, clientOrderId: `${this.state.instanceId}:${round.marketId}:1`,
      price, shares, createdAt: context.now, status: "CREATED", filledShares: 0,
      signal: { ...signal }, askAtSignal: ask,
      ...(fair !== undefined && edge !== undefined ? { fair, edge, edgeShares: sized } : {}) };
    const funded = this.fund(round, stage, context, knownClients);
    // A 15-share pick over the round budget falls back to the configured size
    // (the strongest signals are the ones the budget would drop).
    if (!funded && config.edgeSizing && round.reason === "超过单场预算，本场不下" && sized > config.shares) {
      const fallback = leadShares(config.shares, price);
      if (fallback < shares - EPS && this.validSizeAndPrice(instrument, fallback, price)) {
        return this.fund(round, { ...stage, shares: fallback }, context, knownClients);
      }
    }
    return funded;
  }

  /** The first opposite signal after the round held shares (from
   * EXIT_AFTER_SEC after the first fill, until EXIT_LAST_SEC before the
   * close): record the held side's bid; with exitOnReverse, sell what the
   * round holds (sendExit). Once per round. A GTC or rest remainder still
   * resting is cancelled first and the sell waits until no buy of the round
   * is working: the remainder rests at or above the bid it would sell into. */
  private decideExit(round: LeadRound, event: LeadEvent, context: StrategyContext):
    { changed: boolean; order?: Omit<OrderRequest, "strategyId">; cancels?: string[] } {
    if (round.exitFirst !== undefined) return { changed: false };
    const buy = round.stages[0];
    if (!buy) return { changed: false };
    const held = round.stages.reduce((total, stage) => total + stage.filledShares, 0);
    const first = round.stages.map(stage => stage.firstFillAt).filter(finite).sort((a, b) => a - b)[0];
    const seen = event.receivedAtUnix;
    if (!(held > EPS) || first === undefined || event.direction === buy.direction
      || seen < first + EXIT_AFTER_SEC || seen >= round.endsAt - EXIT_LAST_SEC) return { changed: false };
    const bid = buy.direction === "UP" ? round.latest?.upBid : round.latest?.downBid;
    const record: LeadExitFirst = { at: seen, bid: unitPrice(bid) ? bid : null, shares: held, sent: false };
    if (positive(event.openMean60) && positive(event.price)) {
      record.leadBp = Math.log(event.price / event.openMean60) * 1e4 * (buy.direction === "UP" ? 1 : -1);
    }
    round.exitFirst = record;
    if (!round.config.exitOnReverse) { record.skip = "off"; return { changed: true }; }
    record.waiting = true;
    // A resting GTC or rest remainder would buy the side just sold: end its hold
    // now. One still being accepted (no orderId yet) gets cancelAt = now so the
    // working-rounds cancel path pulls it the moment its id arrives (recordOrder
    // only sets cancelAt when undefined).
    const cancels: string[] = [];
    for (const stage of round.stages) {
      if ((stage.kind !== "gtc" && stage.kind !== "rest")
        || !(activeOrder(stage.status) && stage.filledShares < stage.shares - EPS)) continue;
      stage.cancelAt = Math.min(stage.cancelAt ?? context.now, context.now);
      if (!stage.orderId || context.account.quarantinedOrderIds?.includes(stage.orderId) || !cancelDue(stage, context.now)) continue;
      stage.cancelRequestedAt = context.now;
      cancels.push(stage.orderId);
    }
    return { changed: true, cancels, order: this.sendExit(round, context).order };
  }

  /** The exit sell once decided (exitFirst.waiting): one FAK SELL of what the
   * round holds (its fills, capped by the position, floored to 0.01) at the
   * held side's bid then - EXIT_PREMIUM, rounded up to the tick. Keeps waiting
   * while a buy of the round works or its market is blocked; gives up
   * EXIT_LAST_SEC before the close. Not sent while the strategy is paused,
   * the account halted (other than by the daily loss limit, which still lets
   * a sell reduce risk), without a bid or the venue's rules, or under the
   * venue's minimum size. */
  private sendExit(round: LeadRound, context: StrategyContext): { changed: boolean; order?: Omit<OrderRequest, "strategyId"> } {
    const record = round.exitFirst;
    const buy = round.stages[0];
    if (!record?.waiting || !buy || round.exit) return { changed: false };
    const skip = (why: string) => { delete record.waiting; record.skip = why; return { changed: true }; };
    const working = round.stages.some(stage => activeOrder(stage.status) && stage.filledShares < stage.shares - EPS);
    const blocked = context.account.risk.blockedMarketIds?.includes(round.marketId) === true;
    // Account recovery (a feed reset or a reconnect) passes; a hard halt does not.
    const recovering = context.account.risk.halted && context.account.risk.reason === "账户恢复中";
    const bid = buy.direction === "UP" ? round.latest?.upBid : round.latest?.downBid;
    if (context.now >= round.endsAt - EXIT_LAST_SEC) {
      return skip(working ? "buy_working" : blocked || recovering ? "market_blocked" : !unitPrice(bid) ? "no_bid" : "too_late");
    }
    if (this.state.paused) return skip("paused");
    if (context.account.risk.halted && !recovering && context.account.risk.reason !== "daily loss limit") return skip("halted");
    // Wait for the buy to end, the block to lift and a book with the held side's bid.
    if (working || blocked || recovering || !unitPrice(bid)) return { changed: false };
    const instrument = context.markets.find(m => m.id === round.marketId)?.instruments.find(i => i.tokenId === buy.tokenId);
    if (!instrument || !positive(instrument.tickSize) || !positive(instrument.minOrderSize)) return skip("no_rules");
    // What the round bought, capped by what the account holds of the token.
    const held = round.stages.reduce((total, stage) => total + stage.filledShares, 0);
    const position = context.account.positions.find(p => p.tokenId === buy.tokenId)?.shares ?? 0;
    const shares = Math.floor(Math.min(held, position) * 100 + 1e-6) / 100;
    if (shares < instrument.minOrderSize - EPS) return skip("below_min_size");
    const decimals = Math.max(0, Math.ceil(-Math.log10(instrument.tickSize) - 1e-9));
    const limit = Number(Math.max(instrument.tickSize,
      Math.ceil((bid - EXIT_PREMIUM) / instrument.tickSize - 1e-9) * instrument.tickSize).toFixed(decimals));
    const exit: LeadExitOrder = { tokenId: buy.tokenId, clientOrderId: `${this.state.instanceId}:${round.marketId}:exit`,
      price: limit, shares, createdAt: context.now, status: "CREATED", filledShares: 0 };
    round.exit = exit;
    delete record.waiting;
    record.sent = true;
    this.exitsByClient.set(exit.clientOrderId, { round, exit });
    if (round.status === "running") round.reason = BinanceLeadStrategy.exitReason(exit);
    return { changed: true, order: { clientOrderId: exit.clientOrderId, assetId: round.assetId, marketId: round.marketId,
      roundId: round.roundId, tokenId: exit.tokenId, direction: "SELL", price: limit, shares, timeInForce: "FAK", postOnly: false } };
  }

  /** The rest order after a missed FAK: the round's FAK ended (cancelled or
   * rejected by the venue) short of its shares, the rest is on, there is time
   * for its hold, and the remainder meets the venue minimum. Same token and
   * limit, post-only GTC; budget and cash as any order. The caller already
   * returned for a paused or blocked round. */
  private decideRest(round: LeadRound, context: StrategyContext, knownClients: ReadonlySet<string>):
    { stage: LeadStage; order: Omit<OrderRequest, "strategyId"> } | undefined {
    const config = round.config;
    const fak = round.stages[0];
    if (!(config.restAfterMissSec > 0) || round.stages.length !== 1 || !fak || (fak.kind ?? "fak") !== "fak"
      || fak.restDecided || fak.missedAt === undefined || round.exit
      || (round.config.exitOnReverse && round.exitFirst !== undefined)) return undefined;
    // Only right after the miss (a pause or block that held it longer lets it go)
    // and decided once: a later event never places it late.
    if (context.now - fak.missedAt > REST_LATE_SEC) return undefined;
    fak.restDecided = true;
    const remaining = Number((fak.shares - fak.filledShares).toFixed(6));
    if (!(remaining > EPS) || round.endsAt - context.now < config.restAfterMissSec + REST_MARGIN_SEC) return undefined;
    const instrument = context.markets.find(m => m.id === round.marketId)?.instruments.find(i => i.tokenId === fak.tokenId);
    if (!instrument || !positive(instrument.tickSize) || !this.validSizeAndPrice(instrument, remaining, fak.price)) return undefined;
    const stage: LeadStage = { kind: "rest", direction: fak.direction, tokenId: fak.tokenId,
      clientOrderId: `${this.state.instanceId}:${round.marketId}:rest`, price: fak.price, shares: remaining,
      createdAt: context.now, status: "CREATED", filledShares: 0, signal: clone(fak.signal), askAtSignal: fak.askAtSignal };
    return this.fund(round, stage, context, knownClients);
  }

  /** Fee reserve, round/total budget and cash for a new stage. */
  private fund(round: LeadRound, stage: LeadStage, context: StrategyContext, knownClients: ReadonlySet<string>):
    { stage: LeadStage; order: Omit<OrderRequest, "strategyId"> } | undefined {
    const config = round.config;
    const price = stage.price;
    const order = this.orderIntent(round, stage);
    let feeReserve: number;
    try { feeReserve = context.estimateFee?.(order) ?? 0; }
    catch { round.reason = "当前交易费用暂不可用"; return undefined; }
    if (!Number.isFinite(feeReserve) || feeReserve < 0) { round.reason = "当前交易费用暂不可用"; return undefined; }
    stage.feeReserveUsd = feeReserve;
    const cost = stage.shares * price + feeReserve;
    const pendingCost = (item: LeadStage) => item.price * item.shares + (item.feeReserveUsd ?? 0);
    const unreservedStages = [...this.createdStages.values()].filter(item => !knownClients.has(item.clientOrderId));
    const unreserved = unreservedStages.reduce((total, item) => total + pendingCost(item), 0);
    const tokens = new Set([round.upTokenId, round.downTokenId]);
    const roundCost = context.account.positions.filter(position => tokens.has(position.tokenId))
      .reduce((total, position) => total + position.costUsd, 0)
      + context.account.orders.filter(item => tokens.has(item.tokenId)
        && (activeOrder(item.status) || item.reconciliationPending === true))
        .reduce((total, item) => total + item.reservedUsd, 0)
      + unreservedStages.filter(item => tokens.has(item.tokenId)).reduce((total, item) => total + pendingCost(item), 0);
    if (config.roundBudgetUsd !== undefined && roundCost + cost > config.roundBudgetUsd + EPS) {
      round.reason = "超过单场预算，本场不下"; return undefined;
    }
    if (config.totalBudgetUsd !== undefined && context.account.risk.occupiedUsd + unreserved + cost > config.totalBudgetUsd + EPS) {
      round.reason = "超过总资金预算，本场不下"; return undefined;
    }
    if (cost + unreserved > context.account.risk.availableUsd + EPS) {
      round.reason = "可用余额不足"; return undefined;
    }
    return { stage, order };
  }

  /** Every frame of this round replaces the book in force, one-sided included.
   * True when the round's FAK stage just recorded a time (ask gone, shadow fill). */
  private updateLatest(round: LeadRound, event: Extract<TradingEvent, { kind: "book" }>, now: number): boolean {
    const snapshot = event.snapshot;
    if (!snapshot || event.marketId !== round.marketId || event.roundId !== round.roundId
      || snapshot.marketId !== round.marketId || snapshot.roundId !== round.roundId
      || snapshot.assetId !== undefined && snapshot.assetId !== round.assetId
      || round.assetId !== "btc" && snapshot.assetId !== round.assetId) return false;
    // Only frames of the round itself (backtest: start <= t < start + 300).
    const receivedAt = snapshot.receivedAtUnix ?? now;
    if (receivedAt < round.startsAt) return false;
    const yes = snapshot.YES, no = snapshot.NO;
    if ((yes && yes.assetId !== round.upTokenId) || (no && no.assetId !== round.downTokenId)) return false;
    const upAsk = yes?.ask, downAsk = no?.ask, upBid = yes?.bid, downBid = no?.bid;
    // The first frame after the signal where the ask we bought at is gone: a
    // missed FAK was late by (its ACK - this frame). Watched ASK_GONE_WATCH_SEC.
    let askGone = false;
    const stage = round.stages[0];
    // Shadow rest: with the rest off, the first frame within REST_SHADOW_SEC of
    // the miss whose ask on this side is back at or under the FAK's limit.
    if (stage && round.config.restShadow && !(round.config.restAfterMissSec > 0) && stage.missedAt !== undefined
      && stage.restShadowFillAt === undefined && receivedAt > stage.missedAt && receivedAt <= stage.missedAt + REST_SHADOW_SEC) {
      const ask = (stage.direction === "UP" ? yes : no)?.ask;
      if (unitPrice(ask) && ask <= stage.price + EPS) { stage.restShadowFillAt = receivedAt; askGone = true; }
    }
    if (stage && stage.askGoneAtUnix === undefined && receivedAt > stage.signal.receivedAtUnix
      && receivedAt <= stage.createdAt + ASK_GONE_WATCH_SEC) {
      const side = stage.direction === "UP" ? yes : no;
      const ask = side?.ask;
      if (ask === undefined || ask > stage.price + EPS) {
        stage.askGoneAtUnix = receivedAt;
        if (finite(side?.sourceAt)) stage.askGoneVenueAt = side.sourceAt;
        askGone = true;
      }
    }
    const twoSided = unitPrice(upAsk) && unitPrice(downAsk);
    let staleReason: string | undefined;
    if (twoSided) {
      const maxAgeMs = round.config.maxQuoteAgeSeconds * 1000;
      if (!finite(snapshot.marketAgeMs) || !(snapshot.marketAgeMs <= maxAgeMs)) {
        staleReason = `行情年龄 ${finite(snapshot.marketAgeMs) ? Math.round(snapshot.marketAgeMs) : "?"} ms 超过 ${maxAgeMs} ms`;
      } else if (!finite(yes!.sourceAt) || !finite(no!.sourceAt)
        || !(Math.abs(yes!.sourceAt - no!.sourceAt) <= round.config.maxQuoteSkewSeconds)) {
        staleReason = `两边时间差超过 ${round.config.maxQuoteSkewSeconds} 秒`;
      } else if (upAsk + downAsk > WIDE_SUM) {
        staleReason = `两边卖价之和 ${(upAsk + downAsk).toFixed(2)} 超过 ${WIDE_SUM}`;
      }
    }
    round.latest = { upAsk, downAsk, upBid, downBid, twoSided, freshOnArrival: twoSided && staleReason === undefined,
      ...(staleReason ? { staleReason } : {}) };
    return askGone;
  }

  private discover(context: StrategyContext): boolean {
    let changed = false;
    for (const market of context.markets) {
      if (this.roundsByMarket.has(market.id) || context.now >= market.endsAt) continue;
      const instruments = this.marketInstruments(market);
      if (!instruments) continue;
      const eligible = context.now <= market.startsAt;
      const round: LeadRound = { assetId: market.assetId ?? this.state.config.assetId, marketId: market.id,
        roundId: market.roundId, name: market.name, startsAt: market.startsAt, endsAt: market.endsAt,
        upTokenId: instruments.UP.tokenId, downTokenId: instruments.DOWN.tokenId, config: clone(this.state.config),
        status: eligible ? "waiting_start" : "waiting_next_round", stages: [],
        reason: eligible ? "等待本场开始" : "中途启动，等待下一场" };
      this.state.rounds.push(round);
      this.indexRound(round);
      changed = true;
    }
    return changed;
  }

  private marketInstruments(market: MarketInfo): Record<LeadDirection, Instrument> | undefined {
    const asset = market.assetId ?? this.state.config.assetId;
    if (asset !== this.state.config.assetId) return undefined;
    const match = /^([a-z0-9_-]+)-updown-5m-(\d+)$/.exec(market.name.toLowerCase());
    if (!match || match[1] !== asset || Number(match[2]) !== market.startsAt || market.endsAt - market.startsAt !== 300
      || market.instruments.length !== 2) return undefined;
    const up = market.instruments.find(i => ["UP", "YES"].includes(i.outcome.toUpperCase()));
    const down = market.instruments.find(i => ["DOWN", "NO"].includes(i.outcome.toUpperCase()));
    if (!up || !down || up.tokenId === down.tokenId || up.marketId !== market.id || down.marketId !== market.id) return undefined;
    return { UP: up, DOWN: down };
  }

  private orderIntent(round: LeadRound, stage: LeadStage): Omit<OrderRequest, "strategyId"> {
    return { clientOrderId: stage.clientOrderId, assetId: round.assetId, marketId: round.marketId, roundId: round.roundId,
      tokenId: stage.tokenId, direction: "BUY", price: stage.price, shares: stage.shares,
      ...(stage.kind === "rest" ? { timeInForce: "GTC" as const, postOnly: true }
        : stage.kind === "gtc" ? { timeInForce: "GTC" as const, postOnly: false } : { timeInForce: "FAK" as const, postOnly: false }),
      ...(round.config.roundBudgetUsd === undefined ? {} : { roundBudgetUsd: round.config.roundBudgetUsd }) };
  }
  private validSizeAndPrice(instrument: Instrument, shares: number, price: number): boolean {
    return unitPrice(price) && shares + EPS >= instrument.minOrderSize
      && Math.abs(price / instrument.tickSize - Math.round(price / instrument.tickSize)) < 1e-6;
  }
  private recordOrder(order: OrderRecord): boolean {
    if (order.strategyId !== this.id) return false;
    if (order.direction === "SELL") return this.recordExit(order);
    const indexed = this.stagesByClient.get(order.clientOrderId) ?? this.adoptOrder(order);
    if (!indexed) return false;
    const { round, stage } = indexed;
    if (order.tokenId !== stage.tokenId || order.direction !== "BUY" || Math.abs(order.shares - stage.shares) > EPS
      || Math.abs(order.price - stage.price) > EPS) {
      // The core's order is the truth; a throw here would fail every later event.
      const error = `订单与本场记录不一致（token/价格/股数），以订单为准等对账：${order.orderId ?? order.clientOrderId}`;
      if (stage.error === error) return false;
      stage.error = error;
      return true;
    }
    if (stage.orderId === order.orderId && stage.status === order.status && stage.filledShares === order.filledShares
      && stage.error === order.error) return false;
    stage.orderId = order.orderId; stage.status = order.status; stage.filledShares = order.filledShares; stage.error = order.error;
    this.createdStages.delete(stage.clientOrderId);
    if (stage.firstFillAt === undefined && stage.filledShares > EPS) {
      stage.firstFillAt = finite(order.updatedAt) ? order.updatedAt : this.lastNow;
    }
    if ((stage.kind ?? "fak") === "fak" && stage.missedAt === undefined && ["CANCELLED", "REJECTED"].includes(stage.status)
      && stage.filledShares < stage.shares - EPS) {
      // The miss starts the rest (or its shadow) from the venue's reply.
      stage.missedAt = finite(order.venueReplyAt) ? order.venueReplyAt : finite(order.updatedAt) ? order.updatedAt : this.lastNow;
    }
    if ((stage.kind === "rest" || stage.kind === "gtc") && stage.cancelAt === undefined && ["OPEN", "PARTIAL"].includes(stage.status)) {
      // The hold runs from the venue's acceptance.
      const accepted = finite(order.httpAckAt) ? order.httpAckAt : finite(order.updatedAt) ? order.updatedAt : this.lastNow;
      stage.cancelAt = accepted + round.config.restAfterMissSec;
    }
    this.noteAttempt(round, stage);
    if (round.status === "ended" && hasRemainder(stage)) this.workingRounds.set(round.marketId, round);
    return true;
  }
  /** The core holds this round's order but the strategy has no stage: the
   * process died after the signed order was saved (.intent, before POST) and
   * before the strategy state was. The order is the round's one attempt. The
   * signal it came from is gone; its fields are zero, the ask is the limit. */
  private adoptOrder(order: OrderRecord): { round: LeadRound; stage: LeadStage } | undefined {
    const match = /^(.+):([^:]+):(1|rest)$/.exec(order.clientOrderId);
    if (!match || match[1] !== this.state.instanceId) return undefined;
    const round = this.roundsByMarket.get(match[2]!);
    const rest = match[3] === "rest";
    // A :1 GTC (not post-only) is the round's one GTC (entryOrder gtc).
    const gtc = !rest && order.timeInForce === "GTC" && !order.postOnly;
    // :1 only into an empty round; :rest only after the round's FAK, same token.
    if (!round || order.direction !== "BUY" || round.stages.length !== (rest ? 1 : 0)
      || (rest && (order.tokenId !== round.stages[0]!.tokenId || !order.postOnly))) return undefined;
    const direction = order.tokenId === round.upTokenId ? "UP" : order.tokenId === round.downTokenId ? "DOWN" : undefined;
    if (!direction) return undefined;
    // Its hold from its creation: the venue's acceptance is not known any more.
    const hold = round.config.restAfterMissSec > 0 ? round.config.restAfterMissSec : REST_SHADOW_SEC;
    const stage: LeadStage = { ...(rest ? { kind: "rest" as const, cancelAt: order.createdAt + round.config.restAfterMissSec }
      : gtc ? { kind: "gtc" as const, cancelAt: order.createdAt + hold } : {}),
      direction, tokenId: order.tokenId, clientOrderId: order.clientOrderId,
      price: order.price, shares: order.shares, createdAt: order.createdAt, status: order.status, filledShares: order.filledShares,
      ...(order.orderId ? { orderId: order.orderId } : {}),
      error: "重启时本场订单已在交易所记录中，策略记录丢失，按订单恢复",
      signal: { direction, price: 0, refPrice: 0, moveBp: 0, venue: "bybit", line: "direct", tradeId: 0, tradeTimeMs: 0,
        receivedAtUnix: order.createdAt, receivedAtMonoMs: 0 },
      askAtSignal: order.price };
    round.stages.push(stage);
    this.indexStage(round, stage);
    if (round.status === "ended") this.workingRounds.set(round.marketId, round);
    this.noteAttempt(round, stage);
    return { round, stage };
  }
  private noteAttempt(round: LeadRound, _stage: LeadStage): void {
    if (round.status !== "ended") round.reason = BinanceLeadStrategy.roundReason(round);
  }
  /** The round's order state; with a rest order, the FAK's plus the rest's. */
  private static roundReason(round: LeadRound): string {
    const stage = round.stages[0];
    if (!stage) return round.reason;
    if (round.exit) return BinanceLeadStrategy.exitReason(round.exit);
    if (stage.kind === "gtc") return BinanceLeadStrategy.gtcReason(stage);
    const text = BinanceLeadStrategy.fakReason(stage);
    const rest = round.stages[1];
    return rest ? `${text}；挂单补单：${BinanceLeadStrategy.restReason(rest)}` : text;
  }
  /** The exit sell on the first reverse signal, once sent. */
  private static exitReason(exit: LeadExitOrder): string {
    const got = `${Number(exit.filledShares.toFixed(4))}/${exit.shares}`;
    if (exit.status === "CREATED" || exit.status === "SUBMITTING" || exit.status === "OPEN")
      return `反向信号，卖出 ${exit.shares} 股（限价 ${priceText(exit.price)}）`;
    if (exit.status === "FILLED") return `反向信号，已卖出 ${got} 股`;
    if (exit.status === "PARTIAL") return `反向信号，已卖出 ${got} 股，剩余持有到结算`;
    if (exit.status === "UNKNOWN") return "反向信号卖单状态待确认";
    if (exit.status === "ABANDONED") return "反向信号卖单已放弃，持有到结算";
    if (exit.filledShares > EPS) return `反向信号，卖出 ${got} 股，剩余持有到结算`;
    return "反向信号卖单没成交，持有到结算";
  }
  private static restReason(stage: LeadStage): string {
    const got = `${Number(stage.filledShares.toFixed(4))}/${stage.shares}`;
    if (stage.status === "CREATED" || stage.status === "SUBMITTING") return `在 ${priceText(stage.price)} 挂只挂单的买单`;
    if (stage.status === "OPEN" || stage.status === "PARTIAL") {
      return stage.filledShares > EPS ? `已成交 ${got} 股，到时撤掉剩余` : `买单挂在 ${priceText(stage.price)}，到时撤单`;
    }
    if (stage.status === "REJECTED") return /cross/i.test(stage.error ?? "") ? "卖价已回到限价以内，挂单被拒" : "挂单被拒";
    if (stage.status === "FILLED") return `已买到 ${got} 股`;
    if (stage.status === "UNKNOWN") return "状态待确认";
    if (stage.status === "ABANDONED") return "意图已放弃";
    return stage.filledShares > EPS ? `买到 ${got} 股，剩余已撤` : "没成交，已撤";
  }
  private static gtcReason(stage: LeadStage): string {
    const got = `${Number(stage.filledShares.toFixed(4))}/${stage.shares}`;
    if (stage.status === "CREATED" || stage.status === "SUBMITTING") return "已下单（限价单），等待成交回报";
    if (stage.status === "OPEN") return `本场已下单，未立即成交，挂在 ${priceText(stage.price)}，到时撤单`;
    if (stage.status === "PARTIAL") return `本场已买到 ${got} 股，剩余挂着，到时撤单`;
    if (stage.status === "ABANDONED") return "本场已尝试，意图已放弃";
    if (stage.status === "REJECTED") return "本场已尝试，订单被拒";
    if (stage.status === "UNKNOWN") return "本场已尝试，订单状态待确认";
    if (stage.filledShares > EPS) return `本场已买到 ${got} 股，持有到结算`;
    return "本场已尝试，未成交，已撤";
  }
  private static fakReason(stage: LeadStage): string {
    const got = `${Number(stage.filledShares.toFixed(4))}/${stage.shares}`;
    if (stage.status === "CREATED" || stage.status === "SUBMITTING") return "已下单（FAK），等待成交回报";
    if (stage.status === "ABANDONED") return "本场已尝试，意图已放弃";
    if (stage.status === "REJECTED") return "本场已尝试，订单被拒";
    if (stage.status === "UNKNOWN") return "本场已尝试，订单状态待确认";
    if (stage.filledShares > EPS) return `本场已买到 ${got} 股，持有到结算`;
    return stage.status === "CANCELLED" ? "本场已尝试，未成交" : `本场已尝试，买到 ${got} 股`;
  }
  private indexStage(round: LeadRound, stage: LeadStage): void {
    this.stagesByClient.set(stage.clientOrderId, { round, stage });
    if (stage.status === "CREATED") this.createdStages.set(stage.clientOrderId, stage);
  }
  /** The exit sell's order updates. An exit only the core holds (the process
   * died between persisting the signed sell and the strategy state) is
   * adopted onto its round, so the round shows it and never sends a second. */
  private recordExit(order: OrderRecord): boolean {
    let indexed = this.exitsByClient.get(order.clientOrderId);
    if (!indexed) {
      const match = /^(.+):([^:]+):exit$/.exec(order.clientOrderId);
      const round = match && match[1] === this.state.instanceId ? this.roundsByMarket.get(match[2]!) : undefined;
      if (!round || round.exit || ![round.upTokenId, round.downTokenId].includes(order.tokenId)) return false;
      round.exit = { tokenId: order.tokenId, clientOrderId: order.clientOrderId, price: order.price, shares: order.shares,
        createdAt: order.createdAt, status: order.status, filledShares: order.filledShares,
        error: "重启时卖单已在交易所记录中，策略记录丢失，按订单恢复" };
      round.exitFirst ??= { at: order.createdAt, bid: null, shares: order.shares, sent: true };
      round.exitFirst.sent = true; delete round.exitFirst.waiting; delete round.exitFirst.skip;
      indexed = { round, exit: round.exit };
      this.exitsByClient.set(order.clientOrderId, indexed);
    }
    const { exit } = indexed;
    if (exit.orderId === order.orderId && exit.status === order.status && exit.filledShares === order.filledShares
      && exit.error === order.error) return false;
    exit.orderId = order.orderId; exit.status = order.status; exit.filledShares = order.filledShares; exit.error = order.error;
    if (indexed.round.status !== "ended") indexed.round.reason = BinanceLeadStrategy.roundReason(indexed.round);
    return true;
  }
  private indexRound(round: LeadRound): void {
    this.roundsByMarket.set(round.marketId, round);
    for (const stage of round.stages) this.indexStage(round, stage);
    if (round.exit) this.exitsByClient.set(round.exit.clientOrderId, { round, exit: round.exit });
    if (round.status !== "ended" || round.stages.some(hasRemainder)) this.workingRounds.set(round.marketId, round);
  }
  private save(): void { this.options.persist?.(this.exportState()); }

  private restore(input: BinanceLeadState): BinanceLeadState {
    const state = clone(input);
    if (state.schemaVersion !== 1 || state.strategyId !== this.id || !Array.isArray(state.rounds)
      || typeof state.paused !== "boolean") throw new Error("invalid binance-lead state");
    state.config = normalizeBinanceLeadConfig(state.config);
    if (state.instanceId !== state.config.instanceId) throw new Error("invalid binance-lead state identity");
    const markets = new Set<string>();
    for (const round of state.rounds) {
      round.config = normalizeBinanceLeadConfig(round.config);
      if (!round.marketId || markets.has(round.marketId) || round.config.instanceId !== state.instanceId
        || round.assetId !== state.config.assetId
        || !Number.isFinite(round.startsAt) || round.endsAt - round.startsAt !== 300
        || typeof round.roundId !== "string" || !round.roundId.trim()
        || !round.upTokenId || !round.downTokenId || round.upTokenId === round.downTokenId
        || !Array.isArray(round.stages) || round.stages.length > 2
        || !["waiting_start", "waiting_next_round", "running", "ended"].includes(round.status)
        || typeof round.reason !== "string"
        || (round.exitFirst !== undefined && (!finite(round.exitFirst.at) || !finite(round.exitFirst.shares)
          || (round.exitFirst.bid !== null && !unitPrice(round.exitFirst.bid)) || typeof round.exitFirst.sent !== "boolean"
          || (round.exitFirst.waiting !== undefined && round.exitFirst.waiting !== true)
          || (round.exitFirst.leadBp !== undefined && !finite(round.exitFirst.leadBp))))
        || (round.exit !== undefined && (![round.upTokenId, round.downTokenId].includes(round.exit.tokenId)
          || round.exit.clientOrderId !== `${state.instanceId}:${round.marketId}:exit` || !unitPrice(round.exit.price)
          || !positive(round.exit.shares) || !finite(round.exit.createdAt) || !finite(round.exit.filledShares)
          || round.exit.filledShares < 0 || !STAGE_STATUSES.includes(round.exit.status)))) throw new Error("invalid persisted binance-lead round");
      // The book seen by a previous process is not the book in force now.
      delete round.latest;
      // The 3rd-reverse-signal shadow exit an older engine kept (removed 2026-11-17).
      delete (round as LeadRound & { exitShadow?: unknown }).exitShadow;
      markets.add(round.marketId);
      round.stages.forEach((stage, index) => {
        const signal = stage.signal;
        // Fields an older engine wrote: the stage number (always 1 now) and the
        // fair-value edge are dropped.
        const legacy = stage as LeadStage & { stage?: unknown; fairEdge?: unknown };
        const rest = index === 1;
        const fak = round.stages[0]!;
        const gtc = stage.kind === "gtc";
        if ((legacy.stage !== undefined && legacy.stage !== 1)
          // The first stage is the FAK or the GTC; a rest only follows a FAK.
          || (rest ? stage.kind !== "rest" || fak.kind === "gtc" : !gtc && (stage.kind ?? "fak") !== "fak")
          || stage.clientOrderId !== `${state.instanceId}:${round.marketId}:${rest ? "rest" : "1"}`
          // Only the rest and the GTC have a timed cancel; a rest follows a FAK
          // short of its shares, on its token, at its limit, for at most the remainder.
          || (!rest && !gtc && stage.cancelAt !== undefined)
          || (gtc && stage.cancelAt !== undefined && !finite(stage.cancelAt))
          || (rest && ((stage.cancelAt !== undefined && !finite(stage.cancelAt)) || stage.tokenId !== fak.tokenId
            || Math.abs(stage.price - fak.price) > EPS || stage.shares > fak.shares - fak.filledShares + EPS))
          || !validDirection(stage.direction)
          || stage.tokenId !== (stage.direction === "UP" ? round.upTokenId : round.downTokenId)
          || !unitPrice(stage.price) || stage.price > MAX_LIMIT + EPS
          // The first order is the configured shares, or (edgeSizing) one of the edge tiers.
          || (rest ? !(stage.shares > 0) : ![round.config.shares, EDGE_SHARES_LOW, EDGE_SHARES_HIGH]
            .some(n => stage.shares === leadShares(n, stage.price)))
          || (stage.fair !== undefined && !(finite(stage.fair) && stage.fair >= 0 && stage.fair <= 1))
          || (stage.edge !== undefined && !finite(stage.edge))
          || (stage.edgeShares !== undefined && !positive(stage.edgeShares))
          || (stage.restShadowFillAt !== undefined && !finite(stage.restShadowFillAt))
          || (stage.missedAt !== undefined && !finite(stage.missedAt))
          || (stage.restDecided !== undefined && typeof stage.restDecided !== "boolean")
          || (stage.firstFillAt !== undefined && !finite(stage.firstFillAt))
          || !unitPrice(stage.askAtSignal) || stage.price > stage.askAtSignal + round.config.limitPremium + EPS
          // A BUY below its limit gets more than `shares` for the same budget
          // (2026-10-26: 5.25 of 5); the core bounds every fill by that budget.
          || !Number.isFinite(stage.createdAt) || !Number.isFinite(stage.filledShares) || stage.filledShares < 0
          || (stage.feeReserveUsd !== undefined && (!Number.isFinite(stage.feeReserveUsd) || stage.feeReserveUsd < 0))
          || (stage.askGoneAtUnix !== undefined && !finite(stage.askGoneAtUnix))
          || (stage.askGoneVenueAt !== undefined && !finite(stage.askGoneVenueAt))
          || !STAGE_STATUSES.includes(stage.status)
          || !signal || signal.direction !== stage.direction
          || ![signal.price, signal.refPrice, signal.moveBp, signal.tradeId, signal.tradeTimeMs,
            signal.receivedAtUnix, signal.receivedAtMonoMs].every(finite)
          || (signal.signals300 !== undefined && !finite(signal.signals300))
          || (signal.vol300Bp !== undefined && !finite(signal.vol300Bp))
          || (signal.venue !== undefined && !LEAD_VENUES.includes(signal.venue))
          || (signal.line !== undefined && signal.line !== "direct" && signal.line !== "tokyo")) throw new Error("invalid persisted binance-lead stage");
        // A signal saved before venues existed was Bybit's, direct.
        signal.venue ??= "bybit"; signal.line ??= "direct";
        delete legacy.stage; delete legacy.fairEdge;
        delete (signal as LeadSignalRecord & { fairUp?: unknown }).fairUp;
      });
    }
    return state;
  }
}

export function createStrategy(config: Partial<BinanceLeadConfig> = {}, restored?: BinanceLeadState,
  options: Omit<BinanceLeadOptions, "restoredState"> = {}): BinanceLeadStrategy {
  return new BinanceLeadStrategy(config, { ...options, restoredState: restored });
}
