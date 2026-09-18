#!/usr/bin/env node
/** Independent public-data process; never imports an account or trading client. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findMarket, type Market } from "../live/discovery.js";
import { runPolymarketFeed } from "../live/feeds/polymarket.js";
import type { FeedSink } from "../live/feeds/index.js";
import { ClobMarketProjection, publishSnapshot, type MarketProjectionSnapshot } from "../dashboard/market-projection.js";

export interface MarketSnapshotOptions {
  output: string;
  durationSec: number;
  staleAfterMs: number;
  publishMs: number;
  discoveryMs: number;
}

export function parseMarketSnapshotOptions(argv: string[]): MarketSnapshotOptions | undefined {
  const options: MarketSnapshotOptions = { output: "data/dashboard/market-snapshot.json", durationSec: 0,
    staleAfterMs: 2_000, publishMs: 250, discoveryMs: 15_000 };
  const numeric = new Map<string, keyof Omit<MarketSnapshotOptions, "output">>([
    ["--duration-sec", "durationSec"], ["--stale-after-ms", "staleAfterMs"],
    ["--publish-ms", "publishMs"], ["--discovery-ms", "discoveryMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: market-snapshot [--output path] [--duration-sec seconds] [--stale-after-ms ms] [--publish-ms ms] [--discovery-ms ms]");
      return undefined;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (arg === "--output") options.output = value;
    else {
      const field = numeric.get(arg);
      if (!field) throw new Error(`unknown option: ${arg}`);
      options[field] = Number(value);
    }
  }
  if (!Number.isFinite(options.durationSec) || options.durationSec < 0) throw new Error("--duration-sec must be non-negative");
  for (const field of ["staleAfterMs", "publishMs", "discoveryMs"] as const) {
    if (!Number.isFinite(options[field]) || options[field] <= 0) throw new Error(`${field} must be positive`);
  }
  return options;
}

export interface MarketSnapshotDependencies {
  now: () => number;
  discover: (at: number) => Promise<Market | undefined>;
  feed: (sink: FeedSink, upToken: string, downToken: string, deadline: number) => { stop: () => void };
  publish: (path: string, value: MarketProjectionSnapshot) => void;
}

const defaults: MarketSnapshotDependencies = {
  now: () => Date.now() / 1000,
  discover: at => findMarket(at, false),
  feed: runPolymarketFeed,
  publish: publishSnapshot,
};

/** Runs only public Gamma discovery and the existing public CLOB WS feed. */
export async function runMarketSnapshot(options: MarketSnapshotOptions, dependencies: Partial<MarketSnapshotDependencies> = {}, signal?: AbortSignal): Promise<void> {
  const deps = { ...defaults, ...dependencies };
  const active = new Map<string, { market: Market; projection: ClobMarketProjection; stop: () => void }>();
  let stopped = false;
  let failure: unknown;
  let discoveryJob: Promise<void> | undefined;
  let publishTimer: ReturnType<typeof setInterval> | undefined;
  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  const finished = new Promise<void>(resolvePromise => { finish = resolvePromise; });
  const stop = () => { stopped = true; finish(); };
  const publish = () => {
    const now = deps.now();
    for (const [key, item] of active) {
      if (item.market.end <= now) { item.stop(); item.projection.disconnect(); active.delete(key); }
    }
    const current = [...active.values()].filter(item => item.market.start <= now && now < item.market.end)
      .sort((a, b) => b.market.start - a.market.start)[0];
    const value = current?.projection.snapshot(now) ?? {
      checked_at: new Date(now * 1000).toISOString(), collector_online: false, collector_connected: false,
      stale_after_ms: options.staleAfterMs, source: "polymarket-ws" as const, current_markets: [],
      stale_reason: "Waiting for the current BTC market and its CLOB WebSocket quotes",
    };
    deps.publish(options.output, value);
  };
  const safePublish = () => {
    try { publish(); } catch (error) { failure ??= error; stop(); }
  };
  const discover = (): Promise<void> => {
    if (discoveryJob || stopped) return discoveryJob ?? Promise.resolve();
    discoveryJob = (async () => {
      const now = deps.now();
      const next = (Math.floor(now / 300) + 1) * 300;
      const candidates = await Promise.allSettled([deps.discover(now), deps.discover(next)]);
      if (stopped) return;
      for (const result of candidates) {
        const market = result.status === "fulfilled" ? result.value : undefined;
        if (!market || market.end <= deps.now() || active.has(market.slug)) continue;
        const projection = new ClobMarketProjection({ ...market, staleAfterMs: options.staleAfterMs });
        const control = deps.feed(event => {
          if (stopped) return;
          if (event.kind === "book") projection.applySnapshot(event.snapshot);
          else if (event.kind === "bookStatus") {
            if (event.healthy) projection.markConnected(true);
            else projection.disconnect();
          }
        }, market.upToken, market.downToken, market.end);
        active.set(market.slug, { market, projection, stop: control.stop });
      }
      safePublish();
    })().catch(error => { failure ??= error; stop(); }).finally(() => { discoveryJob = undefined; });
    return discoveryJob;
  };
  const interrupt = () => stop();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) stop();
    if (!stopped) {
      safePublish();
      publishTimer = setInterval(safePublish, options.publishMs);
      discoveryTimer = setInterval(() => { void discover(); }, options.discoveryMs);
      if (options.durationSec > 0) durationTimer = setTimeout(stop, options.durationSec * 1000);
      void discover();
    }
    await finished;
  } finally {
    clearInterval(publishTimer); clearInterval(discoveryTimer); clearTimeout(durationTimer);
    for (const item of active.values()) { item.stop(); item.projection.disconnect(); }
    safePublish();
    await discoveryJob;
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    signal?.removeEventListener("abort", stop);
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseMarketSnapshotOptions(process.argv.slice(2));
    if (options) await runMarketSnapshot(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "market snapshot failed"); process.exitCode = 1;
  }
}
