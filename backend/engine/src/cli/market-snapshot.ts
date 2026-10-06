#!/usr/bin/env node
/** Independent public-data process; never imports an account or trading client. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findMarket, type Market } from "../live/discovery.js";
import { runPolymarketFeed } from "../live/feeds/polymarket.js";
import { runReferenceFeed } from "../live/feeds/btc.js";
import type { FeedMarketIdentity, FeedSink } from "../live/feeds/index.js";
import { ClobMarketProjection, publishSnapshot, readPublishedSnapshot, stalePublishedSnapshot,
  type MarketProjectionSnapshot } from "../dashboard/market-projection.js";
import { MarketRecorder, recordedTop, recordedBook, recordedTrade, recordedPrice } from "./market-recorder.js";

const MARKET_WINDOW_SEC = 300;
// Polymarket publishes 5m up/down markets for these seven; verified live that
// every "<asset>-updown-5m-<round>" slug resolves with 2 tokens and tick 0.01.
const SUPPORTED_SNAPSHOT_ASSETS: readonly string[] = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"];
// The venue stops quoting an expiring 5m market well before its boundary: the
// outgoing book was measured going stale ~40s early, so a 10s prewarm left the
// console without any fresh paired quote for about a minute every round. Start
// discovery early enough to have the next round's feed connected and publishing
// before the current one dies.
const DISCOVERY_PREWARM_MS = 75_000;
const DISCOVERY_PREWARM_RETRY_MS = 250;
const DISCOVERY_POST_BOUNDARY_MS = 20_000;

export interface MarketSnapshotOptions {
  assets?: string[];
  output: string;
  durationSec: number;
  staleAfterMs: number;
  publishMs: number;
  discoveryMs: number;
  /** Record every book event here for replay/backtests; unset = no recording. */
  recordDir?: string;
  recordDays: number;
}

