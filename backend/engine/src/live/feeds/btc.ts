import WebSocket from "ws";
import { type FeedEvent, type FeedSink, nowUnix, REFERENCE_FRESH_MAX_SEC } from "./index.js";

interface Quote {
  bid: number;
  ask: number;
  bidSz: number;
  askSz: number;
}
function micro(q: Quote): number {
  if (q.bidSz > 0 && q.askSz > 0) {
    return (q.bid * q.askSz + q.ask * q.bidSz) / (q.bidSz + q.askSz);
  }
  return (q.bid + q.ask) / 2;
}

interface VenueSpec {
  name: string;
  url: string;
  sub?: string;
  pingSec?: number;
  pingPayload?: string;
  parse: (v: Record<string, unknown>, receivedAt: number, previous?: Quote) => ParsedQuote | undefined;
}

interface ParsedQuote {
  quote: Quote;
  sourceAt: number;
  sequence?: number;
  clockSource: "exchange" | "received";
}

const REFERENCE_MAX_AGE_SEC = REFERENCE_FRESH_MAX_SEC;
const REFERENCE_FUTURE_TOLERANCE_SEC = 1;
const VENUE_IDLE_TIMEOUT_MS = 10_000;

export interface ReferenceFeedStatus {
  asset: string;
  healthy: boolean;
  reason: "waiting_for_quotes" | "healthy" | "stale_reference" | "stopped";
  connectedVenues: number;
  sourceAt?: number;
  expiresAt?: number;
}

export interface ReferenceFeedControl {
  stop: () => void;
  getStatus: () => ReferenceFeedStatus;
}

export interface ReferenceFeedCapability {
  asset: string;
  supported: boolean;
  reason?: "invalid_asset" | "unsupported_asset" | "disabled_by_configuration";
}

interface ReferenceAssetSpec {
  binance: string;
  coinbase: string;
  okx: string;
  bybit: string;
}

export interface ReferenceVenueProducts {
  binance: string;
  coinbase: string;
  okx: string;
  bybit: string;
}

const REFERENCE_ASSETS: Readonly<Record<string, ReferenceAssetSpec>> = Object.freeze({
  btc: { binance: "btcusdt", coinbase: "BTC-USD", okx: "BTC-USDT", bybit: "BTCUSDT" },
  eth: { binance: "ethusdt", coinbase: "ETH-USD", okx: "ETH-USDT", bybit: "ETHUSDT" },
  sol: { binance: "solusdt", coinbase: "SOL-USD", okx: "SOL-USDT", bybit: "SOLUSDT" },
});

function normalizeReferenceAsset(asset = "btc"): string {
  const normalized = asset.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(normalized)) throw new Error("reference asset must contain only letters and digits");
  return normalized;
}

