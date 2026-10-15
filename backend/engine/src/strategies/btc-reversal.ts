import type { AssetId, Instrument, MarketBookSnapshot, MarketInfo, OrderRecord, OrderRequest, OrderStatus, StrategyAction,
  StrategyContext, StrategyPlugin, TradingEvent } from "../platform/contracts.js";

export type ReversalDirection = "UP" | "DOWN";
export interface BtcReversalConfig {
  instanceId: string;
  /** Selected market asset. The historical strategy name is retained for BTC compatibility. */
  assetId: AssetId;
  revision: string;
  triggerPrice: number;
  confirmationPrice: number;
  maxBuyPrice: number;
  stageShares: number[];
  maxStages: number;
  /** Cost caps include actual position costs and working-order fee reservations. */
  roundBudgetUsd?: number;
  totalBudgetUsd?: number;
  dailyLossUsd?: number | null;
  maxQuoteAgeSeconds: number;
  maxQuoteSkewSeconds: number;
  /** STRATEGY.md 3: a round whose first crossing comes before this many seconds
   * after the open is not traded at all; 0 trades from the open. */
  firstTriggerFromSec: number;
}
export interface ReversalStage {
  stage: number;
  direction: ReversalDirection;
  tokenId: string;
  clientOrderId: string;
  price: number;
  shares: number;
  createdAt: number;
  trigger: "initial_band_entry" | "crossing";
  status: OrderStatus | "CREATED" | "ABANDONED";
  orderId?: string;
  filledShares: number;
  /** Estimate reserved before core dispatch; not an actual fill fee. */
  feeReserveUsd?: number;
  error?: string;
  cancelRequestedAt?: number;
  /** Ladder index (0-based) the stage was sized for; older state files lack it. */
  rung?: number;
  /** Rung 1 given up for rung 1 on the other side (STRATEGY.md 4); it holds
   * nothing unless a fill raced the cancel. */
  replaced?: boolean;
}
interface QuoteReference {
  upAsk: number;
  downAsk: number;
  upTs: number;
  downTs: number;
}
export interface ReversalRound {
  assetId: AssetId;
  marketId: string;
  /** Five-minute Unix start identity carried by paired market snapshots. */
  roundId: string;
  name: string;
  startsAt: number;
  endsAt: number;
  upTokenId: string;
  downTokenId: string;
  config: BtcReversalConfig;
  status: "waiting_start" | "waiting_next_round" | "running" | "ended";
  firstSampleSeen: boolean;
  reference?: QuoteReference;
  referenceFloor?: { upTs: number; downTs: number };
  rebuildingReference: boolean;
  lastStageDirection?: ReversalDirection;
  lastConfirmedDirection?: ReversalDirection;
  confirmationCount: number;
  stages: ReversalStage[];
  reason: string;
}
export interface BtcReversalState {
  schemaVersion: 1;
  strategyId: "btc-reversal";
  instanceId: string;
  config: BtcReversalConfig;
  rounds: ReversalRound[];
  paused: boolean;
}
export interface BtcReversalOptions {
  persist?: (state: BtcReversalState) => void;
  restoredState?: BtcReversalState;
}

export const BTC_REVERSAL_DEFAULTS: Readonly<BtcReversalConfig> = Object.freeze({
  instanceId: "btc-reversal", assetId: "btc", revision: "1", triggerPrice: 0.67, confirmationPrice: 0.70,
  maxBuyPrice: 0.70, stageShares: [5, 13, 60], maxStages: 3,     // STRATEGY.md rule 6
  maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5, firstTriggerFromSec: 0,
});
const EPS = 1e-8;
/** A round keeps its config from this many seconds before it starts (the
 * console's "current and pre-warmed rounds keep their config"). */
const CONFIG_FREEZE_SEC = 10;
/** STRATEGY.md rule 2: a frame whose two asks sum above this is a thin book
 * and judges nothing; the baseline stays (same as scripts/backtest.py). */
