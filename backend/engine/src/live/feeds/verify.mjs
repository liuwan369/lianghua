import WebSocket from "ws";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { findFiveMinuteMarket, normalizeMarketAsset } from "../../../dist/live/discovery.js";
import { runPolymarketFeed, PM_WS_SOURCE_FRESH_MAX_MS } from "../../../dist/live/feeds/polymarket.js";
import { FeedQueue } from "../../../dist/live/feeds/index.js";
import * as referenceModule from "../../../dist/live/feeds/btc.js";

// Public market data only: no account, strategy, or order clients.
// npm run build && node src/live/feeds/verify.mjs --assets btc,eth,sol
// --duration-sec 330 --disconnect-after-sec 15 --reference --require-depth
const { values } = parseArgs({ options: {
  asset: { type: "string", default: "btc" }, assets: { type: "string" },
  "duration-sec": { type: "string", default: "25" },
  "disconnect-after-sec": { type: "string", default: "0" },
  "require-depth": { type: "boolean", default: false }, reference: { type: "boolean", default: false },
} });
const assets = [...new Set((values.assets ?? values.asset).split(",").map(value => normalizeMarketAsset(value)))];
const durationSec = Number(values["duration-sec"]), disconnectSec = Number(values["disconnect-after-sec"]);
if (!assets.length || assets.length > 8 || !Number.isFinite(durationSec) || durationSec < 1 || durationSec > 600
  || !Number.isFinite(disconnectSec) || disconnectSec < 0 || disconnectSec >= durationSec) {
  throw new Error("use 1..8 assets, duration 1..600 seconds; disconnect must be 0 or less than duration");
}
const startedAt = Date.now(), abort = new AbortController(), queue = new FeedQueue();
const records = new Map(), tokenRecords = new Map(), sockets = new Map(), attempts = new Map(), references = new Map();
const currentRounds = new Map();
const failures = new Set();
const assetStats = new Map(assets.map(asset => [asset, { asset, discoveryAttempts: 0, discoveryMisses: 0,
  discoveryErrors: 0, acceptedFreshPairs: 0, roundsDiscovered: [], roundsObserved: [], forcedDisconnects: 0 }]));
const eventTypes = new Set(["book", "price_change", "best_bid_ask", "tick_size_change", "last_trade_price", "new_market", "market_resolved"]);
const wire = { frames: 0, malformedJson: 0, malformedEvents: 0, controlFrames: 0, eventTypes: {} };
const bounds = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 1000, Infinity];
const metric = () => ({ count: 0, sum: 0, min: Infinity, max: 0, bins: bounds.map(() => 0) });
function addMetric(m, n) {
  if (!Number.isFinite(n) || n < 0) return;
  m.count++; m.sum += n; m.min = Math.min(m.min, n); m.max = Math.max(m.max, n);
  m.bins[bounds.findIndex(bound => n <= bound)]++;
}
function summarizeMetric(m) {
  if (!m.count) return null;
  const percentile = p => {
    let n = 0;
    for (let i = 0; i < bounds.length; i++) {
      n += m.bins[i];
      if (n >= Math.ceil(m.count * p)) return Number.isFinite(bounds[i]) ? bounds[i] : ">1000";
    }
  };
  return { count: m.count, min: m.min, max: m.max, mean: m.sum / m.count,
    p50UpperBoundMs: percentile(0.5), p99UpperBoundMs: percentile(0.99) };
}
function count(obj, key) { obj[key] = (obj[key] ?? 0) + 1; }
function numeric(value) {
  return (typeof value === "number" || typeof value === "string" && value.trim()) && Number.isFinite(Number(value))
    ? Number(value) : undefined;
}
const sideStats = () => ({ baselines: 0, deltas: 0, topEvents: 0, emptyTopEvents: 0, boundaryTopEvents: 0,
  levels: 0, malformedLevels: 0, boundaryLevels: 0, zeroSizeLevels: 0, lastBaselineLengths: null,
  equalTimestampFrames: 0, olderTimestampFrames: 0, invalidTimestampFrames: 0, lastTimestamp: 0 });