function configuredReferenceAssets(): Set<string> | undefined {
  const raw = process.env.PM_REFERENCE_ASSETS?.trim();
  if (!raw) return undefined;
  return new Set(raw.split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
}

/** Reports whether this process has a real venue mapping for an asset. */
export function referenceFeedCapability(asset = "btc"): ReferenceFeedCapability {
  let normalized: string;
  try { normalized = normalizeReferenceAsset(asset); }
  catch { return { asset: String(asset), supported: false, reason: "invalid_asset" }; }
  if (!Object.hasOwn(REFERENCE_ASSETS, normalized)) return { asset: normalized, supported: false, reason: "unsupported_asset" };
  const configured = configuredReferenceAssets();
  if (configured && !configured.has(normalized)) {
    return { asset: normalized, supported: false, reason: "disabled_by_configuration" };
  }
  return { asset: normalized, supported: true };
}

/** Returns the exact public venue products used for the requested asset. */
export function referenceVenueProducts(asset = "btc"): ReferenceVenueProducts {
  const capability = referenceFeedCapability(asset);
  if (!capability.supported) throw new ReferenceFeedUnsupportedError(capability);
  return { ...REFERENCE_ASSETS[capability.asset]! };
}

export class ReferenceFeedUnsupportedError extends Error {
  readonly code = "reference_feed_unsupported";
  readonly capability: ReferenceFeedCapability;

  constructor(capability: ReferenceFeedCapability) {
    super(`${capability.asset}: ${capability.reason ?? "reference_feed_unsupported"}`);
    this.name = "ReferenceFeedUnsupportedError";
    this.capability = capability;
  }
}

export class ReferenceFeedInvalidEventError extends Error {
  readonly code = "reference_event_invalid";

  constructor() {
    super("reference event timestamp and price must be finite positive numbers");
    this.name = "ReferenceFeedInvalidEventError";
  }
}

/** Namespaces a reference price without allowing a non-BTC symbol to become a BTC event. */
export function referenceEvent(asset: string, tsUnix: number, price: number): Extract<FeedEvent, { kind: "btc" | "oracle" }> {
  const capability = referenceFeedCapability(asset);
  if (!capability.supported) throw new ReferenceFeedUnsupportedError(capability);
  if (!Number.isFinite(tsUnix) || tsUnix <= 0 || !Number.isFinite(price) || price <= 0) {
    throw new ReferenceFeedInvalidEventError();
  }
  return capability.asset === "btc"
    ? { kind: "btc", asset: "btc", tsUnix, price }
    : { kind: "oracle", asset: capability.asset, tsUnix, price };
}

function decimal(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function quoteFields(
  data: Record<string, unknown>, keys: readonly [string, string, string, string],
  fallback: string, previous?: Quote,
): Quote | undefined {
  const [bidKey, askKey, bidSizeKey, askSizeKey] = keys;
  for (const key of [...keys, fallback]) {
    if (data[key] !== undefined && decimal(data[key]) === undefined) return undefined;
  }
  const bid = decimal(data[bidKey]) ?? previous?.bid;
  const ask = decimal(data[askKey]) ?? previous?.ask;
  if (bid !== undefined && ask !== undefined && bid > 0 && ask >= bid) {
    return { bid, ask, bidSz: decimal(data[bidSizeKey]) ?? previous?.bidSz ?? 0,
      askSz: decimal(data[askSizeKey]) ?? previous?.askSz ?? 0 };
  }
  // A partial or crossed quote must not be disguised as a valid last trade.
  if (data[bidKey] !== undefined || data[askKey] !== undefined || previous) return undefined;
  const price = decimal(data[fallback]);
  return price !== undefined && price > 0 ? { bid: price, ask: price, bidSz: 0, askSz: 0 } : undefined;
}

function sequence(value: unknown): number | undefined {
  const parsed = decimal(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function timedQuote(quote: Quote | undefined, milliseconds: unknown, order?: unknown): ParsedQuote | undefined {
  const source = decimal(milliseconds);
  const seq = order === undefined ? undefined : sequence(order);
  if (!quote || source === undefined || source <= 0 || (order !== undefined && seq === undefined)) return undefined;
  return { quote, sourceAt: source / 1000, sequence: seq, clockSource: "exchange" };
}

function venues(asset: string): VenueSpec[] {
  const reference = referenceVenueProducts(asset);
  const binanceSymbol = reference.binance.toUpperCase();
  return [
    {
      name: "binance-spot",
      url: `wss://stream.binance.com:9443/ws/${reference.binance}@bookTicker`,
      parse: (v, receivedAt) => {
        if (v.s !== binanceSymbol) return undefined;
        const quote = quoteFields(v, ["b", "a", "B", "A"], "c");
        const seq = sequence(v.u);
        // Spot bookTicker has no exchange timestamp. Never invent one from E;
        // the mandatory update id prevents replay within and across reconnects.
        return quote && seq !== undefined
          ? { quote, sourceAt: receivedAt, sequence: seq, clockSource: "received" } : undefined;
      },
    },
    {
      name: "binance-perp",
      url: `wss://fstream.binance.com/ws/${reference.binance}@bookTicker`,
      parse: v => v.s === binanceSymbol && v.u !== undefined
        ? timedQuote(quoteFields(v, ["b", "a", "B", "A"], "c"), v.E, v.u) : undefined,
    },
    {
      name: "coinbase", url: "wss://ws-feed.exchange.coinbase.com",
      sub: JSON.stringify({ type: "subscribe", product_ids: [reference.coinbase], channels: ["ticker"] }),
      parse: v => {
        if (v.type !== "ticker" || v.product_id !== reference.coinbase || typeof v.time !== "string"
          || !/^\d{4}-\d\d-\d\dT/.test(v.time)) return undefined;
        return timedQuote(quoteFields(v, ["best_bid", "best_ask", "best_bid_size", "best_ask_size"], "price"),
          Date.parse(v.time), v.sequence);
      },
    },
    {
      name: "okx", url: "wss://ws.okx.com:8443/ws/v5/public",
      sub: JSON.stringify({ op: "subscribe", args: [{ channel: "tickers", instId: reference.okx }] }),
      pingSec: 20, pingPayload: "ping",
      parse: v => {
        const arg = object(v.arg);
        const data = Array.isArray(v.data) ? object(v.data[0]) : undefined;
        if (arg?.channel !== "tickers" || arg.instId !== reference.okx || data?.instId !== reference.okx) return undefined;
        return timedQuote(quoteFields(data, ["bidPx", "askPx", "bidSz", "askSz"], "last"), data.ts);
      },
    },
    {
      name: "bybit-perp", url: "wss://stream.bybit.com/v5/public/linear",
      sub: JSON.stringify({ op: "subscribe", args: [`tickers.${reference.bybit}`] }),
      pingSec: 20, pingPayload: JSON.stringify({ op: "ping" }),
      parse: (v, _receivedAt, previous) => {
        const data = object(v.data);
        if (v.topic !== `tickers.${reference.bybit}` || !data
          || (data.symbol !== undefined && data.symbol !== reference.bybit)
          || (v.type !== "snapshot" && v.type !== "delta")) return undefined;
        if (!["bid1Price", "ask1Price", "bid1Size", "ask1Size", "lastPrice"].some(key => data[key] !== undefined)) return undefined;
        if (v.type === "delta" && !previous) return undefined;
        return timedQuote(quoteFields(data, ["bid1Price", "ask1Price", "bid1Size", "ask1Size"], "lastPrice",
          v.type === "delta" ? previous : undefined), v.ts, v.cs);
      },
    },
  ];
}

function medianSorted(values: number[]): number {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

function connectWs(url: string, sockets: Set<WebSocket>, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const ws = new WebSocket(url);
    sockets.add(ws); // Include CONNECTING sockets so stop never leaves a dial alive.
    ws.on("error", () => {}); // A transport error can arrive between open and the loop attaching.
    let settled = false;
    const timer = setTimeout(() => finish(new Error("reference websocket connect timeout")), 10_000);
    const onOpen = () => finish();
    const onError = () => finish(new Error("reference websocket connection failed"));
    const onClose = () => finish(new Error("reference websocket closed before open"));
    const onAbort = () => finish(new Error("reference feed stopped"));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("open", onOpen); ws.off("error", onError); ws.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (error) { sockets.delete(ws); ws.terminate(); reject(error); }
      else resolve(ws);
    };
    ws.once("open", onOpen); ws.once("error", onError); ws.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function backoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function venueLoop(
  idx: number, spec: VenueSpec, onQuote: (idx: number, parsed: ParsedQuote) => void,
  onConnected: (idx: number, connected: boolean) => void,
  signal: AbortSignal, sockets: Set<WebSocket>,
): Promise<void> {
  // Retain ordering across reconnects. The book itself must be rebuilt per connection.
  let previousSourceAt = 0, previousSequence: number | undefined;
  let failures = 0;
  while (!signal.aborted) {
    let ws: WebSocket | undefined;
    try {
      ws = await connectWs(spec.url, sockets, signal);
      if (signal.aborted) break;
      const socket = ws;
      onConnected(idx, true);
      let previousQuote: Quote | undefined;
      let lastQuoteAt = Date.now();
      await new Promise<void>(resolve => {
        let finished = false;
        let pingTimer: ReturnType<typeof setInterval> | undefined;
        const idleTimer = setInterval(() => {
          if (Date.now() - lastQuoteAt >= VENUE_IDLE_TIMEOUT_MS) finish();
        }, 1000);
        const finish = () => {
          if (finished) return;
          finished = true;
          clearInterval(idleTimer); if (pingTimer) clearInterval(pingTimer);
          signal.removeEventListener("abort", finish);
          socket.off("message", onMessage); socket.off("close", finish); socket.off("error", finish);
          resolve();
        };
        const onMessage = (raw: WebSocket.RawData) => {
          if (signal.aborted || finished) return;
          try {
            const value = object(JSON.parse(String(raw)));
            if (!value) return;
            const receivedAt = nowUnix();
            const parsed = spec.parse(value, receivedAt, previousQuote);
            if (!parsed || parsed.sourceAt <= 0 || parsed.sourceAt > receivedAt + REFERENCE_FUTURE_TOLERANCE_SEC
              || receivedAt - parsed.sourceAt >= REFERENCE_MAX_AGE_SEC || parsed.sourceAt < previousSourceAt
              || (previousSequence !== undefined && (parsed.sequence === undefined || parsed.sequence <= previousSequence))
              || (parsed.sequence === undefined && parsed.sourceAt <= previousSourceAt)) return;
            previousSourceAt = parsed.sourceAt;
            previousSequence = parsed.sequence;
            previousQuote = parsed.quote;
            lastQuoteAt = Date.now(); failures = 0;
            onQuote(idx, parsed);
          } catch { /* Unknown/malformed frames do not kill the connection. */ }
        };
        socket.on("message", onMessage); socket.once("close", finish); socket.once("error", finish);
        signal.addEventListener("abort", finish, { once: true });
        if (spec.pingSec && spec.pingPayload) {
          pingTimer = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              try { socket.send(spec.pingPayload!); } catch { finish(); }
            }
          }, spec.pingSec * 1000);
        }
        if (spec.sub) { try { socket.send(spec.sub); } catch { finish(); } }
      });
    } catch { /* Availability is exposed by getStatus; reconnect without logging untrusted frames. */ }
    finally {
      onConnected(idx, false);
      if (ws) { sockets.delete(ws); ws.terminate(); }
    }
    if (!signal.aborted) {
      const cap = Math.min(30_000, 500 * 2 ** Math.min(failures++, 6));
      await backoff(cap * (0.75 + Math.random() * 0.5), signal);
    }
  }
}

/** Multi-venue reference microprice aggregator for one explicitly supported asset. */
export function runReferenceFeed(
  sink: FeedSink, asset = "btc", options: { allowedAssets?: readonly string[] } = {},
): ReferenceFeedControl {
  const capability = referenceFeedCapability(asset);
  if (!capability.supported) throw new ReferenceFeedUnsupportedError(capability);
  const allowed = options.allowedAssets?.map(value => normalizeReferenceAsset(value));
  if (allowed && !allowed.includes(capability.asset)) {
    throw new ReferenceFeedUnsupportedError({ ...capability, supported: false, reason: "disabled_by_configuration" });
  }
  const specs = venues(capability.asset);
  const controller = new AbortController();
  const last: Array<ParsedQuote | undefined> = specs.map(() => undefined);
  const connected = new Set<number>();
  const sockets = new Set<WebSocket>();
  let receivedQuotes = false;
  let lastPublishedAt = 0;
  const freshQuotes = (at: number) => last.filter((quote): quote is ParsedQuote => quote !== undefined
    && quote.sourceAt <= at + REFERENCE_FUTURE_TOLERANCE_SEC && quote.sourceAt + REFERENCE_MAX_AGE_SEC > at);
  const usableQuotes = () => {
    const fresh = freshQuotes(nowUnix());
    if (!fresh.length) return [];
    const median = medianSorted(fresh.map(item => micro(item.quote)).sort((a, b) => a - b));
    return fresh.filter(item => Math.abs(micro(item.quote) - median) / median < 0.02);
  };
  const onQuote = (idx: number, parsed: ParsedQuote) => {
    if (controller.signal.aborted) return;
    const price = micro(parsed.quote);
    if (!Number.isFinite(price) || price <= 0) return;
    last[idx] = parsed; receivedQuotes = true;
    sink({ kind: "venue", asset: capability.asset, venue: idx, tsUnix: parsed.sourceAt,
      sourceAt: parsed.sourceAt, expiresAt: parsed.sourceAt + REFERENCE_MAX_AGE_SEC, clockSource: parsed.clockSource,
      bid: parsed.quote.bid, ask: parsed.quote.ask, bidSz: parsed.quote.bidSz, askSz: parsed.quote.askSz });
    if (controller.signal.aborted) return;
    const kept = usableQuotes();
    if (!kept.length) return;
    const aggregate = kept.reduce((sum, item) => sum + micro(item.quote), 0) / kept.length;
    if (!Number.isFinite(aggregate) || aggregate <= 0) return;
    const tsUnix = Math.max(...kept.map(item => item.sourceAt));
    if (tsUnix < lastPublishedAt) return;
    const sourceAt = Math.min(...kept.map(item => item.sourceAt));
    const clockSource = kept.every(item => item.clockSource === kept[0]!.clockSource) ? kept[0]!.clockSource : "mixed";
    lastPublishedAt = tsUnix;
    // Valid unchanged quotes refresh freshness too; silence is never refreshed by a timer.
    sink({ ...referenceEvent(capability.asset, tsUnix, aggregate), sourceAt,
      expiresAt: sourceAt + REFERENCE_MAX_AGE_SEC, clockSource });
  };
  for (let idx = 0; idx < specs.length; idx++) {
    void venueLoop(idx, specs[idx]!, onQuote, (index, active) => {
      if (active) connected.add(index);
      else { connected.delete(index); last[index] = undefined; }
    }, controller.signal, sockets);
  }
  return {
    stop: () => {
      if (controller.signal.aborted) return;
      controller.abort();
      for (const socket of sockets) socket.terminate();
      sockets.clear(); connected.clear(); last.fill(undefined);
    },
    getStatus: () => {
      const fresh = usableQuotes();
      const healthy = !controller.signal.aborted && fresh.length > 0;
      const sourceAt = fresh.length ? Math.min(...fresh.map(item => item.sourceAt)) : undefined;
      return { asset: capability.asset, healthy,
        reason: controller.signal.aborted ? "stopped" : healthy ? "healthy" : receivedQuotes ? "stale_reference" : "waiting_for_quotes",
        connectedVenues: connected.size, sourceAt,
        expiresAt: sourceAt === undefined ? undefined : sourceAt + REFERENCE_MAX_AGE_SEC };
    },
  };
}

/** Backward-compatible BTC reference producer used by the existing platform adapter. */
export function runBtcFeed(sink: FeedSink): ReferenceFeedControl {
  return runReferenceFeed(sink, "btc");
}
