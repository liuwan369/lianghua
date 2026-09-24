import WebSocket from "ws";
import { type FeedEvent, type FeedSink, nowUnix, num, sleep } from "./index.js";

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

function venueName(i: number): string {
  return (
    ["binance-spot", "binance-perp", "coinbase", "okx", "bybit-perp"][i] ?? "?"
  );
}

interface VenueSpec {
  name: string;
  url: string;
  sub?: string;
  pingSec?: number;
  pingPayload?: string;
  parse: (v: Record<string, unknown>) => Quote | undefined;
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
  if (!REFERENCE_ASSETS[normalized]) return { asset: normalized, supported: false, reason: "unsupported_asset" };
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

function parseBinance(v: Record<string, unknown>): Quote | undefined {
  const b = num(v.b);
  const a = num(v.a);
  if (b != null && a != null && b > 0 && a > 0) {
    return {
      bid: b,
      ask: a,
      bidSz: num(v.B) ?? 0,
      askSz: num(v.A) ?? 0,
    };
  }
  const p = num(v.p) ?? num(v.c);
  if (p == null) return undefined;
  return { bid: p, ask: p, bidSz: 0, askSz: 0 };
}

function parseCoinbase(v: Record<string, unknown>): Quote | undefined {
  if (v.type !== "ticker") return undefined;
  const b = num(v.best_bid);
  const a = num(v.best_ask);
  if (b != null && a != null && b > 0 && a > 0) {
    return {
      bid: b,
      ask: a,
      bidSz: num(v.best_bid_size) ?? 0,
      askSz: num(v.best_ask_size) ?? 0,
    };
  }
  const p = num(v.price);
  if (p == null) return undefined;
  return { bid: p, ask: p, bidSz: 0, askSz: 0 };
}

function parseOkx(v: Record<string, unknown>): Quote | undefined {
  const data = v.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const d = data[0] as Record<string, unknown>;
  const b = num(d.bidPx);
  const a = num(d.askPx);
  if (b != null && a != null && b > 0 && a > 0) {
    return {
      bid: b,
      ask: a,
      bidSz: num(d.bidSz) ?? 0,
      askSz: num(d.askSz) ?? 0,
    };
  }
  const p = num(d.last);
  if (p == null) return undefined;
  return { bid: p, ask: p, bidSz: 0, askSz: 0 };
}

function parseBybit(v: Record<string, unknown>): Quote | undefined {
  const d = v.data as Record<string, unknown> | undefined;
  if (!d) return undefined;
  const b = num(d.bid1Price);
  const a = num(d.ask1Price);
  if (b != null && a != null && b > 0 && a > 0) {
    return {
      bid: b,
      ask: a,
      bidSz: num(d.bid1Size) ?? 0,
      askSz: num(d.ask1Size) ?? 0,
    };
  }
  const p = num(d.lastPrice);
  if (p == null) return undefined;
  return { bid: p, ask: p, bidSz: 0, askSz: 0 };
}

function venues(asset: string): VenueSpec[] {
  const reference = referenceVenueProducts(asset);
  return [
    {
      name: "binance-spot",
      url: `wss://stream.binance.com:9443/ws/${reference.binance}@bookTicker`,
      parse: parseBinance,
    },
    {
      name: "binance-perp",
      url: `wss://fstream.binance.com/ws/${reference.binance}@bookTicker`,
      parse: parseBinance,
    },
    {
      name: "coinbase",
      url: "wss://ws-feed.exchange.coinbase.com",
      sub: JSON.stringify({
        type: "subscribe",
        product_ids: [reference.coinbase],
        channels: ["ticker"],
      }),
      parse: parseCoinbase,
    },
    {
      name: "okx",
      url: "wss://ws.okx.com:8443/ws/v5/public",
      sub: JSON.stringify({
        op: "subscribe",
        args: [{ channel: "tickers", instId: reference.okx }],
      }),
      pingSec: 20,
      pingPayload: "ping",
      parse: parseOkx,
    },
    {
      name: "bybit-perp",
      url: "wss://stream.bybit.com/v5/public/linear",
      sub: JSON.stringify({
        op: "subscribe",
        args: [`tickers.${reference.bybit}`],
      }),
      pingSec: 20,
      pingPayload: JSON.stringify({ op: "ping" }),
      parse: parseBybit,
    },
  ];
}

function medianSorted(v: number[]): number {
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
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

async function venueLoop(
  idx: number,
  spec: VenueSpec,
  asset: string,
  onQuote: (idx: number, q: Quote, ts: number) => void,
  running: () => boolean,
  sockets: Set<WebSocket>,
): Promise<void> {
  while (running()) {
    try {
      const ws = await connectWs(spec.url);
      if (!running()) {
        ws.terminate();
        break;
      }
      sockets.add(ws);
      if (spec.sub) ws.send(spec.sub);
      console.info(`${asset.toUpperCase()} venue '${spec.name}' connected`);

      let pingTimer: ReturnType<typeof setInterval> | undefined;
      if (spec.pingSec && spec.pingPayload) {
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(spec.pingPayload!);
        }, spec.pingSec * 1000);
      }

      await new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          try {
            const val = JSON.parse(String(data)) as Record<string, unknown>;
            const q = spec.parse(val);
            if (q && q.bid > 0 && q.ask > 0 && q.ask >= q.bid) {
              onQuote(idx, q, nowUnix());
            }
          } catch {
            /* ignore parse errors */
          }
        });
        ws.on("close", () => resolve());
        ws.on("error", () => resolve());
      });

      if (pingTimer) clearInterval(pingTimer);
      ws.terminate();
      sockets.delete(ws);
    } catch (e) {
      console.warn(`${asset.toUpperCase()} venue '${spec.name}' connect failed: ${e}`);
    }
    if (running()) {
      console.warn(`${asset.toUpperCase()} venue '${spec.name}' dropped, reconnecting in 2s`);
      await sleep(2000);
    }
  }
}

