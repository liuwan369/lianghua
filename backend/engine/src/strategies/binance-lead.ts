import type { AssetId, Instrument, MarketInfo, OrderRecord, OrderRequest, OrderStatus, StrategyAction,
  StrategyContext, StrategyPlugin, TradingEvent } from "../platform/contracts.js";

/** Binance lead (frozen 2026-10-25, E:/pm-backup/forward-binance-agg.py): the
 * round's first valid Binance signal whose book in force is two-sided and was
 * fresh on arrival gets one FAK BUY on the signal's side at ask + premium, held
 * to the close. The 250 ms window lives in LeadSignalDetector on the feed side;
 * this plugin only sees the rare signals. */
export type LeadDirection = "UP" | "DOWN";
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
  maxQuoteAgeSeconds: number;
  maxQuoteSkewSeconds: number;
  roundBudgetUsd?: number;
  totalBudgetUsd?: number;
  dailyLossUsd?: number | null;
}
type LeadEvent = Extract<TradingEvent, { kind: "lead" }>;
export type LeadSignalRecord = Omit<LeadEvent, "kind" | "assetId">;
export interface LeadStage {
  stage: 1;
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
}
/** Summary of the round's latest frame; never restored across a restart. */
export interface LeadQuote {
  upAsk?: number;
  downAsk?: number;
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
  /** At most one: one attempt per round. */
  stages: LeadStage[];
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
  limitPremium: 0.03, fromSec: 15, toSec: 265, maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5,
});
const EPS = 1e-8;
/** A round keeps its config from this many seconds before it starts. */
const CONFIG_FREEZE_SEC = 10;
/** A frame whose two asks sum above this was not fresh on arrival (backtest `ok`). */
const WIDE_SUM = 1.05;
const MAX_LIMIT = 0.99;
const WAITING = "等待币安信号";
const clone = <T>(value: T): T => structuredClone(value);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const unitPrice = (n: unknown): n is number => positive(n) && n < 1;
const validDirection = (value: unknown): value is LeadDirection => value === "UP" || value === "DOWN";
const activeOrder = (status: string) => ["CREATED", "SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(status);
const STAGE_STATUSES = ["CREATED", "SUBMITTING", "OPEN", "PARTIAL", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN", "ABANDONED"];

/** Ask + premium, rounded down to the tick (never pays more than the rule), capped at 0.99. */
export function leadLimitPrice(ask: number, premium: number, tickSize: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(tickSize) - 1e-9));
  const onTick = Math.floor((ask + premium) / tickSize + 1e-9) * tickSize;
  return Number(Math.min(MAX_LIMIT, onTick).toFixed(decimals));
}

