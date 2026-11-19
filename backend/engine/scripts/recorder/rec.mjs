// London recorder (user 2026-11-19): everything a later backtest of the BTC
// 5-minute market may need, on one box and one clock. Read-only, no keys.
//
// One gzip'd JSON line per message in <dir>/<UTC day>/<feed>-<process start s>.jsonl.gz,
// one file per feed so a stall or burst on one never delays another. r = this
// box's receive time in ms (chrony-synced), on every row. A killed process
// leaves at most the tail of its own files truncated: read with
// zlib.decompressobj. Needs Node >= 22 (global WebSocket).
//
// pm  Polymarket btc 5m market channel, the live round and the next two:
//   {k:"book", r, ts, R, tok, b:[[p,s]...], a:[[p,s]...]}         full book (every level)
//   {k:"pc", r, ts, c:[[R, tok, price, size, side, bestBid, bestAsk]...]}  level change
//   (the venue's per-change hash is not kept: 75% of the bytes, and the full
//   books it sends resync the depth anyway; tested 2026-11-19, 7.9 -> 1.9 MB / 90 s)
//   {k:"tr", r, ts, R, tok, p, s, S, fee}                           trade print (last_trade_price)
//   {k:"tick", r, ts, R, tok, old, new}                             tick size change
//   {k:"bbo", r, ts, R, tok, b, a, sp}                              best_bid_ask (when sent)
//   {k:"raw", r, m}                                                 any other event, kept whole
// meta  round metadata and official results (gamma):
//   {k:"m", r, R, slug, up, dn, cond, tick, min, start, end}        once per round, when discovered
//   {k:"res", r, R, slug, prices, closed, uma}                      the official result, once resolved
// by  Bybit linear BTCUSDT: {k:"t", r, T, p, v, S, i} publicTrade; {k:"b1"|"b50", r, ts, cts, ty, u, b, a}
// bn  Binance USD-M BTCUSDT: {k:"t", r, E, T, a, p, q, m} aggTrade; {k:"bbo", r, E, T, u, b, B, a, A} bookTicker
// bs  Binance spot BTCUSDT: {k:"t", r, E, T, a, p, q, m} aggTrade
// ok  OKX BTC-USDT-SWAP: {k:"t", r, ts, i, p, q, S} trades; {k:"bbo", r, ts, b, B, a, A} bbo-tbt
// cl  Polymarket RTDS Chainlink BTC/USD (the settlement source): {k:"c", r, ts, p}
// stat  once a minute: {k:"stat", r, counts, rss, lag}
//
//   node rec.mjs [dir]           (systemd: pm-rec.service, Restart=always)
import { createWriteStream, mkdirSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createGzip, constants } from "node:zlib";