function inspectLevels(side, levels) {
  if (!Array.isArray(levels)) { side.malformedLevels++; return; }
  for (const level of levels) {
    side.levels++;
    const p = numeric(level?.price), size = numeric(level?.size);
    if (p == null || size == null || size < 0) side.malformedLevels++;
    if (p != null && (p <= 0 || p >= 1)) side.boundaryLevels++;
    if (size === 0) side.zeroSizeLevels++;
  }
}
function inspectTop(side, event) {
  if (!Object.hasOwn(event, "best_bid") && !Object.hasOwn(event, "best_ask")) return;
  side.topEvents++;
  const bid = numeric(event.best_bid), ask = numeric(event.best_ask);
  if (bid == null || ask == null) side.emptyTopEvents++;
  else if (bid <= 0 || bid >= 1 || ask <= 0 || ask >= 1) side.boundaryTopEvents++;
}
function inspectFrame(data) {
  wire.frames++;
  const text = data.toString();
  if (text === "PONG" || text === "PING") { wire.controlFrames++; return; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { wire.malformedJson++; return; }
  const touched = new Map(); // equality is counted across frames, not within one frame
  const sideFor = token => { const rec = tokenRecords.get(token); return rec?.raw[token === rec.market.upToken ? "YES" : "NO"]; };
  const timestamp = (side, event) => {
    const raw = numeric(event.timestamp ?? event.ts ?? event.time), ms = raw == null ? NaN : raw > 1e12 ? raw : raw * 1000;
    if (!Number.isFinite(ms) || ms <= 0) { side.invalidTimestampFrames++; return; }
    const times = touched.get(side) ?? new Set(); times.add(ms); touched.set(side, times);
  };
  for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!event || typeof event !== "object") { wire.malformedEvents++; continue; }
    const type = String(event.event_type ?? "unknown").toLowerCase();
    count(wire.eventTypes, eventTypes.has(type) ? type : "unknown");
    const side = sideFor(event.asset_id ?? event.token_id);
    if (type === "book" && side) {
      side.baselines++; timestamp(side, event);
      const bids = event.bids ?? event.buys, asks = event.asks ?? event.sells;
      side.lastBaselineLengths = { bids: Array.isArray(bids) ? bids.length : null, asks: Array.isArray(asks) ? asks.length : null };
      inspectLevels(side, bids); inspectLevels(side, asks);
    } else if (type === "price_change") {
      const changes = event.price_changes ?? event.changes;
      if (!Array.isArray(changes)) { wire.malformedEvents++; continue; }
      for (const change of changes) {
        const changedSide = sideFor(change?.asset_id ?? change?.token_id ?? event.asset_id);
        if (!changedSide || !change || typeof change !== "object") continue;
        changedSide.deltas++; timestamp(changedSide, event); inspectLevels(changedSide, [change]); inspectTop(changedSide, change);
      }
    } else if (type === "best_bid_ask" && side) inspectTop(side, event);
  }
  for (const [side, times] of touched) {
    for (const ms of times) {
      if (ms === side.lastTimestamp) side.equalTimestampFrames++;
      if (ms < side.lastTimestamp) side.olderTimestampFrames++;
    }
    side.lastTimestamp = Math.max(side.lastTimestamp, ...times);
  }
}
// Observe only sockets carrying this process's requested token subscriptions.
const originalSend = WebSocket.prototype.send;
function observedSend(...args) {
  let sub;
  try { sub = JSON.parse(String(args[0])); } catch { /* heartbeat */ }
  if (this.url === "wss://ws-subscriptions-clob.polymarket.com/ws/market" && Array.isArray(sub?.assets_ids)) {
    const owners = new Set(sub.assets_ids.map(token => tokenRecords.get(token)).filter(Boolean));
    if (owners.size && !sockets.has(this)) {
      for (const rec of owners) rec.connections++;
      this.on("message", inspectFrame);
      const closed = () => { this.removeListener("message", inspectFrame); sockets.delete(this); };
      this.once("close", closed); sockets.set(this, { owners, closed });
    }
  }
  return originalSend.apply(this, args);
}
function identityValid(s, m) {
  return s.marketId === m.conditionId && s.roundId === m.roundId && s.YES?.assetId === m.upToken && s.NO?.assetId === m.downToken
    && Number.isSafeInteger(s.sequence) && s.sequence > 0 && s.YES.sequence === s.sequence && s.NO.sequence === s.sequence;
}
function sourceValid(s, m) {
  return [s.sourceAt, s.expiresAt, s.YES?.sourceAt, s.NO?.sourceAt, s.YES?.expiresAt, s.NO?.expiresAt]
    .every(value => Number.isFinite(value) && value > 0)
    && s.expiresAt <= m.end && s.YES.expiresAt <= m.end && s.NO.expiresAt <= m.end;
}
function fresh(s, m, now) {
  return now >= m.start && now < m.end && [s.expiresAt, s.YES.expiresAt, s.NO.expiresAt].every(at => at > now)
    && [s.YES.sourceAt, s.NO.sourceAt].every(at => at <= now + 1 && (now - at) * 1000 <= PM_WS_SOURCE_FRESH_MAX_MS);
}
const depthLengths = s => ({ yesBids: s.YES?.bids?.length ?? null, yesAsks: s.YES?.asks?.length ?? null,
  noBids: s.NO?.bids?.length ?? null, noAsks: s.NO?.asks?.length ?? null });