const WIDE_SUM = 1.05;
const clone = <T>(value: T): T => structuredClone(value);
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const validDirection = (value: unknown): value is ReversalDirection => value === "UP" || value === "DOWN";
const activeOrder = (status: string) => ["CREATED", "SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(status);

export function normalizeBtcReversalConfig(input: Partial<BtcReversalConfig> = {}): BtcReversalConfig {
  const config = { ...clone(BTC_REVERSAL_DEFAULTS), ...clone(input) };
  if (input.maxStages === undefined && input.stageShares !== undefined) config.maxStages = input.stageShares.length;
  if (typeof config.instanceId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.instanceId)
    || typeof config.revision !== "string" || !config.revision.trim()) throw new Error("invalid strategy instance or revision");
  if (typeof config.assetId !== "string" || !/^[a-z0-9_-]{1,32}$/.test(config.assetId)) {
    throw new Error("invalid strategy asset identity");
  }
  for (const key of ["triggerPrice", "confirmationPrice", "maxBuyPrice"] as const) {
    if (!positive(config[key]) || config[key] >= 1) throw new Error(`${key} must be between 0 and 1`);
  }
  if (config.triggerPrice > config.maxBuyPrice || config.triggerPrice > config.confirmationPrice) {
    throw new Error("triggerPrice must not exceed maxBuyPrice or confirmationPrice");
  }
  if (!Array.isArray(config.stageShares) || !config.stageShares.length || !config.stageShares.every(positive)
    || !Number.isSafeInteger(config.maxStages) || config.maxStages <= 0 || config.maxStages > config.stageShares.length) {
    throw new Error("stageShares must contain a positive size for every configured stage");
  }
  for (const key of ["roundBudgetUsd", "totalBudgetUsd"] as const) {
    if (config[key] !== undefined && !positive(config[key])) throw new Error(`${key} must be positive when supplied`);
  }
  if (config.dailyLossUsd !== undefined && config.dailyLossUsd !== null && !positive(config.dailyLossUsd)) {
    throw new Error("dailyLossUsd must be positive or null");
  }
  if (!positive(config.maxQuoteAgeSeconds) || !positive(config.maxQuoteSkewSeconds)) throw new Error("invalid quote freshness limits");
  if (typeof config.firstTriggerFromSec !== "number" || !Number.isFinite(config.firstTriggerFromSec)
    || config.firstTriggerFromSec < 0 || config.firstTriggerFromSec >= 300) throw new Error("firstTriggerFromSec must be in [0, 300)");
  return config;
}

/** Only emits order intentions. Actual execution, fees, fills and settlement belong to the platform. */
export class BtcReversalStrategy implements StrategyPlugin {
  readonly id = "btc-reversal";
  private state: BtcReversalState;
  private replayIntents = new Set<string>();
  private restoredWaitingMarkets = new Set<string>();
  private latestNow?: number;
  // Keep the complete audit history in state, but never walk it on every book frame.
  private readonly roundsByMarket = new Map<string, ReversalRound>();
  private readonly stagesByClient = new Map<string, { round: ReversalRound; stage: ReversalStage }>();
  private readonly workingRounds = new Map<string, ReversalRound>();
  /** Strategy clock of the latest event; updateConfig has no context of its own. */
  private lastNow = 0;
  private readonly createdStages = new Map<string, ReversalStage>();

  constructor(config: Partial<BtcReversalConfig> = {}, private readonly options: BtcReversalOptions = {}) {
    if (options.restoredState) {
      this.state = this.restore(options.restoredState);
      if (config.instanceId !== undefined && config.instanceId !== this.state.instanceId) throw new Error("strategy instance identity mismatch");
      if (Object.keys(config).length) this.updateConfig(config);
      // No cross may be inferred from prices observed while this process was absent.
      for (const round of this.state.rounds) {
        if (round.status === "running") this.invalidateReference(round);
        if (round.status === "waiting_start") this.restoredWaitingMarkets.add(round.marketId);
        for (const stage of round.stages) if (stage.status === "CREATED") this.replayIntents.add(stage.clientOrderId);
      }
    } else {
      const normalized = normalizeBtcReversalConfig(config);
      this.state = { schemaVersion: 1, strategyId: this.id, instanceId: normalized.instanceId,
        config: normalized, rounds: [], paused: false };
    }
    for (const round of this.state.rounds) this.indexRound(round);
  }

