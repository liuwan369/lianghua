import WebSocket from "ws";
import { OrderBook } from "../orderbook.js";
import {
  type BookSnapshot,
  type FeedSink,
  type MarketAssetSnapshot,
  nowUnix,
  num,
  sleep,
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
const PM_WS_MAX_CLOCK_SKEW_MS = 1_000;
const PM_WS_WATCHDOG_INTERVAL_MS = 1_000;

export interface AppliedBookTimes {
  upMs: number;
  downMs: number;
}

export interface MarketFeedIdentity {
  marketId?: string;
  roundId?: string;
}

function exchangeTimeMs(event: Record<string, unknown>): number | undefined {
  const value = num(event.timestamp ?? event.ts ?? event.time);
  if (value == null || value <= 0) return undefined;
  return value > 1e12 ? value : value * 1000;
}

export function bookFeedHealthy(
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

function levelList(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const lv of v) {
    if (!lv || typeof lv !== "object") continue;
    const o = lv as Record<string, unknown>;
    const p = num(o.price);
    if (p == null) continue;
    out.push([p, num(o.size) ?? 0]);
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
    if (eventMs == null) return true;
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
    const eventMs = exchangeTimeMs(e);
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
        const isSnapshot = Array.isArray(e.bids ?? e.buys) && Array.isArray(e.asks ?? e.sells);
        if (isSnapshot && acceptsTimestamp(side, eventMs)) {
          const ob = side ? up : dn;
          ob.applySnapshot(bids, asks);
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
        const side =
          sideOf(tok, upToken, downToken) ??
          (topTok ? sideOf(topTok, upToken, downToken) : undefined);
        if (side == null) continue;
        const price = num(c.price);
        if (price == null) continue;
        const size = num(c.size) ?? 0;
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
  bid: number;
  ask: number;
  exchangeMs: number;
  order: number;
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
  for (const [order, raw] of (Array.isArray(v) ? v : [v]).entries()) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    if (String(event.event_type ?? "").toLowerCase() !== "best_bid_ask") continue;
    const token = typeof event.asset_id === "string" ? event.asset_id : undefined;
    const side = token ? sideOf(token, upToken, downToken) : undefined;
    const bid = num(event.best_bid), ask = num(event.best_ask), exchangeMs = exchangeTimeMs(event);
    if (side == null || bid == null || ask == null || exchangeMs == null || !(bid > 0 && bid < 1)
      || !(ask > 0 && ask < 1) || bid > ask) continue;
    const lastMs = side ? accepted.upMs : accepted.downMs;
    // A timestamp is the only venue ordering key available on this channel.
    // Treat equal timestamps as already applied so a delayed duplicate cannot
    // replace a newer top-of-book frame.
    if (exchangeMs <= lastMs) continue;
    changes.push({ side: side ? "up" : "down", bid, ask, exchangeMs, order });
    if (side) accepted.upMs = Math.max(accepted.upMs, exchangeMs);
    else accepted.downMs = Math.max(accepted.downMs, exchangeMs);
  }
  return changes;
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
    if (token && tickSize != null && tickSize > 0) out.push({ token, tickSize, ...(atMs != null ? {tsUnix:atMs / 1000} : {}) });
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

function connectWs(url: string, timeoutMs = 10_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`websocket connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
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
  let activeWs: WebSocket | undefined;
  let connected = false;
  let hasCompleteBook = false;
  let lastUpAtMs = 0;
  let lastDownAtMs = 0;
  let lastFreshBilateralAtMs = 0;
  let lastBothStaleAtMs = 0;
  let sequence = 0;
  let resolvedMarketId = identity.marketId;
  const inferredRoundId = identity.roundId ?? (Number.isFinite(deadline) && deadline % 300 === 0
    ? String(deadline - 300) : undefined);

  const setConnected = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    sink({ kind: "bookStatus", healthy: false, connected: value,
      reason: value ? "connected_waiting_book" : "transport_disconnected", tsUnix: nowUnix() });
  };

  const loop = async () => {
    while (alive && nowUnix() < deadline) {
      try {
        const ws = await connectWs(PM_WS);
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
        const applied: AppliedBookTimes = { upMs: 0, downMs: 0 };
        const tickSizes: { up?: number; down?: number } = {};
        const fastApplied: AppliedBookTimes = { upMs: 0, downMs: 0 };
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
        const tickSizeAt: { up?: number; down?: number } = {};
        let upReceivedAtUnix = 0, downReceivedAtUnix = 0;
        let upReceivedAtMonoMs = 0, downReceivedAtMonoMs = 0;
        let upProcessedAtMonoMs = 0, downProcessedAtMonoMs = 0;
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
            const receivedAtUnix = nowUnix();
            const receivedAtMonoMs = performance.now();
            lastAnyMessageAtMs = Date.now();
            const t = String(data);
            if (t === "PONG" || t === "pong") return;
            if (trace) console.info(`PM_RAW ${t.slice(0, 220)}`);
            try {
              const v = JSON.parse(t) as unknown;
              for (const raw of (Array.isArray(v) ? v : [v])) {
                if (!raw || typeof raw !== "object") continue;
                const e = raw as Record<string, unknown>;
                const id = e.market_id ?? e.market ?? e.condition_id;
                if (typeof id === "string" && id) resolvedMarketId = id;
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
              const changed = applyMessage(v, upToken, downToken, up, dn, applied);
              const atMs = Date.now();
              if (changed.upUpdated) {
                lastUpAtMs = atMs; upReceivedAtUnix = receivedAtUnix; upReceivedAtMonoMs = receivedAtMonoMs;
                if (fastUp && applied.upMs >= fastUp.exchangeMs) fastUp = undefined;
              }
              if (changed.downUpdated) {
                lastDownAtMs = atMs; downReceivedAtUnix = receivedAtUnix; downReceivedAtMonoMs = receivedAtMonoMs;
                if (fastDown && applied.downMs >= fastDown.exchangeMs) fastDown = undefined;
              }
              if (changed.upUpdated) {
                upDepth = up.levels(5);
                upDepthAtMs = applied.upMs;
              }
              if (changed.downUpdated) {
                downDepth = dn.levels(5);
                downDepthAtMs = applied.downMs;
              }
              const fastChanges = bestBidAskChanges(v, upToken, downToken, {
                upMs: Math.max(applied.upMs, fastApplied.upMs),
                downMs: Math.max(applied.downMs, fastApplied.downMs),
              });
              for (const change of fastChanges) {
                if (change.side === "up") {
                  if (changed.upUpdated && change.order < changed.upOrder && change.exchangeMs <= applied.upMs) continue;
                  fastUp = { ...change, receivedAtUnix, receivedAtMonoMs };
                  lastUpAtMs = atMs;
                  fastApplied.upMs = Math.max(fastApplied.upMs, change.exchangeMs);
                } else {
                  if (changed.downUpdated && change.order < changed.downOrder && change.exchangeMs <= applied.downMs) continue;
                  fastDown = { ...change, receivedAtUnix, receivedAtMonoMs };
                  lastDownAtMs = atMs;
                  fastApplied.downMs = Math.max(fastApplied.downMs, change.exchangeMs);
                }
              }
              if (!changed.upUpdated && !changed.downUpdated && !fastChanges.length) return;
              if (lastUpAtMs > 0 && lastDownAtMs > 0) {
                lastBilateralActivityAtMs = Math.min(lastUpAtMs, lastDownAtMs);
              }
              const ub = up.bestBid();
              const ua = up.bestAsk();
              const db = dn.bestBid();
              const da = dn.bestAsk();
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
                if (hasCompleteBook) sink({ kind: "bookStatus", healthy: false, connected: true,
                  reason: "incomplete_book", tsUnix: nowUnix() });
                hasCompleteBook = false;
                return;
              }
              if (!hasCompleteBook) sink({ kind: "bookStatus", healthy: true, connected: true,
                reason: "complete_book", tsUnix: nowUnix() });
              hasCompleteBook = true;
              const upBid = upTop?.bid ?? ub![0];
              const upAsk = upTop?.ask ?? ua![0];
              const downBid = downTop?.bid ?? db![0];
              const downAsk = downTop?.ask ?? da![0];
              const upDepthMatches = upDepth != null
                && (upTop == null || (upDepthAtMs >= upTop.exchangeMs
                  && upDepth.bids[0]?.[0] === upBid && upDepth.asks[0]?.[0] === upAsk));
              const downDepthMatches = downDepth != null
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
                && [upMarketAgeMs, downMarketAgeMs].every(age =>
                  age >= -PM_WS_MAX_CLOCK_SKEW_MS && age <= PM_WS_SOURCE_FRESH_MAX_MS);
              const sourceBothStale = upMarketAgeMs != null && downMarketAgeMs != null
                && upMarketAgeMs > PM_WS_SOURCE_FRESH_MAX_MS && downMarketAgeMs > PM_WS_SOURCE_FRESH_MAX_MS;
              if (sourceFresh) {
                lastFreshBilateralAtMs = atMs;
                lastBothStaleAtMs = 0;
              } else if (sourceBothStale && lastBothStaleAtMs === 0) {
                lastBothStaleAtMs = atMs;
              } else if (!sourceBothStale) {
                lastBothStaleAtMs = 0;
              }
              const sourceAtMs = Math.max(upExchangeMs, downExchangeMs);
              const topChanged = publishedUpBid !== upBid || publishedUpAsk !== upAsk
                || publishedDownBid !== downBid || publishedDownAsk !== downAsk;
              const depthChanged = changed.upUpdated || changed.downUpdated;
              const depthRefreshDue = depthChanged && atMs - publishedAtMs >= PM_WS_DEPTH_REFRESH_MS;
              if (!topChanged && !depthRefreshDue) return;
              const snapshotSequence = ++sequence;
              const expiresAt = Number.isFinite(deadline) ? deadline : undefined;
              const yes: MarketAssetSnapshot = {
                assetId: upToken,
                bid: upBid,
                ask: upAsk,
                bidSize: upBidSz,
                askSize: upAskSz,
                bids: outputUpDepth?.bids,
                asks: outputUpDepth?.asks,
                sourceAt: sourceAtMs > 0 ? sourceAtMs / 1000 : receivedAtUnix,
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
                sourceAt: sourceAtMs > 0 ? sourceAtMs / 1000 : receivedAtUnix,
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
        console.warn(`polymarket connect failed: ${e}`);
      }

      if (alive && nowUnix() < deadline) {
        console.warn("polymarket feed dropped, reconnecting in 1s");
        await sleep(1000);
      }
    }
  };

  void loop();
  return {
    stop: () => {
      alive = false;
      setConnected(false);
      activeWs?.terminate();
      activeWs = undefined;
    },
    isHealthy: (maxStaleMs = 2_000) =>
      bookFeedHealthy(
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

export { applyMessage, bestBidAskChanges, sideOf, levelList, marketTrades, tickSizeChanges };
