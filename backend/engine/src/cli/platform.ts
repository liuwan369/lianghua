#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import * as referenceFeedModule from "../live/feeds/btc.js";
import type { AssetId, CoreState, HardLimits, MarketInfo, OrderRecord, SettlementResult, TradingEvent, TradingMode } from "../platform/contracts.js";
import { PlatformJournal } from "../platform/journal.js";
import { connectPolymarketPlatform, discoverMarket, referenceProducerForAsset } from "../platform/polymarket.js";
import { PlatformStore } from "../platform/store.js";
import { createBtcReversalStrategy, normalizeBtcReversalConfig, type BtcReversalConfig,
  type BtcReversalState, type BtcReversalStrategy } from "../strategies/btc-reversal.js";

const MARKET_WINDOW_SEC = 300;
const DISCOVERY_PREWARM_MS = 10_000;
const DISCOVERY_PREWARM_RETRY_MS = 250;
const DISCOVERY_POST_BOUNDARY_MS = 20_000;
// A duration/operator stop must still give already-traded rounds a chance to
// reach their terminal boundary and submit settlement. Keep this bounded so a
// broken market or RPC cannot hold the process forever. The control plane
// treats a timeout as pending settlement and can reconcile it on the next run.
export const SETTLEMENT_DRAIN_MAX_MS = 5 * 60_000;
const SETTLEMENT_DRAIN_POLL_MS = 15_000;
export const SHUTDOWN_STAGE_MAX_MS = 30_000;
const BEST_EFFORT_LATENCY_METRICS = new Set([
  "book_batch_apply", "book_processing", "market_age", "strategy_decision", "ws_receive_to_decision",
]);

export function countActiveOrders(state: Pick<CoreState, "orders" | "quarantinedOrderIds">): number {
  return state.orders.filter(order => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)
    && !state.quarantinedOrderIds?.includes(order.orderId ?? "")).length;
}

export interface SettlementRecoveryCandidate {
  assetId: AssetId;
  marketId: string;
  roundId: string;
  tokenIds: string[];
}

/** Fee sources good enough to publish a round result. rate-derived is the
 * venue's own fee rate applied to the fill; taker fills rarely get a reported
 * fee, and the ledger already accepts it (BUGS P2-9). */
const RESULT_FEE_SOURCES = new Set(["reported", "rate-derived"]);

/** The UP/DOWN outcome columns of one round, from the account's own state. */
export function roundOutcome(round: { upTokenId: string; downTokenId: string },
  state: Pick<CoreState, "positions" | "orders" | "fills"> | undefined) {
  const tokens = new Set([round.upTokenId, round.downTokenId]);
  const positions = (state?.positions ?? []).filter(position => tokens.has(position.tokenId));
  const costUsd = positions.reduce((total, position) => total + position.costUsd, 0);
  const reservedUsd = (state?.orders ?? []).filter(order => tokens.has(order.tokenId))
    .reduce((total, order) => total + order.reservedUsd, 0);
  const fills = (state?.fills ?? []).filter(fill => tokens.has(fill.tokenId) && fill.status !== "FAILED");
  const coveredHoldings = [...tokens].every(token => Math.abs(
    (positions.find(position => position.tokenId === token)?.shares ?? 0)
    - fills.filter(fill => fill.tokenId === token).reduce((shares, fill) => shares + (fill.direction === "BUY" ? fill.shares : -fill.shares), 0)) < 1e-8);
  const feesVerified = coveredHoldings
    && fills.every(fill => RESULT_FEE_SOURCES.has(fill.feeSource ?? "") && fill.status === "CONFIRMED");
  const upShares = positions.find(position => position.tokenId === round.upTokenId)?.shares ?? 0;
  const downShares = positions.find(position => position.tokenId === round.downTokenId)?.shares ?? 0;
  // Core cost basis already includes fill fees. Do not subtract them twice.
  return { costUsd, reservedUsd, upShares, downShares, feesVerified,
    netIfUpUsd: feesVerified ? upShares - costUsd : null,
    netIfDownUsd: feesVerified ? downShares - costUsd : null,
    resultScope: "account_market", resultReason: feesVerified ? null : "成交或实际费用尚待确认" };
}

/** Recent rounds a status line always carries. The ledger shows rounds[-8:]
 * (scripts/dashboard/ledger.py _strategy_projection), so keep at least that. */
export const STATUS_RECENT_ROUNDS = 8;

/** Bound what one platform_status line carries (BUGS P0-3). Every 2 s the engine
 * wrote ALL rounds and every market it had ever seen; none were pruned, so the
 * line grew until the ledger (256 KB per read) and then the journal (1 MB
 * critical write) rejected it and the engine stopped, on every later start too.
 *
 * Keep the current round, the most recent rounds, and anything still needing
 * work (an active order or an unsettled position). This trims the LINE only: the
 * strategy's own state and settlementRecoveryCandidates still see every round,
 * so no pending redemption is ever dropped. */
export function summaryView<R extends { marketId: string }, M extends { id: string; endsAt: number }>(input: {
  rounds: R[]; currentRound?: R | null; markets: M[]; now: number; needsWork: (marketId: string) => boolean;
}): { rounds: R[]; markets: M[] } {
  const recent = new Set(input.rounds.slice(-STATUS_RECENT_ROUNDS).map(round => round.marketId));
  if (input.currentRound) recent.add(input.currentRound.marketId);
  const keepRound = (round: R) => recent.has(round.marketId) || input.needsWork(round.marketId);
  const rounds = input.rounds.filter(keepRound);
  const keptRoundIds = new Set(rounds.map(round => round.marketId));
  // A market stays while it is live or upcoming, or while its round is kept.
  const markets = input.markets.filter(market => market.endsAt > input.now
    || keptRoundIds.has(market.id) || input.needsWork(market.id));
  return { rounds, markets };
}

/** Should this settlement pass look at the market at all? Not before it ends,
 * and never again once this process saw it terminal or confirmed: a confirmed
 * market re-settled every 15 s answered from its record, but each answer ran a
 * full account recovery whose account_recovery_started reset the strategy's
 * quote baselines, 160 times in one live run (BUGS P2-23). */
export function settlementPassWants(market: { id: string; endsAt: number }, now: number,
  done: { has(marketId: string): boolean }): boolean {
  return market.endsAt <= now && !done.has(market.id);
}

/** An error message safe for the journal and the console: bounded, and never a
 * secret. Anything mentioning a credential, or carrying a 64-hex string that
 * could be a private key, is replaced. Undefined when there is no message. */
export function safeErrorMessage(message: string | undefined): string | undefined {
  const value = String(message ?? "").slice(0, 500);
  if (!value) return undefined;
  if (/secret|token|passphrase|password|private[ _-]?key|api[ _-]?key|mnemonic|diagnostic stdout/i.test(value)) {
    return "sensitive provider error";
  }
  return value.replace(/(0x)?[0-9a-fA-F]{64}/g, "<redacted-64hex>");
}

/** How long an ended round stays in the state file after it is fully done. A
 * late venue frame for a trade arrives within seconds; an hour is ample. */
export const SETTLED_HISTORY_KEEP_SEC = 3_600;

/** Delete rounds that are completely finished from the persisted state (BUGS
 * P0-3, the state half). Every round, market, order and fill used to stay in
 * the state file forever: 28 rounds and 100 KB after one day, restored and
 * re-validated on every start. A round is deleted only when nothing about it
 * can still matter: ended over an hour ago, no live or unreconciled order, no
 * unsettled fill, no position, and, if it traded, a confirmed settlement.
 * History lives in the journals and the ledger, not here. */
export function pruneSettledHistory(state: CoreState, settlementRecords: Record<string, unknown>, now: number,
  keepSec = SETTLED_HISTORY_KEEP_SEC): { state: CoreState; settlementRecords: Record<string, unknown> } {
  const confirmed = new Set(Object.values(settlementRecords).flatMap(raw => {
    const record = raw as { status?: unknown; assetId?: unknown; marketId?: unknown; roundId?: unknown };
    return record?.status === "confirmed" ? [JSON.stringify([record.assetId, record.marketId, record.roundId])] : [];
  }));
  const strategy = state.strategyStates?.["btc-reversal"] as BtcReversalState | undefined;
  const liveStatuses = ["CREATED", "SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"];
  const dead = new Set<string>();
  for (const market of state.markets ?? []) {
    if (market.endsAt > now - keepSec) continue;
    const tokens = new Set(market.instruments.map(instrument => instrument.tokenId));
    const round = strategy?.rounds.find(item => item.marketId === market.id);
    if (round?.stages.some(stage => liveStatuses.includes(stage.status))) continue;
    if (state.orders.some(order => tokens.has(order.tokenId)
      && (liveStatuses.includes(order.status) || order.reconciliationPending))) continue;
    if (state.fills.some(fill => tokens.has(fill.tokenId) && fill.status && !["CONFIRMED", "FAILED"].includes(fill.status))) continue;
    if (state.positions.some(position => tokens.has(position.tokenId) && position.shares > 0)) continue;
    const traded = state.fills.some(fill => tokens.has(fill.tokenId) && fill.status !== "FAILED")
      || round?.stages.some(stage => stage.filledShares > 0) === true;
    if (traded && !confirmed.has(JSON.stringify([market.assetId ?? "btc", market.id, market.roundId]))) continue;
    dead.add(market.id);
  }
  const deadMarkets = (state.markets ?? []).filter(market => dead.has(market.id));
  const deadTokens = new Set(deadMarkets.flatMap(market => market.instruments.map(instrument => instrument.tokenId)));
  // A confirmed record lives exactly as long as its round: deleted for a round
  // the engine kept, it would be settled again on the next start; kept for a
  // round the state no longer has, nothing can ever read it.
  const keptKeys = new Set((state.markets ?? []).filter(market => !dead.has(market.id))
    .map(market => JSON.stringify([market.assetId ?? "btc", market.id, market.roundId])));
  const keptRecords = Object.fromEntries(Object.entries(settlementRecords).filter(([key, raw]) =>
    (raw as { status?: unknown })?.status !== "confirmed" || keptKeys.has(key)));
  if (dead.size === 0) return { state, settlementRecords: keptRecords };
  return { settlementRecords: keptRecords, state: {
    ...state,
    markets: (state.markets ?? []).filter(market => !dead.has(market.id)),
    orders: state.orders.filter(order => !deadTokens.has(order.tokenId)),
    fills: state.fills.filter(fill => !deadTokens.has(fill.tokenId)),
    strategyStates: strategy ? { ...state.strategyStates,
      "btc-reversal": { ...strategy, rounds: strategy.rounds.filter(round => !dead.has(round.marketId)) } }
      : state.strategyStates,
  } };
}

