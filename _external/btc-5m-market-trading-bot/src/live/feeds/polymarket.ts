import WebSocket from "ws";
import { OrderBook } from "../orderbook.js";
import {
  type BookSnapshot,
  type FeedSink,
  nowUnix,
  num,
  sleep,
} from "./index.js";

const PM_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// A connected socket can remain OPEN after the venue stops delivering data.
// Keep these limits independent from the strategy's book freshness threshold:
// the watchdog only decides when to reconnect the transport.
export const PM_WS_MESSAGE_TIMEOUT_MS = 15_000;
export const PM_WS_BILATERAL_QUOTE_TIMEOUT_MS = 30_000;
const PM_WS_WATCHDOG_INTERVAL_MS = 1_000;

export interface AppliedBookTimes {
  upMs: number;
  downMs: number;
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
        const lastMs = side ? applied.upMs : applied.downMs;
        const bids = levelList(e.bids ?? e.buys);
        const asks = levelList(e.asks ?? e.sells);
        const isSnapshot = Array.isArray(e.bids ?? e.buys) && Array.isArray(e.asks ?? e.sells);
        if ((eventMs == null || eventMs >= lastMs) && isSnapshot) {
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
          const lastMs = side ? applied.upMs : applied.downMs;
          if (eventMs != null && eventMs < lastMs) continue;
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
    if (exchangeMs < lastMs) continue;
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
): { stop: () => void; isHealthy: (maxStaleMs?: number) => boolean } {
  let alive = true;
  let activeWs: WebSocket | undefined;
  let connected = false;
  let hasCompleteBook = false;
  let lastUpAtMs = 0;
  let lastDownAtMs = 0;

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
        activeWs = ws;
        setConnected(true);
        hasCompleteBook = false;
        lastUpAtMs = 0;
        lastDownAtMs = 0;
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
        let upReceivedAtUnix = 0, downReceivedAtUnix = 0;
        let upReceivedAtMonoMs = 0, downReceivedAtMonoMs = 0;
        let upProcessedAtMonoMs = 0, downProcessedAtMonoMs = 0;
        const trace = process.env.PM_TRACE != null;

        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, 5000);
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
          if (!silent && !quoteStalled) return;
          const reason = silent ? "message_timeout" : "bilateral_quote_timeout";
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
              for (const change of tickSizeChanges(v)) {
                sink({ kind: "tickSize", ...change, tsUnix: change.tsUnix ?? nowUnix() });
                if (change.token === upToken) tickSizes.up = change.tickSize;
                if (change.token === downToken) tickSizes.down = change.tickSize;
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
              if (!ub || !ua || !db || !da) {
                if (hasCompleteBook) sink({ kind: "bookStatus", healthy: false, connected: true,
                  reason: "incomplete_book", tsUnix: nowUnix() });
                hasCompleteBook = false;
                return;
              }
              if (!hasCompleteBook) sink({ kind: "bookStatus", healthy: true, connected: true,
                reason: "complete_book", tsUnix: nowUnix() });
              hasCompleteBook = true;
              const upTop = fastUp;
              const downTop = fastDown;
              const upBid = upTop?.bid ?? ub[0];
              const upAsk = upTop?.ask ?? ua[0];
              const downBid = downTop?.bid ?? db[0];
              const downAsk = downTop?.ask ?? da[0];
              const upBidSz = !upTop && ub[0] === upBid ? ub[1] : undefined;
              const upAskSz = !upTop && ua[0] === upAsk ? ua[1] : undefined;
              const downBidSz = !downTop && db[0] === downBid ? db[1] : undefined;
              const downAskSz = !downTop && da[0] === downAsk ? da[1] : undefined;
              const processedAtMonoMs = performance.now();
              if (fastChanges.some(change => change.side === "up") && fastUp) fastUp.processedAtMonoMs = processedAtMonoMs;
              if (fastChanges.some(change => change.side === "down") && fastDown) fastDown.processedAtMonoMs = processedAtMonoMs;
              if (changed.upUpdated || fastChanges.some(change => change.side === "up")) upProcessedAtMonoMs = processedAtMonoMs;
              if (changed.downUpdated || fastChanges.some(change => change.side === "down")) downProcessedAtMonoMs = processedAtMonoMs;
              const upDepthAuthoritative = !upTop;
              const downDepthAuthoritative = !downTop;
              const upExchangeMs = Math.max(applied.upMs, upTop?.exchangeMs ?? 0);
              const downExchangeMs = Math.max(applied.downMs, downTop?.exchangeMs ?? 0);
              const selectedUpReceivedAtUnix = upTop?.receivedAtUnix ?? upReceivedAtUnix;
              const selectedDownReceivedAtUnix = downTop?.receivedAtUnix ?? downReceivedAtUnix;
              const selectedUpReceivedAtMonoMs = upTop?.receivedAtMonoMs ?? upReceivedAtMonoMs;
              const selectedDownReceivedAtMonoMs = downTop?.receivedAtMonoMs ?? downReceivedAtMonoMs;
              const selectedUpProcessedAtMonoMs = upTop?.processedAtMonoMs ?? upProcessedAtMonoMs;
              const selectedDownProcessedAtMonoMs = downTop?.processedAtMonoMs ?? downProcessedAtMonoMs;
              const snap: BookSnapshot = {
                tsUnix: nowUnix(),
                source: "polymarket-ws",
                receivedAtUnix,
                receivedAtMonoMs,
                processedAtMonoMs,
                marketAgeMs: Math.min(upExchangeMs, downExchangeMs) > 0
                  ? receivedAtUnix * 1000 - Math.min(upExchangeMs, downExchangeMs) : undefined,
                upExchangeTsUnix: upExchangeMs > 0 ? upExchangeMs / 1000 : undefined,
                downExchangeTsUnix: downExchangeMs > 0 ? downExchangeMs / 1000 : undefined,
                upReceivedAtUnix: selectedUpReceivedAtUnix || undefined,
                downReceivedAtUnix: selectedDownReceivedAtUnix || undefined,
                upReceivedAtMonoMs: selectedUpReceivedAtMonoMs || undefined,
                downReceivedAtMonoMs: selectedDownReceivedAtMonoMs || undefined,
                upProcessedAtMonoMs: selectedUpProcessedAtMonoMs || undefined,
                downProcessedAtMonoMs: selectedDownProcessedAtMonoMs || undefined,
                upMarketAgeMs: upExchangeMs > 0 ? selectedUpReceivedAtUnix * 1000 - upExchangeMs : undefined,
                downMarketAgeMs: downExchangeMs > 0 ? selectedDownReceivedAtUnix * 1000 - downExchangeMs : undefined,
                upBid,
                upAsk,
                downBid,
                downAsk,
                upBidSz,
                upAskSz,
                downBidSz,
                downAskSz,
                upBidLevels: upDepthAuthoritative ? up.bidLevels() : undefined,
                upAskLevels: upDepthAuthoritative ? up.askLevels() : undefined,
                downBidLevels: downDepthAuthoritative ? dn.bidLevels() : undefined,
                downAskLevels: downDepthAuthoritative ? dn.askLevels() : undefined,
                tickSize: tickSizes.up ?? tickSizes.down,
                upTickSize: tickSizes.up,
                downTickSize: tickSizes.down,
              };
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
      ),
  };
}

export { applyMessage, bestBidAskChanges, sideOf, levelList, marketTrades, tickSizeChanges };
