#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import type { HardLimits, MarketInfo, OrderRecord, StrategyPlugin, TradingEvent, TradingMode } from "../platform/contracts.js";
import { PlatformJournal } from "../platform/journal.js";
import { connectPolymarketPlatform, discoverBtcMarket } from "../platform/polymarket.js";
import { PlatformStore } from "../platform/store.js";
import { createBtcReversalStrategy, normalizeBtcReversalConfig, type BtcReversalConfig,
  type BtcReversalState, type BtcReversalStrategy } from "../strategies/btc-reversal.js";

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
  strategyModule?: string;
  strategy?: "btc-reversal";
  strategyConfigFile?: string;
  referenceFeed: boolean;
}

class CliInputError extends Error {}
const positive = (value: unknown, flag: string): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new CliInputError(`${flag} must be a finite positive number`);
  return number;
};

export function parsePlatformOptions(argv: string[]): PlatformCliOptions | undefined {
  const command = new Command()
    .name("trading-platform")
    .description("Shared trading services with an optional StrategyPlugin; defaults to paper observation")
    .exitOverride()
    .option("--live", "Use authenticated REAL trading services; never enabled by environment variables")
    .option("--paper", "Use simulated execution (default)")
    .option("--strategy-module <path>", "Local JS/TS module exporting createStrategy() or a default StrategyPlugin")
    .option("--strategy <name>", "Built-in strategy: btc-reversal")
    .option("--strategy-config <path>", "Persisted strategy configuration JSON")
    .option("--markets <path>", "JSON MarketInfo[] file; defaults to current BTC binary market discovery")
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
    .option("--reference-feed", "Also subscribe to the BTC reference feed");
  try { command.parse(argv, { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return undefined;
    throw error;
  }
  const raw = command.opts();
  if (raw.live && raw.paper) throw new CliInputError("choose either --live or --paper");
  const mode: TradingMode = raw.live === true ? "live" : "paper";
  if (raw.strategy && raw.strategy !== "btc-reversal") throw new CliInputError("unknown built-in strategy");
  if (raw.strategy && raw.strategyModule) throw new CliInputError("choose built-in strategy or strategy module");
  if (!!raw.strategy !== !!raw.strategyConfig) throw new CliInputError("--strategy requires --strategy-config and vice versa");
  const capitalUsd = positive(raw.capitalUsd ?? (mode === "live" ? Number.MAX_SAFE_INTEGER : 1000), "--capital-usd");
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
  return { mode, limits: { capitalUsd, dailyLossUsd, maxOrderUsd, maxOpenOrders }, durationSec, timerMs,
    statusSec, stateFile, journalFile, stopFile, controlFile, strategy: raw.strategy,
    strategyConfigFile,
    marketsFile: raw.markets ? resolve(raw.markets) : undefined,
    strategyModule: raw.strategyModule ? resolve(raw.strategyModule) : undefined,
    referenceFeed: raw.referenceFeed === true };
}

/** Validate file input before any market, wallet or gateway connection. */
export function validateMarkets(input: unknown): MarketInfo[] {
  if (!Array.isArray(input) || input.length === 0) throw new CliInputError("market list must be a nonempty MarketInfo[]");
  const marketIds = new Set<string>(), tokenIds = new Set<string>();
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  for (const market of input) {
    if (!market || !nonempty(market.id) || marketIds.has(market.id) || !nonempty(market.name)
      || !number(market.startsAt) || !number(market.endsAt) || market.startsAt < 0 || market.endsAt <= market.startsAt
      || !Array.isArray(market.instruments) || market.instruments.length !== 2) {
      throw new CliInputError("each Polymarket market needs a unique id, name, ordered timestamps and two instruments");
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
  return structuredClone(input) as MarketInfo[];
}

export async function loadStrategyModule(path: string): Promise<StrategyPlugin> {
  let plugin: unknown;
  try {
    const imported: Record<string, unknown> = await import(pathToFileURL(resolve(path)).href);
    plugin = typeof imported.createStrategy === "function" ? await imported.createStrategy() : imported.default;
  } catch { throw new CliInputError("strategy module could not be loaded or createStrategy() failed"); }
  if (!plugin || typeof plugin !== "object") throw new CliInputError("strategy module must export a StrategyPlugin object");
  const candidate = plugin as Partial<StrategyPlugin>;
  if (typeof candidate.id !== "string" || !candidate.id.trim() || typeof candidate.onEvent !== "function"
    || (candidate.onStop !== undefined && typeof candidate.onStop !== "function")) {
    throw new CliInputError("StrategyPlugin requires a nonempty id, onEvent(), and an optional onStop()");
  }
  return candidate as StrategyPlugin;
}

function readMarkets(path: string): MarketInfo[] {
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new CliInputError("--markets must refer to a readable JSON file"); }
  return validateMarkets(input);
}

export interface ReversalConfigFile {
  config: BtcReversalConfig;
  dailyLossUsd: number | null;
  savedRevision: string;
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
  const explicitMarkets = options.marketsFile ? readMarkets(options.marketsFile) : undefined;
  let strategy = options.strategyModule ? await loadStrategyModule(options.strategyModule) : undefined;
  let reversal: BtcReversalStrategy | undefined;
  let strategyConfig = options.strategyConfigFile ? readReversalConfig(options.strategyConfigFile) : undefined;
  if (strategyConfig) {
    options.limits.dailyLossUsd = strategyConfig.dailyLossUsd;
    options.limits.capitalUsd = strategyConfig.config.totalBudgetUsd ?? Number.MAX_SAFE_INTEGER;
    options.limits.maxOrderUsd = options.limits.capitalUsd;
  }
  const continuousMarkets = options.strategy === "btc-reversal" && !explicitMarkets;
  let store: PlatformStore | undefined;
  let journal: PlatformJournal | undefined;
  let connection: Awaited<ReturnType<typeof connectPolymarketPlatform>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let marketTimer: ReturnType<typeof setTimeout> | undefined;
  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  let controlTimer: ReturnType<typeof setInterval> | undefined;
  let settlementTimer: ReturnType<typeof setInterval> | undefined;
  let settlementJob: Promise<void> | undefined;
  const confirmedSettlements = new Set<string>();
  let discoveryJob: Promise<void> | undefined;
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
    try { reversal?.setPaused(true); } catch { /* Cleanup still needs to release process resources. */ }
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
  const interrupt = () => requestStop("SIGINT");
  const terminate = () => requestStop("SIGTERM");
  const breakSignal = () => requestStop("SIGBREAK");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.once("SIGBREAK", breakSignal);
  const reportError = (errorPhase: string, code: string) => {
    const details = { phase: errorPhase, code };
    console.error(JSON.stringify({ kind: "platform_error", ...details }));
    journal?.write("platform_error", details);
  };
  const marketIdentity = (tokenId: string) => {
    const market = selectedMarkets.find(item => item.instruments.some(instrument => instrument.tokenId === tokenId));
    return { market_slug: market?.name ?? null,
      side: market?.instruments.find(instrument => instrument.tokenId === tokenId)?.outcome ?? null };
  };
  const record = (event: TradingEvent) => {
    if (event.kind === "order") {
      const order = event.order;
      if (order.orderId) knownOrders.set(order.orderId, order);
      journal?.write("order", { client_order_id: order.clientOrderId, order_id: order.orderId ?? null,
        token_id: order.tokenId, strategy_id: order.strategyId, status: order.status,
        filled_shares: order.filledShares, reserved_usd: order.reservedUsd, reserved_shares: order.reservedShares,
        price: order.price, shares: order.shares, direction: order.direction, ...marketIdentity(order.tokenId),
        sign_latency_ms: order.signLatencyMs ?? null, ack_latency_ms: order.ackLatencyMs ?? null,
        updated_at: order.updatedAt });
    } else if (event.kind === "fill") {
      const fill = event.fill;
      const order = knownOrders.get(fill.orderId) ?? connection?.platform.orders.get(fill.orderId);
      journal?.write("fill", { trade_id: fill.tradeId, order_id: fill.orderId, token_id: fill.tokenId,
        strategy_id: order?.strategyId ?? null, price: fill.price, shares: fill.shares,
        fee: fill.feeUsd, fee_source: fill.feeSource ?? null, trade_status: fill.status ?? "CONFIRMED",
        is_maker: fill.isMaker, direction: fill.direction, ...marketIdentity(fill.tokenId),
        engine_ts: fill.ts }, `fill:${JSON.stringify([fill.tradeId, fill.orderId])}${fill.status ? `:${fill.status}:${fill.feeSource ?? "estimate"}:${fill.feeUsd}` : ""}`);
    } else if (event.kind === "error") {
      reportError("event", "platform_event_failed");
    } else if (event.kind === "stopped") {
      journal?.write("platform_stopped", { reason: signalReason ?? "run_complete" });
    } else if (event.kind === "settlement") {
      journal?.write("platform_settlement", { market_id: event.result.marketId, state: event.result.state,
        transaction_id: event.result.transactionId ?? null });
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
      active_orders: state?.orders.filter(order => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)).length ?? null,
      fills_count: state?.fills.length ?? null, risk: state?.risk ?? null, limits: options.limits,
      cash_flow_coverage: state?.cashFlowTracking ? {
        from: state.cashFlowTracking.baselineAt, until: state.cashFlowTracking.coveredThroughAt ?? null,
        from_block: state.cashFlowTracking.baselineBlock ?? null, cursor_block: state.cashFlowTracking.cursorBlock ?? null,
        complete: state.cashFlowTracking.complete, reason: state.cashFlowTracking.reason ?? null,
        applied_count: state.cashFlowTracking.appliedFlows.length,
      } : null,
      strategy_runtime: strategyRuntime,
      saved_revision: strategyConfig?.savedRevision ?? null,
      markets: platform?.market.list() ?? selectedMarkets,
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
        const actions = onEvent(event, context);
        const active = reversal!.exportState().rounds.find(round => round.startsAt <= context.now && context.now < round.endsAt);
        const dailyLossUsd = active?.config.dailyLossUsd ?? null;
        const capitalUsd = active?.config.totalBudgetUsd ?? Number.MAX_SAFE_INTEGER;
        if (connection && (options.limits.dailyLossUsd !== dailyLossUsd || options.limits.capitalUsd !== capitalUsd)) {
          connection.platform.core.updateLimits({ dailyLossUsd, capitalUsd, maxOrderUsd: capitalUsd });
          Object.assign(options.limits, { dailyLossUsd, capitalUsd, maxOrderUsd: capitalUsd });
        }
        return actions;
      };
      strategy = reversal;
      if (options.controlFile && existsSync(options.controlFile)) {
        const control = JSON.parse(readFileSync(options.controlFile, "utf8"));
        if (typeof control.paused !== "boolean") throw new CliInputError("invalid pause control");
        reversal.setPaused(control.paused);
      }
    }
    phase = "market_discovery";
    const markets = explicitMarkets ?? validateMarkets(await discoverBtcMarket());
    if (continuousMarkets && restored?.markets) {
      const unsettledTokens = new Set([
        ...restored.orders.filter(order => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)
          || order.reconciliationPending).map(order => order.tokenId),
        ...restored.fills.filter(fill => fill.status && !["CONFIRMED", "FAILED"].includes(fill.status)).map(fill => fill.tokenId),
        ...restored.positions.filter(position => position.shares > 0).map(position => position.tokenId),
      ]);
      for (const previous of restored.markets) {
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
      connection = await connectPolymarketPlatform({ mode: options.mode, markets, limits: options.limits,
        paperCashUsd: options.limits.capitalUsd, restored, persist: (state, critical) => store!.save(state, critical),
        settle,
        observationOnly: !strategy,
        // Before connection resolution the adapter records initialization;
        // afterwards the subscription includes publish-only plugin/settlement events.
        record: event => { if (!connection) record(event); },
        durationSec: options.durationSec === 0 ? Infinity : options.durationSec, referenceFeed: options.referenceFeed });
      unsubscribe = connection.platform.subscribe(record);
      if (reversal) connection.platform.core.setStrategyState("btc-reversal", reversal.exportState());
    }
    if (connection && !signalReason) {
      if (strategy) {
        connection.platform.attach(strategy);
        connection.platform.replayOrders?.();
      }
      phase = "feed_start";
      await connection.start();
    }
    if (connection && !signalReason) {
      phase = "running";
      if (continuousMarkets) {
        const discover = () => {
          if (discoveryJob || signalReason) return;
          discoveryJob = (async () => {
            const now = Date.now() / 1000;
            const nextBoundary = (Math.floor(now / 300) + 1) * 300;
            const candidates = await Promise.allSettled([discoverBtcMarket(now), discoverBtcMarket(nextBoundary)]);
            for (const result of candidates) {
              if (result.status !== "fulfilled") continue;
              const fresh = result.value.filter(market => market.endsAt > now && !selectedMarkets.some(old => old.id === market.id));
              if (fresh.length) {
                await connection!.addMarkets(validateMarkets(fresh));
                selectedMarkets = connection!.platform.market.list();
              }
            }
          })().catch(() => reportError("market_discovery", "next_market_unavailable"))
            .finally(() => { discoveryJob = undefined; });
        };
        discover(); discoveryTimer = setInterval(discover, 15_000);
      }
      if (reversal) {
        let lastConfig = JSON.stringify(strategyConfig);
        let lastPaused = reversal.exportState().paused;
        controlTimer = setInterval(() => {
          try {
            if (options.strategyConfigFile) {
              const next = readReversalConfig(options.strategyConfigFile), key = JSON.stringify(next);
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
                const result = await connection!.platform.settlement.redeem({ marketId: market.id, tokenIds });
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
    primaryFailure = error;
    reportError(phase, "platform_run_failed");
  } finally {
    clearInterval(timer); clearInterval(statusTimer); clearInterval(stopFileTimer);
    clearInterval(discoveryTimer); clearInterval(controlTimer); clearInterval(settlementTimer);
    clearTimeout(durationTimer); clearTimeout(marketTimer);
    await discoveryJob;
    await settlementJob;
    try { await connection?.stop(signalReason ?? (primaryFailure ? "run_failed" : "run_complete")); }
    catch (error) {
      primaryFailure ??= error;
      reportError("shutdown", "platform_shutdown_failed");
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