/** Multi-venue reference microprice aggregator for one explicitly supported asset. */
export function runReferenceFeed(
  sink: FeedSink,
  asset = "btc",
  options: { allowedAssets?: readonly string[] } = {},
): { stop: () => void } {
  const capability = referenceFeedCapability(asset);
  if (!capability.supported) throw new ReferenceFeedUnsupportedError(capability);
  const allowed = options.allowedAssets?.map(value => normalizeReferenceAsset(value));
  if (allowed && !allowed.includes(capability.asset)) {
    throw new ReferenceFeedUnsupportedError({ ...capability, supported: false, reason: "disabled_by_configuration" });
  }
  const specs = venues(capability.asset);
  const n = specs.length;
  let alive = true;
  const last = Array.from({ length: n }, () => Number.NaN);
  const lastTs = Array.from({ length: n }, () => 0);
  const trace = process.env.BTC_TRACE != null || process.env.REFERENCE_TRACE != null;
  const sockets = new Set<WebSocket>();

  const onQuote = (i: number, q: Quote, ts: number) => {
    const microPx = micro(q);
    const prev = last[i]!;
    last[i] = microPx;
    lastTs[i] = ts;

    if (!Number.isFinite(prev) || Math.abs(microPx - prev) >= 0.001) {
      sink({
        kind: "venue",
        asset: capability.asset,
        venue: i,
        tsUnix: ts,
        bid: q.bid,
        ask: q.ask,
        bidSz: q.bidSz,
        askSz: q.askSz,
      });
    }

    const venueMoved =
      !Number.isFinite(prev) || Math.abs(microPx - prev) >= 0.005;
    if (!venueMoved) return;

    const fresh: number[] = [];
    for (let j = 0; j < n; j++) {
      if (Number.isFinite(last[j]!) && ts - lastTs[j]! < 5) {
        fresh.push(last[j]!);
      }
    }
    if (fresh.length === 0) return;

    fresh.sort((a, b) => a - b);
    const med = medianSorted(fresh);
    const kept = fresh.filter((p) => med <= 0 || Math.abs(p - med) / med < 0.02);
    const price = kept.reduce((s, p) => s + p, 0) / kept.length;

    if (trace) {
      console.info(
        `${capability.asset.toUpperCase()}_AGG live=${kept.length}/${n} mean=$${price.toFixed(2)} (moved ${venueName(i)})`,
      );
    }

    sink(capability.asset === "btc"
      ? { kind: "btc", asset: "btc", tsUnix: ts, price }
      : { kind: "oracle", asset: capability.asset, tsUnix: ts, price });
  };

  for (let i = 0; i < specs.length; i++) {
    void venueLoop(i, specs[i]!, capability.asset, onQuote, () => alive, sockets);
  }

  return { stop: () => {
    alive = false;
    for (const ws of sockets) ws.terminate();
    sockets.clear();
  } };
}

/** Backward-compatible BTC reference producer used by the existing platform adapter. */
export function runBtcFeed(sink: FeedSink): { stop: () => void } {
  return runReferenceFeed(sink, "btc");
}
