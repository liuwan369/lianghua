import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { OrderBook } from "../orderbook.js";
import {
  type BookSnapshot,
  type FeedSink,
  type MarketAssetSnapshot,
  nowUnix,
} from "./index.js";

const PM_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// A connected socket can remain OPEN after the venue stops delivering data.
// The venue can also keep sending frames whose exchange timestamps are old.
// Reconnect that second failure mode instead of letting the strategy wait on a
// socket that only appears healthy because bytes are still arriving.
export const PM_WS_MESSAGE_TIMEOUT_MS = 15_000;
export const PM_WS_BILATERAL_QUOTE_TIMEOUT_MS = 30_000;
export const PM_WS_SOURCE_FRESH_MAX_MS = 2_000;
// Reconnect promptly when both outcome frames keep arriving with stale venue
// timestamps. The strategy still requires <=2s source age before trading; this
// watchdog only bounds how long a bad socket can keep that gate closed.
export const PM_WS_SOURCE_AGE_TIMEOUT_MS = 5_000;
export const PM_WS_DEPTH_REFRESH_MS = 250;
export const PM_WS_RECONNECT_BASE_MS = 250;
export const PM_WS_RECONNECT_MAX_MS = 30_000;
const PM_WS_MAX_CLOCK_SKEW_MS = 1_000;
const PM_WS_WATCHDOG_INTERVAL_MS = 1_000;
const PM_WS_RECONNECT_STABLE_MS = 30_000;

export interface AppliedBookTimes {
  upMs: number;
  downMs: number;
  upInitialized?: boolean;
  downInitialized?: boolean;
}
export interface MarketFeedIdentity {
  marketId?: string;
  roundId?: string;
  sequenceBase?: number;
}

function num(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function exchangeTimeMs(event: Record<string, unknown>): number | undefined {
  const value = num(event.timestamp ?? event.ts ?? event.time);
  if (value == null || value <= 0) return undefined;
  return value > 1e12 ? value : value * 1000;
}

function bookFeedHealthy(
  connected: boolean,
  hasCompleteBook: boolean,
  lastUpAtMs: number,
  lastDownAtMs: number,
  nowMs = Date.now(),
  maxStaleMs = 2_000,
): boolean {
  return (
    connected &&
    hasCompleteBook &&
    lastUpAtMs > 0 &&
    lastDownAtMs > 0 &&
    nowMs - lastUpAtMs <= maxStaleMs &&
    nowMs - lastDownAtMs <= maxStaleMs
  );
}

function sideOf(
  tok: string,
  upToken: string,
  downToken: string,
): boolean | undefined {
  if (tok === upToken) return true;
  if (tok === downToken) return false;
  return undefined;
}

function levelList(v: unknown): [number, number][] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: [number, number][] = [];
  for (const lv of v) {
    if (!lv || typeof lv !== "object") return undefined;
    const o = lv as Record<string, unknown>;
    const p = num(o.price);
    const size = num(o.size);
    if (p == null || p <= 0 || p >= 1 || size == null || size <= 0) return undefined;
    out.push([p, size]);
  }
  return out;
}