export function normalizeBinanceLeadConfig(input: Partial<BinanceLeadConfig> = {}): BinanceLeadConfig {
  const config = { ...clone(BINANCE_LEAD_DEFAULTS), ...clone(input) };
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
          if (round.status !== "ended") round.reason = BinanceLeadStrategy.attemptReason(stage);
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
    }
    this.state.rounds = kept;
    this.save();
  }
  /** The round whose window holds `ts`, without cloning the state. Callers must not mutate it. */
  roundAt(ts: number): Readonly<LeadRound> | undefined {
    return this.state.rounds.find(round => round.startsAt <= ts && ts < round.endsAt);
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
      if (this.restoredWaitingMarkets.delete(round.marketId) && round.startsAt < context.now) {
        round.status = "waiting_next_round"; round.reason = "重启时已错过本场开始，等待下一场"; changed = true;
      }
      if (context.now >= round.endsAt) {
        if (round.status !== "ended") { round.status = "ended"; round.reason = "本场已结束，处理余单与结算"; round.latest = undefined; changed = true; }
        let hasRemainder = false;
        const quarantined = new Set(context.account.quarantinedOrderIds ?? []);
        for (const stage of round.stages) {
          if (!activeOrder(stage.status) || !stage.orderId || stage.filledShares >= stage.shares - EPS) continue;
          hasRemainder = true;
          // A complete authenticated snapshot already excluded this UNKNOWN order.
          if (quarantined.has(stage.orderId)) continue;
          // Retry an unconfirmed cancel on later timers, without recursive callback storms.
          if (stage.cancelRequestedAt !== undefined && context.now - stage.cancelRequestedAt < 1) continue;
          stage.cancelRequestedAt = context.now; changed = true;
          actions.push({ kind: "cancel", orderId: stage.orderId });
        }
        // Late acknowledgements or failed-fill corrections can wake this round again.
        if (!hasRemainder) { this.workingRounds.delete(round.marketId); this.blockNoted.delete(round.marketId); }
        continue;
      }
      if (context.now < round.startsAt || round.status === "waiting_next_round") continue;
      if (round.status === "waiting_start") {
        // The config is frozen by updateConfig's warm-window rule.
        round.status = "running"; round.reason = WAITING; changed = true;
      }
      // The book in force is tracked while paused or blocked too.
      if (event.kind === "book") this.updateLatest(round, event, context.now);
      const marketBlocked = context.account.risk.blockedMarketIds?.includes(round.marketId) === true;
      const blocked = this.state.paused ? "已暂停新增交易"
        : marketBlocked ? "本场订单等待交易所确认"
        : context.account.risk.halted ? context.account.risk.reason ?? "账户暂不可交易" : undefined;
      if (blocked) {
        if (!round.stages.length) { round.reason = blocked; this.blockNoted.add(round.marketId); }
        continue;
      }
      if (this.blockNoted.delete(round.marketId) && !round.stages.length) round.reason = WAITING;
      if (event.kind !== "lead") continue;
      const seenAt = event.receivedAtUnix;
      if (!(round.startsAt <= seenAt && seenAt < round.endsAt)) continue;
      // One attempt per round, filled or not (backtest retry=False).
      if (round.stages.length) continue;
      const decision = this.decide(round, event, context, knownClients);
      if (!decision) continue;
      round.stages.push(decision.stage);
      round.reason = "已下单（FAK），等待成交回报";
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
    const latest = round.latest;
    if (!latest) { round.reason = "信号到达时没有当前盘口，等下一个信号"; return undefined; }
    if (!latest.twoSided) { round.reason = "当前盘口一边没有卖价，等下一个信号"; return undefined; }
    if (!latest.freshOnArrival) {
      round.reason = `当前盘口到达时不新鲜（${latest.staleReason ?? "未知"}），等下一个信号`; return undefined;
    }
    const direction = event.direction;
    const tokenId = direction === "UP" ? round.upTokenId : round.downTokenId;
    const ask = (direction === "UP" ? latest.upAsk : latest.downAsk)!;
    const instrument = context.markets.find(m => m.id === round.marketId)?.instruments.find(i => i.tokenId === tokenId);
    if (!instrument || !positive(instrument.tickSize) || !positive(instrument.minOrderSize)) {
      round.reason = "交易所规则暂不可用"; return undefined;
    }
    const price = leadLimitPrice(ask, config.limitPremium, instrument.tickSize);
    // A FAK under the ask cannot fill: keep the round's attempt for a later signal.
    if (price < ask - EPS) { round.reason = `卖价 ${ask} 高于最高限价 ${MAX_LIMIT}，等下一个信号`; return undefined; }
    if (!this.validSizeAndPrice(instrument, config.shares, price)) {
      round.reason = "数量或限价不符合交易所规则"; return undefined;
    }
    const { kind: _kind, assetId: _assetId, ...signal } = event;
    const stage: LeadStage = { stage: 1, direction, tokenId, clientOrderId: `${this.state.instanceId}:${round.marketId}:1`,
      price, shares: config.shares, createdAt: context.now, status: "CREATED", filledShares: 0,
      signal: { ...signal }, askAtSignal: ask };
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

  /** Every frame of this round replaces the book in force, one-sided included. */
  private updateLatest(round: LeadRound, event: Extract<TradingEvent, { kind: "book" }>, now: number): void {
    const snapshot = event.snapshot;
    if (!snapshot || event.marketId !== round.marketId || event.roundId !== round.roundId
      || snapshot.marketId !== round.marketId || snapshot.roundId !== round.roundId
      || snapshot.assetId !== undefined && snapshot.assetId !== round.assetId
      || round.assetId !== "btc" && snapshot.assetId !== round.assetId) return;
    // Only frames of the round itself (backtest: start <= t < start + 300).
    if ((snapshot.receivedAtUnix ?? now) < round.startsAt) return;
    const yes = snapshot.YES, no = snapshot.NO;
    if ((yes && yes.assetId !== round.upTokenId) || (no && no.assetId !== round.downTokenId)) return;
    const upAsk = yes?.ask, downAsk = no?.ask;
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
    round.latest = { upAsk, downAsk, twoSided, freshOnArrival: twoSided && staleReason === undefined,
      ...(staleReason ? { staleReason } : {}) };
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
      tokenId: stage.tokenId, direction: "BUY", price: stage.price, shares: stage.shares, timeInForce: "FAK", postOnly: false,
      ...(round.config.roundBudgetUsd === undefined ? {} : { roundBudgetUsd: round.config.roundBudgetUsd }) };
  }
  private validSizeAndPrice(instrument: Instrument, shares: number, price: number): boolean {
    return unitPrice(price) && shares + EPS >= instrument.minOrderSize
      && Math.abs(price / instrument.tickSize - Math.round(price / instrument.tickSize)) < 1e-6;
  }
  private recordOrder(order: OrderRecord): boolean {
    if (order.strategyId !== this.id) return false;
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
    this.noteAttempt(round, stage);
    if (round.status === "ended" && activeOrder(stage.status) && stage.orderId
      && stage.filledShares < stage.shares - EPS) this.workingRounds.set(round.marketId, round);
    return true;
  }
  /** The core holds this round's order but the strategy has no stage: the
   * process died after the signed order was saved (.intent, before POST) and
   * before the strategy state was. The order is the round's one attempt. The
   * signal it came from is gone; its fields are zero, the ask is the limit. */
  private adoptOrder(order: OrderRecord): { round: LeadRound; stage: LeadStage } | undefined {
    const match = /^(.+):([^:]+):1$/.exec(order.clientOrderId);
    if (!match || match[1] !== this.state.instanceId) return undefined;
    const round = this.roundsByMarket.get(match[2]!);
    if (!round || round.stages.length || order.direction !== "BUY") return undefined;
    const direction = order.tokenId === round.upTokenId ? "UP" : order.tokenId === round.downTokenId ? "DOWN" : undefined;
    if (!direction) return undefined;
    const stage: LeadStage = { stage: 1, direction, tokenId: order.tokenId, clientOrderId: order.clientOrderId,
      price: order.price, shares: order.shares, createdAt: order.createdAt, status: order.status, filledShares: order.filledShares,
      ...(order.orderId ? { orderId: order.orderId } : {}),
      error: "重启时本场订单已在交易所记录中，策略记录丢失，按订单恢复",
      signal: { direction, price: 0, refPrice: 0, moveBp: 0, tradeId: 0, tradeTimeMs: 0, receivedAtUnix: order.createdAt,
        receivedAtMonoMs: 0 },
      askAtSignal: order.price };
    round.stages.push(stage);
    this.indexStage(round, stage);
    if (round.status === "ended") this.workingRounds.set(round.marketId, round);
    this.noteAttempt(round, stage);
    return { round, stage };
  }
  private noteAttempt(round: LeadRound, stage: LeadStage): void {
    if (round.status !== "ended") round.reason = BinanceLeadStrategy.attemptReason(stage);
  }
  private static attemptReason(stage: LeadStage): string {
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
  private indexRound(round: LeadRound): void {
    this.roundsByMarket.set(round.marketId, round);
    for (const stage of round.stages) this.indexStage(round, stage);
    if (round.status !== "ended" || round.stages.some(stage => activeOrder(stage.status) && stage.orderId
      && stage.filledShares < stage.shares - EPS)) this.workingRounds.set(round.marketId, round);
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
        || !Array.isArray(round.stages) || round.stages.length > 1
        || !["waiting_start", "waiting_next_round", "running", "ended"].includes(round.status)
        || typeof round.reason !== "string") throw new Error("invalid persisted binance-lead round");
      // The book seen by a previous process is not the book in force now.
      delete round.latest;
      markets.add(round.marketId);
      for (const stage of round.stages) {
        const signal = stage.signal;
        if (stage.stage !== 1 || stage.clientOrderId !== `${state.instanceId}:${round.marketId}:1`
          || !validDirection(stage.direction)
          || stage.tokenId !== (stage.direction === "UP" ? round.upTokenId : round.downTokenId)
          || !unitPrice(stage.price) || stage.price > MAX_LIMIT + EPS || stage.shares !== round.config.shares
          || !unitPrice(stage.askAtSignal) || stage.price > stage.askAtSignal + round.config.limitPremium + EPS
          || !Number.isFinite(stage.createdAt) || !Number.isFinite(stage.filledShares)
          || stage.filledShares < 0 || stage.filledShares > stage.shares + EPS
          || (stage.feeReserveUsd !== undefined && (!Number.isFinite(stage.feeReserveUsd) || stage.feeReserveUsd < 0))
          || !STAGE_STATUSES.includes(stage.status)
          || !signal || signal.direction !== stage.direction
          || ![signal.price, signal.refPrice, signal.moveBp, signal.tradeId, signal.tradeTimeMs,
            signal.receivedAtUnix, signal.receivedAtMonoMs].every(finite)) throw new Error("invalid persisted binance-lead stage");
      }
    }
    return state;
  }
}

export function createStrategy(config: Partial<BinanceLeadConfig> = {}, restored?: BinanceLeadState,
  options: Omit<BinanceLeadOptions, "restoredState"> = {}): BinanceLeadStrategy {
  return new BinanceLeadStrategy(config, { ...options, restoredState: restored });
}
