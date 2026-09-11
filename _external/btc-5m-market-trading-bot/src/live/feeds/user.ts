import WebSocket from "ws";
import type { ApiKeyCreds } from "../clob/client.js";
import { Side, type Fill } from "../../models.js";
import { type FeedSink, num, nowUnix, sleep } from "./index.js";

const USER_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const DEFAULT_PENDING_EVENT_TTL_MS = 10_000;
const MIN_PENDING_EVENT_TTL_MS = 5_000;

export interface UserFeedOptions {
  creds: ApiKeyCreds;
  conditionId: string;
  upToken: string;
  downToken: string;
  /** Keep fills that can arrive before the order POST response (minimum 5s). */
  pendingEventTtlMs?: number;
  /** Read-only fallback used to reconcile trade IDs returned by an order ACK. */
  fetchTrades?: (tradeIds: string[]) => Promise<unknown[]>;
  /** Authenticated account query used only after an order ACK becomes unknown. */
  fetchRecentTrades?: (afterUnix: number) => Promise<unknown[]>;
  /** Proxy/funder address used to identify our maker leg in authenticated trades. */
  accountAddress?: string;
  /** Returns true if this order id belongs to our executor. */
  isOurOrder: (orderId: string) => boolean;
}

export type UserFeedEvent =
  | { kind: "exchangeFill"; fill: Fill; reportLatencyMs?: number; orderId?: string; tradeId?: string }
  | { kind: "orderCancelled"; orderId: string; side?: Side };

export interface UserFeedControl {
  stop: () => void;
  waitUntilReady: (timeoutMs?: number) => Promise<void>;
  isHealthy: (maxStaleMs?: number) => boolean;
  registerOrder: (orderId: string, tradeIds?: string[]) => void;
  reconcileRecentTrades: (afterUnix: number) => Promise<UserFeedEvent[]>;
}

function sideOfToken(
  tok: string,
  upToken: string,
  downToken: string,
): Side | undefined {
  if (tok === upToken) return Side.Up;
  if (tok === downToken) return Side.Down;
  return undefined;
}