function applyMessage(
  v: unknown,
  upToken: string,
  downToken: string,
  up: OrderBook,
  dn: OrderBook,
  applied: AppliedBookTimes = { upMs: 0, downMs: 0 },
): { upUpdated: boolean; downUpdated: boolean; upOrder: number; downOrder: number } {
  let upUpdated = false;
  let downUpdated = false;
  const events = Array.isArray(v) ? v : [v];
  let upOrder = -1;
  let downOrder = -1;
  let frameUpMs: number | undefined;
  let frameDownMs: number | undefined;
  const acceptsTimestamp = (side: boolean, eventMs: number | undefined): boolean => {
    if (eventMs == null) return false;
    const lastMs = side ? applied.upMs : applied.downMs;
    const frameMs = side ? frameUpMs : frameDownMs;
    if (eventMs < lastMs) return false;
    // Equal timestamps are valid only for later events in this same frame.
    // Across websocket frames, equality is treated as a duplicate and rejected.
    if (eventMs === lastMs && frameMs !== eventMs) return false;
    if (eventMs > lastMs) {
      if (side) frameUpMs = eventMs;
      else frameDownMs = eventMs;
    }
    return (side ? frameUpMs : frameDownMs) === eventMs;
  };
  for (const [eventOrder, raw] of events.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const eventType = String(e.event_type ?? "").toLowerCase();
    if (eventType !== "book" && eventType !== "price_change") continue;
    const eventMs = exchangeTimeMs(e);
    if (eventMs == null) continue;
    const topTok =
      typeof e.asset_id === "string"
        ? e.asset_id
        : typeof e.token_id === "string"
          ? e.token_id
          : undefined;

    if (topTok) {
      const side = sideOf(topTok, upToken, downToken);
      if (side != null) {
        const bids = levelList(e.bids ?? e.buys);
        const asks = levelList(e.asks ?? e.sells);
        const initialized = side ? applied.upInitialized : applied.downInitialized;
        const lastMs = side ? applied.upMs : applied.downMs;
        // Equal-time reconnect snapshots rebuild depth without refreshing
        // liveness or publishing an old quote as a new observation.
        const bootstrap = initialized === false && eventMs === lastMs;
        if (bids && asks && (bootstrap || acceptsTimestamp(side, eventMs))) {
          const ob = side ? up : dn;
          ob.applySnapshot(bids, asks);
          if (side) applied.upInitialized = true;
          else applied.downInitialized = true;
          if (bootstrap) continue;
          if (side) {
            upUpdated = true;
            upOrder = eventOrder;
            if (eventMs != null) applied.upMs = Math.max(applied.upMs, eventMs);
          } else {
            downUpdated = true;
            downOrder = eventOrder;
            if (eventMs != null) applied.downMs = Math.max(applied.downMs, eventMs);
          }
        }
      }
    }

    const changes = e.price_changes ?? e.changes;
    if (Array.isArray(changes)) {
      for (const ch of changes) {
        if (!ch || typeof ch !== "object") continue;
        const c = ch as Record<string, unknown>;
        const tok =
          typeof c.asset_id === "string"
            ? c.asset_id
            : typeof c.token_id === "string"
              ? c.token_id
              : topTok;
        if (typeof tok !== "string") continue;
        const side = sideOf(tok, upToken, downToken);
        if (side == null) continue;
        if ((side ? applied.upInitialized : applied.downInitialized) === false) continue;
        const price = num(c.price);
        const size = num(c.size);
        if (price == null || price <= 0 || price >= 1 || size == null || size < 0) continue;
        const dside = String(c.side ?? "").toUpperCase();
        const isBuy = dside === "BUY" || dside === "BID";
        const isSell = dside === "SELL" || dside === "ASK";
        if (isBuy || isSell) {
          if (!acceptsTimestamp(side, eventMs)) continue;
          const ob = side ? up : dn;
          ob.applyChange(price, size, isBuy);
          if (side) {
            upUpdated = true;
            upOrder = eventOrder;
            if (eventMs != null) applied.upMs = Math.max(applied.upMs, eventMs);
          } else {
            downUpdated = true;
            downOrder = eventOrder;
            if (eventMs != null) applied.downMs = Math.max(applied.downMs, eventMs);
          }
        }
      }
    }
  }
  return { upUpdated, downUpdated, upOrder, downOrder };
}

export interface BestBidAskChange {
  side: "up" | "down";
  bid?: number;
  ask?: number;
  exchangeMs: number;
  order: number;
  clear?: boolean;
  receivedAtUnix?: number;
  receivedAtMonoMs?: number;
  processedAtMonoMs?: number;
}

