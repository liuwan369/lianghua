import WebSocket from "ws";
import { type FeedSink, nowUnix, num, sleep } from "./index.js";

const RTDS_WS = "wss://ws-live-data.polymarket.com";

export function parseOracle(text: string): number | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  const events = Array.isArray(v) ? v : [v];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const payload = (e.payload ?? e) as Record<string, unknown>;
    const sym = String(payload.symbol ?? "").toLowerCase();
    if (sym && !sym.includes("btc")) continue;
    const val = num(payload.value) ?? num(payload.price);
    if (val != null && Number.isFinite(val) && val > 0) return val;
  }
  return undefined;
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

/** RTDS Chainlink BTC/USD oracle websocket feed. */
export function runRtdsFeed(sink: FeedSink): { stop: () => void } {
  let alive = true;
  let activeWs: WebSocket | undefined;

  const loop = async () => {
    while (alive) {
      try {
        const ws = await connectWs(RTDS_WS);
        activeWs = ws;
        ws.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [
              {
                topic: "crypto_prices_chainlink",
                type: "update",
                filters: JSON.stringify({ symbol: "btc/usd" }),
              },
            ],
          }),
        );
        console.info("RTDS chainlink BTC/USD oracle feed connected + subscribed");

        const trace = process.env.RTDS_TRACE != null;
        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, 5000);

        await new Promise<void>((resolve) => {
          ws.on("message", (data) => {
            const t = String(data);
            if (trace) console.info(`RTDS_RAW ${t.slice(0, 240)}`);
            const price = parseOracle(t);
            if (price != null) {
              sink({ kind: "oracle", tsUnix: nowUnix(), price });
            }
          });
          ws.on("close", () => resolve());
          ws.on("error", () => resolve());
        });

        clearInterval(ping);
        ws.terminate();
        if (activeWs === ws) activeWs = undefined;
      } catch (e) {
        console.warn(`RTDS connect failed: ${e}`);
      }

      if (alive) {
        console.warn("RTDS oracle feed dropped, reconnecting in 2s");
        await sleep(2000);
      }
    }
  };

  void loop();
  return { stop: () => {
    alive = false;
    activeWs?.terminate();
    activeWs = undefined;
  } };
}