/** Does this closed market count toward --max-rounds? Only a round that began at
 * or after the run started can have been traded: the strategy admits a round only
 * when it is discovered before it starts (btc-reversal discover: now <= startsAt),
 * parks the round already running at startup as waiting_next_round, and old
 * markets restored for settlement recovery ended before the run (BUGS P1-9). */
export function countsTowardRoundLimit(market: Pick<MarketInfo, "startsAt">, runStartedAtSec: number,
  strategyParked?: boolean): boolean {
  // The strategy's own verdict wins when known: a round it parked as
  // waiting_next_round was never tradeable, even if it started a moment after
  // the process did (its boundary passed before discovery finished).
  if (strategyParked === true) return false;
  return market.startsAt >= runStartedAtSec;
}

/** Identify ended traded rounds that still need the idempotent settlement adapter. */
export function settlementRecoveryCandidates(
  strategyState: unknown,
  settlementState: unknown,
  now: number,
): SettlementRecoveryCandidate[] {
  const candidates = new Map<string, SettlementRecoveryCandidate>();
  const add = (candidate: SettlementRecoveryCandidate) => {
    if (!candidate.marketId || !/^\d+$/.test(candidate.roundId)
      || !Number.isSafeInteger(Number(candidate.roundId))
      || Number(candidate.roundId) % MARKET_WINDOW_SEC !== 0
      || now < Number(candidate.roundId) + MARKET_WINDOW_SEC
      || candidate.tokenIds.length !== 2 || new Set(candidate.tokenIds).size !== 2) return;
    candidates.set(JSON.stringify([candidate.assetId, candidate.marketId, candidate.roundId]), candidate);
  };
  const strategy = strategyState && typeof strategyState === "object"
    ? strategyState as { rounds?: unknown } : undefined;
  for (const rawRound of Array.isArray(strategy?.rounds) ? strategy!.rounds : []) {
    if (!rawRound || typeof rawRound !== "object") continue;
    const round = rawRound as { assetId?: unknown; marketId?: unknown; roundId?: unknown;
      upTokenId?: unknown; downTokenId?: unknown; stages?: unknown };
    if (typeof round.marketId !== "string" || typeof round.roundId !== "string"
      || typeof round.assetId !== "string" || typeof round.upTokenId !== "string"
      || typeof round.downTokenId !== "string" || !Array.isArray(round.stages)) continue;
    const traded = round.stages.some(stage => stage && typeof stage === "object"
      && (Number((stage as { filledShares?: unknown }).filledShares) > 0
        || ["PARTIAL", "FILLED"].includes(String((stage as { status?: unknown }).status))));
    if (!traded) continue;
    add({ assetId: round.assetId as AssetId, marketId: round.marketId, roundId: round.roundId,
      tokenIds: [round.upTokenId, round.downTokenId] });
  }
  const records = settlementState && typeof settlementState === "object"
    ? (settlementState as { records?: unknown }).records : undefined;
  const settlementRecords = records && typeof records === "object" ? Object.values(records) : [];
  const terminal = settlementRecords.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const record = raw as { status?: unknown; assetId?: unknown; marketId?: unknown; roundId?: unknown; tokenIds?: unknown };
    if (!(record.status === "confirmed"
      && typeof record.marketId === "string" && Array.isArray(record.tokenIds))) return [];
    return [{ assetId: typeof record.assetId === "string" ? record.assetId : undefined,
      marketId: record.marketId, roundId: typeof record.roundId === "string" ? record.roundId : undefined,
      tokenIds: record.tokenIds.filter((token): token is string => typeof token === "string") }];
  });
  for (const raw of settlementRecords) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as { status?: unknown; assetId?: unknown; marketId?: unknown; roundId?: unknown; tokenIds?: unknown };
    if (record.status !== "prepared" && record.status !== "submitted") continue;
    if (typeof record.marketId !== "string" || !Array.isArray(record.tokenIds)) continue;
    const tokenIds = record.tokenIds.filter((token): token is string => typeof token === "string");
    if (tokenIds.length !== record.tokenIds.length) continue;
    const roundId = typeof record.roundId === "string" ? record.roundId : undefined;
    const assetId = typeof record.assetId === "string" ? record.assetId : "btc";
    const candidateRound = roundId ?? [...candidates.values()].find(candidate => candidate.marketId === record.marketId
      && candidate.assetId === assetId
      && candidate.tokenIds.every(token => tokenIds.includes(token)))?.roundId;
    if (!candidateRound) continue;
    add({ assetId: assetId as AssetId, marketId: record.marketId, roundId: candidateRound,
      tokenIds });
  }
  return [...candidates.values()].filter(candidate => !terminal.some(record =>
    record.marketId === candidate.marketId
    && (record.assetId === undefined || record.assetId === candidate.assetId)
    && (record.roundId === undefined || record.roundId === candidate.roundId)
    && record.tokenIds.length === candidate.tokenIds.length
    && record.tokenIds.every(token => candidate.tokenIds.includes(token))));
}

const TERMINAL_SETTLEMENT_REASONS = new Set([
  "settlement_asset_identity_missing", "settlement_round_identity_missing", "settlement_invalid_token_id",
  "settlement_asset_identity_changed", "settlement_round_identity_changed", "settlement_token_identity_changed",
  "settlement_market_identity_changed", "settlement_market_token_mismatch_or_unsupported_protocol",
  "settlement_transaction_reverted", "settlement_receipt_balance_or_payout_mismatch",
  "settlement_invalid_payout_vector", "neg_risk_redemption_not_supported_by_this_sender",
]);

/** Distinguish durable failure/identity errors from market data that can appear later. */
export function isTerminalSettlementResult(result: Pick<SettlementResult, "state" | "reason" | "transactionId">): boolean {
  if (result.state !== "unsupported") return false;
  const reason = result.reason ?? "";
  return result.transactionId !== undefined || TERMINAL_SETTLEMENT_REASONS.has(reason)
    || reason === "settlement_failed" || reason.startsWith("settlement_relayer_");
}

export function settlementFailureCode(reason: string | undefined): string {
  return reason && /^[a-z0-9_.-]{1,120}$/i.test(reason) ? reason : "settlement_terminal_failure";
}

/**
 * Bound a cleanup operation without losing its eventual rejection. The
 * underlying request still has its own venue/network timeout, but shutdown
 * must continue once this stage's deadline is reached.
 */
export function waitForShutdownStage<T>(operation: Promise<T> | undefined, timeoutMs: number, label: string): Promise<T | undefined> {
  if (!operation) return Promise.resolve(undefined);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error(`${label}_timeout`));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`${label}_timeout`));
    }, timeoutMs);
    operation.then(
      value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); },
      error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); },
    );
  });
}

function isShutdownTimeout(error: unknown, label: string): boolean {
  return error instanceof Error && error.message === `${label}_timeout`;
}

export interface PlatformCliOptions {
  mode: TradingMode;
  limits: HardLimits;
  durationSec: number;
  /** Stop after this many rounds have closed. 0 disables. Preferred over
   * durationSec: rounds are 5 minutes wide, so a minute count can cut off mid
   * round and abandon a position it just opened. */
  maxRounds: number;
  timerMs: number;
  statusSec: number;
  stateFile: string;
  journalFile?: string;
  stopFile?: string;
  controlFile?: string;
  marketsFile?: string;
  expectedMarketIdentity?: { marketId: string; roundId: string };
  strategy?: "btc-reversal";
  strategyConfigFile?: string;
  referenceFeed: boolean;
  assetId: AssetId;
}

class CliInputError extends Error {}
const SUPPORTED_ASSETS = new Set<AssetId>(["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"]);
const parseAsset = (value: unknown): AssetId => {
  const asset = String(value ?? "btc").trim().toLowerCase();
  if (!SUPPORTED_ASSETS.has(asset as AssetId)) throw new CliInputError(`unsupported --asset ${asset}; choose one of ${[...SUPPORTED_ASSETS].join(", ")}`);
  return asset as AssetId;
};
const positive = (value: unknown, flag: string): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new CliInputError(`${flag} must be a finite positive number`);
  return number;
};