/** Parse every fast top update in a frame; callers apply the frame atomically. */
function bestBidAskChanges(
  v: unknown,
  upToken: string,
  downToken: string,
  applied: AppliedBookTimes = { upMs: 0, downMs: 0 },
): BestBidAskChange[] {
  const changes: BestBidAskChange[] = [];
  const accepted = { ...applied };
  let frameUpMs: number | undefined;
  let frameDownMs: number | undefined;
  const acceptsTimestamp = (side: boolean, exchangeMs: number): boolean => {
    const lastMs = side ? accepted.upMs : accepted.downMs;
    const frameMs = side ? frameUpMs : frameDownMs;
    if (exchangeMs < lastMs) return false;
    // Equal timestamps are duplicates across frames, but multiple ordered
    // events in one venue frame may legitimately share a timestamp.
    if (exchangeMs === lastMs && frameMs !== exchangeMs) return false;
    if (exchangeMs > lastMs) {
      if (side) frameUpMs = exchangeMs;
      else frameDownMs = exchangeMs;
    }
    return true;
  };
  const events = Array.isArray(v) ? v : [v];
  for (let order = 0; order < events.length; order += 1) {
    const raw = events[order];
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    const eventType = String(event.event_type ?? "").toLowerCase();
    const exchangeMs = exchangeTimeMs(event);
    if (exchangeMs == null) continue;
    const priceChanges = eventType === "price_change" && Array.isArray(event.price_changes)
      ? event.price_changes
      : undefined;
    const candidateCount = eventType === "best_bid_ask" ? 1 : priceChanges?.length ?? 0;
    for (let index = 0; index < candidateCount; index += 1) {
      const candidate = eventType === "best_bid_ask" ? event : priceChanges![index];
      if (!candidate || typeof candidate !== "object") continue;
      const quote = candidate as Record<string, unknown>;
      const token = typeof quote.asset_id === "string" ? quote.asset_id : undefined;
      const side = token ? sideOf(token, upToken, downToken) : undefined;
      if (side == null) continue;
      const hasBid = Object.prototype.hasOwnProperty.call(quote, "best_bid");
      const hasAsk = Object.prototype.hasOwnProperty.call(quote, "best_ask");
      if (!hasBid || !hasAsk) continue;
      const bid = num(quote.best_bid), ask = num(quote.best_ask);
      const emptyBid = quote.best_bid == null || quote.best_bid === "";
      const emptyAsk = quote.best_ask == null || quote.best_ask === "";
      const candidateOrder = eventType === "best_bid_ask" ? order : order + (index + 1) / (candidateCount + 1);
      if (bid == null || ask == null) {
        if ((bid == null && !emptyBid) || (ask == null && !emptyAsk)) continue;
        // A timestamp is the only venue ordering key available on this
        // channel. Empty quotes are valid tombstones and still advance it.
        if (!acceptsTimestamp(side, exchangeMs)) continue;
        // Empty best quotes are venue tombstones, not malformed data. Advance
        // the timestamp watermark so an older quote cannot be restored.
        changes.push({ side: side ? "up" : "down", exchangeMs, order: candidateOrder, clear: true });
        if (side) accepted.upMs = Math.max(accepted.upMs, exchangeMs);
        else accepted.downMs = Math.max(accepted.downMs, exchangeMs);
        continue;
      }
      if (!(bid > 0 && bid < 1) || !(ask > 0 && ask < 1) || bid > ask) continue;
      // Equal timestamps are ordered only within this frame so a delayed
      // duplicate from a later frame cannot replace a newer top-of-book frame.
      if (!acceptsTimestamp(side, exchangeMs)) continue;
      // Preserve order inside a frame so same-timestamp L2 and top updates
      // are resolved in venue frame order without allocating mapped objects.
      changes.push({ side: side ? "up" : "down", bid, ask, exchangeMs, order: candidateOrder });
      if (side) accepted.upMs = Math.max(accepted.upMs, exchangeMs);
      else accepted.downMs = Math.max(accepted.downMs, exchangeMs);
    }
  }
  return changes;
}

export function reconnectDelayMs(attempt: number, random = Math.random()): number {
  const boundedAttempt = Math.max(0, Math.min(20, Math.floor(attempt)));
  const cap = Math.min(PM_WS_RECONNECT_BASE_MS * 2 ** boundedAttempt, PM_WS_RECONNECT_MAX_MS);
  return Math.max(0, Math.min(1, random)) * cap;
}

function tickSizeChanges(v: unknown): Array<{ token: string; tickSize: number; tsUnix?: number }> {
  const out: Array<{ token: string; tickSize: number; tsUnix?: number }> = [];
  const events = Array.isArray(v) ? v : [v];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (!["tick_size_change", "book"].includes(String(e.event_type ?? "").toLowerCase())) continue;
    const token = typeof e.asset_id === "string" ? e.asset_id : undefined;
    const tickSize = num(e.new_tick_size ?? e.tick_size);
    const atMs = exchangeTimeMs(e);
    if (token && tickSize != null && tickSize > 0 && atMs != null) out.push({ token, tickSize, tsUnix: atMs / 1000 });
  }
  return out;
}

function marketTrades(v: unknown): Array<{
  token: string;
  price: number;
  shares: number;
  takerSide: string;
  tsUnix: number;
}> {
  const out: Array<{
    token: string;
    price: number;
    shares: number;
    takerSide: string;
    tsUnix: number;
  }> = [];
  const events = Array.isArray(v) ? v : [v];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    if (String(event.event_type ?? "").toLowerCase() !== "last_trade_price") continue;
    const token = typeof event.asset_id === "string" ? event.asset_id : undefined;
    const price = num(event.price);
    const shares = num(event.size);
    const takerSide = String(event.side ?? "").toUpperCase();
    const timestampMs = exchangeTimeMs(event);
    if (
      !token || price == null || shares == null || shares <= 0 ||
      (takerSide !== "BUY" && takerSide !== "SELL")
    ) continue;
    out.push({
      token,
      price,
      shares,
      takerSide,
      tsUnix: timestampMs != null ? timestampMs / 1000 : nowUnix(),
    });
  }
  return out;
}