const DIR = process.argv[2] ?? "/root/rec";
const START = Math.floor(Date.now() / 1000);
const counts = {};
const bump = (k, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
const files = new Map(); // feed -> {day, gz}
let stopping = false;

function out(feed, row) {
  if (stopping) return;
  const day = new Date().toISOString().slice(0, 10);
  let f = files.get(feed);
  if (!f || f.day !== day) {
    f?.gz.end();
    mkdirSync(join(DIR, day), { recursive: true });
    const gz = createGzip({ level: 6 });
    gz.pipe(createWriteStream(join(DIR, day, `${feed}-${START}.jsonl.gz`), { flags: "a" }));
    gz.on("error", () => bump(feed + ":gzerr"));
    f = { day, gz };
    files.set(feed, f);
  }
  f.gz.write(JSON.stringify(row) + "\n");
  bump(`${feed}.${row.k}`);
}
// A sync flush every 2 s bounds what a crash loses to ~2 s per feed.
const flusher = setInterval(() => { for (const { gz } of files.values()) gz.flush(constants.Z_SYNC_FLUSH); }, 2000);
process.on("uncaughtException", e => { bump("uncaught"); console.error("uncaught", String(e?.stack ?? e).slice(0, 300)); });
process.on("unhandledRejection", e => { bump("unhandled"); console.error("unhandled", String(e).slice(0, 300)); });
function finish(why) {
  if (stopping) return;
  console.log(why, JSON.stringify(counts));
  stopping = true; clearInterval(flusher);
  let left = files.size;
  if (!left) process.exit(0);
  for (const { gz } of files.values()) gz.end(() => { if (--left === 0) setTimeout(() => process.exit(0), 300); });
  setTimeout(() => process.exit(0), 5000);
}
process.on("SIGTERM", () => finish("sigterm"));
process.on("SIGINT", () => finish("sigint"));

// One websocket that reconnects, pings, and reconnects after a silence.
function feed(name, url, { onOpen, onMsg, pingMs = 0, pingMsg = "", silentMs = 30000 }) {
  let ws, ping, last = 0;
  const go = () => {
    if (stopping) return;
    ws = new WebSocket(url);
    last = Date.now();
    ws.onopen = () => { bump(name + ":open"); onOpen?.(ws); };
    ws.onmessage = ev => {
      const r = Date.now(); last = r;
      if (typeof ev.data !== "string") return;
      if (ev.data === "pong" || ev.data === "PONG") return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      try { onMsg(m, r); } catch (e) { bump(name + ":err"); counts[name + ":lasterr"] = String(e).slice(0, 120); }
    };
    ws.onclose = () => { bump(name + ":close"); setTimeout(go, 1000); };
    ws.onerror = () => {};
  };
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - last > silentMs) { bump(name + ":silent"); try { ws.close(); } catch {} return; }
    if (pingMs && pingMsg) try { ws.send(pingMsg); } catch {}
  }, Math.max(1000, Math.min(pingMs || 5000, 5000)));
  go();
  return { send: s => ws?.readyState === 1 && ws.send(s) };
}

// ---------- signal venues
feed("by", "wss://stream.bybit.com/v5/public/linear", {
  onOpen: ws => ws.send(JSON.stringify({ op: "subscribe", args: ["publicTrade.BTCUSDT", "orderbook.1.BTCUSDT", "orderbook.50.BTCUSDT"] })),
  onMsg: (m, r) => {
    if (m.topic === "publicTrade.BTCUSDT") for (const t of m.data) out("by", { k: "t", r, T: t.T, p: +t.p, v: +t.v, S: t.S, i: t.i });
    else if (m.topic === "orderbook.1.BTCUSDT" || m.topic === "orderbook.50.BTCUSDT")
      out("by", { k: m.topic === "orderbook.1.BTCUSDT" ? "b1" : "b50", r, ts: m.ts, cts: m.cts, ty: m.type === "snapshot" ? "s" : "d", u: m.data.u, b: m.data.b, a: m.data.a });
  }, pingMs: 20000, pingMsg: '{"op":"ping"}' });
// Binance USD-M: trades on /market, book tickers on /public (seen 2026-11-12).
const bnRow = (feedName, m, r) => {
  const d = m.data ?? m;
  if (d.e === "aggTrade") out(feedName, { k: "t", r, E: d.E, T: d.T, a: d.a, p: +d.p, q: +d.q, m: d.m });
  else if (d.e === "bookTicker" || (d.b !== undefined && d.a !== undefined && d.u !== undefined))
    out(feedName, { k: "bbo", r, E: d.E, T: d.T, u: d.u, b: +d.b, B: +d.B, a: +d.a, A: +d.A });
};
feed("bnt", "wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade", { onMsg: (m, r) => bnRow("bn", m, r) });
feed("bnb", "wss://fstream.binance.com/public/stream?streams=btcusdt@bookTicker", { onMsg: (m, r) => bnRow("bn", m, r) });
feed("bs", "wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade", { onMsg: (m, r) => bnRow("bs", m, r) });
feed("ok", "wss://ws.okx.com:8443/ws/v5/public", {
  onOpen: ws => ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "trades", instId: "BTC-USDT-SWAP" }, { channel: "bbo-tbt", instId: "BTC-USDT-SWAP" }] })),
  onMsg: (m, r) => {
    if (!m.data) return;
    if (m.arg?.channel === "trades") for (const t of m.data) out("ok", { k: "t", r, ts: +t.ts, i: t.tradeId, p: +t.px, q: +t.sz, S: t.side });
    else if (m.arg?.channel === "bbo-tbt") for (const b of m.data) out("ok", { k: "bbo", r, ts: +b.ts, b: +b.bids?.[0]?.[0], B: +b.bids?.[0]?.[1], a: +b.asks?.[0]?.[0], A: +b.asks?.[0]?.[1] });
  }, pingMs: 20000, pingMsg: "ping" });