export function parsePlatformOptions(argv: string[]): PlatformCliOptions | undefined {
  const command = new Command()
    .name("trading-platform")
    .description("Live Polymarket five-minute reversal trading service")
    .exitOverride()
    .option("--live", "Use authenticated REAL trading services; required and never enabled by environment variables")
    .option("--strategy <name>", "Built-in strategy: btc-reversal")
    .option("--strategy-config <path>", "Persisted strategy configuration JSON")
    .option("--asset <symbol>", "Selected market asset: btc, eth or sol", "btc")
    .option("--markets <path>", "JSON MarketInfo[] file; defaults to current selected-asset binary market discovery")
    .option("--expected-market-id <id>", "Require the initially discovered market id to match the start request")
    .option("--expected-round-id <round>", "Require the initially discovered round id to match the start request")
    .option("--capital-usd <number>", "Optional capital ceiling; live always respects actual available funds")
    .option("--daily-loss-usd <number>", "Optional daily loss stop; omitted disables this stop")
    .option("--order-usd <number>", "Maximum order notional (defaults to capital ceiling)")
    .option("--max-open-orders <number>", "Shared active-order count ceiling", "100")
    .option("--duration-sec <number>", "Stop after this many seconds; 0 runs until an operator signal", "300")
    .option("--max-rounds <number>", "Stop once this many rounds have closed; 0 disables", "0")
    .option("--timer-ms <number>", "Strategy timer event interval; feed events remain immediate", "1000")
    .option("--status-sec <number>", "JSON status output interval", "30")
    .option("--state-file <path>", "Durable state and exclusive lock file")
    .option("--journal-file <path>", "Append pure JSONL platform status and execution events")
    .option("--stop-file <path>", "Stop normally when this controller-owned file exists")
    .option("--control-file <path>", "Controller JSON containing paused true or false")
    .option("--reference-feed", "Subscribe to the selected asset reference feed");
  try { command.parse(argv, { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return undefined;
    throw error;
  }
  const raw = command.opts();
  const mode: TradingMode = "live";
  const assetId = parseAsset(raw.asset);
  if (raw.strategy && raw.strategy !== "btc-reversal") throw new CliInputError("unknown built-in strategy");
  // The reversal strategy is asset-agnostic: it reads triggerPrice/maxBuyPrice
  // and the paired up/down book, none of which are btc-specific. The strategy id
  // keeps its historical name for persisted state compatibility.
  if (raw.strategy === "btc-reversal" && !SUPPORTED_ASSETS.has(assetId)) {
    throw new CliInputError(`btc-reversal live trading supports ${[...SUPPORTED_ASSETS].join(", ")}`);
  }
  if (!!raw.strategy !== !!raw.strategyConfig) throw new CliInputError("--strategy requires --strategy-config and vice versa");
  if (!!raw.expectedMarketId !== !!raw.expectedRoundId) {
    throw new CliInputError("--expected-market-id and --expected-round-id must be provided together");
  }
  const expectedMarketIdentity = raw.expectedMarketId ? {
    marketId: String(raw.expectedMarketId).trim(),
    roundId: String(raw.expectedRoundId).trim(),
  } : undefined;
  if (expectedMarketIdentity && (!expectedMarketIdentity.marketId
    || !/^\d+$/.test(expectedMarketIdentity.roundId)
    || !Number.isSafeInteger(Number(expectedMarketIdentity.roundId))
    || Number(expectedMarketIdentity.roundId) % MARKET_WINDOW_SEC !== 0)) {
    throw new CliInputError("expected market identity must contain a market id and aligned five-minute round id");
  }
  const capitalUsd = positive(raw.capitalUsd ?? Number.MAX_SAFE_INTEGER, "--capital-usd");
  const dailyLossUsd = raw.dailyLossUsd == null ? null : positive(raw.dailyLossUsd, "--daily-loss-usd");
  const maxOrderUsd = positive(raw.orderUsd ?? capitalUsd, "--order-usd");
  const maxOpenOrders = positive(raw.maxOpenOrders, "--max-open-orders");
  if (!Number.isSafeInteger(maxOpenOrders)) throw new CliInputError("--max-open-orders must be a positive safe integer");
  if (maxOrderUsd > capitalUsd) throw new CliInputError("--order-usd must not exceed --capital-usd");
  const durationSec = Number(raw.durationSec);
  if (!Number.isFinite(durationSec) || durationSec < 0) throw new CliInputError("--duration-sec must be a finite nonnegative number");
  const maxRounds = raw.maxRounds === undefined ? 0 : Number(raw.maxRounds);
  if (!Number.isInteger(maxRounds) || maxRounds < 0) throw new CliInputError("--max-rounds must be a nonnegative integer");
  const timerMs = positive(raw.timerMs, "--timer-ms");
  const statusSec = positive(raw.statusSec, "--status-sec");
  if (durationSec * 1000 > 2_147_483_647 || timerMs > 2_147_483_647 || statusSec * 1000 > 2_147_483_647) {
    throw new CliInputError("timer intervals must fit the Node.js timer range (2147483647 ms)");
  }
  const stateFile = resolve(raw.stateFile ?? `results/platform/${mode}-state.json`);
  const journalFile = raw.journalFile ? resolve(raw.journalFile) : undefined;
  const stopFile = raw.stopFile ? resolve(raw.stopFile) : undefined;
  const controlFile = raw.controlFile ? resolve(raw.controlFile) : undefined;
  const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  if (journalFile && [stateFile, `${stateFile}.lock`, `${stateFile}.next`].some(path => pathKey(path) === pathKey(journalFile))) {
    throw new CliInputError("--journal-file must be separate from state and recovery files");
  }
  if (stopFile && [stateFile, `${stateFile}.lock`, `${stateFile}.next`, journalFile]
    .some(path => path !== undefined && pathKey(path) === pathKey(stopFile))) {
    throw new CliInputError("--stop-file must be separate from state, recovery and journal files");
  }
  if (controlFile && [stateFile, `${stateFile}.lock`, `${stateFile}.next`, journalFile, stopFile]
    .some(path => path !== undefined && pathKey(path) === pathKey(controlFile))) {
    throw new CliInputError("--control-file must be separate from state, recovery, stop and journal files");
  }
  const strategyConfigFile = raw.strategyConfig ? resolve(raw.strategyConfig) : undefined;
  if (strategyConfigFile && [stateFile, `${stateFile}.lock`, `${stateFile}.next`, `${stateFile}.settlements.json`, journalFile, stopFile, controlFile]
    .some(path => path !== undefined && pathKey(path) === pathKey(strategyConfigFile))) {
    throw new CliInputError("--strategy-config must be separate from execution state and control files");
  }
  if (raw.live !== true) throw new CliInputError("--live is required; simulated platform execution has been removed");
  return { mode, limits: { capitalUsd, dailyLossUsd, maxOrderUsd, maxOpenOrders }, durationSec, maxRounds, timerMs,
    statusSec, stateFile, journalFile, stopFile, controlFile, strategy: raw.strategy,
    strategyConfigFile,
    marketsFile: raw.markets ? resolve(raw.markets) : undefined,
    expectedMarketIdentity,
    referenceFeed: raw.referenceFeed === true, assetId };
}

/** Compare the request selector against authoritative discovery before connecting the live platform. */
export function assertInitialMarketIdentity(
  market: Pick<MarketInfo, "id" | "roundId"> | undefined,
  expected: { marketId: string; roundId: string } | undefined,
): void {
  if (!expected) return;
  if (!market || market.id !== expected.marketId || market.roundId !== expected.roundId) {
    throw new CliInputError("initial discovered market does not match requested marketId and roundId");
  }
}

/** Validate file input before any market, wallet or gateway connection. */
export function validateMarkets(input: unknown, selectedAsset: AssetId = "btc"): MarketInfo[] {
  if (!Array.isArray(input) || input.length === 0) throw new CliInputError("market list must be a nonempty MarketInfo[]");
  const marketIds = new Set<string>(), tokenIds = new Set<string>();
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  for (const candidate of input) {
    const market = candidate && typeof candidate === "object" ? candidate as MarketInfo & { asset?: unknown } : undefined;
    const marketAsset = typeof market?.assetId === "string" ? market.assetId.toLowerCase()
      : typeof market?.asset === "string" ? market.asset.toLowerCase() : selectedAsset;
    if (!market || !nonempty(market.id) || marketIds.has(market.id) || !nonempty(market.name)
      || !new RegExp(`^${selectedAsset}-updown-5m(?:-|$)`, "i").test(market.name)
      || marketAsset !== selectedAsset
      || !nonempty(market.roundId) || !/^\d+$/.test(market.roundId) || market.roundId !== String(market.startsAt)
      || !number(market.startsAt) || !number(market.endsAt) || market.startsAt < 0
      || market.startsAt % MARKET_WINDOW_SEC !== 0 || market.endsAt - market.startsAt !== MARKET_WINDOW_SEC
      || !Array.isArray(market.instruments) || market.instruments.length !== 2) {
      throw new CliInputError(`each market must be a ${selectedAsset.toUpperCase()} five-minute market with unique identity, aligned timestamps and two instruments`);
    }
    marketIds.add(market.id);
    for (const instrument of market.instruments) {
      if (!instrument || !nonempty(instrument.tokenId) || tokenIds.has(instrument.tokenId)
        || instrument.marketId !== market.id || !nonempty(instrument.outcome)
        || !number(instrument.tickSize) || instrument.tickSize <= 0 || instrument.tickSize >= 1
        || !number(instrument.minOrderSize) || instrument.minOrderSize <= 0) {
        throw new CliInputError("each instrument needs a unique token, matching marketId, outcome and valid venue rules");
      }
      tokenIds.add(instrument.tokenId);
    }
  }
  return structuredClone(input).map(market => ({ ...market as MarketInfo,
    assetId: selectedAsset, referenceProducer: (market as MarketInfo).referenceProducer ?? referenceProducerForAsset(selectedAsset) }));
}

export function journalMarketIdentity(market: MarketInfo | undefined, tokenId?: string): {
  asset_id: AssetId | null; market_id: string | null; round_id: string | null; market_slug: string | null; side: string | null;
} {
  return { asset_id: market?.assetId ?? null, market_id: market?.id ?? null, round_id: market?.roundId ?? null,
    market_slug: market?.name ?? null, side: tokenId ? market?.instruments.find(instrument => instrument.tokenId === tokenId)?.outcome ?? null : null };
}

export function journalAssetId(event: Extract<TradingEvent, { kind: "order" | "fill" | "settlement" }>, fallback?: AssetId | null): AssetId | null {
  if (event.kind === "order") return event.assetId ?? event.order.assetId ?? fallback ?? null;
  if (event.kind === "fill") return event.assetId ?? event.fill.assetId ?? fallback ?? null;
  return event.result.assetId ?? fallback ?? null;
}

function readMarkets(path: string, selectedAsset: AssetId): MarketInfo[] {
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new CliInputError("--markets must refer to a readable JSON file"); }
  return validateMarkets(input, selectedAsset);
}

export interface ReversalConfigFile {
  config: BtcReversalConfig;
  dailyLossUsd: number | null;
  savedRevision: string;
}

/** Strategy revisions may tighten a run's operator ceilings, but never raise them. */
export function resolveReversalLimits(operator: Readonly<HardLimits>,
  config: Pick<BtcReversalConfig, "totalBudgetUsd" | "dailyLossUsd">): HardLimits {
  const capitalUsd = Math.min(operator.capitalUsd, config.totalBudgetUsd ?? Number.MAX_SAFE_INTEGER);
  const configuredLoss = config.dailyLossUsd ?? null;
  const dailyLossUsd = operator.dailyLossUsd == null ? configuredLoss
    : configuredLoss == null ? operator.dailyLossUsd : Math.min(operator.dailyLossUsd, configuredLoss);
  return { ...operator, capitalUsd, maxOrderUsd: Math.min(operator.maxOrderUsd, capitalUsd), dailyLossUsd };
}

export function readReversalConfig(path: string): ReversalConfigFile {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new CliInputError("--strategy-config must refer to a readable JSON file"); }
  if (!raw || raw.strategyId !== "btc-reversal" || !raw.config || typeof raw.config !== "object") {
    throw new CliInputError("strategy configuration needs strategyId btc-reversal and config");
  }
  const input = { ...raw.config as Record<string, unknown> };
  input.revision = String(input.revision ?? raw.savedRevision ?? "1");
  for (const key of ["roundBudgetUsd", "totalBudgetUsd"]) if (input[key] == null) delete input[key];
  const dailyLossUsd = input.dailyLossUsd == null ? null : positive(input.dailyLossUsd, "dailyLossUsd");
  return { config: normalizeBtcReversalConfig(input as Partial<BtcReversalConfig>), dailyLossUsd,
    savedRevision: String(raw.savedRevision ?? input.revision) };
}

