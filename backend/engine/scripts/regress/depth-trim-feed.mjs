// Live 2026-10-01: the replica's 5-level depth went crossed (bids 0.74 over
// asks 0.34) because emptied levels were never deleted. The venue's best
// bid/ask proves them gone, so the feed trims to it once per frame.
// Review case: one price_change frame with two UP entries whose per-entry
// best_bid differ (0.52 then 0.55); trimming per entry deleted the real 0.55.
//
// Drives the real runPolymarketFeed against a local WebSocket server.
// Run after `npm run build`:  node scripts/regress/depth-trim-feed.mjs
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { runPolymarketFeed } from "../../dist/live/feeds/polymarket.js";

const UP = "1".repeat(20), DOWN = "2".repeat(20);
const START = Math.floor(Date.now() / 1000 / 300) * 300;
const wss = new WebSocketServer({ port: 0 });
await new Promise((resolve) => wss.once("listening", resolve));
const sockets = new Set();
wss.on("connection", (sock) => { sockets.add(sock); sock.on("close", () => sockets.delete(sock)); sock.on("message", () => {}); });
const send = (data) => { for (const s of sockets) if (s.readyState === 1) s.send(JSON.stringify(data)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return false; };
let clock = Date.now();
const ts = () => String(clock = Math.max(clock + 1, Date.now()));
const lvl = (price, size) => ({ price: price.toFixed(2), size: String(size) });

const books = [];
const feed = runPolymarketFeed((event) => { if (event.kind === "book") books.push(event.snapshot); },
  UP, DOWN, START + 300, { marketId: "0xm", roundId: String(START), url: `ws://127.0.0.1:${wss.address().port}` });
assert.ok(await until(() => sockets.size >= 1), "socket connects");

// Snapshot: UP carries a dead bid at 0.74 (an emptied level) above real 0.52/0.60.
const t0 = ts();
send([{ event_type: "book", asset_id: UP, market: "0xm", timestamp: t0, bids: [lvl(0.74, 107), lvl(0.52, 50)], asks: [lvl(0.60, 40), lvl(0.61, 30)] },
      { event_type: "book", asset_id: DOWN, market: "0xm", timestamp: t0, bids: [lvl(0.39, 40)], asks: [lvl(0.41, 50)] }]);
await wait(100);
// One frame, two UP entries: cancel the 0.60 ask (best_bid 0.52), then a new 0.55 bid (best_bid 0.55).
send({ event_type: "price_change", market: "0xm", timestamp: ts(), price_changes: [
  { asset_id: UP, price: "0.60", size: "0", side: "SELL", best_bid: "0.52", best_ask: "0.61" },
  { asset_id: UP, price: "0.55", size: "10", side: "BUY", best_bid: "0.55", best_ask: "0.61" }] });
assert.ok(await until(() => books.some((b) => b.upAsk === 0.61)), "the frame is published");
await wait(100);
const last = books.at(-1);
const bids = last.upBidLevels ?? last.YES?.bids, asks = last.upAskLevels ?? last.YES?.asks;
const prices = (levels) => (levels || []).map((l) => Array.isArray(l) ? l[0] : Number(l.price));
assert.equal(last.upBid, 0.55, "the published best bid is the venue's final 0.55");
assert.ok(!prices(bids).includes(0.74), `the dead 0.74 bid is gone; bids ${JSON.stringify(bids)}`);
assert.ok(prices(bids).includes(0.55), `the real 0.55 bid survives the frame; bids ${JSON.stringify(bids)}`);
assert.ok(Math.max(...prices(bids)) < Math.min(...prices(asks)), "the depth is not crossed");
feed.stop(); wss.close();
console.log("depth-trim-feed OK");
process.exit(0);