  exportState(): BtcReversalState { return clone(this.state); }
  /** The running round's config, read without cloning the whole state: the
   * engine asks on every event, and a full clone per event grew with every
   * stored round (BUGS P2-13). Callers must not mutate it. */
  activeRoundConfig(now: number): Readonly<BtcReversalConfig> | undefined {
    return this.state.rounds.find(round => round.startsAt <= now && now < round.endsAt)?.config;
  }
  snapshot(): BtcReversalState { return this.exportState(); }
  getStatus() {
    const state = this.exportState();
    const rounds = state.rounds.map(round => ({ ...round, configRevision: round.config.revision,
      isRunning: round.status === "running" && !state.paused,
      // Report the ladder position actually consumed, so a rejected stage does
      // not advertise a rung the next entry will not use.
      consumedStages: BtcReversalStrategy.consumedRungs(round),
      nextStage: BtcReversalStrategy.nextRung(round) < round.config.maxStages ? BtcReversalStrategy.nextRung(round) + 1 : null,
      nextShares: BtcReversalStrategy.nextRung(round) < round.config.maxStages ? round.config.stageShares[BtcReversalStrategy.nextRung(round)] : null,
      nextDirection: BtcReversalStrategy.lastLiveDirection(round) === "UP" ? "DOWN"
        : BtcReversalStrategy.lastLiveDirection(round) === "DOWN" ? "UP" : null }));
    const currentRound = [...rounds].sort((a, b) => b.startsAt - a.startsAt).find(round =>
      (round.status === "running" || round.status === "waiting_next_round")
      && (this.latestNow === undefined || (round.startsAt <= this.latestNow && this.latestNow < round.endsAt)));
    return { ...state, rounds, savedRevision: state.config.revision, currentRound: currentRound ?? null };
  }
  updateConfig(input: Partial<BtcReversalConfig>): void {
    const next = normalizeBtcReversalConfig({ ...this.state.config, ...input,
      maxStages: input.maxStages ?? (input.stageShares ? input.stageShares.length : this.state.config.maxStages) });
    if (next.instanceId !== this.state.instanceId) throw new Error("cannot change the running strategy instance");
    this.state.config = next;
    // "Takes effect next round": a round that has not started still follows the
    // live config until its warm window (CONFIG_FREEZE_SEC before start), then
    // keeps it. The next round usually exists for minutes before it starts, so
    // freezing at creation applied a change one round late; re-cloning at start
    // let a change in the last 10 s alter the round's size (BUGS P2-12).
    for (const round of this.workingRounds.values()) {
      if (round.status === "waiting_start" && round.startsAt - this.lastNow > CONFIG_FREEZE_SEC) round.config = clone(next);
    }
    this.save();
  }
  setPaused(paused: boolean): void {
    if (this.state.paused === paused) return;
    this.state.paused = paused;
    for (const round of this.workingRounds.values()) if (round.status === "running") this.invalidateReference(round);
    this.save();
  }
  /** Called on an explicit feed disconnect even when fresh cached quotes still exist. */
  resetQuoteReference(marketId?: string): void {
    for (const round of this.workingRounds.values()) {
      if (round.status === "running" && (marketId === undefined || round.marketId === marketId)) {
        this.invalidateReference(round); round.reason = "行情恢复中";
      }
    }
  }
  onStop(): void { this.resetQuoteReference(); this.save(); }