// ---------- Chainlink BTC/USD (Polymarket RTDS, what the round settles on)
feed("cl", "wss://ws-live-data.polymarket.com", {
  onOpen: ws => ws.send(JSON.stringify({ action: "subscribe", subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: "" }] })),
  onMsg: (m, r) => {
    if (m?.topic !== "crypto_prices_chainlink") return;
    const p = m.payload ?? {};
    const sym = String(p.symbol ?? "").toLowerCase();
    if (sym.startsWith("btc")) out("cl", { k: "c", r, ts: +(p.timestamp ?? m.timestamp), p: +p.value });
  }, pingMs: 5000, pingMsg: "PING", silentMs: 20000 });

// ---------- Polymarket btc 5m: the live round and the next two
const gamma = async path => {
  const res = await fetch(`https://gamma-api.polymarket.com${path}`, { headers: { "User-Agent": "curl/8" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`gamma ${res.status}`);
  return res.json();
};
const tok = new Map();   // asset id -> [R, "u"|"d"]
const rounds = new Map(); // R -> {slug, up, dn}
const resolved = new Set();
async function discover() {
  const R0 = Math.floor(Date.now() / 300e3) * 300;
  for (const R of [R0, R0 + 300, R0 + 600]) {
    if (rounds.has(R)) continue;
    const g = (await gamma(`/markets?slug=btc-updown-5m-${R}`))?.[0];
    if (!g) continue;
    const cl = JSON.parse(g.clobTokenIds), oc = JSON.parse(g.outcomes).map(x => String(x).toLowerCase());
    const up = cl[oc.indexOf("up")], dn = cl[oc.indexOf("down")];
    if (!up || !dn) continue;
    rounds.set(R, { slug: g.slug, up, dn });
    tok.set(up, [R, "u"]); tok.set(dn, [R, "d"]);
    out("meta", { k: "m", r: Date.now(), R, slug: g.slug, up, dn, cond: g.conditionId, tick: +g.orderPriceMinTickSize, min: +g.orderMinSize,
      start: g.eventStartTime ?? g.startDate, end: g.endDate });
  }
  // Forget rounds that ended over 10 minutes ago (their result is looked up below).
  for (const [R, x] of rounds) if (R + 900 < R0) { tok.delete(x.up); tok.delete(x.dn); }
  return [R0, R0 + 300, R0 + 600].flatMap(R => rounds.has(R) ? [rounds.get(R).up, rounds.get(R).dn] : []);
}
// The official result: /events keeps closed rounds (/markets drops them).
async function results() {
  const R0 = Math.floor(Date.now() / 300e3) * 300;
  for (const [R, x] of rounds) {
    if (resolved.has(R) || R + 300 > R0) continue;
    if (R + 6 * 3600 < R0) { rounds.delete(R); continue; }       // give up after 6 h
    const e = (await gamma(`/events?slug=${x.slug}`))?.[0];
    const m = e?.markets?.[0];
    if (!m || !(m.closed || m.umaResolutionStatus === "resolved")) continue;
    out("meta", { k: "res", r: Date.now(), R, slug: x.slug, prices: m.outcomePrices, closed: m.closed, uma: m.umaResolutionStatus });
    resolved.add(R);
  }
}
let pm = null, pmKey = "";
function pmOpen(ids) {
  const key = ids.join(",");
  if (!ids.length || (key === pmKey && pm?.readyState === 1)) return;
  pmKey = key;
  const old = pm;
  const ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
  pm = ws;
  let ping, first = true, last = Date.now();
  ws.onopen = () => {
    bump("pm:open");
    ws.send(JSON.stringify({ assets_ids: ids, type: "market", custom_feature_enabled: true }));
    ping = setInterval(() => {
      if (Date.now() - last > 30000) { bump("pm:silent"); try { ws.close(); } catch {} return; }
      try { ws.send("PING"); } catch {}
    }, 10000);
  };
  ws.onmessage = ev => {
    const r = Date.now(); last = r;
    if (ws.retired || typeof ev.data !== "string" || ev.data === "PONG") return;
    // The new socket replaces the old one once it delivers: no gap at a round change.
    if (first && old) { first = false; old.retired = true; try { old.close(); } catch {} }
    let msgs; try { msgs = JSON.parse(ev.data); } catch { return; }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
      const e = m.event_type;
      if (e === "book") {
        const t = tok.get(m.asset_id);
        if (t) out("pm", { k: "book", r, ts: +m.timestamp, R: t[0], tok: t[1], b: (m.bids ?? []).map(x => [+x.price, +x.size]), a: (m.asks ?? []).map(x => [+x.price, +x.size]) });
      } else if (e === "price_change") {
        const c = [];
        for (const x of m.price_changes ?? []) {
          const t = tok.get(x.asset_id);
          if (t) c.push([t[0], t[1], +x.price, +x.size, x.side, +x.best_bid, +x.best_ask]);
        }
        if (c.length) out("pm", { k: "pc", r, ts: +m.timestamp, c });
      } else if (e === "last_trade_price") {
        const t = tok.get(m.asset_id);
        if (t) out("pm", { k: "tr", r, ts: +m.timestamp, R: t[0], tok: t[1], p: +m.price, s: +m.size, S: m.side, fee: m.fee_rate_bps });
      } else if (e === "tick_size_change") {
        const t = tok.get(m.asset_id);
        if (t) out("pm", { k: "tick", r, ts: +m.timestamp, R: t[0], tok: t[1], old: +m.old_tick_size, new: +m.new_tick_size });
      } else if (e === "best_bid_ask") {
        const t = tok.get(m.asset_id);
        if (t) out("pm", { k: "bbo", r, ts: +m.timestamp, R: t[0], tok: t[1], b: +m.best_bid, a: +m.best_ask, sp: +m.spread });
      } else if (e === "new_market" || e === "market_resolved") {
        // Broadcast for every market on the venue: keep only ours (btc 5m).
        if (String(m.slug ?? "").startsWith("btc-updown-5m-")) out("pm", { k: "raw", r, m });
      } else {
        out("pm", { k: "raw", r, m });
      }
    }
  };
  ws.onclose = () => { clearInterval(ping); bump("pm:close"); if (pm === ws) { pmKey = ""; setTimeout(tick, 1000); } };
  ws.onerror = () => {};
}
async function tick() {
  try { pmOpen(await discover()); } catch (e) { bump("pm:gamma"); counts["pm:lastgamma"] = String(e).slice(0, 120); }
}
await tick();
// Every 5 s, so the next round is subscribed well before it opens.
setInterval(tick, 5000);
setInterval(() => results().catch(e => { bump("res:err"); counts["res:last"] = String(e).slice(0, 120); }), 60000);

// ---------- health line, once a minute (stdout -> journal, and the stat feed)
let lagAt = Date.now();
setInterval(() => {
  const now = Date.now(); const lag = now - lagAt - 60000; lagAt = now;
  const rss = Math.round(process.memoryUsage().rss / 1e6);
  out("stat", { k: "stat", r: now, counts: { ...counts }, rss, lag });
  console.log(new Date(now).toISOString(), `rss ${rss} MB lag ${lag} ms`, JSON.stringify(counts));
}, 60000);
console.log("recording to", DIR, "pid", process.pid);