function authPayload(creds: ApiKeyCreds, conditionId: string): string {
  return JSON.stringify({
    auth: {
      apiKey: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
    markets: conditionId ? [conditionId] : [],
    type: "user",
  });
}

/** Parse one user-channel WS message into feed events. Exported for tests. */
export function parseUserMessage(
  raw: unknown,
  opts: UserFeedOptions,
  orderMatched: Map<string, number>,
  seenTrades: Set<string>,
): UserFeedEvent[] {
  const events: UserFeedEvent[] = [];
  const batch = Array.isArray(raw) ? raw : [raw];

  for (const item of batch) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const eventType = String(e.event_type ?? e.type ?? "").toLowerCase();

    if (eventType === "order") {
      const orderId = typeof e.id === "string" ? e.id : undefined;
      const orderType = String(e.type ?? "").toUpperCase();
      if (!orderId || !opts.isOurOrder(orderId)) continue;

      if (orderType === "CANCELLATION") {
        const tok =
          typeof e.asset_id === "string" ? e.asset_id : undefined;
        events.push({
          kind: "orderCancelled",
          orderId,
          side: tok
            ? sideOfToken(tok, opts.upToken, opts.downToken)
            : undefined,
        });
        orderMatched.delete(orderId);
        continue;
      }

      if (orderType === "UPDATE" || orderType === "PLACEMENT") {
        const matched = num(e.size_matched) ?? 0;
        orderMatched.set(orderId, Math.max(orderMatched.get(orderId) ?? 0, matched));
      }
      continue;
    }

    if (eventType !== "trade") continue;
    const status = String(e.status ?? "").toUpperCase();
    if (status !== "MATCHED" && status !== "CONFIRMED") continue;

    const tradeId =
      typeof e.id === "string"
        ? e.id
        : typeof e.trade_id === "string"
          ? e.trade_id
          : undefined;
    if (tradeId && seenTrades.has(tradeId)) continue;
    const eventStart = events.length;
    const receivedAtUnix = num(e.__receivedAtUnix);
    const timestamp = num(e.match_time_nano ?? e.matchtime ?? e.match_time ?? e.timestamp);
    const exchangeUnix = timestamp == null ? undefined : timestamp > 1e15 ? timestamp / 1e9
      : timestamp > 1e12 ? timestamp / 1000 : timestamp;
    const reportLatencyMs = receivedAtUnix != null && exchangeUnix != null
      ? (receivedAtUnix - exchangeUnix) * 1000 : undefined;

    const takerId = typeof e.taker_order_id === "string" ? e.taker_order_id : undefined;
    if (takerId && opts.isOurOrder(takerId)) {
      const tok = typeof e.asset_id === "string" ? e.asset_id : undefined;
      const side = tok ? sideOfToken(tok, opts.upToken, opts.downToken) : undefined;
      const price = num(e.price);
      const size = num(e.size);
      if (side != null && price != null && size != null && size > 0) {
        events.push({
          kind: "exchangeFill",
          fill: { side, shares: size, price, tsUnix: exchangeUnix ?? nowUnix(), isMaker: false },
          reportLatencyMs,
          orderId: takerId,
          tradeId,
        });
      }
    } else if (Array.isArray(e.maker_orders)) {
      for (const rawMaker of e.maker_orders) {
        if (!rawMaker || typeof rawMaker !== "object") continue;
        const maker = rawMaker as Record<string, unknown>;
        const orderId = typeof maker.order_id === "string" ? maker.order_id : undefined;
        if (!orderId || !opts.isOurOrder(orderId)) continue;
        const tok = typeof maker.asset_id === "string" ? maker.asset_id : undefined;
        const side = tok ? sideOfToken(tok, opts.upToken, opts.downToken) : undefined;
        const price = num(maker.price);
        const size = num(maker.matched_amount);
        if (side == null || price == null || size == null || size <= 0) continue;
        events.push({
          kind: "exchangeFill",
          fill: { side, shares: size, price, tsUnix: exchangeUnix ?? nowUnix(), isMaker: true },
          reportLatencyMs,
          orderId,
          tradeId,
        });
      }
    }
    if (tradeId && events.length > eventStart) seenTrades.add(tradeId);
  }

  return events;
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

/** Parse a row returned by the authenticated trades endpoint. */
export function parseAuthenticatedTrade(
  raw: unknown,
  opts: UserFeedOptions,
  seenTrades: Set<string>,
): UserFeedEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const e = raw as Record<string, unknown>;
  const status = String(e.status ?? "").toUpperCase();
  if (!["MATCHED", "MINED", "CONFIRMED"].includes(status)) return [];
  const market = typeof e.market === "string" ? e.market : undefined;
  if (market && opts.conditionId && market !== opts.conditionId) return [];
  const tradeId = typeof e.id === "string" ? e.id : undefined;
  if (!tradeId || seenTrades.has(tradeId)) return [];

  const tsRaw = num(e.match_time_nano ?? e.match_time);
  const tsUnix = tsRaw == null
    ? nowUnix()
    : tsRaw > 1e15
      ? tsRaw / 1e9
      : tsRaw > 1e12
        ? tsRaw / 1000
        : tsRaw;
  const traderSide = String(e.trader_side ?? "").toUpperCase();
  const out: UserFeedEvent[] = [];

  if (traderSide === "TAKER") {
    const action = String(e.side ?? "").toUpperCase();
    if (action && action !== "BUY") return [];
    const tok = typeof e.asset_id === "string" ? e.asset_id : undefined;
    const side = tok ? sideOfToken(tok, opts.upToken, opts.downToken) : undefined;
    const price = num(e.price);
    const size = num(e.size);
    const orderId = typeof e.taker_order_id === "string" ? e.taker_order_id : undefined;
    if (side != null && price != null && size != null && size > 0) {
      out.push({
        kind: "exchangeFill",
        fill: { side, shares: size, price, tsUnix, isMaker: false },
        orderId,
        tradeId,
      });
    }
  } else if (traderSide === "MAKER" && opts.accountAddress && Array.isArray(e.maker_orders)) {
    const account = opts.accountAddress.toLowerCase();
    for (const rawMaker of e.maker_orders) {
      if (!rawMaker || typeof rawMaker !== "object") continue;
      const maker = rawMaker as Record<string, unknown>;
      const address = String(maker.maker_address ?? maker.owner ?? "").toLowerCase();
      if (address !== account) continue;
      const makerAction = String(maker.side ?? "").toUpperCase();
      if (makerAction && makerAction !== "BUY") continue;
      const tok = typeof maker.asset_id === "string" ? maker.asset_id : undefined;
      const side = tok ? sideOfToken(tok, opts.upToken, opts.downToken) : undefined;
      const price = num(maker.price);
      const size = num(maker.matched_amount);
      const orderId = typeof maker.order_id === "string" ? maker.order_id : undefined;
      if (side == null || price == null || size == null || size <= 0) continue;
      out.push({
        kind: "exchangeFill",
        fill: { side, shares: size, price, tsUnix, isMaker: true },
        orderId,
        tradeId,
      });
    }
  }

  if (out.length > 0) seenTrades.add(tradeId);
  return out;
}