  onEvent(event: TradingEvent, context: StrategyContext): readonly StrategyAction[] {
    if (!Number.isFinite(context.now)) return [];
    this.latestNow = context.now;
    if (event.kind === "reference" && event.assetId !== this.state.config.assetId) return [];
    this.lastNow = context.now;
    let changed = this.discover(context);
    // A durable stage intent can outlive the five-minute market if the
    // process dies after persisting the strategy state but before the order
    // request reaches the execution layer. It can no longer be submitted.
    for (const [clientOrderId, stage] of this.createdStages) {
      const indexed = this.stagesByClient.get(clientOrderId);
      if (!indexed || context.now < indexed.round.endsAt) continue;
      stage.status = "ABANDONED";
      stage.error ??= "场次已结束，未提交的阶段意图已放弃";
      this.replayIntents.delete(stage.clientOrderId);
      this.createdStages.delete(stage.clientOrderId);
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
      const stage = this.stagesByClient.get(event.clientOrderId)?.stage;
      if (stage && activeOrder(stage.status)) {
        stage.status = "ABANDONED";
        stage.error = event.message;
        this.replayIntents.delete(stage.clientOrderId);
        this.createdStages.delete(stage.clientOrderId);
        changed = true;
      }
    }
    if (event.kind === "error" && event.clientOrderId) {
      const stage = this.stagesByClient.get(event.clientOrderId)?.stage;
      if (stage && stage.error !== event.message) { stage.error = event.message; changed = true; }
      if (stage?.status === "CREATED" && event.code === "order_not_submitted") {
        stage.status = "REJECTED"; this.replayIntents.delete(stage.clientOrderId);
        this.createdStages.delete(stage.clientOrderId); changed = true;
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
        // Only the markets the recovery blocks (BUGS U2).
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
        if (round.status !== "ended") { round.status = "ended"; round.reason = "本场已结束，处理余单与结算"; changed = true; }
        let hasRemainder = false;
        const quarantined = new Set(context.account.quarantinedOrderIds ?? []);
        for (const stage of round.stages) {
          if (!activeOrder(stage.status) || !stage.orderId || stage.filledShares >= stage.shares - EPS) continue;
          hasRemainder = true;
          // A complete authenticated snapshot already excluded this UNKNOWN order.
          // Keep waiting for a venue terminal state without issuing the same cancel again.
          if (quarantined.has(stage.orderId)) continue;
          // Retry an unconfirmed cancel on later timers, without recursive callback storms.
          if (stage.cancelRequestedAt !== undefined && context.now - stage.cancelRequestedAt < 1) continue;
          stage.cancelRequestedAt = context.now; changed = true;
          actions.push({ kind: "cancel", orderId: stage.orderId });
        }
        // Late acknowledgements or failed-fill corrections can wake this round again.
        if (!hasRemainder) this.workingRounds.delete(round.marketId);
        continue;
      }
      if (context.now < round.startsAt || round.status === "waiting_next_round") continue;
      if (round.status === "waiting_start") {
        // The config is frozen by updateConfig's warm-window rule (BUGS P2-12).
        round.status = "running"; changed = true;
      }
      // A replaced rung 1 is cancelled as soon as it has a venue identity: one
      // still in flight at the switch gets its cancel when its ID arrives.
      changed = this.cancelReplaced(round, context, actions) || changed;
      const marketBlocked = context.account.risk.blockedMarketIds?.includes(round.marketId) === true;
      if (this.state.paused || context.account.risk.halted || marketBlocked) {
        round.reason = this.state.paused ? "已暂停新增交易"
          : marketBlocked ? "本场订单等待交易所确认" : context.account.risk.reason ?? "账户暂不可交易";
        this.invalidateReference(round);
        continue;
      }
      // Only a gated paired book can update the reversal reference. Latency,
      // order, fill, timer and other lifecycle events must not look like a
      // missing quote and erase a baseline that was just accepted.
      if (event.kind !== "book") continue;
      const snapshot = event.snapshot;
      if (!snapshot || snapshot.marketId !== round.marketId
        || snapshot.roundId !== round.roundId) continue;
      const snapshotForRound = snapshot;
      const pair = this.pairFromSnapshot(round, snapshotForRound, context.now);
      if (!pair) {
        if (round.reference) this.invalidateReference(round);
        round.reason = "等待新鲜双边行情";
        continue;
      }
      // A restored CREATED intent is also held until this round has supplied
      // a fresh, identity-matched paired snapshot. Account/order events and
      // another round's book can never replay it into the venue.
      if (!quoteGateBlocked) for (const stage of round.stages) {
        if (!this.replayIntents.delete(stage.clientOrderId) || stage.status !== "CREATED") continue;
        actions.push({ kind: "submit", order: this.orderIntent(round, stage, round.config) });
      }
      // Rule 2: skipped before it can become a baseline or a crossing. Resting
      // orders are untouched; they still fill on the venue.
      if (pair.upAsk + pair.downAsk > WIDE_SUM) { round.reason = "盘口太薄，等待正常报价"; continue; }
      const previous = round.reference;
      if (previous && pair.upTs === previous.upTs && pair.downTs === previous.downTs
        && pair.upAsk === previous.upAsk && pair.downAsk === previous.downAsk) continue;
      if (previous && (pair.upTs - previous.upTs > round.config.maxQuoteAgeSeconds
        || pair.downTs - previous.downTs > round.config.maxQuoteAgeSeconds)) round.rebuildingReference = true;
      const first = !round.firstSampleSeen;
      round.firstSampleSeen = true;
      if (first) changed = true;
      const threshold = round.config.triggerPrice;
      const confirming = this.uniqueDirection(pair.upAsk >= round.config.confirmationPrice,
        pair.downAsk >= round.config.confirmationPrice);
      if (first) {
        // The first complete pair is only a baseline. Without a prior
        // below-trigger observation there is no real crossing to trade.
        // The first sample is already a fresh baseline. A recovery that landed
        // before it (account_recovery_started has no marketId) must not make
        // the second sample a baseline too, or that crossing is lost (BUGS P3-6).
        round.reference = pair; round.rebuildingReference = false; round.referenceFloor = undefined;
        round.reason = "已建立行情基线，等待跨价";
        if (confirming) round.lastConfirmedDirection = confirming;
        changed = true;
        continue;
      }
      if (round.rebuildingReference) {
        round.reference = pair; round.rebuildingReference = false; round.referenceFloor = undefined;
        if (confirming) round.lastConfirmedDirection = confirming;
        round.reason = "行情已恢复，等待下一次跨价";
        changed = true;
        continue;
      }
      if (confirming && confirming !== round.lastConfirmedDirection) {
        if (round.lastConfirmedDirection) round.confirmationCount += 1;
        round.lastConfirmedDirection = confirming; changed = true;
      }
      // Rule 5: a crossing is an ask going from below the trigger to at or
      // above it; both sides crossing on one frame is no direction.
      const upCross = previous !== undefined && previous.upAsk < threshold && pair.upAsk >= threshold;
      const downCross = previous !== undefined && previous.downAsk < threshold && pair.downAsk >= threshold;
      round.reference = pair;
      const direction = this.uniqueDirection(upCross, downCross);
      // Rule 3: the round's first crossing came too early, so the whole round is
      // skipped (later crossings included), as the backtest's --first-after.
      // Parked like a round joined mid-way. A skipped round does not count toward
      // --max-rounds (countsTowardRoundLimit): "run N rounds" means N traded ones.
      if (direction && !round.stages.length && context.now - round.startsAt < round.config.firstTriggerFromSec) {
        round.status = "waiting_next_round";
        round.reason = `第一次触发在开盘后 ${Math.floor(context.now - round.startsAt)} 秒，早于 ${round.config.firstTriggerFromSec} 秒，本场不做`;
        changed = true;
        continue;
      }
      // "Our side" is the last rung placed, in flight or resting unfilled
      // included (STRATEGY.md 5, backtest `sides[-1]`): only the other side
      // crossing is a reversal. Taking it from filled rungs only re-placed the
      // same rung while one was still on its way (240 of 2.5k btc rounds).
      const placed = BtcReversalStrategy.placedStages(round);
      if (!direction) { round.reason = placed.length ? "等待相反方向跨价" : "等待触发跨价"; continue; }
      if (direction === placed[placed.length - 1]?.direction) {
        round.reason = "方向明确但与上一阶段同向，等待相反方向跨价"; continue;
      }
      // Rule 4: nothing bought yet when the other side crosses → give up rung 1
      // there and place rung 1 here (before the ladder limit: a 1-rung ladder
      // switches sides too, as the backtest does).
      const switchSides = placed.length > 0 && placed.every(stage => stage.filledShares <= EPS);
      const rung = switchSides ? 0 : placed.length;
      if (rung >= round.config.maxStages) { round.reason = "已达到设置的阶段上限"; continue; }
      const market = context.markets.find(m => m.id === round.marketId);
      const tokenId = direction === "UP" ? round.upTokenId : round.downTokenId;
      const instrument = market?.instruments.find(i => i.tokenId === tokenId);
      const shares = round.config.stageShares[rung];
      if (!instrument || !this.validSizeAndPrice(instrument, shares, round.config.maxBuyPrice)) {
        round.reason = "当前阶段数量或价格不符合交易所规则"; continue;
      }
      const candidate: ReversalStage = { stage: round.stages.length + 1, direction, tokenId,
        clientOrderId: `${this.state.instanceId}:${round.marketId}:${round.stages.length + 1}`,
        price: round.config.maxBuyPrice, shares, createdAt: context.now,
        trigger: "crossing", status: "CREATED", filledShares: 0 };
      let feeReserve: number;
      try { feeReserve = context.estimateFee?.(this.orderIntent(round, candidate, round.config)) ?? 0; }
      catch { round.reason = "当前交易费用暂不可用"; continue; }
      if (!Number.isFinite(feeReserve) || feeReserve < 0) { round.reason = "当前交易费用暂不可用"; continue; }
      candidate.feeReserveUsd = feeReserve;
      const cost = shares * round.config.maxBuyPrice + feeReserve;
      const unreservedStages = [...this.createdStages.values()].filter(stage => !knownClients.has(stage.clientOrderId));
      const pendingCost = (stage: ReversalStage) => stage.price * stage.shares + (stage.feeReserveUsd ?? 0);
      const unreserved = unreservedStages.reduce((total, stage) => total + pendingCost(stage), 0);
      const tokens = new Set([round.upTokenId, round.downTokenId]);
      const roundCost = context.account.positions.filter(position => tokens.has(position.tokenId))
        .reduce((total, position) => total + position.costUsd, 0)
        + context.account.orders.filter(order => tokens.has(order.tokenId)
          && (activeOrder(order.status) || order.reconciliationPending === true))
          .reduce((total, order) => total + order.reservedUsd, 0)
        + unreservedStages.filter(stage => tokens.has(stage.tokenId)).reduce((total, stage) => total + pendingCost(stage), 0);
      if (round.config.roundBudgetUsd !== undefined && roundCost + cost > round.config.roundBudgetUsd + EPS) {
        round.reason = "该阶段超过单场预算"; continue;
      }
      if (round.config.totalBudgetUsd !== undefined && context.account.risk.occupiedUsd + unreserved + cost > round.config.totalBudgetUsd + EPS) {
        round.reason = "该阶段超过总资金预算"; continue;
      }
      if (cost + unreserved > context.account.risk.availableUsd + EPS) {
        round.reason = "可用余额不足以提交该阶段"; continue;
      }
      if (switchSides) for (const stage of placed) stage.replaced = true;
      candidate.rung = rung;
      round.stages.push(candidate); round.lastStageDirection = direction; round.reason = "已触发，等待真实订单回报";
      this.indexStage(round, candidate);
      changed = true;
      if (switchSides) this.cancelReplaced(round, context, actions);
      actions.push({ kind: "submit", order: this.orderIntent(round, candidate, round.config) });
    }
    // Write the economic stage key before returning an action to the execution layer.
    if (changed) this.save();
    return actions;
  }

