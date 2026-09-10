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
): { upUpdated: boolean; downUpdated: boolean } {
  let upUpdated = false;
  let downUpdated = false;
  const events = Array.isArray(v) ? v : [v];
  for (const raw of events) {
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
            if (eventMs != null) applied.upMs = Math.max(applied.upMs, eventMs);
          } else {
            downUpdated = true;
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
            if (eventMs != null) applied.upMs = Math.max(applied.upMs, eventMs);
          } else {
            downUpdated = true;
            if (eventMs != null) applied.downMs = Math.max(applied.downMs, eventMs);
          }
        }
      }
    }
  }
  return { upUpdated, downUpdated };
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
    sink({ kind: "bookStatus", healthy: value, tsUnix: nowUnix() });
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
        let fastUp: { bid: number; ask: number; atMs: number } | undefined;
        let fastDown: { bid: number; ask: number; atMs: number } | undefined;
        let lastSent: Array<number | undefined> | undefined;
        const trace = process.env.PM_TRACE != null;

        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, 5000);

        await new Promise<void>((resolve) => {
          ws.on("message", (data) => {
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
              // Fast top-of-book updates (requires custom_feature_enabled).
              if (v && typeof v === "object" && !Array.isArray(v)) {
                const e = v as Record<string, unknown>;
                if (e.event_type === "best_bid_ask") {
                  const tok =
                    typeof e.asset_id === "string" ? e.asset_id : undefined;
                  const side = tok ? sideOf(tok, upToken, downToken) : undefined;
                  const bb = num(e.best_bid);
                  const ba = num(e.best_ask);
                  const eventMs = exchangeTimeMs(e);
                  const lastMs = side === true ? applied.upMs : applied.downMs;
                  if (
                    side != null &&
                    bb != null &&
                    ba != null &&
                    (eventMs == null || eventMs >= lastMs)
                  ) {
                    const top = { bid: bb, ask: ba, atMs: Date.now() };
                    if (side) {
                      fastUp = top;
                      lastUpAtMs = top.atMs;
                      if (eventMs != null) applied.upMs = Math.max(applied.upMs, eventMs);
                    } else {
                      fastDown = top;
                      lastDownAtMs = top.atMs;
                      if (eventMs != null) applied.downMs = Math.max(applied.downMs, eventMs);
                    }
                  }
                } else {
                  const changed = applyMessage(v, upToken, downToken, up, dn, applied);
                  const atMs = Date.now();
                  if (changed.upUpdated) { lastUpAtMs = atMs; fastUp = undefined; }
                  if (changed.downUpdated) { lastDownAtMs = atMs; fastDown = undefined; }
                }
              } else {
                const changed = applyMessage(v, upToken, downToken, up, dn, applied);
                const atMs = Date.now();
                if (changed.upUpdated) { lastUpAtMs = atMs; fastUp = undefined; }
                if (changed.downUpdated) { lastDownAtMs = atMs; fastDown = undefined; }
              }
              const ub = up.bestBid();
              const ua = up.bestAsk();
              const db = dn.bestBid();
              const da = dn.bestAsk();
              if (!ub || !ua || !db || !da) { hasCompleteBook = false; return; }
              hasCompleteBook = true;
              const nowMs = Date.now();
              const upTop = fastUp && nowMs - fastUp.atMs <= 1_000 ? fastUp : undefined;
              const downTop = fastDown && nowMs - fastDown.atMs <= 1_000 ? fastDown : undefined;
              const upBid = upTop?.bid ?? ub[0];
              const upAsk = upTop?.ask ?? ua[0];
              const downBid = downTop?.bid ?? db[0];
              const downAsk = downTop?.ask ?? da[0];
              const upBidSz = ub[0] === upBid ? ub[1] : undefined;
              const upAskSz = ua[0] === upAsk ? ua[1] : undefined;
              const downBidSz = db[0] === downBid ? db[1] : undefined;
              const downAskSz = da[0] === downAsk ? da[1] : undefined;
              const key = [
                upBid,
                upAsk,
                downBid,
                downAsk,
                upBidSz,
                upAskSz,
                downBidSz,
                downAskSz,
                applied.upMs,
                applied.downMs,
              ];
              if (lastSent && lastSent.every((value, i) => value === key[i])) return;
              lastSent = key;
              const snap: BookSnapshot = {
                tsUnix: nowUnix(),
                source: "polymarket-ws",
                upExchangeTsUnix: applied.upMs > 0 ? applied.upMs / 1000 : undefined,
                downExchangeTsUnix: applied.downMs > 0 ? applied.downMs / 1000 : undefined,
                upBid,
                upAsk,
                downBid,
                downAsk,
                upBidSz,
                upAskSz,
                downBidSz,
                downAskSz,
                upBidLevels: up.bidLevels(),
                downBidLevels: dn.bidLevels(),
                tickSize: tickSizes.up ?? tickSizes.down,
                upTickSize: tickSizes.up,
                downTickSize: tickSizes.down,
              };
              sink({ kind: "book", snapshot: snap });
            } catch {
              /* ignore */
            }
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

export { applyMessage, sideOf, levelList, marketTrades, tickSizeChanges };
