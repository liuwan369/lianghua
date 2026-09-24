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
  pendingAmbiguity?: boolean;
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
  maxBuyPrice: 0.70, stageShares: [5, 18, 54, 130], maxStages: 4,
  maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5,
});
const EPS = 1e-8;
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
  snapshot(): BtcReversalState { return this.exportState(); }
  getStatus() {
    const state = this.exportState();
    const rounds = state.rounds.map(round => ({ ...round, configRevision: round.config.revision,
      isRunning: round.status === "running" && !state.paused,
      nextStage: round.stages.length < round.config.maxStages ? round.stages.length + 1 : null,
      nextShares: round.stages.length < round.config.maxStages ? round.config.stageShares[round.stages.length] : null,
      nextDirection: round.lastStageDirection === "UP" ? "DOWN" : round.lastStageDirection === "DOWN" ? "UP" : null }));
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
      this.resetQuoteReference(event.marketId);
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
        round.config = clone(this.state.config); round.status = "running"; changed = true;
      }
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
        round.reference = pair;
        round.reason = "已建立行情基线，等待跨价";
        if (confirming) round.lastConfirmedDirection = confirming;
        changed = true;
        continue;
      }
      if (round.rebuildingReference) {
        round.reference = pair; round.rebuildingReference = false; round.referenceFloor = undefined;
        round.pendingAmbiguity = false;
        if (confirming) round.lastConfirmedDirection = confirming;
        round.reason = "行情已恢复，等待下一次跨价";
        changed = true;
        continue;
      }
      // Both asks above the trigger are ambiguous only when there is no
      // directional baseline. If one side was already above the trigger and
      // the other side newly crosses it, that is a clear reversal and must
      // produce the opposite stage immediately.
      const bothAbove = pair.upAsk >= threshold && pair.downAsk >= threshold;
      const previousBothBelow = previous !== undefined
        && previous.upAsk < threshold && previous.downAsk < threshold;
      const previousBothAbove = previous !== undefined
        && previous.upAsk >= threshold && previous.downAsk >= threshold;
      const baselineAlsoBothAbove = previousBothBelow || previousBothAbove;
      if (bothAbove && baselineAlsoBothAbove) {
        round.pendingAmbiguity = true;
        round.reference = pair;
        round.reason = "双边价格冲突，等待明确方向"; changed = true; continue;
      }
      if (confirming && confirming !== round.lastConfirmedDirection) {
        if (round.lastConfirmedDirection) round.confirmationCount += 1;
        round.lastConfirmedDirection = confirming; changed = true;
      }
      const resolvingAmbiguity = round.pendingAmbiguity === true;
      if (resolvingAmbiguity) { round.pendingAmbiguity = false; changed = true; }
      const upCross = resolvingAmbiguity ? pair.upAsk >= threshold
        : previous !== undefined && previous.upAsk < threshold && pair.upAsk >= threshold;
      const downCross = resolvingAmbiguity ? pair.downAsk >= threshold
        : previous !== undefined && previous.downAsk < threshold && pair.downAsk >= threshold;
      round.reference = pair;
      const direction = this.uniqueDirection(upCross, downCross);
      if (round.stages.length >= round.config.maxStages) { round.reason = "已达到设置的阶段上限"; continue; }
      if (!direction) {
        round.reason = resolvingAmbiguity ? "双边均已回落，本次冲突信号作废"
          : round.stages.length ? "等待相反方向跨价" : "等待触发跨价";
        continue;
      }
      if (direction === round.lastStageDirection) { round.reason = "方向明确但与上一阶段同向，等待相反方向跨价"; continue; }
      const market = context.markets.find(m => m.id === round.marketId);
      const tokenId = direction === "UP" ? round.upTokenId : round.downTokenId;
      const instrument = market?.instruments.find(i => i.tokenId === tokenId);
      const shares = round.config.stageShares[round.stages.length];
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
      round.stages.push(candidate); round.lastStageDirection = direction; round.reason = "已触发，等待真实订单回报";
      this.indexStage(round, candidate);
      changed = true;
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
        pendingAmbiguity: false, confirmationCount: 0, stages: [], reason: eligible ? "等待本场开始" : "中途启动，等待下一场" };
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
    round.pendingAmbiguity = false;
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
        || !Array.isArray(round.stages) || round.stages.length > round.config.maxStages
        || !Number.isSafeInteger(round.confirmationCount) || round.confirmationCount < 0
        || !["waiting_start", "waiting_next_round", "running", "ended"].includes(round.status)
        || typeof round.firstSampleSeen !== "boolean" || typeof round.rebuildingReference !== "boolean"
        || (round.pendingAmbiguity !== undefined && typeof round.pendingAmbiguity !== "boolean")
        || (round.lastConfirmedDirection !== undefined && !validDirection(round.lastConfirmedDirection))) {
        throw new Error("invalid persisted reversal round");
      }
      round.pendingAmbiguity ??= false;
      markets.add(round.marketId);
      let direction: ReversalDirection | undefined;
      for (const [index, stage] of round.stages.entries()) {
        const expectedId = `${state.instanceId}:${round.marketId}:${index + 1}`;
        if (stage.stage !== index + 1 || stage.clientOrderId !== expectedId || clients.has(stage.clientOrderId)
          || !validDirection(stage.direction) || stage.direction === direction
          || stage.tokenId !== (stage.direction === "UP" ? round.upTokenId : round.downTokenId)
          || stage.price !== round.config.maxBuyPrice || stage.shares !== round.config.stageShares[index]
          || !Number.isFinite(stage.createdAt) || !Number.isFinite(stage.filledShares)
          || stage.filledShares < 0 || stage.filledShares > stage.shares + EPS
          || (stage.feeReserveUsd !== undefined && (!Number.isFinite(stage.feeReserveUsd) || stage.feeReserveUsd < 0))
          || !["CREATED", "SUBMITTING", "OPEN", "PARTIAL", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN", "ABANDONED"].includes(stage.status)
          || !["initial_band_entry", "crossing"].includes(stage.trigger)) throw new Error("invalid persisted reversal stage");
        clients.add(stage.clientOrderId); direction = stage.direction;
      }
      if (direction !== round.lastStageDirection) throw new Error("invalid persisted stage direction");
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
