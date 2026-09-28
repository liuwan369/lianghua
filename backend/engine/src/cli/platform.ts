#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
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
  return { mode, limits: { capitalUsd, dailyLossUsd, maxOrderUsd, maxOpenOrders }, durationSec, timerMs,
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
  const safeEventMessage = (message: string | undefined): string => {
    const value = String(message ?? "").slice(0, 500);
    if (!value) return "platform event failed";
    return /secret|token|passphrase|password|private[ _-]?key|api[ _-]?key|diagnostic stdout/i.test(value)
      ? "sensitive provider error" : value;
  };
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
        payout_verified: event.result.payoutVerified === true,
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
    const currentMarket = (platform?.market.list() ?? selectedMarkets)
      .filter(market => market.startsAt <= now && now < market.endsAt)
      .sort((left, right) => right.startsAt - left.startsAt)[0];
    const strategyStatus = reversal?.getStatus();
    const enrichRound = (round: NonNullable<typeof strategyStatus>["rounds"][number]) => {
      const tokens = new Set([round.upTokenId, round.downTokenId]);
      const positions = (state?.positions ?? []).filter(position => tokens.has(position.tokenId));
      const costUsd = positions.reduce((total, position) => total + position.costUsd, 0);
      const reservedUsd = (state?.orders ?? []).filter(order => tokens.has(order.tokenId))
        .reduce((total, order) => total + order.reservedUsd, 0);
      const fills = (state?.fills ?? []).filter(fill => tokens.has(fill.tokenId) && fill.status !== "FAILED");
      const coveredHoldings = [...tokens].every(token => Math.abs(
        (positions.find(position => position.tokenId === token)?.shares ?? 0)
        - fills.filter(fill => fill.tokenId === token).reduce((shares, fill) => shares + (fill.direction === "BUY" ? fill.shares : -fill.shares), 0)) < 1e-8);
      const feesVerified = coveredHoldings && fills.every(fill => fill.feeSource === "reported" && fill.status === "CONFIRMED");
      const upShares = positions.find(position => position.tokenId === round.upTokenId)?.shares ?? 0;
      const downShares = positions.find(position => position.tokenId === round.downTokenId)?.shares ?? 0;
      // Core cost basis already includes fill fees. Do not subtract them twice.
      return { ...round, costUsd, reservedUsd, upShares, downShares, feesVerified,
        netIfUpUsd: feesVerified ? upShares - costUsd : null,
        netIfDownUsd: feesVerified ? downShares - costUsd : null,
        resultScope: "account_market", resultReason: feesVerified ? null : "成交或实际费用尚待确认" };
    };
    const strategyRuntime = strategyStatus ? { ...strategyStatus,
      rounds: strategyStatus.rounds.map(enrichRound),
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
      markets: platform?.market.list() ?? selectedMarkets,
      current_market: currentMarket ? {
        marketId: currentMarket.id, roundId: currentMarket.roundId, assetId: currentMarket.assetId ?? options.assetId,
        name: currentMarket.name, startsAt: currentMarket.startsAt, endsAt: currentMarket.endsAt,
      } : null,
      current_market_id: currentMarket?.id ?? null,
      current_round_id: currentMarket?.roundId ?? null,
      // This is the accepted paired snapshot projection. It is cloned by the
      // platform API and is not rebuilt from legacy single-token books.
      snapshots: platform?.market.snapshots() ?? [],
      books: (platform?.market.books() ?? []).map(book => {
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
    const restored = store.load();
    if (strategyConfig) {
      reversal = createBtcReversalStrategy(strategyConfig.config, {
        restoredState: restored?.strategyStates?.["btc-reversal"] as BtcReversalState | undefined,
        persist: state => connection?.platform.core.setStrategyState("btc-reversal", state),
      });
      const onEvent = reversal.onEvent.bind(reversal);
      reversal.onEvent = (event, context) => {
        // Shutdown is local to this run. Do not persist it as an operator
        // pause, or the next run would inherit a permanent admission lock.
        if (signalReason || primaryFailure) return [];
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
      const settlementStateFile = `${options.stateFile}.settlements.json`;
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
          const runSettlementPass = async (draining = false) => {
            const state = connection!.platform.account.current(), now = Date.now() / 1000;
            const runMarketIds = currentRunMarketIds();
            for (const market of connection!.platform.market.list()) {
              if (market.endsAt > now || terminalSettlements.has(market.id)) continue;
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
            const deadline = Date.now() + SETTLEMENT_DRAIN_MAX_MS;
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
                break;
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
      reportError(phase, "platform_run_failed");
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
      try {
        await waitForShutdownStage(connection?.platform.orders.cancelAll("btc-reversal"),
          SHUTDOWN_STAGE_MAX_MS, "cancel_all");
        await waitForShutdownStage(connection?.platform.idle(), SHUTDOWN_STAGE_MAX_MS, "order_idle");
        await waitForShutdownStage(connection?.recoverAccount(), SHUTDOWN_STAGE_MAX_MS, "account_recovery");
      } catch (error) {
        const timeout = isShutdownTimeout(error,
          error instanceof Error && error.message.endsWith("_timeout") ? error.message.slice(0, -8) : "settlement_preparation");
        if (!timeout) primaryFailure ??= error;
        reportError("shutdown", timeout ? "settlement_preparation_timeout" : "settlement_preparation_failed", {
          message: safeEventMessage(error instanceof Error ? error.message : undefined),
        });
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
        ? error.message : "platform could not complete; inspect the phase and local configuration" }));
    process.exitCode = 1;
  }
}
