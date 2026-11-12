// Lead trade per-message cost (no network): Tokyo encode (HMAC), Ireland
// decode (mac check + parse) + venue dedupe, and a direct WebSocket frame's
// JSON parse + dedupe, for each venue. Run after `npm run build`:
//   node scripts/bench/lead-relay.mjs [messages=200000]
import { createSecretKey, randomBytes } from "node:crypto";
import { VenueIngest, decodeRelay, encodeRelay } from "../../dist/live/feeds/lead-trades.js";

const N = Number(process.argv[2] ?? 200_000);
const key = createSecretKey(randomBytes(32));
const T0 = Date.now() - 50;
const ns = (start, n) => Number(process.hrtime.bigint() - start) / n;
const sink = () => {};

const trades = {
  bybit: k => ({ venue: "bybit", id: `0b6d1c5e-7a1f-5c2b-9e8d-${String(k).padStart(12, "0")}`, seq: 834185528852 + k * 97, price: 80000 + (k % 50) / 10, tradeTimeMs: T0 }),
  binance: k => ({ venue: "binance", id: 5_123_456_789 + k, price: 80000 + (k % 50) / 10, tradeTimeMs: T0 }),
  okx: k => ({ venue: "okx", id: 1_234_567_890 + k, price: 80000 + (k % 50) / 10, tradeTimeMs: T0 }),
};
const frames = {
  bybit: t => JSON.stringify({ topic: "publicTrade.BTCUSDT", type: "snapshot", ts: t.tradeTimeMs,
    data: [{ T: t.tradeTimeMs, s: "BTCUSDT", S: "Buy", v: "0.010", p: String(t.price), L: "PlusTick", i: t.id, BT: false, RPI: false, seq: t.seq }] }),
  binance: t => JSON.stringify({ e: "aggTrade", E: t.tradeTimeMs + 2, s: "BTCUSDT", a: t.id, p: String(t.price), q: "0.010", f: t.id, l: t.id, T: t.tradeTimeMs, m: false }),
  okx: t => JSON.stringify({ arg: { channel: "trades", instId: "BTC-USDT-SWAP" },
    data: [{ instId: "BTC-USDT-SWAP", tradeId: String(t.id), px: String(t.price), sz: "0.01", side: "buy", ts: String(t.tradeTimeMs), count: "1" }] }),
};
const product = { bybit: "BTCUSDT", binance: "btcusdt", okx: "BTC-USDT-SWAP" };

const rows = [];
for (const venue of ["bybit", "binance", "okx"]) {
  const list = Array.from({ length: N }, (_, k) => trades[venue](k));
  // Tokyo: encode + HMAC
  let start = process.hrtime.bigint();
  const messages = list.map(t => encodeRelay(key, t, T0 + 20));
  const encodeNs = ns(start, N);
  // Ireland: decode (mac + parse) + dedupe, every trade delivered
  const relayIngest = new VenueIngest(venue, product[venue], sink);
  const unix = (T0 + 50) / 1000;   // fixed: every trade 50 ms old
  start = process.hrtime.bigint();
  for (const m of messages) { const t = decodeRelay(m, key); if (typeof t !== "number") relayIngest.relayed(t, unix, 0); }
  const relayNs = ns(start, N);
  // The same trades again (the other line's copies): mac + parse + dedupe drop
  start = process.hrtime.bigint();
  for (const m of messages) { const t = decodeRelay(m, key); if (typeof t !== "number") relayIngest.relayed(t, unix, 0); }
  const copyNs = ns(start, N);
  if (relayIngest.stats().tokyo.delivered !== N) throw new Error(`${venue}: delivered ${relayIngest.stats().tokyo.delivered}`);
  // Direct frame: JSON parse + dedupe
  const raw = list.map(frames[venue]);
  const directIngest = new VenueIngest(venue, product[venue], sink);
  start = process.hrtime.bigint();
  for (const f of raw) directIngest.frame(f, "direct", unix, 0);
  const directNs = ns(start, N);
  rows.push({ venue, encode_ns: Math.round(encodeNs), relay_decode_dedupe_ns: Math.round(relayNs),
    relay_copy_dropped_ns: Math.round(copyNs), direct_frame_ns: Math.round(directNs), bytes: messages[0].length });
}
console.table(rows);
