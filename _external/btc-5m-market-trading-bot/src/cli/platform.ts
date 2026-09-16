#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import type { HardLimits, MarketInfo, StrategyPlugin, TradingMode } from "../platform/contracts.js";
import { connectPolymarketPlatform, discoverBtcMarket } from "../platform/polymarket.js";
import { PlatformStore } from "../platform/store.js";

export interface PlatformCliOptions {
  mode: TradingMode;
  limits: HardLimits;
  durationSec: number;
  timerMs: number;
  statusSec: number;
  stateFile: string;
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
    .option("--duration-sec <number>", "Stop and cancel owned orders after this many seconds", "300")
    .option("--timer-ms <number>", "Strategy timer event interval; feed events remain immediate", "1000")
    .option("--status-sec <number>", "JSON status output interval", "30")
    .option("--state-file <path>", "Durable state and exclusive lock file")
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
  const durationSec = positive(raw.durationSec, "--duration-sec");
  const timerMs = positive(raw.timerMs, "--timer-ms");
  const statusSec = positive(raw.statusSec, "--status-sec");
  if (durationSec * 1000 > 2_147_483_647 || timerMs > 2_147_483_647 || statusSec * 1000 > 2_147_483_647) {
    throw new CliInputError("timer intervals must fit the Node.js timer range (2147483647 ms)");
  }
  return { mode, limits: { capitalUsd, dailyLossUsd, maxOrderUsd, maxOpenOrders }, durationSec, timerMs,
    statusSec, stateFile: resolve(raw.stateFile ?? `results/platform/${mode}-state.json`),
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
  let connection: Awaited<ReturnType<typeof connectPolymarketPlatform>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let signalReason: string | undefined;
  let notifyStop: (() => void) | undefined;
  let primaryFailure: unknown;
  let phase = "initializing";
  const stopRequested = new Promise<void>(done => { notifyStop = done; });
  const requestStop = (reason: string) => { signalReason ??= reason; notifyStop?.(); };
  const interrupt = () => requestStop("SIGINT");
  const terminate = () => requestStop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const summary = (status: string) => {
    const platform = connection?.platform;
    if (!platform) return;
    const state = platform.account.current();
    console.log(JSON.stringify({ kind: "platform_status", status, mode: options.mode,
      strategy: strategy?.id ?? null, markets: platform.market.list().map(market => market.id),
      cashUsd: state.cashUsd, positions: state.positions.length, orders: state.orders.length,
      activeOrders: state.orders.filter(order => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status)).length,
      fills: state.fills.length, risk: state.risk, telemetry: platform.telemetry.snapshot(),
      capabilities: platform.capabilities(), reason: signalReason ?? null }));
  };
  try {
    phase = "state_open";
    store = new PlatformStore(options.stateFile);
    const restored = store.load();
    phase = "market_discovery";
    const markets = explicitMarkets ?? validateMarkets(await discoverBtcMarket());
    if (!signalReason) {
      phase = "platform_connect";
      connection = await connectPolymarketPlatform({ mode: options.mode, markets, limits: options.limits,
        paperCashUsd: options.limits.capitalUsd, restored, persist: (state, critical) => store!.save(state, critical),
        durationSec: options.durationSec, referenceFeed: options.referenceFeed });
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
      durationTimer = setTimeout(() => requestStop("duration_elapsed"), options.durationSec * 1000);
      summary("running");
      await stopRequested;
    }
  } catch (error) {
    primaryFailure = error;
    console.error(JSON.stringify({ kind: "platform_error", phase, code: "platform_run_failed" }));
  } finally {
    clearInterval(timer); clearInterval(statusTimer); clearTimeout(durationTimer);
    try { await connection?.stop(signalReason ?? (primaryFailure ? "run_failed" : "run_complete")); }
    catch (error) {
      primaryFailure ??= error;
      console.error(JSON.stringify({ kind: "platform_error", phase: "shutdown", code: "platform_shutdown_failed" }));
    }
    try { summary(primaryFailure ? "failed" : "stopped"); }
    catch (error) { primaryFailure ??= error; }
    try { store?.close(); }
    catch (error) {
      primaryFailure ??= error;
      console.error(JSON.stringify({ kind: "platform_error", phase: "state_close", code: "platform_state_close_failed" }));
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
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
