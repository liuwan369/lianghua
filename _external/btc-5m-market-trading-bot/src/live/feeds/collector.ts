import { type BookSnapshot, type FeedSink, nowUnix, sleep } from "./index.js";

export function runCollectorBookFeed(sink: FeedSink, upToken: string, downToken: string, deadline: number, hz = 2): { stop: () => void } {
  let alive = true;
  let activeController: AbortController | undefined;
  const base = process.env.PM_LIVE_URL ?? "http://127.0.0.1:8765/api/live";
  const periodMs = Math.min(Math.max(1000 / Math.max(hz, 0.2), 250), 5000);
  const loop = async () => {
    let last: string | undefined;
    while (alive && nowUnix() < deadline) {
      try {
        const controller = new AbortController();
        activeController = controller;
        const timeout = setTimeout(() => controller.abort(), 30_000);
        const resp = await fetch(base, { signal: controller.signal });
        clearTimeout(timeout);
        if (activeController === controller) activeController = undefined;
        if (resp.ok) {
          const payload = (await resp.json()) as { collector_online?: boolean; current_markets?: Array<Record<string, unknown>> };
          if (payload.collector_online !== true) {
            if (!alive) break;
            await sleep(periodMs);
            continue;
          }
          const item = (payload.current_markets ?? []).find((m) => m.up_token === upToken && m.down_token === downToken);
          const quoteAt = typeof item?.quote_at === "string" ? Date.parse(item.quote_at) : NaN;
          const quoteAgeSec = Number.isFinite(quoteAt) ? (Date.now() - quoteAt) / 1000 : Number.POSITIVE_INFINITY;
          if (quoteAgeSec < 0 || quoteAgeSec > 2) {
            if (!alive) break;
            await sleep(periodMs);
            continue;
          }
          const ub = Number(item?.up_bid), ua = Number(item?.up_ask), db = Number(item?.down_bid), da = Number(item?.down_ask);
          if ([ub, ua, db, da].every((p) => Number.isFinite(p) && p > 0 && p < 1)) {
            const key = `${ub}|${ua}|${db}|${da}`;
            if (key !== last) {
              last = key;
              const snapshot: BookSnapshot = { tsUnix: quoteAt / 1000, source: "collector-rest", upBid: ub, upAsk: ua, downBid: db, downAsk: da };
              sink({ kind: "book", snapshot });
            }
          }
        }
      } catch {
        activeController = undefined;
        /* retry */
      }
      if (!alive) break;
      await sleep(periodMs);
    }
  };
  void loop();
  return { stop: () => {
    alive = false;
    activeController?.abort();
    activeController = undefined;
  } };
}