function validDepth(s) {
  for (const side of [s.YES, s.NO]) for (const [name, top, descending] of [["bids", side.bid, true], ["asks", side.ask, false]]) {
    const levels = side[name];
    if (levels == null) continue;
    if (!Array.isArray(levels) || levels.length > 5 || levels.length && levels[0]?.[0] !== top) return false;
    if (levels.some((level, i) => !Array.isArray(level) || level.length !== 2
      || !(level[0] > 0 && level[0] < 1) || !(level[1] > 0) || !Number.isFinite(level[1])
      || (i > 0 && (descending ? levels[i - 1][0] <= level[0] : levels[i - 1][0] >= level[0])))) return false;
  }
  return true;
}
function drain() { const out = []; for (let event; (event = queue.tryPop());) out.push(event); return out; }
function accept(rec, s) {
  const now = Date.now() / 1000;
  if (!fresh(s, rec.market, now)) { rec.queueNonCurrentPairs++; return; }
  rec.acceptedFreshPairs++; assetStats.get(rec.market.asset).acceptedFreshPairs++;
  rec.latest = s;
  if (rec.firstAcceptedAt == null) assetStats.get(rec.market.asset).roundsObserved.push(rec.market.roundId);
  rec.firstAcceptedAt ??= now; rec.lastAcceptedAt = now;
  rec.depthLengths = depthLengths(s);
  if (Object.values(rec.depthLengths).every(n => n >= 5)) rec.fullDepthPairs++;
  if (Object.values(rec.depthLengths).some(n => n === null)) rec.missingDepthPairs++;
  if (!validDepth(s)) rec.depthErrors++;
  addMetric(rec.processing, s.processedAtMonoMs - s.receivedAtMonoMs);
  addMetric(rec.sourceAge, Math.max(now - s.YES.sourceAt, now - s.NO.sourceAt) * 1000);
  if (rec.disconnected && !rec.recoveredAt && rec.connections > rec.disconnected.connections
    && s.sequence > rec.disconnected.sequence && s.sourceAt >= rec.disconnected.sourceAt) rec.recoveredAt = Date.now();
}
function onEvent(rec, event) {
  if (event.kind === "bookStatus") count(rec.statuses, `${event.connected ?? "unknown"}:${event.reason ?? event.healthy}`);
  if (event.kind !== "book") { queue.push(event); drain(); return; }
  const s = event.snapshot; rec.rawPairs++;
  if (!identityValid(s, rec.market)) { rec.identityErrors++; return; }
  if (!sourceValid(s, rec.market)) { rec.timeErrors++; return; }
  if ([s.YES, s.NO].some(side => !(side.bid > 0 && side.bid < 1 && side.ask > 0 && side.ask < 1 && side.bid <= side.ask))) {
    rec.priceErrors++; return;
  }
  const previous = rec.previous;
  if (previous) {
    if (s.sequence <= previous.sequence) rec.sequenceRegressions++;
    if (s.sourceAt < previous.sourceAt) rec.sourceRegressions++;
    if (s.YES.sourceAt < previous.YES.sourceAt) rec.yesSourceRegressions++;
    if (s.NO.sourceAt < previous.NO.sourceAt) rec.noSourceRegressions++;
  }
  rec.previous = s;
  const expired = Math.min(s.expiresAt, s.YES.expiresAt, s.NO.expiresAt) <= Date.now() / 1000;
  if (expired) rec.rawExpiredPairs++;
  queue.push(event);
  const accepted = drain().filter(candidate => candidate.kind === "book");
  if (!accepted.length) rec.queueDroppedPairs++;
  for (const candidate of accepted) { if (expired) rec.expiredAcceptedErrors++; accept(rec, candidate.snapshot); }
  // Explicit synthetic queue checks, never included in live pair counts.
  if (accepted.length && !rec.expiryProbe) {
    queue.push({ kind: "book", snapshot: { ...s, sequence: s.sequence + 100, expiresAt: Date.now() / 1000 - 1 } });
    rec.expiryProbe = drain().some(candidate => candidate.kind === "book") ? "FAILED" : "dropped";
  }
  if (accepted.length && previous && !rec.replayProbe) {
    queue.push({ kind: "book", snapshot: previous });
    rec.replayProbe = drain().some(candidate => candidate.kind === "book") ? "FAILED" : "dropped";
  }
}
function startMarket(market) {
  const key = `${market.asset}:${market.roundId}`;
  if (records.has(key)) return;
  const rec = { market, rawPairs: 0, rawExpiredPairs: 0, acceptedFreshPairs: 0, queueDroppedPairs: 0, queueNonCurrentPairs: 0,
    fullDepthPairs: 0, missingDepthPairs: 0, identityErrors: 0, timeErrors: 0, priceErrors: 0, depthErrors: 0,
    expiredAcceptedErrors: 0, sequenceRegressions: 0, sourceRegressions: 0, yesSourceRegressions: 0, noSourceRegressions: 0,
    connections: 0, statuses: {}, processing: metric(), sourceAge: metric(), raw: { YES: sideStats(), NO: sideStats() } };
  records.set(key, rec);
  for (const token of [market.upToken, market.downToken]) {
    if (tokenRecords.has(token)) failures.add(`token_reused:${key}`);
    tokenRecords.set(token, rec);
  }
  assetStats.get(market.asset).roundsDiscovered.push(market.roundId);
  console.log("DISCOVERY", JSON.stringify(market));
  rec.feed = runPolymarketFeed(event => onEvent(rec, event), market.upToken, market.downToken, market.end,
    { marketId: market.conditionId, roundId: market.roundId });
}
async function discover(asset, round) {
  const key = `${asset}:${round}`;
  if (records.has(key) || Date.now() - (attempts.get(key) ?? 0) < 5000) return;
  attempts.set(key, Date.now()); assetStats.get(asset).discoveryAttempts++;
  try {
    const market = await findFiveMinuteMarket(asset, { now: round + 1,
      allowCollectorFallback: false, directOnly: true, signal: abort.signal });
    if (abort.signal.aborted) return;
    if (!market) { assetStats.get(asset).discoveryMisses++; return; }
    if (market.asset !== asset || market.roundId !== String(round) || market.start !== round || market.end !== round + 300) {
      failures.add(`discovery_identity:${key}`); return;
    }
    if (market.end > Date.now() / 1000) startMarket(market);
  } catch { if (!abort.signal.aborted) assetStats.get(asset).discoveryErrors++; }
}
function forceDisconnect() {
  const now = Date.now();
  for (const [socket, { owners }] of sockets) {
    const current = [...owners].filter(rec => rec.market.start <= now / 1000 && now / 1000 < rec.market.end);
    if (!current.length || socket.readyState !== WebSocket.OPEN) continue;
    for (const rec of current) {
      rec.disconnected = { at: now, connections: rec.connections, sequence: rec.previous?.sequence ?? 0, sourceAt: rec.previous?.sourceAt ?? 0 };
      assetStats.get(rec.market.asset).forcedDisconnects++;
    }
    console.log("FORCE_DISCONNECT", JSON.stringify(current.map(rec => ({ asset: rec.market.asset, roundId: rec.market.roundId }))));
    socket.terminate();
  }
}
function startReferences() {
  if (!values.reference) return;
  for (const asset of assets) {
    const ref = { asset, capability: referenceModule.referenceFeedCapability?.(asset)
      ?? { asset, supported: false, reason: "capability_api_unavailable" }, rawSignals: 0, acceptedFreshSignals: 0,
      queueDroppedSignals: 0, identityErrors: 0, timeRegressions: 0, venues: {} };
    references.set(asset, ref);
    if (!ref.capability.supported) { failures.add(`reference_unavailable:${asset}:${ref.capability.reason}`); continue; }
    try {
      ref.feed = referenceModule.runReferenceFeed(event => {
        if (event.kind === "venue") { count(ref.venues, event.venue); return; }
        if (event.kind !== "btc" && event.kind !== "oracle") return;
        ref.rawSignals++;
        if (event.asset !== asset || event.kind === "btc" && asset !== "btc") { ref.identityErrors++; return; }
        if (ref.lastTs != null && event.tsUnix < ref.lastTs) ref.timeRegressions++;
        ref.lastTs = event.tsUnix;
        queue.push(event);
        const accepted = drain().filter(candidate => candidate.kind === "btc" || candidate.kind === "oracle");
        if (!accepted.length) ref.queueDroppedSignals++;
        for (const signal of accepted) {
          if (signal.asset !== asset || signal.expiresAt <= Date.now() / 1000) ref.identityErrors++;
          else { ref.acceptedFreshSignals++; ref.latest = signal; }
        }
      }, asset);
    } catch { failures.add(`reference_start_failed:${asset}`); }
  }
}
const stopRequested = () => abort.abort();
const durationTimer = setTimeout(stopRequested, durationSec * 1000);
const disconnectTimer = disconnectSec > 0 ? setTimeout(forceDisconnect, disconnectSec * 1000) : undefined;
process.once("SIGINT", stopRequested); process.once("SIGTERM", stopRequested);
async function discoveryLoop(asset) {
  while (!abort.signal.aborted) {
    const now = Date.now() / 1000, round = Math.floor(now / 300) * 300;
    const key = `${asset}:${round}`;
    if (!currentRounds.has(key)) currentRounds.set(key, { since: Date.now(), end: (round + 300) * 1000 });
    for (const rec of records.values()) if (rec.feed && rec.market.end <= now) {
      rec.feed.stop(); rec.feed = undefined;
    }

    // Each asset owns its discovery timer. A slow or unavailable ETH/SOL
    // request cannot delay a BTC feed that was already discovered.
    const requests = [discover(asset, round)];
    if (round + 300 - now <= 30) requests.push(discover(asset, round + 300));
    await Promise.allSettled(requests);
    try {
      await delay(1000, undefined, { signal: abort.signal });
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  }
}
try {
  WebSocket.prototype.send = observedSend;
  startReferences();
  await Promise.allSettled(assets.map(asset => discoveryLoop(asset)));
} catch (error) {
  if (!abort.signal.aborted) { failures.add("probe_internal_error"); console.error("PROBE_ERROR", error?.name ?? "Error"); }
} finally {
  abort.abort(); clearTimeout(durationTimer); clearTimeout(disconnectTimer);
  process.removeListener("SIGINT", stopRequested); process.removeListener("SIGTERM", stopRequested);
  for (const rec of records.values()) rec.feed?.stop();
  for (const ref of references.values()) { ref.status = ref.feed?.getStatus?.() ?? null; ref.feed?.stop(); }
  for (const [socket, { closed }] of sockets) {
    socket.removeListener("message", inspectFrame); socket.removeListener("close", closed);
  }
  if (WebSocket.prototype.send === observedSend) WebSocket.prototype.send = originalSend;
}
const results = [...records.values()].map(rec => {
  const key = `${rec.market.asset}:${rec.market.roundId}`;
  for (const field of ["identityErrors", "timeErrors", "priceErrors", "depthErrors", "expiredAcceptedErrors",
    "sequenceRegressions", "sourceRegressions", "yesSourceRegressions", "noSourceRegressions"]) if (rec[field]) failures.add(`${field}:${key}`);
  if (rec.disconnected && !rec.recoveredAt) failures.add(`recovery_failed:${key}`);
  if (rec.expiryProbe === "FAILED" || rec.replayProbe === "FAILED") failures.add(`queue_filter_failed:${key}`);
  const { feed, processing, sourceAge, previous, latest, ...stats } = rec;
  return { ...stats, processingMs: summarizeMetric(processing), sourceAgeMs: summarizeMetric(sourceAge),
    recoveryMs: rec.recoveredAt ? rec.recoveredAt - rec.disconnected.at : null,
    latest: latest && { marketId: latest.marketId, roundId: latest.roundId, sequence: latest.sequence,
      sourceAt: latest.sourceAt, expiresAt: latest.expiresAt, YES: latest.YES, NO: latest.NO } };
});
for (const [key, window] of currentRounds) {
  if (Math.min(Date.now(), window.end) - window.since >= 10_000 && !records.get(key)?.acceptedFreshPairs) {
    failures.add(`round_without_fresh_pair:${key}`);
  }
}
for (const stats of assetStats.values()) {
  if (!stats.acceptedFreshPairs) failures.add(`no_current_fresh_pair:${stats.asset}`);
  if (disconnectSec > 0 && !stats.forcedDisconnects) failures.add(`disconnect_not_exercised:${stats.asset}`);
  if (values["require-depth"] && !results.some(rec => rec.market.asset === stats.asset && rec.fullDepthPairs > 0)) failures.add(`five_levels_not_observed:${stats.asset}`);
}
const referenceResults = [...references.values()].map(({ feed, ...ref }) => {
  if (!ref.acceptedFreshSignals || ref.identityErrors || ref.timeRegressions) failures.add(`reference_failed:${ref.asset}`);
  return ref;
});
console.log("PROBE", JSON.stringify({ mode: "public-read-only", durationMs: Date.now() - startedAt, success: failures.size === 0,
  failures: [...failures], assets: [...assetStats.values()], wire, rounds: results, references: referenceResults,
  notes: ["Future-round prewarm is not counted as a current fresh pair.",
    "Missing or fewer than five depth levels remain explicit; no levels are fabricated.",
    "Expiry/replay injections test FeedQueue only; rawExpiredPairs and raw timestamp counters are live observations.",
    "Raw-frame inspection adds probe overhead; processing metrics are not a production latency benchmark."] }));
if (failures.size) process.exitCode = 1;
