#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import type { HardLimits, MarketInfo, OrderRecord, StrategyPlugin, TradingEvent, TradingMode } from "../platform/contracts.js";
import { PlatformJournal } from "../platform/journal.js";
import { connectPolymarketPlatform, discoverBtcMarket } from "../platform/polymarket.js";
import { PlatformStore } from "../platform/store.js";

export interface PlatformCliOptions {
  mode: TradingMode;
  limits: HardLimits;
  durationSec: number;
  timerMs: number;
  statusSec: number;
  stateFile: string;
  journalFile?: string;
  stopFile?: string;
  marketsFile?: string;
  strategyModule?: string;
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
    .option("--markets <path>", "JSON MarketInfo[] file; defaults to current BTC binary market discovery")
    .option("--capital-usd <number>", "Shared capital ceiling (paper 1000; live 50)")
    .option("--daily-loss-usd <number>", "Shared daily loss ceiling (paper 1000; live 30)")
    .option("--order-usd <number>", "Maximum order notional (defaults to capital ceiling)")
    .option("--max-open-orders <number>", "Shared active-order count ceiling", "100")
    .option("--duration-sec <number>", "Stop after this many seconds; 0 runs until an operator signal", "300")
    .option("--timer-ms <number>", "Strategy timer event interval; feed events remain immediate", "1000")
    .option("--status-sec <number>", "JSON status output interval", "30")
    .option("--state-file <path>", "Durable state and exclusive lock file")
    .option("--journal-file <path>", "Append pure JSONL platform status and execution events")
    .option("--stop-file <path>", "Stop normally when this controller-owned file exists")
    .option("--reference-feed", "Also subscribe to the BTC reference feed");
  try { command.parse(argv, { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return undefined;
    throw error;
  }
  const raw = command.opts();
  if (raw.live && raw.paper) throw new CliInputError("choose either --live or --paper");
  const mode: TradingMode = raw.live === true ? "live" : "paper";
  const capitalUsd = positive(raw.capitalUsd ?? (mode === "live" ? 50 : 1000), "--capital-usd");
  const dailyLossUsd = positive(raw.dailyLossUsd ?? (mode === "live" ? 30 : 1000), "--daily-loss-usd");
  const maxOrderUsd = positive(raw.orderUsd ?? capitalUsd, "--order-usd");
  const maxOpenOrders = positive(raw.maxOpenOrders, "--max-open-orders");
  if (!Number.isSafeInteger(maxOpenOrders)) throw new CliInputError("--max-open-orders must be a positive safe integer");
  if (maxOrderUsd > capitalUsd) throw new CliInputError("--order-usd must not exceed --capital-usd");
  if (mode === "live" && (capitalUsd > 50 || dailyLossUsd > 30)) {
    throw new CliInputError("live limits must fit the configured $50 capital / $30 daily loss budget");
  }
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
  const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  if (journalFile && [stateFile, `${stateFile}.lock`, `${stateFile}.next`].some(path => pathKey(path) === pathKey(journalFile))) {
    throw new CliInputError("--journal-file must be separate from state and recovery files");
  }
  if (stopFile && [stateFile, `${stateFile}.lock`, `${stateFile}.next`, journalFile]
    .some(path => path !== undefined && pathKey(path) === pathKey(stopFile))) {
    throw new CliInputError("--stop-file must be separate from state, recovery and journal files");
  }
  return { mode, limits: { capitalUsd, dailyLossUsd, maxOrderUsd, maxOpenOrders }, durationSec, timerMs,
    statusSec, stateFile, journalFile, stopFile,
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

export async function runPlatformCli(argv: string[]): Promise<void> {
  const options = parsePlatformOptions(argv);
  if (!options) return;
  const explicitMarkets = options.marketsFile ? readMarkets(options.marketsFile) : undefined;
  const strategy = options.strategyModule ? await loadStrategyModule(options.strategyModule) : undefined;
  let store: PlatformStore | undefined;
  let journal: PlatformJournal | undefined;
  let connection: Awaited<ReturnType<typeof connectPolymarketPlatform>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let marketTimer: ReturnType<typeof setTimeout> | undefined;
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
  const requestStop = (reason: string) => { signalReason ??= reason; notifyStop?.(); };
  const checkStopFile = () => {
    if (options.stopFile && existsSync(options.stopFile)) requestStop("controller_stop");
  };
  const watchMarketExpiry = () => {
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
        fee: fill.feeUsd, is_maker: fill.isMaker, direction: fill.direction, ...marketIdentity(fill.tokenId),
        engine_ts: fill.ts }, `fill:${JSON.stringify([fill.tradeId, fill.orderId])}`);
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
    const runtime = { schemaVersion: 1, engine: "platform", execution: strategy ? "strategy" : "observation",
      strategy_id: strategy?.id ?? null, status, mode: options.mode, started_at: startedAt,
      cash_usd: state?.cashUsd ?? null, positions_count: state?.positions.length ?? null,
      orders_count: state?.orders.length ?? null,
      active_orders: state?.orders.filter(order => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)).length ?? null,
      fills_count: state?.fills.length ?? null, risk: state?.risk ?? null, limits: options.limits,
      markets: platform?.market.list() ?? selectedMarkets,
      books: (platform?.market.books() ?? []).map(book => {
        const receivedAt = book.receivedAt ?? book.ts;
        const ageMs = Number.isFinite(receivedAt) ? Math.max(0, (now - receivedAt) * 1000) : null;
        const market = selectedMarkets.find(item => item.instruments.some(instrument => instrument.tokenId === book.tokenId));
        const expired = market ? now >= market.endsAt : true;
        return { ...book, bids: book.bids?.slice(0, 5), asks: book.asks?.slice(0, 5),
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
    phase = "market_discovery";
    const markets = explicitMarkets ?? validateMarkets(await discoverBtcMarket());
    selectedMarkets = markets;
    watchMarketExpiry();
    if (!signalReason) {
      phase = "platform_connect";
      connection = await connectPolymarketPlatform({ mode: options.mode, markets, limits: options.limits,
        paperCashUsd: options.limits.capitalUsd, restored, persist: (state, critical) => store!.save(state, critical),
        // Before connection resolution the adapter records initialization;
        // afterwards the subscription includes publish-only plugin/settlement events.
        record: event => { if (!connection) record(event); },
        durationSec: options.durationSec === 0 ? Infinity : options.durationSec, referenceFeed: options.referenceFeed });
      unsubscribe = connection.platform.subscribe(record);
    }
    if (connection && !signalReason) {
      if (strategy) connection.platform.attach(strategy);
      phase = "feed_start";
      await connection.start();
    }
    if (connection && !signalReason) {
      phase = "running";
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
    clearTimeout(durationTimer); clearTimeout(marketTimer);
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
