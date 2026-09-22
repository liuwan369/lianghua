import WebSocket from "ws";
import type { ApiKeyCreds } from "../clob/client.js";
import { Side, type Fill } from "../../models.js";
import { type FeedSink, num, nowUnix, sleep } from "./index.js";
import type { AccountEventLedger } from "../account-event-ledger.js";
import type { TradeStatus } from "../../platform/contracts.js";

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
  /** Authoritative open-order read used to prove a reconnect sweep covered cancels. */
  fetchOpenOrders?: () => Promise<unknown[]>;
  /** Full account reconciliation required before a reconnect can reopen the order gate. Return false when the account remains blocked. */
  reconcileAfterReconnect?: (afterUnix: number, openOrders: unknown[]) => Promise<boolean | void>;
  /** Signed L2 account read used as authentication evidence when WS omits a ready event. */
  verifyAuthenticated?: () => Promise<boolean>;
  /** Proxy/funder address used to identify our maker leg in authenticated trades. */
  accountAddress?: string;
  /** Optional durable ledger for idempotent event processing and continuity gates. */
  ledger?: AccountEventLedger;
  /** Returns true if this order id belongs to our executor. */
  isOurOrder: (orderId: string) => boolean;
  orderDirection?: (orderId: string) => "BUY" | "SELL" | undefined;
  /** Observe authenticated order lifecycle messages with their WS receive time. */
  onOrderEvent?: (event: {
    orderId: string;
    type: string;
    venueStatus?: string;
    sizeMatched?: number;
    receivedAtMonoMs: number;
    receivedAtUnix?: number;
  }) => void;
}

export type UserFeedEvent =
  | { kind: "exchangeFill"; fill: Fill & { status?: TradeStatus; feeRateBps?: number; feeUsd?: number }; reportLatencyMs?: number; orderId?: string; tradeId?: string;
      tokenId?: string; direction?: "BUY" | "SELL" }
  | { kind: "orderCancelled"; orderId: string; side?: Side; receivedAtUnix?: number };