function candidateOrderIds(raw: unknown, opts: UserFeedOptions): string[] {
  if (!raw || typeof raw !== "object") return [];
  const e = raw as Record<string, unknown>;
  const eventType = String(e.event_type ?? e.type ?? "").toLowerCase();
  const token = typeof e.asset_id === "string" ? e.asset_id : undefined;
  if (token && token !== opts.upToken && token !== opts.downToken) return [];
  if (eventType === "order") {
    return typeof e.id === "string" ? [e.id] : [];
  }
  if (eventType === "trade") {
    const ids: string[] = [];
    if (typeof e.taker_order_id === "string") ids.push(e.taker_order_id);
    if (Array.isArray(e.maker_orders)) {
      for (const rawMaker of e.maker_orders) {
        if (!rawMaker || typeof rawMaker !== "object") continue;
        const orderId = (rawMaker as Record<string, unknown>).order_id;
        if (typeof orderId === "string") ids.push(orderId);
      }
    }
    return [...new Set(ids)];
  }
  return [];
}

function isSubscriptionConfirmation(raw: unknown): boolean {
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    return value === "subscribed" || value === "authenticated";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;

  const event = raw as Record<string, unknown>;
  const eventType = String(event.event_type ?? event.type ?? "").toLowerCase();
  const channel = String(event.channel ?? event.subscription ?? "").toLowerCase();
  const status = String(event.status ?? "").toLowerCase();
  if (["error", "failed", "failure", "rejected", "unauthorized"].includes(status)) {
    return false;
  }
  const confirmed =
    eventType === "subscribed" ||
    eventType === "authenticated" ||
    status === "subscribed" ||
    status === "authenticated" ||
    status === "success";
  if (!confirmed) return false;

  return (
    eventType === "subscribed" ||
    eventType === "authenticated" ||
    eventType === "user" ||
    channel === "user"
  );
}