export async function runPlatformCli(argv: string[]): Promise<void> {
  const options = parsePlatformOptions(argv);
  if (!options) return;
  const operatorLimits: Readonly<HardLimits> = { ...options.limits };
  const explicitMarkets = options.marketsFile ? readMarkets(options.marketsFile, options.assetId) : undefined;
  let strategy: BtcReversalStrategy | undefined;
  let reversal: BtcReversalStrategy | undefined;
  let strategyConfig = options.strategyConfigFile ? readReversalConfig(options.strategyConfigFile) : undefined;
  if (strategyConfig) {
    if (strategyConfig.config.assetId !== options.assetId) {
      throw new CliInputError(`strategy configuration asset ${strategyConfig.config.assetId} does not match selected asset ${options.assetId}`);
    }
    Object.assign(options.limits, resolveReversalLimits(operatorLimits, strategyConfig.config));
  }
  const continuousMarkets = options.strategy === "btc-reversal" && !explicitMarkets;
  let store: PlatformStore | undefined;
  let journal: PlatformJournal | undefined;
  let connection: Awaited<ReturnType<typeof connectPolymarketPlatform>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let marketTimer: ReturnType<typeof setTimeout> | undefined;
  const marketEndTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const marketEndsProcessed = new Set<string>();
  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  let discoveryPrewarmStartTimer: ReturnType<typeof setTimeout> | undefined;
  let discoveryBoundaryTimer: ReturnType<typeof setTimeout> | undefined;
  let discoveryPrewarmTimer: ReturnType<typeof setInterval> | undefined;
  let discoveryPrewarmStopTimer: ReturnType<typeof setTimeout> | undefined;
  let controlTimer: ReturnType<typeof setInterval> | undefined;
  let settlementTimer: ReturnType<typeof setInterval> | undefined;
  let settlementJob: Promise<void> | undefined;
  let drainSettlements: (() => Promise<void>) | undefined;
  const confirmedSettlements = new Set<string>();
  const settlementRecoveryMarketIds = new Set<string>();
  let discoveryJob: Promise<void> | undefined;
  const discoveryAbort = new AbortController();
  let stopFileTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let signalReason: string | undefined;
  let notifyStop: (() => void) | undefined;
  let primaryFailure: unknown;
  let phase = "initializing";
  let selectedMarkets = explicitMarkets ?? [];
  const startedAt = Date.now() / 1000;
  const knownOrders = new Map<string, OrderRecord>();
  const stopRequested = new Promise<void>(done => { notifyStop = done; });
  const requestStop = (reason: string) => {
    signalReason ??= reason;
    discoveryAbort.abort();
    notifyStop?.();
  };
  // Start the operator-visible duration window at CLI start, rather than
  // after account recovery, market discovery, and websocket setup. Startup
  // latency must not silently extend a requested live-test window.
  if (options.durationSec > 0) {
    durationTimer = setTimeout(() => requestStop("duration_elapsed"), options.durationSec * 1000);
  }
  const checkStopFile = () => {
    if (options.stopFile && existsSync(options.stopFile)) requestStop("controller_stop");
  };
  const watchMarketExpiry = () => {
    if (continuousMarkets) return;
    const lastExpiry = Math.max(...selectedMarkets.map(market => market.endsAt));
    const remainingMs = lastExpiry * 1000 - Date.now();
    if (remainingMs <= 0) { requestStop("markets_expired"); return; }
    marketTimer = setTimeout(watchMarketExpiry, Math.min(remainingMs, 2_147_483_647));
  };
  // Rounds this run could actually trade. marketEndsProcessed also holds the
  // round that was already running when we started (the strategy parks it as
  // waiting_next_round and never trades it) and old markets restored from the
  // state file for settlement recovery; counting those toward --max-rounds made
  // "run N rounds" trade at most N-1, and maxRounds=1 trade none (BUGS P1-9).
  let roundsCounted = 0;
  const scheduleMarketEnd = (market: MarketInfo) => {
    if (!continuousMarkets || signalReason || primaryFailure || marketEndsProcessed.has(market.id) || marketEndTimers.has(market.id)) return;
    const trigger = () => {
      marketEndTimers.delete(market.id);
      if (signalReason || primaryFailure) return;
      const remainingMs = market.endsAt * 1000 - Date.now();
      if (remainingMs > 0) {
        marketEndTimers.set(market.id, setTimeout(trigger, Math.min(remainingMs, 2_147_483_647)));
        return;
      }
      if (marketEndsProcessed.has(market.id) || signalReason) return;
      marketEndsProcessed.add(market.id);
      try { connection?.platform.ingest({ kind: "timer", ts: Math.max(market.endsAt, Date.now() / 1000) }); }
      catch (error) { primaryFailure ??= error; requestStop("market_end_event_failed"); }
      // Stopping after a whole number of rounds is what an operator actually
      // means by "run a few rounds". A wall-clock window cannot express it: the
      // rounds are five minutes wide, so any minute count risks cutting off mid
      // round, buying into a round that then gets abandoned. Counting closed
      // rounds also stops on a boundary, which is when the drain can finish.
      const parked = reversal?.getStatus().rounds
        .find(round => round.marketId === market.id)?.status === "waiting_next_round";
      if (countsTowardRoundLimit(market, startedAt, parked)) roundsCounted += 1;
      if (options.maxRounds > 0 && roundsCounted >= options.maxRounds) {
        requestStop("round_limit_reached");
      }
    };
    trigger();
  };
  const interrupt = () => requestStop("SIGINT");
  const terminate = () => requestStop("SIGTERM");
  const breakSignal = () => requestStop("SIGBREAK");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.once("SIGBREAK", breakSignal);
  const reportError = (errorPhase: string, code: string, extra: Record<string, unknown> = {}) => {
    const details = { phase: errorPhase, code, ...extra };
    console.error(JSON.stringify({ kind: "platform_error", ...details }));
    journal?.write("platform_error", details);
  };
  const safeEventMessage = (message: string | undefined): string => safeErrorMessage(message) ?? "platform event failed";
  const marketIdentity = (tokenId: string) => {
    const market = selectedMarkets.find(item => item.instruments.some(instrument => instrument.tokenId === tokenId));
    return journalMarketIdentity(market, tokenId);
  };
  const record = (event: TradingEvent) => {
    if (event.kind === "order") {
      const order = event.order;
      if (order.orderId) knownOrders.set(order.orderId, order);
      journal?.write("order", { client_order_id: order.clientOrderId, order_id: order.orderId ?? null,
        token_id: order.tokenId, strategy_id: order.strategyId, status: order.status,
        venue_status: order.venueStatus ?? null,
        filled_shares: order.filledShares, reserved_usd: order.reservedUsd, reserved_shares: order.reservedShares,
        price: order.price, shares: order.shares, direction: order.direction, created_at: order.createdAt,
        asset_id: journalAssetId(event, marketIdentity(order.tokenId).asset_id),
        market_id: event.marketId ?? order.marketId ?? marketIdentity(order.tokenId).market_id,
        round_id: event.roundId ?? order.roundId ?? marketIdentity(order.tokenId).round_id,
        market_slug: marketIdentity(order.tokenId).market_slug, side: marketIdentity(order.tokenId).side,
        sign_latency_ms: order.signLatencyMs ?? null, risk_metadata_latency_ms: order.riskMetadataLatencyMs ?? null,
        l2_header_latency_ms: order.l2HeaderLatencyMs ?? null, post_latency_ms: order.postLatencyMs ?? null,
        response_headers_latency_ms: order.responseHeadersLatencyMs ?? null,
        response_body_latency_ms: order.responseBodyLatencyMs ?? null,
        failure_phase: order.failurePhase ?? null, ack_latency_ms: order.ackLatencyMs ?? null,
        total_ack_latency_ms: order.totalLatencyMs ?? null,
        venue_status_source: order.venueStatusSource ?? null,
        venue_status_at: order.venueStatusAt ?? null,
        venue_status_latency_ms: order.venueStatusLatencyMs ?? null,
        venue_status_after_ack_latency_ms: order.venueStatusAfterAckLatencyMs ?? null,
        cancellation_source: order.cancellationSource ?? null,
        trigger_to_post_latency_ms: order.triggerToPostLatencyMs ?? null,
        decision_to_post_latency_ms: order.decisionToPostLatencyMs ?? null,
        reaction_latency_ms: order.reactionLatencyMs ?? null,
        durable_commit_latency_ms: order.durableCommitLatencyMs ?? null,
        cancel_requested_at: order.cancelRequestedAt ?? null, cancel_ack_at: order.cancelAckAt ?? null,
        cancel_ack_latency_ms: order.cancelAckLatencyMs ?? null,
        updated_at: order.updatedAt });
    } else if (event.kind === "fill") {
      const fill = event.fill;
      const order = knownOrders.get(fill.orderId) ?? connection?.platform.orders.get(fill.orderId);
      journal?.write("fill", { trade_id: fill.tradeId, order_id: fill.orderId, token_id: fill.tokenId,
        strategy_id: order?.strategyId ?? null, price: fill.price, shares: fill.shares,
        fee: fill.feeUsd, fee_source: fill.feeSource ?? null, trade_status: fill.status ?? "CONFIRMED",
        is_maker: fill.isMaker, direction: fill.direction,
        asset_id: journalAssetId(event, order?.assetId ?? marketIdentity(fill.tokenId).asset_id),
        market_id: event.marketId ?? fill.marketId ?? order?.marketId ?? marketIdentity(fill.tokenId).market_id,
        round_id: event.roundId ?? fill.roundId ?? order?.roundId ?? marketIdentity(fill.tokenId).round_id,
        market_slug: marketIdentity(fill.tokenId).market_slug, side: marketIdentity(fill.tokenId).side,
        created_at: fill.ts, engine_ts: fill.ts }, `fill:${JSON.stringify([fill.tradeId, fill.orderId])}${fill.status ? `:${fill.status}:${fill.feeSource ?? "estimate"}:${fill.feeUsd}` : ""}`);
    } else if (event.kind === "latency") {
      const fields = { metric: event.metric, duration_ms: event.durationMs,
        market_id: event.marketId ?? null, token_id: event.tokenId ?? null,
        strategy_id: event.strategyId ?? null, client_order_id: event.clientOrderId ?? null,
        order_id: event.orderId ?? null, outcome: event.outcome ?? null, engine_ts: event.ts };
      if (BEST_EFFORT_LATENCY_METRICS.has(event.metric)) journal?.writeTelemetry("latency", fields);
      else journal?.write("latency", fields);
    } else if (event.kind === "error") {
      if (event.code === "order_abandoned") {
        journal?.write("order_abandoned", { client_order_id: event.clientOrderId ?? null,
          order_id: event.orderId ?? null, strategy_id: event.strategyId ?? null, message: event.message });
      } else {
        reportError("event", event.code ?? "platform_event_failed", {
          strategy_id: event.strategyId ?? null, client_order_id: event.clientOrderId ?? null,
          order_id: event.orderId ?? null, market_id: event.marketId ?? null,
          message: safeEventMessage(event.message),
        });
      }
    } else if (event.kind === "stopped") {
      journal?.write("platform_stopped", { reason: signalReason ?? "run_complete" });
    } else if (event.kind === "settlement") {
      const market = selectedMarkets.find(item => item.id === event.result.marketId);
      journal?.write("platform_settlement", { asset_id: journalAssetId(event, market?.assetId),
        market_id: event.result.marketId, round_id: event.result.roundId ?? market?.roundId ?? null,
        created_at: Date.now() / 1000, market_slug: market?.name ?? null,
        state: event.result.state, reason: event.result.reason ?? null,
        transaction_id: event.result.transactionId ?? null,
        payout_verified: event.result.payoutVerified === true, payout_proof: event.result.payoutProof ?? null,
        credited_usd: event.result.creditedUsd ?? null, expected_payout_usd: event.result.expectedPayoutUsd ?? null,
        cash_before_usd: event.result.cashBeforeUsd ?? null, cash_after_usd: event.result.cashAfterUsd ?? null },
      `settlement:${JSON.stringify([event.result.marketId, event.result.roundId ?? market?.roundId ?? null,
        event.result.state, event.result.transactionId ?? null])}`);
    }
  };
  const summary = (status: "starting" | "running" | "stopped" | "failed") => {
    const platform = connection?.platform;
    const state = platform?.account.current();
    const now = Date.now() / 1000;
    const allMarkets = platform?.market.list() ?? selectedMarkets;
    const currentMarket = allMarkets
      .filter(market => market.startsAt <= now && now < market.endsAt)
      .sort((left, right) => right.startsAt - left.startsAt)[0];
    const strategyStatus = reversal?.getStatus();
    const enrichRound = (round: NonNullable<typeof strategyStatus>["rounds"][number]) => ({
      ...round, ...roundOutcome(round, state) });
    // A market still needs work while it has an active or reconciliation-pending
    // order, an unsettled position, or a non-terminal fill. Such markets stay in
    // the status line no matter how old (BUGS P0-3).
    const tokenMarket = new Map<string, string>();
    for (const market of allMarkets) {
      for (const instrument of market.instruments) tokenMarket.set(instrument.tokenId, market.id);
    }
    const workMarkets = new Set<string>();
    for (const order of state?.orders ?? []) {
      if (["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status) || order.reconciliationPending) {
        const id = tokenMarket.get(order.tokenId); if (id) workMarkets.add(id);
      }
    }
    for (const position of state?.positions ?? []) {
      if (position.shares > 0) { const id = tokenMarket.get(position.tokenId); if (id) workMarkets.add(id); }
    }
    for (const fill of state?.fills ?? []) {
      if (fill.status && !["CONFIRMED", "FAILED"].includes(fill.status)) {
        const id = tokenMarket.get(fill.tokenId); if (id) workMarkets.add(id);
      }
    }
    for (const id of settlementRecoveryMarketIds) workMarkets.add(id);
    const view = summaryView({
      rounds: strategyStatus?.rounds ?? [], currentRound: strategyStatus?.currentRound ?? null,
      markets: allMarkets, now, needsWork: marketId => workMarkets.has(marketId),
    });
    const viewMarketIds = new Set(view.markets.map(market => market.id));
    const viewTokens = new Set(view.markets.flatMap(market => market.instruments.map(instrument => instrument.tokenId)));
    const strategyRuntime = strategyStatus ? { ...strategyStatus,
      rounds: view.rounds.map(enrichRound),
      currentRound: strategyStatus.currentRound ? enrichRound(strategyStatus.currentRound) : null } : null;
    const runtime = { schemaVersion: 1, engine: "platform", execution: strategy ? "strategy" : "observation",
      strategy_id: strategy?.id ?? null, status, mode: options.mode, started_at: startedAt,
      cash_usd: state?.cashUsd ?? null, positions_count: state?.positions.length ?? null,
      positions: state?.positions ?? [],
      orders_count: state?.orders.length ?? null,
      // A quarantined UNKNOWN is temporarily isolated; recovery can abandon it
      // locally after a complete account and trade read proves it is absent.
      // Do not present that uncertainty as an active venue order.
      active_orders: state ? countActiveOrders(state) : null,
      fills_count: state?.fills.length ?? null, risk: state?.risk ?? null, limits: options.limits,
      cash_flow_coverage: state?.cashFlowTracking ? {
        from: state.cashFlowTracking.baselineAt, until: state.cashFlowTracking.coveredThroughAt ?? null,
        from_block: state.cashFlowTracking.baselineBlock ?? null, cursor_block: state.cashFlowTracking.cursorBlock ?? null,
        complete: state.cashFlowTracking.complete, reason: state.cashFlowTracking.reason ?? null,
        applied_count: state.cashFlowTracking.appliedFlows.length,
      } : null,
      strategy_runtime: strategyRuntime,
      journal: journal?.stats() ?? null,
      saved_revision: strategyConfig?.savedRevision ?? null,
      markets: view.markets,
      current_market: currentMarket ? {
        marketId: currentMarket.id, roundId: currentMarket.roundId, assetId: currentMarket.assetId ?? options.assetId,
        name: currentMarket.name, startsAt: currentMarket.startsAt, endsAt: currentMarket.endsAt,
      } : null,
      current_market_id: currentMarket?.id ?? null,
      current_round_id: currentMarket?.roundId ?? null,
      // This is the accepted paired snapshot projection. It is cloned by the
      // platform API and is not rebuilt from legacy single-token books.
      snapshots: (platform?.market.snapshots() ?? []).filter(snapshot => viewMarketIds.has(snapshot.marketId ?? "")),
      books: (platform?.market.books() ?? []).filter(book => viewTokens.has(book.tokenId)).map(book => {
        const receivedAt = book.receivedAt ?? book.ts;
        const ageMs = Number.isFinite(receivedAt) ? Math.max(0, (now - receivedAt) * 1000) : null;
        const market = selectedMarkets.find(item => item.instruments.some(instrument => instrument.tokenId === book.tokenId));
        const expired = market ? now >= market.endsAt : true;
          return { ...book, bids: book.bids?.slice(0, 10), asks: book.asks?.slice(0, 10),
          received_age_ms: ageMs, market_expired: expired,
          stale: expired || ageMs === null || ageMs > 10_000 || receivedAt > now + 1 };
      }) };
    journal?.write("platform_status", { runtime });
    console.log(JSON.stringify({ kind: "platform_status", status, mode: options.mode,
      strategy: strategy?.id ?? null, markets: runtime.markets.map(market => market.id),
      cashUsd: runtime.cash_usd, positions: runtime.positions_count, orders: runtime.orders_count,
      activeOrders: runtime.active_orders, fills: runtime.fills_count, risk: runtime.risk,
      snapshots: runtime.snapshots,
      currentMarket: runtime.current_market,
      currentMarketId: runtime.current_market_id,
      currentRoundId: runtime.current_round_id,
      journal: runtime.journal,
      telemetry: platform?.telemetry.snapshot() ?? null, capabilities: platform?.capabilities() ?? null,
      reason: signalReason ?? null }));
  };
  try {
    phase = "journal_open";
    if (options.journalFile) journal = new PlatformJournal(options.journalFile, { onFailure: error => {
      primaryFailure ??= error; requestStop("journal_failed");
    } });
    summary("starting");
    checkStopFile();
    if (options.stopFile) stopFileTimer = setInterval(checkStopFile, 150);
    phase = "state_open";
    store = new PlatformStore(options.stateFile);
    const loaded = store.load();
    const settlementStateFile = `${options.stateFile}.settlements.json`;
    const settlementFile = existsSync(settlementStateFile)
      ? JSON.parse(readFileSync(settlementStateFile, "utf8")) as { records?: Record<string, unknown> } : undefined;
    const pruned = loaded && pruneSettledHistory(loaded, settlementFile?.records ?? {}, Date.now() / 1000);
    const restored = pruned?.state;
    if (settlementFile && pruned
      && Object.keys(pruned.settlementRecords).length !== Object.keys(settlementFile.records ?? {}).length) {
      // Written before the settlement adapter opens the file, the only other writer.
      writeFileSync(`${settlementStateFile}.tmp`, JSON.stringify({ ...settlementFile, records: pruned.settlementRecords }),
        { mode: 0o600 });
      renameSync(`${settlementStateFile}.tmp`, settlementStateFile);
    }
    if (strategyConfig) {
      reversal = createBtcReversalStrategy(strategyConfig.config, {
        restoredState: restored?.strategyStates?.["btc-reversal"] as BtcReversalState | undefined,
        persist: state => connection?.platform.core.setStrategyState("btc-reversal", state),
      });
      const onEvent = reversal.onEvent.bind(reversal);
      reversal.onEvent = (event, context) => {
        // Shutdown is local to this run. Do not persist it as an operator
        // pause, or the next run would inherit a permanent admission lock.
        // Still record order/fill/settlement evidence though: short-circuiting
        // before onEvent left a fill that landed in the shutdown window out of
        // the stage ledger, so the round reported filledShares: 0 and
        // currentRunMarketIds() excluded it — the drain then skipped the very
        // round whose capital was just committed. Suppress the actions, not the
        // bookkeeping.
        if (signalReason || primaryFailure) {
          if (["order", "fill", "settlement"].includes(event.kind)) onEvent(event, context);
          return [];
        }
        const actions = onEvent(event, context);
        const active = reversal!.exportState().rounds.find(round => round.startsAt <= context.now && context.now < round.endsAt);
        const limits = resolveReversalLimits(operatorLimits, active?.config ?? strategyConfig!.config);
        if (connection && (options.limits.dailyLossUsd !== limits.dailyLossUsd || options.limits.capitalUsd !== limits.capitalUsd
          || options.limits.maxOrderUsd !== limits.maxOrderUsd)) {
          connection.platform.core.updateLimits(limits);
          Object.assign(options.limits, limits);
        }
        return actions;
      };
      strategy = reversal;
      if (options.controlFile) {
        // Dashboard starts have a fresh, per-run control path. An existing
        // pause command still wins when recovering the same run.
        let paused = false;
        if (existsSync(options.controlFile)) {
          const control = JSON.parse(readFileSync(options.controlFile, "utf8"));
          if (typeof control.paused !== "boolean") throw new CliInputError("invalid pause control");
          paused = control.paused;
        }
        reversal.setPaused(paused);
      }
    }
    phase = "market_discovery";
    const markets = explicitMarkets ?? validateMarkets(await discoverMarket(options.assetId, undefined, false, discoveryAbort.signal), options.assetId);
    assertInitialMarketIdentity(markets[0], options.expectedMarketIdentity);
    if (continuousMarkets && restored?.markets) {
      const settlementState = existsSync(settlementStateFile)
        ? JSON.parse(readFileSync(settlementStateFile, "utf8")) as unknown : undefined;
      const settlementCandidates = reversal
        ? settlementRecoveryCandidates(reversal.exportState(), settlementState, Date.now() / 1000) : [];
      const unsettledTokens = new Set([
        ...restored.orders.filter(order => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)
          || order.reconciliationPending).map(order => order.tokenId),
        ...restored.fills.filter(fill => fill.status && !["CONFIRMED", "FAILED"].includes(fill.status)).map(fill => fill.tokenId),
        ...restored.positions.filter(position => position.shares > 0).map(position => position.tokenId),
      ]);
      for (const previous of restored.markets) {
        if ((previous.assetId ?? "btc") !== options.assetId) continue;
        const tokenIds = previous.instruments.map(instrument => instrument.tokenId);
        const hasUnsettledActivity = previous.instruments.some(instrument => unsettledTokens.has(instrument.tokenId));
        const needsSettlementRecovery = settlementCandidates.some(candidate => candidate.assetId === (previous.assetId ?? "btc")
          && candidate.marketId === previous.id && candidate.roundId === previous.roundId
          && candidate.tokenIds.length === tokenIds.length && candidate.tokenIds.every(token => tokenIds.includes(token)));
        if (needsSettlementRecovery) settlementRecoveryMarketIds.add(previous.id);
        if (!markets.some(market => market.id === previous.id) && (hasUnsettledActivity || needsSettlementRecovery)) {
          markets.push(previous);
        }
      }
    }
    selectedMarkets = markets;
    watchMarketExpiry();
    if (!signalReason) {
      phase = "platform_connect";
      const settle = options.mode === "live" && reversal
        ? await (await import("../platform/live-settlement.js")).createLiveSettlementAdapter({ stateFile: `${options.stateFile}.settlements.json` })
        : undefined;
      const referenceFeeds = options.referenceFeed ? (() => {
        const module = referenceFeedModule as typeof referenceFeedModule & {
          referenceFeedCapability?: (asset: string) => { supported: boolean; reason?: string };
          runReferenceFeed?: (sink: (event: import("../live/feeds/index.js").FeedEvent) => void, asset: string) => { stop: () => void };
        };
        const capability = module.referenceFeedCapability?.(options.assetId)
          ?? (options.assetId === "btc" ? { supported: true } : { supported: false, reason: "asset_reference_feed_unavailable" });
        if (!capability.supported) throw new CliInputError(`reference feed unavailable for ${options.assetId}: ${capability.reason}`);
        const runner = module.runReferenceFeed
          ?? (options.assetId === "btc" ? (sink: (event: import("../live/feeds/index.js").FeedEvent) => void) => referenceFeedModule.runBtcFeed(sink) : undefined);
        if (!runner) throw new CliInputError(`reference feed producer unavailable for ${options.assetId}`);
        return { [options.assetId]: (sink: (event: import("../live/feeds/index.js").FeedEvent) => void, _asset: AssetId) => runner(sink, options.assetId) };
      })() : undefined;
      connection = await connectPolymarketPlatform({ mode: options.mode, markets, limits: options.limits,
        restored, persist: (state, critical) => store!.save(state, critical),
        deferPersistence: () => store!.defer(),
        persistPreparedOrder: order => store!.savePreparedOrder(order),
        settle,
        // Before connection resolution the adapter records initialization;
        // afterwards the subscription includes publish-only plugin/settlement events.
        record: event => { if (!connection) record(event); },
        durationSec: options.durationSec === 0 ? Infinity : options.durationSec, referenceFeed: options.referenceFeed,
        assetId: options.assetId, referenceFeeds });
      unsubscribe = connection.platform.subscribe(record);
      if (reversal) connection.platform.core.setStrategyState("btc-reversal", reversal.exportState());
    }
    if (connection && !signalReason) {
      if (strategy) {
        connection.platform.attach(strategy);
      }
      phase = "feed_start";
      await connection.start();
    }
    if (connection && !signalReason) {
      phase = "running";
      if (continuousMarkets) {
        for (const market of selectedMarkets) scheduleMarketEnd(market);
        const discover = (target?: number, directOnly = false): Promise<void> => {
          if (discoveryJob || signalReason) return discoveryJob ?? Promise.resolve();
          discoveryJob = (async () => {
            const now = Date.now() / 1000;
            const nextBoundary = target ?? (Math.floor(now / MARKET_WINDOW_SEC) + 1) * MARKET_WINDOW_SEC;
            const candidates = target == null
              ? await Promise.allSettled([
                discoverMarket(options.assetId, now, false, discoveryAbort.signal),
                discoverMarket(options.assetId, nextBoundary, false, discoveryAbort.signal),
              ])
              : await Promise.allSettled([discoverMarket(options.assetId, nextBoundary, directOnly, discoveryAbort.signal)]);
            if (signalReason || primaryFailure) return;
            for (const result of candidates) {
              if (signalReason || primaryFailure) return;
              if (result.status !== "fulfilled") continue;
              const fresh = result.value.filter(market => market.endsAt > now && !selectedMarkets.some(old => old.id === market.id));
              if (fresh.length) {
                if (signalReason || primaryFailure) return;
                await connection!.addMarkets(validateMarkets(fresh, options.assetId), discoveryAbort.signal);
                for (const market of fresh) scheduleMarketEnd(market);
                selectedMarkets = connection!.platform.market.list();
              }
            }
          })().catch(() => { if (!signalReason && !primaryFailure) reportError("market_discovery", "next_market_unavailable"); })
            .finally(() => { discoveryJob = undefined; });
          return discoveryJob;
        };
        const scheduleBoundaryDiscovery = () => {
          if (signalReason || primaryFailure) return;
          const nowMs = Date.now();
          const boundaryMs = (Math.floor(nowMs / (MARKET_WINDOW_SEC * 1000)) + 1) * MARKET_WINDOW_SEC * 1000;
          const boundaryPrepared = () => selectedMarkets.some(market =>
            market.startsAt <= boundaryMs / 1000 && boundaryMs / 1000 < market.endsAt);
          const stopPrewarm = () => {
            clearInterval(discoveryPrewarmTimer);
            discoveryPrewarmTimer = undefined;
          };
          const prewarm = () => {
            void discover(boundaryMs / 1000, true).finally(() => { if (boundaryPrepared()) stopPrewarm(); });
          };
          const beginPrewarm = () => {
            if (signalReason || primaryFailure || discoveryPrewarmTimer || boundaryPrepared()) return;
            prewarm();
            discoveryPrewarmTimer = setInterval(prewarm, DISCOVERY_PREWARM_RETRY_MS);
          };
          discoveryPrewarmStartTimer = setTimeout(beginPrewarm,
            Math.max(0, boundaryMs - DISCOVERY_PREWARM_MS - nowMs));
          discoveryBoundaryTimer = setTimeout(() => { void discover(boundaryMs / 1000, true); }, Math.max(0, boundaryMs - nowMs));
          discoveryPrewarmStopTimer = setTimeout(() => {
            stopPrewarm();
            scheduleBoundaryDiscovery();
          }, Math.max(0, boundaryMs + DISCOVERY_POST_BOUNDARY_MS - nowMs));
        };
        void discover(); discoveryTimer = setInterval(() => { void discover(); }, 15_000); scheduleBoundaryDiscovery();
      }
      if (reversal) {
        let lastConfig = JSON.stringify(strategyConfig);
        let lastPaused = reversal.exportState().paused;
        controlTimer = setInterval(() => {
          try {
            if (options.strategyConfigFile) {
              const next = readReversalConfig(options.strategyConfigFile);
              if (next.config.assetId !== options.assetId) throw new CliInputError(`strategy configuration asset ${next.config.assetId} does not match selected asset ${options.assetId}`);
              const key = JSON.stringify(next);
              if (key !== lastConfig) {
                reversal!.updateConfig(next.config); strategyConfig = next; lastConfig = key;
                journal?.write("strategy_config_saved", { saved_revision: next.savedRevision });
              }
            }
            if (options.controlFile && existsSync(options.controlFile)) {
              const control = JSON.parse(readFileSync(options.controlFile, "utf8"));
              if (typeof control.paused !== "boolean") throw new Error("invalid pause control");
              if (control.paused !== lastPaused) { reversal!.setPaused(control.paused); lastPaused = control.paused; }
            }
          } catch { reportError("strategy_control", "strategy_configuration_unavailable"); }
        }, 1000);
        if (options.mode === "live") {
          const pendingSettlements = new Set<string>();
          const terminalSettlements = new Set<string>();
          // The account snapshot also contains positions from older runs. They
          // remain visible for recovery, but must not keep this run's bounded
          // shutdown drain alive. A round that starts shortly before this run
          // is included because startup can happen after its five-minute
          // window has already opened.
          const currentRunMarketIds = () => new Set(reversal!.getStatus().rounds
            .filter(round => Number.isFinite(round.startsAt)
              && round.startsAt >= startedAt - MARKET_WINDOW_SEC
              && round.startsAt <= Date.now() / 1000
              && round.stages.some(stage => Number(stage.filledShares) > 0
                || ["PARTIAL", "FILLED"].includes(String(stage.status))))
            .map(round => round.marketId));
          const settledOrTerminal = { has: (marketId: string) =>
            terminalSettlements.has(marketId) || confirmedSettlements.has(marketId) };
          const runSettlementPass = async (draining = false) => {
            const state = connection!.platform.account.current(), now = Date.now() / 1000;
            const runMarketIds = currentRunMarketIds();
            // Redeem this run's own rounds first. The drain budget is shared with
            // historical recovery, and recovering long-dead markets must never
            // starve the round we just traded out of its only redemption pass.
            const queue = connection!.platform.market.list()
              .map(market => ({ market, mine: runMarketIds.has(market.id) }))
              .sort((left, right) => Number(right.mine) - Number(left.mine)
                || right.market.endsAt - left.market.endsAt);
            for (const { market } of queue) {
              if (!settlementPassWants(market, now, settledOrTerminal)) continue;
              // Historical recovery remains available during normal runtime,
              // but shutdown only waits for markets traded by this run.
              if (draining && !runMarketIds.has(market.id)) continue;
              const tokenIds = market.instruments.map(instrument => instrument.tokenId);
              const hasStrategyRound = reversal!.getStatus().rounds.some(round => round.marketId === market.id && round.stages.length > 0);
              if (!hasStrategyRound && !settlementRecoveryMarketIds.has(market.id)
                && !state.positions.some(position => tokenIds.includes(position.tokenId) && position.shares > 0)) continue;
              if (state.orders.some(order => tokenIds.includes(order.tokenId)
                && (["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status) || order.reconciliationPending))) continue;
              if (state.fills.some(fill => tokenIds.includes(fill.tokenId) && fill.status
                && !["CONFIRMED", "FAILED"].includes(fill.status))) continue;
              const result = await connection!.platform.settlement.redeem({ marketId: market.id, assetId: market.assetId, tokenIds });
              if (result.state === "confirmed") {
                await connection!.recoverAccount();
                confirmedSettlements.add(market.id);
                pendingSettlements.delete(market.id);
              } else if (result.state === "pending") {
                pendingSettlements.add(market.id);
              } else {
                if (isTerminalSettlementResult(result)) {
                  pendingSettlements.delete(market.id);
                  terminalSettlements.add(market.id);
                  reportError("settlement", "settlement_terminal_failure", {
                    market_id: market.id, round_id: result.roundId ?? market.roundId,
                    settlement_reason: settlementFailureCode(result.reason),
                  });
                } else pendingSettlements.add(market.id);
              }
            }
          };
          const settleEndedMarkets = (draining = false): Promise<void> | undefined => {
            if (settlementJob || (!draining && signalReason)) return settlementJob;
            settlementJob = runSettlementPass(draining).catch(() => reportError("settlement", "settlement_reconciliation_pending"))
              .finally(() => { settlementJob = undefined; });
            return settlementJob;
          };
          drainSettlements = async () => {
            // A round that ends around shutdown cannot be redeemed before it
            // ends, and an on-chain redemption then needs block confirmations.
            // Measure the budget from the last traded round's close, not from
            // the stop request, or the final round loses its only chance.
            const lastClose = Math.max(0, ...connection!.platform.market.list()
              .filter(market => currentRunMarketIds().has(market.id))
              .map(market => market.endsAt * 1000));
            const deadline = Math.max(Date.now(), lastClose) + SETTLEMENT_DRAIN_MAX_MS;
            let needsMore = true;
            while (needsMore && Date.now() < deadline) {
              const remainingMs = Math.max(1, deadline - Date.now());
              try {
                await waitForShutdownStage(settleEndedMarkets(true),
                  Math.min(SHUTDOWN_STAGE_MAX_MS, remainingMs), "settlement_pass");
              } catch (error) {
                const timeout = isShutdownTimeout(error, "settlement_pass");
                reportError("settlement", timeout ? "settlement_pass_timeout" : "settlement_pass_failed", {
                  message: safeEventMessage(error instanceof Error ? error.message : undefined),
                });
                needsMore = true;
                // One slow redeem or RPC stall used to abandon the whole
                // remaining budget, leaving the round just traded with a single
                // attempt and its winnings unredeemed. Keep retrying until the
                // deadline instead.
                const backoffMs = Math.min(SETTLEMENT_DRAIN_POLL_MS, Math.max(1, deadline - Date.now()));
                if (backoffMs <= 1) break;
                await new Promise<void>(resolveWait => setTimeout(resolveWait, backoffMs));
                continue;
              }
              const state = connection!.platform.account.current();
              const runMarketIds = currentRunMarketIds();
              needsMore = connection!.platform.market.list().some(market => {
                if (!runMarketIds.has(market.id)) return false;
                const tokenIds = new Set(market.instruments.map(instrument => instrument.tokenId));
                const hasActivity = state.positions.some(position => tokenIds.has(position.tokenId) && position.shares > 0)
                  || state.fills.some(fill => tokenIds.has(fill.tokenId) && fill.status !== "FAILED" && fill.shares > 0)
                  || state.orders.some(order => tokenIds.has(order.tokenId)
                    && (["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status) || order.reconciliationPending));
                if (terminalSettlements.has(market.id) || confirmedSettlements.has(market.id)) return false;
                if (!hasActivity && !pendingSettlements.has(market.id)) return false;
                // Keep polling an ended round while a redemption is pending;
                // a single submitted transaction is not yet a cash receipt.
                return true;
              });
              if (needsMore) {
                const waitMs = Math.min(SETTLEMENT_DRAIN_POLL_MS, Math.max(1, deadline - Date.now()));
                await new Promise<void>(resolveWait => setTimeout(resolveWait, waitMs));
              }
            }
            if (needsMore) reportError("settlement", "settlement_drain_timeout");
          };
          settleEndedMarkets(); settlementTimer = setInterval(() => { settleEndedMarkets(); }, 15_000);
        }
      }
      timer = setInterval(() => {
        try { connection!.platform.ingest({ kind: "timer", ts: Date.now() / 1000 }); }
        catch (error) { primaryFailure ??= error; requestStop("timer_event_failed"); }
      }, options.timerMs);
      statusTimer = setInterval(() => {
        try { summary("running"); }
        catch (error) { primaryFailure ??= error; requestStop("status_failed"); }
      }, options.statusSec * 1000);
      summary("running");
      await stopRequested;
    }
  } catch (error) {
    const expectedStopAbort = signalReason && error instanceof Error && error.name === "AbortError";
    if (!expectedStopAbort) {
      primaryFailure = error;
      // Keep the cause: four failed starts on 09-29 left only a phase name, and
      // RPC overload, geo check, clock skew and Gamma timeouts all looked alike (BUGS P2-7).
      reportError(phase, "platform_run_failed", { message: safeErrorMessage(error instanceof Error ? error.message : String(error)) });
    }
  } finally {
    discoveryAbort.abort();
    clearInterval(timer); clearInterval(statusTimer); clearInterval(stopFileTimer);
    clearInterval(discoveryTimer); clearInterval(controlTimer); clearInterval(settlementTimer);
    clearTimeout(discoveryPrewarmStartTimer); clearTimeout(discoveryBoundaryTimer);
    clearInterval(discoveryPrewarmTimer); clearTimeout(discoveryPrewarmStopTimer);
    clearTimeout(durationTimer); clearTimeout(marketTimer);
    for (const marketEndTimer of marketEndTimers.values()) clearTimeout(marketEndTimer);
    marketEndTimers.clear();
    // Finish any settlement pass that was already in flight before closing the
    // gateway. Pause new strategy decisions and cancel active orders first so
    // the bounded drain can submit the last round's redeem while the adapter
    // is still connected.
    try {
      await waitForShutdownStage(settlementJob, SHUTDOWN_STAGE_MAX_MS, "settlement_shutdown");
    } catch (error) {
      const timeout = isShutdownTimeout(error, "settlement_shutdown");
      if (!timeout) primaryFailure ??= error;
      reportError("shutdown", timeout ? "settlement_shutdown_timeout" : "settlement_shutdown_failed", {
        message: safeEventMessage(error instanceof Error ? error.message : undefined),
      });
    }
    if (reversal) {
      reversal.setPaused(true);
      // Each stage gets its own guard. Chained in one try, a slow cancel_all
      // skipped both the order drain and the account re-read, so the settlement
      // pass then ran against stale order state and refused to redeem anything
      // (it declines any market with a locally-active order).
      for (const [stage, work] of [
        ["cancel_all", async () => { await connection?.platform.orders.cancelAll("btc-reversal"); }],
        ["order_idle", async () => { await connection?.platform.idle(); }],
        ["account_recovery", async () => { await connection?.recoverAccount(); }],
      ] as const) {
        try {
          await waitForShutdownStage(work(), SHUTDOWN_STAGE_MAX_MS, stage);
        } catch (error) {
          const timeout = isShutdownTimeout(error, stage);
          if (!timeout) primaryFailure ??= error;
          reportError("shutdown", timeout ? `${stage}_timeout` : `${stage}_failed`, {
            message: safeEventMessage(error instanceof Error ? error.message : undefined),
          });
        }
      }
    }
    try { await drainSettlements?.(); }
    catch (error) {
      primaryFailure ??= error;
      reportError("settlement", "settlement_drain_failed");
    }
    try {
      await waitForShutdownStage(connection?.stop(signalReason ?? (primaryFailure ? "run_failed" : "run_complete")),
        SHUTDOWN_STAGE_MAX_MS, "platform_shutdown");
    }
    catch (error) {
      primaryFailure ??= error;
      const timeout = isShutdownTimeout(error, "platform_shutdown");
      reportError("shutdown", timeout ? "platform_shutdown_timeout" : "platform_shutdown_failed", {
        message: safeEventMessage(error instanceof Error ? error.message : undefined),
      });
    }
    try { await waitForShutdownStage(discoveryJob, SHUTDOWN_STAGE_MAX_MS, "discovery_shutdown"); }
    catch (error) {
      const timeout = isShutdownTimeout(error, "discovery_shutdown");
      if (!timeout) primaryFailure ??= error;
      reportError("shutdown", timeout ? "discovery_shutdown_timeout" : "discovery_shutdown_failed", {
        message: safeEventMessage(error instanceof Error ? error.message : undefined),
      });
    }
    try { await waitForShutdownStage(settlementJob, SHUTDOWN_STAGE_MAX_MS, "settlement_shutdown_final"); }
    catch (error) {
      const timeout = isShutdownTimeout(error, "settlement_shutdown_final");
      if (!timeout) primaryFailure ??= error;
      reportError("shutdown", timeout ? "settlement_shutdown_timeout" : "settlement_shutdown_failed", {
        message: safeEventMessage(error instanceof Error ? error.message : undefined),
      });
    }
    try { store?.close(); }
    catch (error) {
      primaryFailure ??= error;
      reportError("state_close", "platform_state_close_failed");
    }
    try { summary(primaryFailure ? "failed" : "stopped"); }
    catch (error) { primaryFailure ??= error; }
    try { await journal?.close(); }
    catch (error) {
      primaryFailure ??= error;
      reportError("journal_close", "platform_journal_close_failed");
    }
    unsubscribe?.();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGBREAK", breakSignal);
  }
  if (primaryFailure) throw new Error("platform run failed; see the JSON error phase");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await import("dotenv/config");
  try { await runPlatformCli(process.argv.slice(2)); }
  catch (error) {
    console.error(JSON.stringify({ kind: "platform_error", code: "cli_failed",
      message: error instanceof CliInputError || error instanceof CommanderError
        ? error.message : safeErrorMessage(error instanceof Error ? error.message : String(error))
          ?? "platform could not complete; inspect the phase and local configuration" }));
    process.exitCode = 1;
  }
}