export interface UserFeedControl {
  stop: () => void;
  /** Mark the authenticated account continuous after an external full reconcile. */
  markContinuous?: () => void;
  waitUntilReady: (timeoutMs?: number, signal?: AbortSignal) => Promise<void>;
  isHealthy: (maxStaleMs?: number) => boolean;
  registerOrder: (orderId: string, tradeIds?: string[]) => void;
  reconcileRecentTrades: (afterUnix: number) => Promise<UserFeedEvent[]>;
  isContinuous?: () => boolean;
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

function directionFields(opts: UserFeedOptions, orderId: string | undefined, raw: unknown, tokenId: string) {
  const owned = orderId ? opts.orderDirection?.(orderId) : undefined;
  const value = String(raw ?? "").toUpperCase();
  return { tokenId, direction: owned ?? (value === "BUY" || value === "SELL" ? value : undefined) };
}

function tradeMetadata(event: Record<string, unknown>, status: string) {
  const feeUsd = num(event.fee_usd), feeRateBps = num(event.fee_rate_bps);
  return { status: status as TradeStatus,
    ...(feeUsd != null && feeUsd >= 0 ? { feeUsd } : {}),
    ...(feeRateBps != null && feeRateBps >= 0 ? { feeRateBps } : {}) };
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
          receivedAtUnix: num(e.__receivedAtUnix),
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
    const status = String(e.status ?? "").toUpperCase().replace(/^TRADE_STATUS_/, "");
    if (!["MATCHED", "MATCHED_NOT_BROADCASTED", "MINED", "RETRYING", "CONFIRMED", "FAILED"].includes(status)) continue;

    const tradeId =
      typeof e.id === "string"
        ? e.id
        : typeof e.trade_id === "string"
          ? e.trade_id
          : undefined;
    const dedupeKey = `${tradeId}:${status}${num(e.fee_usd) != null ? `:fee:${num(e.fee_usd)}` : ""}`;
    if (dedupeKey && seenTrades.has(dedupeKey)) continue;
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
          fill: { side, shares: size, price, tsUnix: exchangeUnix ?? nowUnix(), isMaker: false, ...tradeMetadata(e, status) },
          ...directionFields(opts, takerId, e.side, tok!),
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
          fill: { side, shares: size, price, tsUnix: exchangeUnix ?? nowUnix(), isMaker: true, ...tradeMetadata(e, status) },
          ...directionFields(opts, orderId, maker.side, tok!),
          reportLatencyMs,
          orderId,
          tradeId,
        });
      }
    }
    if (tradeId && events.length > eventStart) { seenTrades.add(tradeId); if (dedupeKey) seenTrades.add(dedupeKey); }
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
  const status = String(e.status ?? "").toUpperCase().replace(/^TRADE_STATUS_/, "");
  if (!["MATCHED", "MATCHED_NOT_BROADCASTED", "MINED", "RETRYING", "CONFIRMED", "FAILED"].includes(status)) return [];
  const market = typeof e.market === "string" ? e.market : undefined;
  if (market && opts.conditionId && market !== opts.conditionId) return [];
  const tradeId = typeof e.id === "string" ? e.id : undefined;
  const dedupeKey = `${tradeId}:${status}${num(e.fee_usd) != null ? `:fee:${num(e.fee_usd)}` : ""}`;
  if (!tradeId || (dedupeKey && seenTrades.has(dedupeKey))) return [];

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
    const tok = typeof e.asset_id === "string" ? e.asset_id : undefined;
    const side = tok ? sideOfToken(tok, opts.upToken, opts.downToken) : undefined;
    const price = num(e.price);
    const size = num(e.size);
    const orderId = typeof e.taker_order_id === "string" ? e.taker_order_id : undefined;
    if (!orderId || !opts.isOurOrder(orderId)) return [];
    if (side != null && price != null && size != null && size > 0) {
      out.push({
        kind: "exchangeFill",
        fill: { side, shares: size, price, tsUnix, isMaker: false, ...tradeMetadata(e, status) },
        ...directionFields(opts, orderId, e.side, tok!),
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
      const tok = typeof maker.asset_id === "string" ? maker.asset_id : undefined;
      const side = tok ? sideOfToken(tok, opts.upToken, opts.downToken) : undefined;
      const price = num(maker.price);
      const size = num(maker.matched_amount);
      const orderId = typeof maker.order_id === "string" ? maker.order_id : undefined;
      if (!orderId || (!opts.isOurOrder(orderId) && address !== account)) continue;
      if (side == null || price == null || size == null || size <= 0) continue;
      out.push({
        kind: "exchangeFill",
        fill: { side, shares: size, price, tsUnix, isMaker: true, ...tradeMetadata(e, status) },
        ...directionFields(opts, orderId, maker.side, tok!),
        orderId,
        tradeId,
      });
    }
  }

  if (out.length > 0) { seenTrades.add(tradeId); if (dedupeKey) seenTrades.add(dedupeKey); }
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
  if (String(event.event_type ?? "").toLowerCase() === "trade") return false;
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
  let connectedOnce = false;
  let discontinuity = !(opts.ledger?.status().continuous ?? true);
  let authenticated = false;
  let gapStartUnix: number | undefined;

  const emitEvent = (event: UserFeedEvent): void => {
    const id = event.kind === "exchangeFill"
      ? (event.tradeId && event.orderId ? `fill:${event.tradeId}:${event.orderId}${event.fill.status ? `:${event.fill.status}${event.fill.feeUsd != null ? `:fee:${event.fill.feeUsd}` : ""}` : ""}` : undefined)
      : `cancel:${event.orderId}`;
    if (opts.ledger && id && !opts.ledger.append(id, event)) return;
    sink({ kind: "user", event });
  };

  const emitRaw = (raw: unknown) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const value = raw as Record<string, unknown>;
      const eventType = String(value.event_type ?? value.type ?? "").toLowerCase();
      const orderId = typeof value.id === "string" ? value.id : undefined;
      if (eventType === "order" && orderId && opts.isOurOrder(orderId)) {
        // The WS loop stamps __receivedAtUnix before buffering. Falling back
        // to lastTransportAtMs is incorrect because a later PONG or unrelated
        // frame can overwrite it while this order waits for registration.
        // An unstamped event has no trustworthy transport timestamp; let the
        // consumer use its processing time instead of inventing a latency.
        const receivedAtUnix = num(value.__receivedAtUnix);
        opts.onOrderEvent?.({
          orderId,
          type: String(value.type ?? "").toUpperCase(),
          venueStatus: typeof value.status === "string" ? value.status : undefined,
          sizeMatched: num(value.size_matched),
          receivedAtMonoMs: performance.now(),
          receivedAtUnix,
        });
      }
    }
    for (const ev of parseUserMessage(raw, opts, orderMatched, seenTrades)) {
      emitEvent(ev);
    }
  };

  const pending = new PendingUserEvents(opts, emitRaw);

  const reconcileTrades = async (tradeIds: string[]) => {
    if (!opts.fetchTrades || tradeIds.length === 0) return;
    // Query immediately after registration. Waiting before the first read
    // added avoidable fill confirmation latency when the trade was already
    // visible in the authenticated endpoint.
    for (const delayMs of [0, 250, 750, 1_500]) {
      await sleep(delayMs);
      const missing = tradeIds.filter((id) => !seenTrades.has(id));
      if (missing.length === 0 || !alive) return;
      const rows = await opts.fetchTrades(missing).catch(() => []);
      for (const row of rows) {
        for (const event of parseAuthenticatedTrade(row, opts, seenTrades)) {
          emitEvent(event);
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

  const markContinuous = () => {
    discontinuity = false;
    gapStartUnix = undefined;
    opts.ledger?.markResynced("authenticated account reconciliation");
    if (authenticated && activeWs?.readyState === WebSocket.OPEN) setReady(true);
  };

  const loop = async () => {
    while (alive && nowUnix() < deadline) {
      try {
        const ws = await connectWs(USER_WS);
        if (!alive || nowUnix() >= deadline) {
          ws.terminate();
          break;
        }
        activeWs = ws;
        authenticated = false;
        ws.send(authPayload(opts.creds, opts.conditionId));
        lastTransportAtMs = Date.now();
        if (opts.verifyAuthenticated) {
          let credentialsValid = false;
          try {
            credentialsValid = (await opts.verifyAuthenticated()) === true;
          } catch {
            credentialsValid = false;
          }
          if (!credentialsValid) {
            setReady(false);
            ws.terminate();
            throw new Error("authenticated L2 account verification failed");
          }
          authenticated = credentialsValid;
        }
        if (connectedOnce) {
          discontinuity = true;
          opts.ledger?.markDiscontinuous("user websocket reconnect");
          setReady(false);
          if (opts.fetchRecentTrades && opts.fetchOpenOrders) {
            const afterUnix = Math.max(0, (gapStartUnix ?? lastTransportAtMs / 1000) - 5);
            const [first, firstOpen] = await Promise.all([
              opts.fetchRecentTrades(afterUnix).catch(() => null),
              opts.fetchOpenOrders().catch(() => null),
            ]);
            await sleep(250);
            const [rows, secondOpen] = await Promise.all([
              opts.fetchRecentTrades(afterUnix).catch(() => null),
              opts.fetchOpenOrders().catch(() => null),
            ]);
            const key = (value: unknown[] | null) => value?.map((row) => JSON.stringify(row)).sort().join("|");
            if (first && rows && firstOpen && secondOpen && key(first) === key(rows) && key(firstOpen) === key(secondOpen)) {
              for (const row of rows) for (const event of parseAuthenticatedTrade(row, opts, seenTrades)) emitEvent(event);
              try {
                const resynced = await opts.reconcileAfterReconnect?.(afterUnix, secondOpen) ?? true;
                if (resynced === false) {
                  // The authenticated transport is usable, but the account gate
                  // remains closed until a later run obtains terminal evidence.
                  // Do not mark the ledger continuous or replay the same order.
                  if (authenticated) setReady(true);
                } else {
                  opts.ledger?.markResynced("authenticated REST trade and account compensation");
                  discontinuity = false;
                  gapStartUnix = undefined;
                  if (authenticated) setReady(true);
                }
              } catch {
                // Stable REST lists do not prove the local ledger is current.
                discontinuity = true;
                setReady(false);
                ws.terminate();
                throw new Error("authenticated account reconciliation failed after reconnect");
              }
            }
            else {
              ws.terminate();
              throw new Error("authenticated account reconciliation incomplete after reconnect");
            }
          } else {
            ws.terminate();
            throw new Error("authenticated account reconciliation unavailable after reconnect");
          }
        } else {
          if (!discontinuity && authenticated) setReady(true);
          connectedOnce = true;
        }
        console.info("user feed connected + subscription sent");

        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, 10_000);

        await new Promise<void>((resolve) => {
          ws.on("message", (data) => {
            const t = String(data);
            lastTransportAtMs = Date.now();
            if (t === "PONG" || t === "pong") return;
            if (isUserChannelEvidence(t, opts)) {
              authenticated = true;
              if (!discontinuity) setReady(true);
              return;
            }
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
                if (isUserChannelEvidence(raw, opts)) {
                  authenticated = true;
                  if (!discontinuity) setReady(true);
                }
                if (raw && typeof raw === "object") {
                  (raw as Record<string, unknown>).__receivedAtUnix = lastTransportAtMs / 1000;
                }
                pending.accept(raw);
              }
            } catch (error) {
              discontinuity = true;
              gapStartUnix ??= lastTransportAtMs / 1000;
              console.warn(`user message rejected: ${error instanceof SyntaxError ? "invalid_json" : "processing_failed"}`);
              try { setReady(false); }
              catch { console.warn("user unhealthy status notification failed"); }
              try { opts.ledger?.markDiscontinuous("user websocket message processing failed"); }
              catch { console.warn("user continuity marker write failed"); }
              ws.terminate();
            }
          });
          ws.on("close", () => { gapStartUnix ??= lastTransportAtMs / 1000; resolve(); });
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
      for (const waiter of readyWaiters) waiter();
      readyWaiters.clear();
    },
    markContinuous,
    waitUntilReady: (timeoutMs = 10_000, signal?: AbortSignal) => {
      if (ready) return Promise.resolve();
      if (!alive) return Promise.reject(new Error("user websocket stopped before becoming ready"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      const generation = readyGeneration;
      return new Promise<void>((resolve, reject) => {
        let done = false;
        const cleanup = () => {
          clearTimeout(timer);
          readyWaiters.delete(onReady);
          signal?.removeEventListener("abort", onAbort);
        };
        const onReady = () => {
          if (done) return;
          if (!alive) {
            done = true;
            cleanup();
            reject(new Error("user websocket stopped before becoming ready"));
            return;
          }
          if (readyGeneration === generation) return;
          done = true;
          cleanup();
          resolve();
        };
        const onAbort = () => {
          if (done) return;
          done = true;
          cleanup();
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error(`user websocket not ready after ${timeoutMs}ms`));
        }, timeoutMs);
        readyWaiters.add(onReady);
        signal?.addEventListener("abort", onAbort, { once: true });
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
      // Use the same trade identity set as the WebSocket parser. A REST
      // compensation response can contain the same trade after its status
      // changes from MATCHED to MINED/CONFIRMED; parsing it with a fresh set
      // would emit a second fill for the same execution.
      const events = finalRows.flatMap((row) => parseAuthenticatedTrade(row, opts, seenTrades));
      discontinuity = false;
      gapStartUnix = undefined;
      opts.ledger?.markResynced("explicit authenticated REST reconciliation");
      return events;
    },
    isContinuous: () => !discontinuity && (opts.ledger?.status().continuous ?? true),
  };
}

export { candidateOrderIds };