export function isUserChannelFailure(raw: unknown): boolean {
  if (typeof raw === "string") return /invalid.*auth|unauthori[sz]ed|authentication.*fail/i.test(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const event = raw as Record<string, unknown>;
  return Boolean(event.error || event.error_msg) ||
    [event.type, event.event_type, event.status].some((value) =>
      ["error", "failed", "failure", "rejected", "unauthorized"].includes(String(value ?? "").toLowerCase()));
}

/** True only when a message proves that the authenticated user channel is active. */
export function isUserChannelEvidence(
  raw: unknown,
  opts: UserFeedOptions,
): boolean {
  if (Array.isArray(raw)) {
    return raw.some((item) => isUserChannelEvidence(item, opts));
  }
  if (isSubscriptionConfirmation(raw)) return true;
  if (!raw || typeof raw !== "object") return false;

  const event = raw as Record<string, unknown>;
  const eventType = String(event.event_type ?? event.type ?? "").toLowerCase();
  if (eventType !== "order" && eventType !== "trade") return false;

  const token = typeof event.asset_id === "string" ? event.asset_id : undefined;
  if (token !== opts.upToken && token !== opts.downToken) return false;
  const market =
    typeof event.market === "string"
      ? event.market
      : typeof event.condition_id === "string"
        ? event.condition_id
        : undefined;
  if (market && opts.conditionId && market !== opts.conditionId) return false;

  if (eventType === "order") return typeof event.id === "string";
  return typeof event.id === "string" || typeof event.trade_id === "string";
}

export class PendingUserEvents {
  private pending = new Map<
    string,
    Array<{ raw: unknown; atMs: number; pendingId: number }>
  >();
  private nextPendingId = 1;
  private readonly ttlMs: number;

  constructor(
    private readonly opts: UserFeedOptions,
    private readonly emit: (raw: unknown) => void,
    ttlMs = opts.pendingEventTtlMs ?? DEFAULT_PENDING_EVENT_TTL_MS,
  ) {
    this.ttlMs = Math.max(ttlMs, MIN_PENDING_EVENT_TTL_MS);
  }

  accept(raw: unknown): void {
    const candidates = candidateOrderIds(raw, this.opts);
    if (candidates.length === 0 || candidates.some((id) => this.opts.isOurOrder(id))) {
      this.emit(raw);
      return;
    }
    const row = { raw, atMs: Date.now(), pendingId: this.nextPendingId++ };
    for (const orderId of candidates) {
      const rows = this.pending.get(orderId) ?? [];
      rows.push(row);
      this.pending.set(orderId, rows);
      setTimeout(() => this.prune(orderId), this.ttlMs + 50).unref?.();
    }
  }

  register(orderId: string): void {
    const rows = this.pending.get(orderId) ?? [];
    for (const row of rows) {
      if (Date.now() - row.atMs <= this.ttlMs) {
        this.removePendingId(row.pendingId);
        this.emit(row.raw);
      }
    }
    this.pending.delete(orderId);
  }

  private removePendingId(pendingId: number): void {
    for (const [orderId, rows] of this.pending) {
      const remaining = rows.filter((row) => row.pendingId !== pendingId);
      if (remaining.length > 0) this.pending.set(orderId, remaining);
      else this.pending.delete(orderId);
    }
  }

  private prune(orderId: string): void {
    const cutoff = Date.now() - this.ttlMs;
    const fresh = (this.pending.get(orderId) ?? []).filter(
      (row) => row.atMs >= cutoff,
    );
    if (fresh.length > 0) this.pending.set(orderId, fresh);
    else this.pending.delete(orderId);
  }
}

/** Authenticated user-channel feed — authoritative fills and cancels. */
export function runUserFeed(
  sink: FeedSink,
  opts: UserFeedOptions,
  deadline: number,
): UserFeedControl {
  let alive = true;
  let activeWs: WebSocket | undefined;
  let ready = false;
  let readyGeneration = 0;
  let lastTransportAtMs = 0;
  const orderMatched = new Map<string, number>();
  const seenTrades = new Set<string>();
  const readyWaiters = new Set<() => void>();

  const emitRaw = (raw: unknown) => {
    for (const ev of parseUserMessage(raw, opts, orderMatched, seenTrades)) {
      sink({ kind: "user", event: ev });
    }
  };

  const pending = new PendingUserEvents(opts, emitRaw);

  const reconcileTrades = async (tradeIds: string[]) => {
    if (!opts.fetchTrades || tradeIds.length === 0) return;
    for (const delayMs of [250, 750, 1_500]) {
      await sleep(delayMs);
      const missing = tradeIds.filter((id) => !seenTrades.has(id));
      if (missing.length === 0 || !alive) return;
      const rows = await opts.fetchTrades(missing).catch(() => []);
      for (const row of rows) {
        for (const event of parseAuthenticatedTrade(row, opts, seenTrades)) {
          sink({ kind: "user", event });
        }
      }
    }
    const unresolved = tradeIds.filter((id) => !seenTrades.has(id));
    if (unresolved.length > 0) {
      console.error(`trade reconciliation missing ${unresolved.length} ACK trade(s)`);
      setReady(false);
      activeWs?.terminate();
    }
  };

  const setReady = (value: boolean) => {
    if (ready === value) return;
    ready = value;
    sink({ kind: "userStatus", healthy: value, tsUnix: nowUnix() });
    if (!value) return;
    readyGeneration += 1;
    for (const resolve of readyWaiters) resolve();
    readyWaiters.clear();
  };

  const loop = async () => {
    while (alive && nowUnix() < deadline) {
      try {
        const ws = await connectWs(USER_WS);
        activeWs = ws;
        ws.send(authPayload(opts.creds, opts.conditionId));
        lastTransportAtMs = Date.now();
        // The official user channel is silent while an account has no order
        // events. Startup cancel-all has already proven these L2 credentials;
        // an open socket with the subscription frame sent is therefore the
        // usable readiness signal. Any later close immediately disables live.
        setReady(true);
        console.info("user feed connected + subscription sent");

        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, 10_000);

        await new Promise<void>((resolve) => {
          ws.on("message", (data) => {
            const t = String(data);
            lastTransportAtMs = Date.now();
            if (t === "PONG" || t === "pong") return;
            if (isUserChannelFailure(t)) {
              setReady(false);
              ws.terminate();
              return;
            }
            try {
              const v = JSON.parse(t) as unknown;
              const batch = Array.isArray(v) ? v : [v];
              if (batch.some(isUserChannelFailure)) {
                setReady(false);
                ws.terminate();
                return;
              }
              for (const raw of batch) {
                if (raw && typeof raw === "object") {
                  (raw as Record<string, unknown>).__receivedAtUnix = lastTransportAtMs / 1000;
                }
                pending.accept(raw);
              }
            } catch {
              /* ignore */
            }
          });
          ws.on("close", () => resolve());
          ws.on("error", () => resolve());
        });

        clearInterval(ping);
        setReady(false);
        ws.terminate();
        if (activeWs === ws) activeWs = undefined;
      } catch (e) {
        setReady(false);
        console.warn(`user feed connect failed: ${e}`);
      }

      if (alive && nowUnix() < deadline) {
        console.warn("user feed dropped, reconnecting in 2s");
        await sleep(2000);
      }
    }
  };

  void loop();
  return {
    stop: () => {
      alive = false;
      setReady(false);
      activeWs?.terminate();
      activeWs = undefined;
    },
    waitUntilReady: (timeoutMs = 10_000) => {
      if (ready) return Promise.resolve();
      const generation = readyGeneration;
      return new Promise<void>((resolve, reject) => {
        let done = false;
        const onReady = () => {
          if (done || readyGeneration === generation) return;
          done = true;
          clearTimeout(timer);
          readyWaiters.delete(onReady);
          resolve();
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          readyWaiters.delete(onReady);
          reject(new Error(`user websocket not ready after ${timeoutMs}ms`));
        }, timeoutMs);
        readyWaiters.add(onReady);
      });
    },
    isHealthy: (maxStaleMs = 25_000) =>
      ready &&
      activeWs?.readyState === WebSocket.OPEN &&
      Date.now() - lastTransportAtMs <= maxStaleMs,
    registerOrder: (orderId: string, tradeIds: string[] = []) => {
      pending.register(orderId);
      void reconcileTrades(tradeIds);
    },
    reconcileRecentTrades: async (afterUnix: number) => {
      if (!opts.fetchRecentTrades) {
        throw new Error("recent trade reconciliation is not configured");
      }
      const observeUntil = Date.now() + 5_000;
      let previousKey: string | undefined;
      let stableCount = 0;
      let finalRows: unknown[] = [];
      while (Date.now() < observeUntil) {
        if (!ready || activeWs?.readyState !== WebSocket.OPEN) {
          // A close and reconnect can race with the caller's cancellation
          // sweep. Wait within the existing bounded reconciliation window so
          // the REST snapshot is taken only after the authenticated channel
          // is usable again. The caller still fails closed when the window
          // expires or the feed cannot reconnect.
          const remainingMs = observeUntil - Date.now();
          if (remainingMs <= 0) break;
          await new Promise<void>((resolve) => {
            let done = false;
            const onReady = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              readyWaiters.delete(onReady);
              resolve();
            };
            const timer = setTimeout(() => {
              if (done) return;
              done = true;
              readyWaiters.delete(onReady);
              resolve();
            }, remainingMs);
            readyWaiters.add(onReady);
          });
          if (!ready || activeWs?.readyState !== WebSocket.OPEN) continue;
        }
        // A reconnect may restore WS before the REST endpoint is ready. Keep
        // retrying until the same bounded observation deadline rather than
        // reporting an incomplete account snapshot on one transient error.
        const rows = await opts.fetchRecentTrades(afterUnix).catch(() => null);
        if (rows == null) {
          await sleep(Math.min(250, Math.max(1, observeUntil - Date.now())));
          continue;
        }
        finalRows = rows;
        const key = rows
          .map((row) => {
            if (!row || typeof row !== "object") return "invalid";
            const trade = row as Record<string, unknown>;
            return [trade.id, trade.status, trade.last_update, trade.size].join(":");
          })
          .sort()
          .join("|");
        stableCount = previousKey === key ? stableCount + 1 : 1;
        previousKey = key;
        if (Date.now() < observeUntil) {
          await sleep(Math.min(500, observeUntil - Date.now()));
        }
      }
      if (stableCount < 2) {
        throw new Error("authenticated trade snapshot did not stabilize in 5 seconds");
      }
      const snapshotSeen = new Set<string>();
      return finalRows.flatMap((row) => parseAuthenticatedTrade(row, opts, snapshotSeen));
    },
  };
}

export { candidateOrderIds };
