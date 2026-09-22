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

export function venueName(i: number): string {
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

function venues(): VenueSpec[] {
  return [
    {
      name: "binance-spot",
      url: "wss://stream.binance.com:9443/ws/btcusdt@bookTicker",
      parse: parseBinance,
    },
    {
      name: "binance-perp",
      url: "wss://fstream.binance.com/ws/btcusdt@bookTicker",
      parse: parseBinance,
    },
    {
      name: "coinbase",
      url: "wss://ws-feed.exchange.coinbase.com",
      sub: JSON.stringify({
        type: "subscribe",
        product_ids: ["BTC-USD"],
        channels: ["ticker"],
      }),
      parse: parseCoinbase,
    },
    {
      name: "okx",
      url: "wss://ws.okx.com:8443/ws/v5/public",
      sub: JSON.stringify({
        op: "subscribe",
        args: [{ channel: "tickers", instId: "BTC-USDT" }],
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
        args: ["tickers.BTCUSDT"],
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
  onQuote: (idx: number, q: Quote, ts: number) => void,
  running: () => boolean,
  sockets: Set<WebSocket>,
): Promise<void> {
  while (running()) {
    try {
      const ws = await connectWs(spec.url);
      sockets.add(ws);
      if (spec.sub) ws.send(spec.sub);
      console.info(`BTC venue '${spec.name}' connected`);

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
      console.warn(`BTC venue '${spec.name}' connect failed: ${e}`);
    }
    if (running()) {
      console.warn(`BTC venue '${spec.name}' dropped, reconnecting in 2s`);
      await sleep(2000);
    }
  }
}

/** Multi-venue BTC microprice aggregator. */
export function runBtcFeed(sink: FeedSink): { stop: () => void } {
  const specs = venues();
  const n = specs.length;
  let alive = true;
  const last = Array.from({ length: n }, () => Number.NaN);
  const lastTs = Array.from({ length: n }, () => 0);
  const trace = process.env.BTC_TRACE != null;
  const sockets = new Set<WebSocket>();

  const onQuote = (i: number, q: Quote, ts: number) => {
    const microPx = micro(q);
    const prev = last[i]!;
    last[i] = microPx;
    lastTs[i] = ts;

    if (!Number.isFinite(prev) || Math.abs(microPx - prev) >= 0.001) {
      sink({
        kind: "venue",
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
        `BTC_AGG live=${kept.length}/${n} mean=$${price.toFixed(2)} (moved ${venueName(i)})`,
      );
    }

    sink({ kind: "btc", tsUnix: ts, price });
  };

  for (let i = 0; i < specs.length; i++) {
    void venueLoop(i, specs[i]!, onQuote, () => alive, sockets);
  }

  return { stop: () => {
    alive = false;
    for (const ws of sockets) ws.terminate();
    sockets.clear();
  } };
}

export type { FeedEvent };