function connectWs(url: string, signal: AbortSignal, timeoutMs = 10_000): Promise<WebSocket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const abort = () => {
      ws.terminate();
      cleanup();
      reject(new Error("websocket connect cancelled"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const timer = setTimeout(() => {
      ws.terminate();
      cleanup();
      reject(new Error(`websocket connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.once("open", () => {
      cleanup();
      resolve(ws);
    });
    ws.once("error", (error) => {
      cleanup();
      reject(error);
    });
    ws.once("close", () => {
      cleanup();
      reject(new Error("websocket closed before open"));
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Polymarket CLOB book websocket feed. */
export function runPolymarketFeed(
  sink: FeedSink,
  upToken: string,
  downToken: string,
  deadline: number,
  identity: MarketFeedIdentity = {},
): { stop: () => void; isHealthy: (maxStaleMs?: number) => boolean } {
  let alive = true;
  const stopSignal = new AbortController();
  let activeWs: WebSocket | undefined;
  let connected = false;
  let hasCompleteBook = false;
  let lastUpAtMs = 0;
  let lastDownAtMs = 0;
  let lastFreshBilateralAtMs = 0;
  let lastBothStaleAtMs = 0;
  const sequenceBase = identity.sequenceBase ?? 0;
  if (!Number.isSafeInteger(sequenceBase) || sequenceBase < 0) throw new Error("sequenceBase must be a non-negative safe integer");
  let sequence = sequenceBase;
  let reconnectAttempt = 0;
  let connectingWs: Promise<WebSocket> | undefined;
  // Keep venue watermarks across reconnects so a replayed frame from the
  // previous socket cannot publish a newer local sequence with an older book.
  let acceptedUpSourceMs = 0;
  let acceptedDownSourceMs = 0;
  let resolvedMarketId = identity.marketId;
  const inferredRoundId = identity.roundId ?? (Number.isFinite(deadline) && deadline % 300 === 0
    ? String(deadline - 300) : undefined);

  const setConnected = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    sink({ kind: "bookStatus", healthy: false, connected: value,
      marketId: resolvedMarketId, roundId: inferredRoundId, yesAssetId: upToken, noAssetId: downToken,
      reason: value ? "connected_waiting_book" : "transport_disconnected", tsUnix: nowUnix() });
  };

  const connect = (): Promise<WebSocket> => {
    if (connectingWs) return connectingWs;
    const task = connectWs(PM_WS, stopSignal.signal);
    connectingWs = task;
    // Keep one in-flight connection attempt per feed. This also prevents a
    // stop/reconnect race from opening a second socket before the first settles.
    void task.then(
      () => { if (connectingWs === task) connectingWs = undefined; },
      () => { if (connectingWs === task) connectingWs = undefined; },
    );
    return task;
  };

  const loop = async () => {
    while (alive && nowUnix() < deadline) {
      try {
        const ws = await connect();
        if (!alive || nowUnix() >= deadline) {
          ws.terminate();
          break;
        }
        activeWs = ws;
        setConnected(true);
        hasCompleteBook = false;
        lastUpAtMs = 0;
        lastDownAtMs = 0;
        lastFreshBilateralAtMs = 0;
        lastBothStaleAtMs = 0;
        ws.send(
          JSON.stringify({
            assets_ids: [upToken, downToken],
            type: "market",
            custom_feature_enabled: true,
          }),
        );
        console.info("polymarket book feed connected + subscribed");

        const up = new OrderBook();
        const dn = new OrderBook();
        const applied: AppliedBookTimes = {
          upMs: acceptedUpSourceMs,
          downMs: acceptedDownSourceMs,
          upInitialized: false,
          downInitialized: false,
        };
        const tickSizes: { up?: number; down?: number } = {};
        const fastApplied: AppliedBookTimes = {
          upMs: acceptedUpSourceMs,
          downMs: acceptedDownSourceMs,
        };
        let fastUp: BestBidAskChange | undefined;
        let fastDown: BestBidAskChange | undefined;
        let publishedUpBid: number | undefined;
        let publishedUpAsk: number | undefined;
        let publishedDownBid: number | undefined;
        let publishedDownAsk: number | undefined;
        let publishedAtMs = 0;
        let upDepth: { bids: [number, number][]; asks: [number, number][] } | undefined;
        let downDepth: { bids: [number, number][]; asks: [number, number][] } | undefined;
        let upDepthAtMs = 0;
        let downDepthAtMs = 0;
        let upFastClearedAtMs = 0;
        let downFastClearedAtMs = 0;
        const tickSizeAt: { up?: number; down?: number } = {};
        let upReceivedAtUnix = 0, downReceivedAtUnix = 0;
        let upReceivedAtMonoMs = 0, downReceivedAtMonoMs = 0;
        let upProcessedAtMonoMs = 0, downProcessedAtMonoMs = 0;
        let reportedHealthy: boolean | undefined;
        const reportHealth = (healthy: boolean, reason: "complete_book" | "incomplete_book" | "stale_book") => {
          if (reportedHealthy === healthy) return;
          reportedHealthy = healthy;
          sink({ kind: "bookStatus", healthy, connected: true,
            marketId: resolvedMarketId, roundId: inferredRoundId, yesAssetId: upToken, noAssetId: downToken,
            reason, tsUnix: nowUnix() });
        };
        const trace = process.env.PM_TRACE != null;

        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, 5000);
        const expiryTimer = Number.isFinite(deadline)
          ? setTimeout(() => {
              hasCompleteBook = false;
              setConnected(false);
              ws.terminate();
            }, Math.max(0, (deadline - nowUnix()) * 1000))
          : undefined;
        const connectedAtMs = Date.now();
        let lastAnyMessageAtMs = connectedAtMs;
        // Empty books still prove subscription activity, but cannot enable trading.
        let lastBilateralActivityAtMs = 0;
        const watchdog = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const nowMs = Date.now();
          if (reportedHealthy && nowMs - lastFreshBilateralAtMs > PM_WS_SOURCE_FRESH_MAX_MS) {
            reportHealth(false, "stale_book");
          }
          const silent = nowMs - lastAnyMessageAtMs >= PM_WS_MESSAGE_TIMEOUT_MS;
          const quoteStalled = nowMs - (lastBilateralActivityAtMs || connectedAtMs)
            >= PM_WS_BILATERAL_QUOTE_TIMEOUT_MS;
          const sourceStalled = hasCompleteBook && lastBothStaleAtMs > 0
            && nowMs - lastBothStaleAtMs >= PM_WS_SOURCE_AGE_TIMEOUT_MS;
          if (!silent && !quoteStalled && !sourceStalled) return;
          const reason = silent ? "message_timeout"
            : sourceStalled ? "source_age_timeout" : "bilateral_quote_timeout";
          console.warn(`polymarket feed watchdog terminating stale socket: ${reason}`);
          hasCompleteBook = false;
          setConnected(false);
          ws.terminate();
        }, PM_WS_WATCHDOG_INTERVAL_MS);

        await new Promise<void>((resolve) => {
          ws.on("message", (data) => {
            if (!alive || !connected || activeWs !== ws || nowUnix() >= deadline) return;
            const receivedAtUnix = nowUnix();
            const receivedAtMonoMs = performance.now();
            lastAnyMessageAtMs = Date.now();
            const t = String(data);
            if (t === "PONG" || t === "pong") return;
            if (trace) console.info(`PM_RAW ${t.slice(0, 220)}`);
            let v: unknown;
            try {
              v = JSON.parse(t) as unknown;
            } catch {
              // Unknown or malformed control frames should not tear down a
              // healthy market socket. The watchdog still handles silence.
              console.warn("polymarket message rejected: invalid_json");
              return;
            }
            try {
              for (const raw of (Array.isArray(v) ? v : [v])) {
                if (!raw || typeof raw !== "object") continue;
                const e = raw as Record<string, unknown>;
                const id = e.market_id ?? e.market ?? e.condition_id;
                const knownAsset = e.asset_id === upToken || e.asset_id === downToken;
                if (!resolvedMarketId && knownAsset && typeof id === "string" && id) resolvedMarketId = id;
              }
              for (const change of tickSizeChanges(v)) {
                const tsUnix = change.tsUnix ?? nowUnix();
                const side = change.token === upToken ? "up" : change.token === downToken ? "down" : undefined;
                if (!side || tsUnix <= (tickSizeAt[side] ?? 0)) continue;
                tickSizeAt[side] = tsUnix;
                sink({ kind: "tickSize", token: change.token, tickSize: change.tickSize, tsUnix });
                if (side === "up") tickSizes.up = change.tickSize;
                else tickSizes.down = change.tickSize;
              }
              for (const trade of marketTrades(v)) {
                sink({ kind: "marketTrade", ...trade });
              }
              // Apply the full frame before producing one paired snapshot. The
              // fast top is authoritative until a newer L2 update catches up.
              // Keep the watermark from before this frame so same-timestamp
              // embedded fast quotes are accepted and resolved by frame order.
              const fastWatermark: AppliedBookTimes = {
                upMs: Math.max(applied.upMs, fastApplied.upMs),
                downMs: Math.max(applied.downMs, fastApplied.downMs),
              };
              const changed = applyMessage(v, upToken, downToken, up, dn, applied);
              acceptedUpSourceMs = Math.max(acceptedUpSourceMs, applied.upMs);
              acceptedDownSourceMs = Math.max(acceptedDownSourceMs, applied.downMs);
              const atMs = Date.now();
              if (changed.upUpdated) {
                lastUpAtMs = atMs; upReceivedAtUnix = receivedAtUnix; upReceivedAtMonoMs = receivedAtMonoMs;
                if (fastUp && applied.upMs > fastUp.exchangeMs) fastUp = undefined;
                if (upFastClearedAtMs > 0 && applied.upMs > upFastClearedAtMs) upFastClearedAtMs = 0;
              }
              if (changed.downUpdated) {
                lastDownAtMs = atMs; downReceivedAtUnix = receivedAtUnix; downReceivedAtMonoMs = receivedAtMonoMs;
                if (fastDown && applied.downMs > fastDown.exchangeMs) fastDown = undefined;
                if (downFastClearedAtMs > 0 && applied.downMs > downFastClearedAtMs) downFastClearedAtMs = 0;
              }
              if (changed.upUpdated) {
                upDepth = up.levels(5);
                upDepthAtMs = applied.upMs;
              }
              if (changed.downUpdated) {
                downDepth = dn.levels(5);
                downDepthAtMs = applied.downMs;
              }
              const fastChanges = bestBidAskChanges(v, upToken, downToken, fastWatermark);
              for (const change of fastChanges) {
                if (change.side === "up") {
                  if (changed.upUpdated && (change.exchangeMs < applied.upMs
                    || (change.exchangeMs === applied.upMs && change.order < changed.upOrder))) continue;
                  fastUp = change.clear ? undefined : { ...change, receivedAtUnix, receivedAtMonoMs };
                  lastUpAtMs = atMs;
                  fastApplied.upMs = Math.max(fastApplied.upMs, change.exchangeMs);
                  acceptedUpSourceMs = Math.max(acceptedUpSourceMs, fastApplied.upMs);
                  if (change.clear) upFastClearedAtMs = Math.max(upFastClearedAtMs, change.exchangeMs);
                  else upFastClearedAtMs = 0;
                } else {
                  if (changed.downUpdated && (change.exchangeMs < applied.downMs
                    || (change.exchangeMs === applied.downMs && change.order < changed.downOrder))) continue;
                  fastDown = change.clear ? undefined : { ...change, receivedAtUnix, receivedAtMonoMs };
                  lastDownAtMs = atMs;
                  fastApplied.downMs = Math.max(fastApplied.downMs, change.exchangeMs);
                  acceptedDownSourceMs = Math.max(acceptedDownSourceMs, fastApplied.downMs);
                  if (change.clear) downFastClearedAtMs = Math.max(downFastClearedAtMs, change.exchangeMs);
                  else downFastClearedAtMs = 0;
                }
              }
              if (!changed.upUpdated && !changed.downUpdated && !fastChanges.length) return;
              if (lastUpAtMs > 0 && lastDownAtMs > 0) {
                lastBilateralActivityAtMs = Math.min(lastUpAtMs, lastDownAtMs);
              }
              const ub = upFastClearedAtMs === 0 || applied.upMs > upFastClearedAtMs
                ? up.bestBid() : undefined;
              const ua = upFastClearedAtMs === 0 || applied.upMs > upFastClearedAtMs
                ? up.bestAsk() : undefined;
              const db = downFastClearedAtMs === 0 || applied.downMs > downFastClearedAtMs
                ? dn.bestBid() : undefined;
              const da = downFastClearedAtMs === 0 || applied.downMs > downFastClearedAtMs
                ? dn.bestAsk() : undefined;
              // `best_bid_ask` is the venue's fastest top-of-book channel.
              // A depth snapshot can temporarily lag or be incomplete while
              // the top remains valid. Do not discard that bilateral frame:
              // depth is for display/size context, while the reversal trigger
              // only needs fresh best bid/ask values.
              const upTop = fastUp;
              const downTop = fastDown;
              const hasUpTop = upTop != null || (ub != null && ua != null);
              const hasDownTop = downTop != null || (db != null && da != null);
              if (!hasUpTop || !hasDownTop) {
                reportHealth(false, "incomplete_book");
                hasCompleteBook = false;
                return;
              }
              hasCompleteBook = true;
              const upBid = upTop?.bid ?? ub![0];
              const upAsk = upTop?.ask ?? ua![0];
              const downBid = downTop?.bid ?? db![0];
              const downAsk = downTop?.ask ?? da![0];
              const upDepthMatches = upDepth != null
                && (upFastClearedAtMs === 0 || upDepthAtMs > upFastClearedAtMs)
                && (upTop == null || (upDepthAtMs >= upTop.exchangeMs
                  && upDepth.bids[0]?.[0] === upBid && upDepth.asks[0]?.[0] === upAsk));
              const downDepthMatches = downDepth != null
                && (downFastClearedAtMs === 0 || downDepthAtMs > downFastClearedAtMs)
                && (downTop == null || (downDepthAtMs >= downTop.exchangeMs
                  && downDepth.bids[0]?.[0] === downBid && downDepth.asks[0]?.[0] === downAsk));
              const outputUpDepth = upDepthMatches ? upDepth : undefined;
              const outputDownDepth = downDepthMatches ? downDepth : undefined;
              const upBidSz = outputUpDepth?.bids.find(([price]) => price === upBid)?.[1];
              const upAskSz = outputUpDepth?.asks.find(([price]) => price === upAsk)?.[1];
              const downBidSz = outputDownDepth?.bids.find(([price]) => price === downBid)?.[1];
              const downAskSz = outputDownDepth?.asks.find(([price]) => price === downAsk)?.[1];
              const processedAtMonoMs = performance.now();
              if (fastChanges.some(change => change.side === "up") && fastUp) fastUp.processedAtMonoMs = processedAtMonoMs;
              if (fastChanges.some(change => change.side === "down") && fastDown) fastDown.processedAtMonoMs = processedAtMonoMs;
              if (changed.upUpdated || fastChanges.some(change => change.side === "up")) upProcessedAtMonoMs = processedAtMonoMs;
              if (changed.downUpdated || fastChanges.some(change => change.side === "down")) downProcessedAtMonoMs = processedAtMonoMs;
              const upExchangeMs = Math.max(applied.upMs, upTop?.exchangeMs ?? 0);
              const downExchangeMs = Math.max(applied.downMs, downTop?.exchangeMs ?? 0);
              const selectedUpReceivedAtUnix = upTop?.receivedAtUnix ?? upReceivedAtUnix;
              const selectedDownReceivedAtUnix = downTop?.receivedAtUnix ?? downReceivedAtUnix;
              const selectedUpReceivedAtMonoMs = upTop?.receivedAtMonoMs ?? upReceivedAtMonoMs;
              const selectedDownReceivedAtMonoMs = downTop?.receivedAtMonoMs ?? downReceivedAtMonoMs;
              const selectedUpProcessedAtMonoMs = upTop?.processedAtMonoMs ?? upProcessedAtMonoMs;
              const selectedDownProcessedAtMonoMs = downTop?.processedAtMonoMs ?? downProcessedAtMonoMs;
              const upMarketAgeMs = upExchangeMs > 0 ? selectedUpReceivedAtUnix * 1000 - upExchangeMs : undefined;
              const downMarketAgeMs = downExchangeMs > 0 ? selectedDownReceivedAtUnix * 1000 - downExchangeMs : undefined;
              const sourceFresh = upMarketAgeMs != null && downMarketAgeMs != null
                && [atMs - upExchangeMs, atMs - downExchangeMs].every(age =>
                  age >= -PM_WS_MAX_CLOCK_SKEW_MS && age <= PM_WS_SOURCE_FRESH_MAX_MS);
              const sourceBothStale = upMarketAgeMs != null && downMarketAgeMs != null
                && upMarketAgeMs > PM_WS_SOURCE_FRESH_MAX_MS && downMarketAgeMs > PM_WS_SOURCE_FRESH_MAX_MS;
              if (sourceFresh) {
                if (atMs - connectedAtMs >= PM_WS_RECONNECT_STABLE_MS) reconnectAttempt = 0;
                lastFreshBilateralAtMs = Math.min(atMs, upExchangeMs, downExchangeMs);
                lastBothStaleAtMs = 0;
              } else if (sourceBothStale && lastBothStaleAtMs === 0) {
                lastBothStaleAtMs = atMs;
              } else if (!sourceBothStale) {
                lastBothStaleAtMs = 0;
              }
              if (!sourceFresh) lastFreshBilateralAtMs = 0;
              const healthChanged = reportedHealthy !== sourceFresh;
              reportHealth(sourceFresh, sourceFresh ? "complete_book" : "stale_book");
              const sourceAtMs = Math.max(upExchangeMs, downExchangeMs);
              const topChanged = publishedUpBid !== upBid || publishedUpAsk !== upAsk
                || publishedDownBid !== downBid || publishedDownAsk !== downAsk;
              const refreshDue = atMs - publishedAtMs >= PM_WS_DEPTH_REFRESH_MS;
              if (!topChanged && !refreshDue && !healthChanged) return;
              const snapshotSequence = ++sequence;
              const expiresAt = Math.min(deadline,
                (Math.min(upExchangeMs, downExchangeMs) + PM_WS_SOURCE_FRESH_MAX_MS) / 1000);
              const yes: MarketAssetSnapshot = {
                assetId: upToken,
                bid: upBid,
                ask: upAsk,
                bidSize: upBidSz,
                askSize: upAskSz,
                bids: outputUpDepth?.bids,
                asks: outputUpDepth?.asks,
                sourceAt: upExchangeMs / 1000,
                expiresAt,
                sequence: snapshotSequence,
              };
              const no: MarketAssetSnapshot = {
                assetId: downToken,
                bid: downBid,
                ask: downAsk,
                bidSize: downBidSz,
                askSize: downAskSz,
                bids: outputDownDepth?.bids,
                asks: outputDownDepth?.asks,
                sourceAt: downExchangeMs / 1000,
                expiresAt,
                sequence: snapshotSequence,
              };
              const snap: BookSnapshot = {
                marketId: resolvedMarketId,
                roundId: inferredRoundId,
                sequence: snapshotSequence,
                sourceAt: sourceAtMs > 0 ? sourceAtMs / 1000 : receivedAtUnix,
                expiresAt,
                YES: yes,
                NO: no,
                tsUnix: nowUnix(),
                source: "polymarket-ws",
                receivedAtUnix,
                receivedAtMonoMs,
                processedAtMonoMs,
                // A bilateral snapshot is only as fresh as its older side.
                // Report the worst source age rather than using the current
                // frame's receive time with the older exchange timestamp.
                marketAgeMs: upMarketAgeMs != null && downMarketAgeMs != null
                  ? Math.max(upMarketAgeMs, downMarketAgeMs) : undefined,
                upExchangeTsUnix: upExchangeMs > 0 ? upExchangeMs / 1000 : undefined,
                downExchangeTsUnix: downExchangeMs > 0 ? downExchangeMs / 1000 : undefined,
                upReceivedAtUnix: selectedUpReceivedAtUnix || undefined,
                downReceivedAtUnix: selectedDownReceivedAtUnix || undefined,
                upReceivedAtMonoMs: selectedUpReceivedAtMonoMs || undefined,
                downReceivedAtMonoMs: selectedDownReceivedAtMonoMs || undefined,
                upProcessedAtMonoMs: selectedUpProcessedAtMonoMs || undefined,
                downProcessedAtMonoMs: selectedDownProcessedAtMonoMs || undefined,
                upMarketAgeMs,
                downMarketAgeMs,
                upBid,
                upAsk,
                downBid,
                downAsk,
                upBidSz,
                upAskSz,
                downBidSz,
                downAskSz,
                upBidLevels: yes.bids,
                upAskLevels: yes.asks,
                downBidLevels: no.bids,
                downAskLevels: no.asks,
                tickSize: tickSizes.up ?? tickSizes.down,
                upTickSize: tickSizes.up,
                downTickSize: tickSizes.down,
              };
              publishedUpBid = upBid;
              publishedUpAsk = upAsk;
              publishedDownBid = downBid;
              publishedDownAsk = downAsk;
              publishedAtMs = atMs;
              sink({ kind: "book", snapshot: snap });
            } catch (error) {
              hasCompleteBook = false;
              console.warn(`polymarket message rejected: ${error instanceof SyntaxError ? "invalid_json" : "processing_failed"}`);
              try { setConnected(false); }
              catch { console.warn("polymarket unhealthy status notification failed"); }
              ws.terminate();
            }
          });
          // `ws` protocol PONG frames do not arrive through `message`.
          // They prove the transport is alive but carry no market quote.
          ws.on("pong", () => {
            lastAnyMessageAtMs = Date.now();
          });
          ws.on("close", () => {
            setConnected(false);
            resolve();
          });
          ws.on("error", () => {
            setConnected(false);
            resolve();
          });
        });

        clearInterval(ping);
        clearInterval(watchdog);
        if (expiryTimer) clearTimeout(expiryTimer);
        ws.terminate();
        if (activeWs === ws) activeWs = undefined;
      } catch (e) {
        setConnected(false);
        if (alive) console.warn(`polymarket connect failed: ${e}`);
      }

      if (alive && nowUnix() < deadline) {
        const delayMs = reconnectDelayMs(reconnectAttempt++);
        console.warn(`polymarket feed dropped, reconnecting in ${Math.round(delayMs)}ms`);
        try {
          await delay(Math.min(delayMs, Math.max(0, (deadline - nowUnix()) * 1000)),
            undefined, { signal: stopSignal.signal });
        } catch {
          if (!alive) break;
        }
      }
    }
  };

  void loop();
  return {
    stop: () => {
      alive = false;
      stopSignal.abort();
      setConnected(false);
      activeWs?.terminate();
      activeWs = undefined;
    },
    isHealthy: (maxStaleMs = 2_000) =>
      alive && nowUnix() < deadline && bookFeedHealthy(
        connected,
        hasCompleteBook,
        lastUpAtMs,
        lastDownAtMs,
        Date.now(),
        maxStaleMs,
      ) && lastFreshBilateralAtMs > 0
        && Date.now() - lastFreshBilateralAtMs <= PM_WS_SOURCE_FRESH_MAX_MS,
  };
}