export function parseMarketSnapshotOptions(argv: string[]): MarketSnapshotOptions | undefined {
  const options: MarketSnapshotOptions = { output: "data/dashboard/market-snapshot.json", durationSec: 0,
    staleAfterMs: 2_000, publishMs: 250, discoveryMs: 15_000, recordDays: 10 };
  const numeric = new Map<string, keyof Omit<MarketSnapshotOptions, "output" | "assets" | "recordDir">>([
    ["--duration-sec", "durationSec"], ["--stale-after-ms", "staleAfterMs"],
    ["--publish-ms", "publishMs"], ["--discovery-ms", "discoveryMs"], ["--record-days", "recordDays"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: market-snapshot [--assets btc,eth,sol,xrp,doge,hype,bnb] [--output path] [--duration-sec seconds] [--stale-after-ms ms] [--publish-ms ms] [--discovery-ms ms] [--record-dir path] [--record-days 10]");
      return undefined;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (arg === "--output") options.output = value;
    else if (arg === "--record-dir") options.recordDir = value;
    else if (arg === "--assets") {
      const assets = value.split(",").map(asset => asset.trim().toLowerCase());
      if (assets.some(asset => !asset)) throw new Error("--assets must contain one or more comma-separated assets");
      options.assets = [...new Set(assets)];
    }
    else {
      const field = numeric.get(arg);
      if (!field) throw new Error(`unknown option: ${arg}`);
      options[field] = Number(value);
    }
  }
  if (!Number.isFinite(options.durationSec) || options.durationSec < 0) throw new Error("--duration-sec must be non-negative");
  if (options.assets && (!options.assets.length || options.assets.some(asset => !SUPPORTED_SNAPSHOT_ASSETS.includes(asset)))) {
    throw new Error(`--assets supports one or more of ${SUPPORTED_SNAPSHOT_ASSETS.join(", ")}`);
  }
  for (const field of ["staleAfterMs", "publishMs", "discoveryMs", "recordDays"] as const) {
    if (!Number.isFinite(options[field]) || options[field] <= 0) throw new Error(`${field} must be positive`);
  }
  return options;
}

export interface MarketSnapshotDependencies {
  now: () => number;
  discover: (at: number, directOnly?: boolean, signal?: AbortSignal, asset?: string) => Promise<Market | undefined>;
  feed: (sink: FeedSink, upToken: string, downToken: string, deadline: number, identity?: FeedMarketIdentity) => { stop: () => void };
  publish: (path: string, value: MarketProjectionSnapshot) => void;
  /** The coin's own price (the venue aggregator the engine uses); recorded only. */
  reference: (sink: FeedSink, asset: string) => { stop: () => void };
}

const defaults: MarketSnapshotDependencies = {
  now: () => Date.now() / 1000,
  discover: (at, directOnly = false, signal, asset = "btc") => findMarket(at, false, directOnly, signal, asset),
  feed: runPolymarketFeed,
  publish: publishSnapshot,
  reference: (sink, asset) => runReferenceFeed(sink, asset),
};

/** Runs only public Gamma discovery and the existing public CLOB WS feed. */
export async function runMarketSnapshot(options: MarketSnapshotOptions, dependencies: Partial<MarketSnapshotDependencies> = {}, signal?: AbortSignal): Promise<void> {
  const deps = { ...defaults, ...dependencies };
  const assets = options.assets ?? ["btc"];
  const active = new Map<string, { market: Market; projection: ClobMarketProjection; stop: () => void }>();
  let lastPublished = readPublishedSnapshot(options.output);
  if (lastPublished) lastPublished = stalePublishedSnapshot(lastPublished, deps.now(), "Collector restarted; waiting for a fresh paired quote");
  let stopped = false;
  let failure: unknown;
  const discoveryJobs = new Map<string, Promise<void>>();
  let publishTimer: ReturnType<typeof setInterval> | undefined;
  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  let discoveryPrewarmStartTimer: ReturnType<typeof setTimeout> | undefined;
  let discoveryBoundaryTimer: ReturnType<typeof setTimeout> | undefined;
  let discoveryPrewarmTimer: ReturnType<typeof setInterval> | undefined;
  let discoveryPrewarmStopTimer: ReturnType<typeof setTimeout> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  const finished = new Promise<void>(resolvePromise => { finish = resolvePromise; });
  const discoveryAbort = new AbortController();
  const recorder = options.recordDir ? new MarketRecorder({ directory: options.recordDir, retentionDays: options.recordDays }) : undefined;
  // The markets settle on the coin's price at the close against the open:
  // record that price next to the book, at most one row per coin per second.
  const references: Array<{ stop: () => void }> = [];
  if (recorder) {
    for (const asset of assets) {
      let lastSecond = -1;
      try {
        references.push(deps.reference(event => {
          if (event.kind !== "btc" && event.kind !== "oracle") return;
          const second = Math.floor(event.tsUnix);
          if (second === lastSecond) return;
          lastSecond = second;
          const receivedAt = deps.now();
          const roundId = String(Math.floor(receivedAt / MARKET_WINDOW_SEC) * MARKET_WINDOW_SEC);
          try { recorder.record(recordedPrice(asset, roundId, event.tsUnix, event.price, receivedAt)); }
          catch { recorder.dropped += 1; }
        }, asset));
      } catch { /* a coin without a reference feed simply records no price */ }
    }
  }
  const stop = () => {
    stopped = true;
    discoveryAbort.abort();
    finish();
  };
  const publish = () => {
    const now = deps.now();
    for (const [key, item] of active) {
      if (item.market.end <= now) { item.stop(); item.projection.disconnect(); active.delete(key); }
    }
    const rows: MarketProjectionSnapshot["current_markets"] = [];
    let connected = false;
    for (const asset of assets) {
      const current = [...active.values()].filter(item => item.market.asset === asset && item.market.start <= now && now < item.market.end)
        .sort((a, b) => b.market.start - a.market.start)[0];
      const snapshot = current?.projection.snapshot(now);
      connected ||= snapshot?.collector_connected === true;
      if (snapshot?.current_markets.length) rows.push(...snapshot.current_markets);
      else if (lastPublished) {
        const retained = stalePublishedSnapshot(lastPublished, now, "Waiting for a fresh paired quote");
        rows.push(...retained.current_markets.filter(row => (row.assetId ?? (row.slug.split("-updown-5m-")[0] || "btc")) === asset));
      }
      // Also publish the prewarmed upcoming round. The venue stops quoting the
      // expiring market before its boundary, so without this the console has no
      // fresh paired quote for the last stretch of every round. These rows are
      // marked nextRound so consumers never mistake them for the live round; the
      // engine's own gate still rejects any book outside the running round.
      const upcoming = [...active.values()].filter(item => item.market.asset === asset && item.market.start > now)
        .sort((a, b) => a.market.start - b.market.start)[0];
      const upcomingSnapshot = upcoming?.projection.snapshot(now, { beforeStart: true });
      connected ||= upcomingSnapshot?.collector_connected === true;
      for (const row of upcomingSnapshot?.current_markets ?? []) {
        if (rows.some(existing => existing.marketId === row.marketId && existing.roundId === row.roundId)) continue;
        rows.push({ ...row, nextRound: true });
      }
    }
    // A healthy prewarmed round must not make a dead current round look online.
    const online = rows.some(row => row.healthy && row.nextRound !== true);
    const value: MarketProjectionSnapshot = {
      checked_at: new Date(now * 1000).toISOString(), collector_online: online, collector_connected: connected,
      strategyEligible: false, stale_after_ms: options.staleAfterMs,
      source: "polymarket-ws", current_markets: rows,
      ...(!online ? { stale_reason: "Waiting for fresh CLOB WebSocket quotes" } : {}),
    };
    if (rows.length) lastPublished = value;
    deps.publish(options.output, value);
  };
  const safePublish = () => {
    try { publish(); } catch (error) { failure ??= error; stop(); }
  };
  const discover = (target?: number, directOnly = false): Promise<void> => {
    if (stopped) return Promise.resolve();
    const now = deps.now();
    const next = target ?? (Math.floor(now / MARKET_WINDOW_SEC) + 1) * MARKET_WINDOW_SEC;
    // The periodic pass looks up only the current round. Asking for the next
    // one too opened its sockets ~296 s early (Gamma lists it as soon as the
    // current round starts), bypassing the 75 s prewarm and doubling sockets
    // and reconnect churn (BUGS M1). scheduleBoundaryDiscovery owns the next.
    const jobs = assets.flatMap(asset => (target == null ? [now] : [next]).map(at => {
      const key = `${asset}:${Math.floor(at / MARKET_WINDOW_SEC)}`;
      const existing = discoveryJobs.get(key);
      if (existing) return existing;
      const job = (async () => {
        let market: Market | undefined;
        try { market = await deps.discover(at, directOnly, discoveryAbort.signal, asset); }
        catch { return; } // A failed public discovery is retried on its own cadence.
        if (stopped || !market || market.asset !== asset || market.end <= deps.now() || active.has(market.slug)) return;
        const projection = new ClobMarketProjection({ ...market, staleAfterMs: options.staleAfterMs });
        const previous = lastPublished?.current_markets.find(row => row.marketId === market.conditionId
          && row.roundId === market.roundId && row.snapshot.marketId === market.conditionId
          && row.snapshot.roundId === market.roundId && row.snapshot.YES.assetId === market.upToken
          && row.snapshot.NO.assetId === market.downToken);
        const control = deps.feed(event => {
          if (stopped) return;
          if (event.kind === "book") {
            projection.applySnapshot(event.snapshot);
            // Recording must never break the collector: a bad frame is skipped.
            const receivedAt = deps.now();
            try { recorder?.record(recordedBook(asset, event.snapshot as unknown as Record<string, unknown>, receivedAt)); }
            catch { if (recorder) recorder.dropped += 1; }
          }
          else if (event.kind === "bookTop") {
            // One side empty (near the close): record it; the strategy and the
            // published snapshot keep requiring both sides.
            try { recorder?.record(recordedTop(asset, event, deps.now())); }
            catch { if (recorder) recorder.dropped += 1; }
          }
          else if (event.kind === "marketTrade") {
            // Trade prints go into the same recording (rows k:"t").
            try {
              const row = recordedTrade(asset, { marketId: market.conditionId, roundId: market.roundId,
                upToken: market.upToken, downToken: market.downToken }, event, deps.now());
              if (row) recorder?.record(row);
            } catch { if (recorder) recorder.dropped += 1; }
          }
          else if (event.kind === "bookStatus") {
            if (event.healthy) projection.markConnected(true);
            else if (event.connected) { projection.markConnected(true); projection.invalidateBook(); }
            else projection.disconnect();
          }
        }, market.upToken, market.downToken, market.end,
        { marketId: market.conditionId, roundId: market.roundId,
          yesAssetId: market.upToken, noAssetId: market.downToken,
          sequenceBase: previous?.snapshot.sequence });
        active.set(market.slug, { market, projection, stop: control.stop });
        safePublish();
      })().catch(error => {
        if (!stopped) { failure ??= error; stop(); }
      }).finally(() => { discoveryJobs.delete(key); });
      discoveryJobs.set(key, job);
      return job;
    }));
    return Promise.allSettled(jobs).then(() => {});
  };
  const scheduleBoundaryDiscovery = () => {
    if (stopped) return;
    const nowMs = deps.now() * 1000;
    const boundaryMs = (Math.floor(nowMs / (MARKET_WINDOW_SEC * 1000)) + 1) * MARKET_WINDOW_SEC * 1000;
    const boundaryPrepared = () => assets.every(asset => [...active.values()].some(item =>
      item.market.asset === asset && item.market.start <= boundaryMs / 1000 && boundaryMs / 1000 < item.market.end));
    const stopPrewarm = () => {
      clearInterval(discoveryPrewarmTimer);
      discoveryPrewarmTimer = undefined;
    };
    const prewarm = () => {
      void discover(boundaryMs / 1000, true).finally(() => { if (boundaryPrepared()) stopPrewarm(); });
    };
    const beginPrewarm = () => {
      if (stopped || discoveryPrewarmTimer || boundaryPrepared()) return;
      prewarm();
      discoveryPrewarmTimer = setInterval(prewarm, DISCOVERY_PREWARM_RETRY_MS);
    };
    discoveryPrewarmStartTimer = setTimeout(beginPrewarm, Math.max(0, boundaryMs - DISCOVERY_PREWARM_MS - nowMs));
    discoveryBoundaryTimer = setTimeout(() => { void discover(boundaryMs / 1000, true); }, Math.max(0, boundaryMs - nowMs));
    discoveryPrewarmStopTimer = setTimeout(() => {
      stopPrewarm();
      scheduleBoundaryDiscovery();
    }, Math.max(0, boundaryMs + DISCOVERY_POST_BOUNDARY_MS - nowMs));
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
      scheduleBoundaryDiscovery();
      if (options.durationSec > 0) durationTimer = setTimeout(stop, options.durationSec * 1000);
      void discover();
    }
    await finished;
  } finally {
    clearInterval(publishTimer); clearInterval(discoveryTimer); clearTimeout(durationTimer);
    clearTimeout(discoveryPrewarmStartTimer); clearTimeout(discoveryBoundaryTimer);
    clearInterval(discoveryPrewarmTimer); clearTimeout(discoveryPrewarmStopTimer);
    for (const item of active.values()) { item.stop(); item.projection.disconnect(); }
    for (const reference of references) { try { reference.stop(); } catch { /* shutting down */ } }
    safePublish();
    await Promise.allSettled(discoveryJobs.values());
    await recorder?.close();
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