  private discover(context: StrategyContext): boolean {
    let changed = false;
    for (const market of context.markets) {
      if (this.roundsByMarket.has(market.id) || context.now >= market.endsAt) continue;
      const instruments = this.marketInstruments(market);
      if (!instruments) continue;
      const eligible = context.now <= market.startsAt;
      const round: ReversalRound = { assetId: market.assetId ?? this.state.config.assetId, marketId: market.id, roundId: market.roundId, name: market.name, startsAt: market.startsAt, endsAt: market.endsAt,
        upTokenId: instruments.UP.tokenId, downTokenId: instruments.DOWN.tokenId, config: clone(this.state.config),
        status: eligible ? "waiting_start" : "waiting_next_round", firstSampleSeen: false, rebuildingReference: false,
        confirmationCount: 0, stages: [], reason: eligible ? "等待本场开始" : "中途启动，等待下一场" };
      this.state.rounds.push(round);
      this.indexRound(round);
      changed = true;
    }
    return changed;
  }

  private marketInstruments(market: MarketInfo): Record<ReversalDirection, Instrument> | undefined {
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

  private pairFromSnapshot(round: ReversalRound, snapshot: MarketBookSnapshot, now: number): QuoteReference | undefined {
    if (snapshot.marketId !== round.marketId || snapshot.roundId !== round.roundId
      || snapshot.assetId !== undefined && snapshot.assetId !== round.assetId
      || round.assetId !== "btc" && snapshot.assetId !== round.assetId
      || snapshot.expiresAt == null || snapshot.expiresAt <= now
      || snapshot.marketAgeMs != null && snapshot.marketAgeMs > round.config.maxQuoteAgeSeconds * 1000) return undefined;
    const yes = snapshot.YES, no = snapshot.NO;
    if (!yes || !no || yes.assetId !== round.upTokenId || no.assetId !== round.downTokenId
      || !positive(yes.ask) || yes.ask >= 1 || !positive(no.ask) || no.ask >= 1
      || yes.sourceAt == null || no.sourceAt == null) return undefined;
    const upTs = yes.sourceAt, downTs = no.sourceAt;
    if (Math.abs(upTs - downTs) > round.config.maxQuoteSkewSeconds) return undefined;
    if (round.reference && (upTs < round.reference.upTs || downTs < round.reference.downTs)) return undefined;
    if (round.referenceFloor && (upTs <= round.referenceFloor.upTs || downTs <= round.referenceFloor.downTs)) return undefined;
    return { upAsk: yes.ask, downAsk: no.ask, upTs, downTs };
  }

  private uniqueDirection(up: boolean, down: boolean): ReversalDirection | undefined {
    return up === down ? undefined : up ? "UP" : "DOWN";
  }
  private orderIntent(round: ReversalRound, stage: ReversalStage, config: BtcReversalConfig): Omit<OrderRequest, "strategyId"> {
    return { clientOrderId: stage.clientOrderId, assetId: round.assetId, marketId: round.marketId, roundId: round.roundId,
      tokenId: stage.tokenId, direction: "BUY", price: stage.price,
      shares: stage.shares, timeInForce: "GTC", postOnly: false,
      ...(config.roundBudgetUsd === undefined ? {} : { roundBudgetUsd: config.roundBudgetUsd }) };
  }
  private invalidateReference(round: ReversalRound): void {
    if (round.reference) round.referenceFloor = { upTs: round.reference.upTs, downTs: round.reference.downTs };
    round.reference = undefined; round.rebuildingReference = true;
  }
  private validSizeAndPrice(instrument: Instrument, shares: number, price: number): boolean {
    return positive(instrument.tickSize) && positive(instrument.minOrderSize) && shares + EPS >= instrument.minOrderSize
      && Math.abs(price / instrument.tickSize - Math.round(price / instrument.tickSize)) < 1e-6;
  }
  private recordOrder(order: OrderRecord): boolean {
    if (order.strategyId !== this.id) return false;
    const indexed = this.stagesByClient.get(order.clientOrderId);
    if (!indexed) return false;
    const { round, stage } = indexed;
    if (order.tokenId !== stage.tokenId || order.direction !== "BUY" || Math.abs(order.shares - stage.shares) > EPS
      || Math.abs(order.price - stage.price) > EPS) throw new Error("restored order does not match its reversal stage");
    if (stage.orderId === order.orderId && stage.status === order.status && stage.filledShares === order.filledShares
      && stage.error === order.error) return false;
    stage.orderId = order.orderId; stage.status = order.status; stage.filledShares = order.filledShares; stage.error = order.error;
    this.createdStages.delete(stage.clientOrderId);
    if (round.status === "ended" && activeOrder(stage.status) && stage.orderId
      && stage.filledShares < stage.shares - EPS) this.workingRounds.set(round.marketId, round);
    return true;
  }
  /** Ladder rungs actually consumed. A REJECTED/ABANDONED stage never reached the
   * venue and committed no capital, so it must not advance the ladder: sizing off
   * `stages.length` turned a rejected first rung into an 18-share entry where 5
   * was intended (stageShares [5, 18, 54, 130] then). */
  private cancelReplaced(round: ReversalRound, context: StrategyContext, actions: StrategyAction[]): boolean {
    let changed = false;
    const quarantined = context.account.quarantinedOrderIds ?? [];
    for (const stage of round.stages) {
      if (!stage.replaced || !activeOrder(stage.status) || !stage.orderId || stage.filledShares >= stage.shares - EPS
        || quarantined.includes(stage.orderId)) continue;
      if (stage.cancelRequestedAt !== undefined && context.now - stage.cancelRequestedAt < 1) continue;
      stage.cancelRequestedAt = context.now; changed = true;
      actions.push({ kind: "cancel", orderId: stage.orderId });
    }
    return changed;
  }
  private static consumedRungs(round: ReversalRound): number {
    return BtcReversalStrategy.placedStages(round).length;
  }
  /** The rungs on the ladder: placed and not given up. In flight (CREATED,
   * SUBMITTING) and resting unfilled (OPEN at 0) count, as the backtest's live
   * orders do. A stage that never reached the venue (REJECTED/ABANDONED), a rung
   * 1 replaced on the other side, or one cancelled with nothing bought holds no
   * rung, so the ladder retries it. */
  private static placedStages(round: ReversalRound): ReversalStage[] {
    return round.stages.filter(stage => stage.status !== "REJECTED" && stage.status !== "ABANDONED" && !stage.replaced
      && !(stage.status === "CANCELLED" && stage.filledShares <= EPS));
  }
  /** Ladder index the next reversal would place (for the console). */
  private static nextRung(round: ReversalRound): number {
    const placed = BtcReversalStrategy.placedStages(round);
    return placed.length && placed.every(stage => stage.filledShares <= EPS) ? 0 : placed.length;
  }
  private static lastLiveDirection(round: ReversalRound): "UP" | "DOWN" | undefined {
    const placed = BtcReversalStrategy.placedStages(round);
    return placed[placed.length - 1]?.direction;
  }
  private indexStage(round: ReversalRound, stage: ReversalStage): void {
    this.stagesByClient.set(stage.clientOrderId, { round, stage });
    if (stage.status === "CREATED") this.createdStages.set(stage.clientOrderId, stage);
  }
  private indexRound(round: ReversalRound): void {
    this.roundsByMarket.set(round.marketId, round);
    for (const stage of round.stages) this.indexStage(round, stage);
    if (round.status !== "ended" || round.stages.some(stage => activeOrder(stage.status) && stage.orderId
      && stage.filledShares < stage.shares - EPS)) this.workingRounds.set(round.marketId, round);
  }
  private save(): void { this.options.persist?.(this.exportState()); }

  private restore(input: BtcReversalState): BtcReversalState {
    const state = clone(input);
    if (state.schemaVersion !== 1 || state.strategyId !== this.id || !Array.isArray(state.rounds)
      || typeof state.paused !== "boolean") throw new Error("invalid reversal state");
    state.config = normalizeBtcReversalConfig(state.config);
    if (state.instanceId !== state.config.instanceId) throw new Error("invalid reversal state identity");
    const markets = new Set<string>(), clients = new Set<string>();
    for (const round of state.rounds) {
      round.config = normalizeBtcReversalConfig(round.config);
      round.assetId ??= state.config.assetId;
      if (!round.marketId || markets.has(round.marketId) || round.config.instanceId !== state.instanceId
        || round.assetId !== state.config.assetId
        || !Number.isFinite(round.startsAt) || round.endsAt - round.startsAt !== 300
        || typeof round.roundId !== "string" || !round.roundId.trim()
        || !round.upTokenId || !round.downTokenId || round.upTokenId === round.downTokenId
        || !Array.isArray(round.stages)
        // A round can hold more stage records than maxStages (rejected,
        // replaced or 0-fill-cancelled ones hold no rung, BUGS P0-1); each
        // stage's own rung is bounded below.
        || !Number.isSafeInteger(round.confirmationCount) || round.confirmationCount < 0
        || !["waiting_start", "waiting_next_round", "running", "ended"].includes(round.status)
        || typeof round.firstSampleSeen !== "boolean" || typeof round.rebuildingReference !== "boolean"
        || (round.lastConfirmedDirection !== undefined && !validDirection(round.lastConfirmedDirection))) {
        throw new Error("invalid persisted reversal round");
      }
      delete (round as { pendingAmbiguity?: boolean }).pendingAmbiguity;   // dropped field of older state files
      markets.add(round.marketId);
      // Validate stages by the same rule the creation path uses. A stage's size
      // is stageShares[rungs consumed BEFORE it], not stageShares[array index]:
      // a rejected/0-fill-cancelled stage consumes no rung, so the next stage
      // reuses the same size and may repeat the same direction (BUGS P0-1).
      // A stage records the rung it was sized for. Older files lack it: derive
      // it from the filled rungs before it, the rule they were written under.
      let direction: ReversalDirection | undefined;      // last filled direction (older files)
      let lastStageDir: ReversalDirection | undefined;    // direction of the last stage record
      let consumed = 0;
      for (const [index, stage] of round.stages.entries()) {
        const expectedId = `${state.instanceId}:${round.marketId}:${index + 1}`;
        const legacy = stage.rung === undefined;
        const rung = stage.rung ?? consumed;
        if (stage.stage !== index + 1 || stage.clientOrderId !== expectedId || clients.has(stage.clientOrderId)
          || !validDirection(stage.direction) || (legacy && stage.direction === direction)
          || !Number.isSafeInteger(rung) || rung < 0 || (!legacy && rung >= round.config.maxStages)
          || (stage.replaced !== undefined && typeof stage.replaced !== "boolean")
          || stage.tokenId !== (stage.direction === "UP" ? round.upTokenId : round.downTokenId)
          || stage.price !== round.config.maxBuyPrice || stage.shares !== round.config.stageShares[rung]
          || !Number.isFinite(stage.createdAt) || !Number.isFinite(stage.filledShares)
          || stage.filledShares < 0 || stage.filledShares > stage.shares + EPS
          || (stage.feeReserveUsd !== undefined && (!Number.isFinite(stage.feeReserveUsd) || stage.feeReserveUsd < 0))
          || !["CREATED", "SUBMITTING", "OPEN", "PARTIAL", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN", "ABANDONED"].includes(stage.status)
          || !["initial_band_entry", "crossing"].includes(stage.trigger)) throw new Error("invalid persisted reversal stage");
        clients.add(stage.clientOrderId);
        lastStageDir = stage.direction;
        if (stage.status !== "REJECTED" && stage.status !== "ABANDONED" && stage.filledShares > EPS) {
          direction = stage.direction; consumed += 1;
        }
      }
      if (lastStageDir !== round.lastStageDirection) throw new Error("invalid persisted stage direction");
    }
    return state;
  }
}

export function createStrategy(config: Partial<BtcReversalConfig> = {}, restored?: BtcReversalState,
  options: Omit<BtcReversalOptions, "restoredState"> = {}): BtcReversalStrategy {
  return new BtcReversalStrategy(config, { ...options, restoredState: restored });
}
export function createBtcReversalStrategy(config: Partial<BtcReversalConfig> = {}, options: BtcReversalOptions = {}): BtcReversalStrategy {
  return new BtcReversalStrategy(config, options);
}
