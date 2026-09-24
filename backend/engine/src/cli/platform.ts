#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import * as referenceFeedModule from "../live/feeds/btc.js";
import type { AssetId, CoreState, HardLimits, MarketInfo, OrderRecord, TradingEvent, TradingMode } from "../platform/contracts.js";
import { PlatformJournal } from "../platform/journal.js";
import { connectPolymarketPlatform, discoverMarket, referenceProducerForAsset } from "../platform/polymarket.js";
import { PlatformStore } from "../platform/store.js";
import { createBtcReversalStrategy, normalizeBtcReversalConfig, type BtcReversalConfig,
  type BtcReversalState, type BtcReversalStrategy } from "../strategies/btc-reversal.js";

const MARKET_WINDOW_SEC = 300;
const DISCOVERY_PREWARM_MS = 10_000;
const DISCOVERY_PREWARM_RETRY_MS = 250;
const DISCOVERY_POST_BOUNDARY_MS = 20_000;
const BEST_EFFORT_LATENCY_METRICS = new Set([
  "book_batch_apply", "book_processing", "market_age", "strategy_decision", "ws_receive_to_decision",
]);

export function countActiveOrders(state: Pick<CoreState, "orders" | "quarantinedOrderIds">): number {
  return state.orders.filter(order => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)
    && !state.quarantinedOrderIds?.includes(order.orderId ?? "")).length;
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
  strategy?: "btc-reversal";
  strategyConfigFile?: string;
  referenceFeed: boolean;
  assetId: AssetId;
}

class CliInputError extends Error {}
const SUPPORTED_ASSETS = new Set<AssetId>(["btc", "eth", "sol"]);
const parseAsset = (value: unknown): AssetId => {
  const asset = String(value ?? "btc").trim().toLowerCase();
  if (!SUPPORTED_ASSETS.has(asset as AssetId)) throw new CliInputError(`unsupported --asset ${asset}; choose btc, eth or sol`);
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
  if (!!raw.strategy !== !!raw.strategyConfig) throw new CliInputError("--strategy requires --strategy-config and vice versa");
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
    referenceFeed: raw.referenceFeed === true, assetId };
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
  const confirmedSettlements = new Set<string>();
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
        state: event.result.state, transaction_id: event.result.transactionId ?? null,
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
    if (continuousMarkets && restored?.markets) {
      const unsettledTokens = new Set([
        ...restored.orders.filter(order => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)
          || order.reconciliationPending).map(order => order.tokenId),
        ...restored.fills.filter(fill => fill.status && !["CONFIRMED", "FAILED"].includes(fill.status)).map(fill => fill.tokenId),
        ...restored.positions.filter(position => position.shares > 0).map(position => position.tokenId),
      ]);
      for (const previous of restored.markets) {
        if ((previous.assetId ?? "btc") !== options.assetId) continue;
        if (!markets.some(market => market.id === previous.id)
          && previous.instruments.some(instrument => unsettledTokens.has(instrument.tokenId))) markets.push(previous);
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
          const settleEndedMarkets = () => {
            if (settlementJob || signalReason) return;
            settlementJob = (async () => {
              const state = connection!.platform.account.current(), now = Date.now() / 1000;
              for (const market of connection!.platform.market.list()) {
                if (market.endsAt > now || confirmedSettlements.has(market.id)) continue;
                const tokenIds = market.instruments.map(instrument => instrument.tokenId);
                const hasStrategyRound = reversal!.getStatus().rounds.some(round => round.marketId === market.id && round.stages.length > 0);
                if (!hasStrategyRound && !state.positions.some(position => tokenIds.includes(position.tokenId) && position.shares > 0)) continue;
                if (state.orders.some(order => tokenIds.includes(order.tokenId)
                  && (["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status) || order.reconciliationPending))) continue;
                if (state.fills.some(fill => tokenIds.includes(fill.tokenId) && fill.status
                  && !["CONFIRMED", "FAILED"].includes(fill.status))) continue;
                const result = await connection!.platform.settlement.redeem({ marketId: market.id, assetId: market.assetId, tokenIds });
                if (result.state === "confirmed") {
                  await connection!.recoverAccount();
                  confirmedSettlements.add(market.id);
                }
              }
            })().catch(() => reportError("settlement", "settlement_reconciliation_pending"))
              .finally(() => { settlementJob = undefined; });
          };
          settleEndedMarkets(); settlementTimer = setInterval(settleEndedMarkets, 15_000);
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
      if (options.durationSec > 0) durationTimer = setTimeout(() => requestStop("duration_elapsed"), options.durationSec * 1000);
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
    try { await connection?.stop(signalReason ?? (primaryFailure ? "run_failed" : "run_complete")); }
    catch (error) {
      primaryFailure ??= error;
      reportError("shutdown", "platform_shutdown_failed");
    }
    await discoveryJob;
    await settlementJob;
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
