import { type BookSnapshot, type FeedSink, nowUnix, num, sleep } from "./index.js";

const CLOB_PRICES = "https://clob.polymarket.com/prices";

function price(v: unknown, token: string, side: string): number | undefined {
  if (!v || typeof v !== "object") return undefined;
  const tok = (v as Record<string, unknown>)[token];
  if (!tok || typeof tok !== "object") return undefined;
  return num((tok as Record<string, unknown>)[side]);
}

/** REST top-of-book backstop poller. */
export function runClobPollFeed(
  sink: FeedSink,
  upToken: string,
  downToken: string,
  deadline: number,
  hz: number,
): { stop: () => void } {
  if (hz <= 0) return { stop: () => {} };

  let alive = true;
  const periodMs = Math.min(Math.max(1000 / hz, 20), 5000);
  const body = [
    { token_id: upToken, side: "BUY" },
    { token_id: upToken, side: "SELL" },
    { token_id: downToken, side: "BUY" },
    { token_id: downToken, side: "SELL" },
  ];

  const loop = async () => {
    let lastSent: [number, number, number, number] | undefined;

    while (alive && nowUnix() < deadline) {
      await sleep(periodMs);
      if (!alive || nowUnix() >= deadline) break;
      try {
        const resp = await fetch(CLOB_PRICES, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) continue;
        const v = await resp.json();
        const ub = price(v, upToken, "BUY");
        const ua = price(v, upToken, "SELL");
        const db = price(v, downToken, "BUY");
        const da = price(v, downToken, "SELL");
        if (ub == null || ua == null || db == null || da == null) continue;
        if (![ub, ua, db, da].every((p) => p > 0 && p < 1)) continue;

        const key: [number, number, number, number] = [ub, ua, db, da];
        if (
          lastSent &&
          lastSent[0] === key[0] &&
          lastSent[1] === key[1] &&
          lastSent[2] === key[2] &&
          lastSent[3] === key[3]
        ) {
          continue;
        }
        lastSent = key;

        const snap: BookSnapshot = {
          tsUnix: nowUnix(),
          source: "clob-rest",
          upBid: ub,
          upAsk: ua,
          downBid: db,
          downAsk: da,
        };
        sink({ kind: "book", snapshot: snap });
      } catch {
        /* retry next tick */
      }
      if (!alive) break;
    }
  };

  void loop();
  return { stop: () => { alive = false; } };
}

export { price };
