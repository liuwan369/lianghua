// Live probe (user agreed 2026-10-28): is the venue slow AT a Binance signal for
// every order (queueing), or only for orders near the book? Each "shot" sends
// two orders at once and records the POST -> response-headers time of each:
//   A far  : post-only BUY 5 @ 0.01 on the side whose bid is >= 0.30 (rests far
//            below the book; post-only never takes);
//   C bad  : FAK BUY 5 @ 0.01 = 0.05 USD, under the venue's 1 USD marketable
//            minimum, refused at validation ("front door" time). If the side's
//            ask is ever <= 0.05 the shot is skipped, so C can never match.
// A is cancelled right after. (No order near the book: one could fill, and the
// user agreed only to orders that cannot.) Shots are fired at Binance 2bp/250 ms
// signals (the engine's own LeadSignalDetector) and, as control, at calm moments
// (no signal for 5 s). Stops on any trade, any unexpected status, or the cap.
// Worst case: 0 USD. A rests at 0.01 under a bid >= 0.30; C is refused.
//
//   node scripts/probe-signal-latency.mjs <minutes> <maxShots>
// Needs the engine's account env. Prints one JSON line per shot, then a summary.
import { ClobWrapper } from "../dist/live/clob/client.js";
import { ownerSignerPrivateKey } from "../dist/live/account.js";
import { LeadSignalDetector, runBinanceTrades } from "../dist/live/feeds/binance-trades.js";

const minutes = Number(process.argv[2] ?? 30), maxShots = Number(process.argv[3] ?? 40);
if (!(minutes > 0 && minutes <= 120 && maxShots >= 1 && maxShots <= 80)) throw new Error("usage: <minutes<=120> <maxShots<=80>");
const MIN_BID = 0.3, SHARES = 5, CALM_MS = 5000, MIN_GAP_MS = 4000;
const key = ownerSignerPrivateKey();
if (!key) throw new Error("owner signer key unavailable");
const client = await ClobWrapper.connect({ key });

const gamma = async (start) => {
  const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${start}`);
  const [m] = await r.json();
  if (!m) return undefined;
  const tokens = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
  const outs = (typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes).map(o => o.toLowerCase());
  return { conditionId: m.conditionId, up: tokens[outs.indexOf("up")], down: tokens[outs.indexOf("down")], start };
};
const book = async (token) => {
  const b = await (await fetch(`https://clob.polymarket.com/book?token_id=${token}`)).json();
  const bids = (b.bids ?? []).map(x => Number(x.price)), asks = (b.asks ?? []).map(x => Number(x.price));
  return { bid: bids.length ? Math.max(...bids) : 0, ask: asks.length ? Math.min(...asks) : 1, tick: Number(b.tick_size ?? 0.01) };
};

let market, marketFor = 0;
const ensureMarket = async () => {
  const start = Math.floor(Date.now() / 1000 / 300) * 300;
  if (marketFor === start) return market;
  marketFor = start;
  market = await gamma(start);
  if (market) await client.warmMarket(market.conditionId);
  return market;
};
await ensureMarket();
// Keep a fresh book of both sides (REST, 1 s): the shot reads it without waiting.
const books = {};
const refresh = async () => {
  const m = await ensureMarket().catch(() => undefined);
  if (!m) return;
  const [u, d] = await Promise.all([book(m.up), book(m.down)]).catch(() => [undefined, undefined]);
  if (u && d) Object.assign(books, { [m.up]: u, [m.down]: d, at: Date.now(), start: m.start });
};
await refresh();
const refresher = setInterval(() => { void refresh(); }, 1000);

const rows = [];
let busy = false, lastShot = 0, lastSignal = 0, stop = false;
const send = async (args) => {
  const t0 = performance.now();
  const r = await client.submitOrder(args);
  return { r, ms: performance.now() - t0 };
};
async function shot(kind, signal) {
  if (busy || stop || rows.length >= maxShots || Date.now() - lastShot < MIN_GAP_MS) return;
  const m = market, sec = Date.now() / 1000 - (m?.start ?? 0);
  if (!m || books.start !== m.start || Date.now() - books.at > 2500 || sec < 15 || sec > 270) return;
  const token = books[m.up].bid >= books[m.down].bid ? m.up : m.down, side = books[token];
  if (side.bid < MIN_BID || side.ask <= 0.05 || side.ask - side.bid > 0.05) return;
  busy = true; lastShot = Date.now();
  const base = { tokenId: token, size: SHARES, tickSize: side.tick, direction: "BUY" };
  const [a, c] = await Promise.all([
    send({ ...base, price: 0.01, timeInForce: "GTC", postOnly: true }),
    send({ ...base, price: 0.01, timeInForce: "FAK", postOnly: false }),
  ]);
  for (const x of [a]) if (x.r.orderId) await client.cancel(x.r.orderId).catch(e => { x.cancelErr = String(e.message ?? e).slice(0, 60); });
  const traded = [a, c].some(x => (x.r.tradeIds?.length ?? 0) > 0 || ["matched", "delayed"].includes(x.r.status));
  const row = { kind, at: Math.round(Date.now() / 1000), sinceTradeMs: signal ? Math.round(Date.now() - signal.tradeTimeMs) : null,
    moveBp: signal ? Math.round(signal.moveBp * 100) / 100 : null, bid: side.bid, ask: side.ask,
    A: Math.round(a.r.responseHeadersLatencyMs ?? a.ms), C: Math.round(c.r.responseHeadersLatencyMs ?? c.ms),
    st: [a.r.status ?? a.r.errorMsg?.slice(0, 30), (c.r.errorMsg ?? c.r.status ?? "").slice(0, 40)] };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (traded) { stop = true; console.log("STOP: a probe order traded", JSON.stringify(row.st)); }
  if (a.r.status !== "live" || !/invalid amount/i.test(c.r.errorMsg ?? "")) {
    stop = true; console.log("STOP: unexpected status", JSON.stringify(row.st));
  }
  busy = false;
}

const detector = new LeadSignalDetector({ windowMs: 250, thresholdBp: 2, fromSec: 15, toSec: 270 });
const feed = runBinanceTrades(trade => {
  const signal = detector.push(trade, trade.receivedAtUnix);
  if (signal) { lastSignal = Date.now(); void shot("signal", signal); }
});
const calm = setInterval(() => { if (Date.now() - lastSignal > CALM_MS) void shot("calm"); }, 7000);
const deadline = Date.now() + minutes * 60_000;
while (!stop && rows.length < maxShots && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
clearInterval(calm); clearInterval(refresher); feed.stop();
while (busy) await new Promise(r => setTimeout(r, 100));
const open = await client.client.getOpenOrders().catch(() => null);
const pick = (kind, k) => rows.filter(r => r.kind === kind).map(r => r[k]).sort((x, y) => x - y);
const q = (v, f) => v.length ? v[Math.min(v.length - 1, Math.floor(v.length * f))] : null;
const summary = {};
for (const kind of ["signal", "calm"]) for (const k of ["A", "C"]) {
  const v = pick(kind, k);
  summary[`${kind}_${k}`] = { n: v.length, p50: q(v, 0.5), p90: q(v, 0.9), max: v.at(-1) ?? null };
}
console.log(JSON.stringify({ summary, openOrdersLeft: open?.length ?? "unknown", stopped: stop }));
process.exit(0);
