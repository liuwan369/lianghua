// BUGS U1 (second audit, P1): a fill pushed while reconnect compensation runs,
// on a socket that then dies, was never booked: compensation declared the feed
// continuous before checking the socket, dropped the held frames, and left the
// gap start unset, so the next attempt looked back only 5 s from its own auth.
//
// Connection 1 drops; connection 2's reconcileAfterReconnect is slow (4.5 s);
// a taker fill is pushed on it and the socket is killed. The fill must reach the
// engine (from the replayed frame or from connection 3's lookback).
//
// Run after `npm run build`:  node scripts/regress/U1.mjs
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { runUserFeed } from "../../dist/live/feeds/user.js";

const server = new WebSocketServer({ port: 0 });
const url = `ws://127.0.0.1:${server.address().port}`;
const sockets = [];
server.on("connection", (socket) => { sockets.push(socket); socket.on("message", () => {}); });
const start = Date.now() / 1000;
const fillAt = start + 2.6;
const lookbacks = [];
const fill = { event_type: "trade", id: "t-gap", trader_side: "TAKER", taker_order_id: "ours", asset_id: "111", side: "BUY", price: "0.68",
  size: "5", status: "MATCHED", match_time: String(fillAt), market: "0xm", maker_orders: [] };
const events = [];
const feed = runUserFeed((wrapped) => { if (wrapped.kind === "user") events.push(wrapped.event); }, {
  url, creds: { key: "k", secret: "c2VjcmV0", passphrase: "p" }, conditionId: "0xm", upToken: "111", downToken: "222",
  isOurOrder: (id) => id === "ours",
  // Venue REST: the fill exists once its match time has passed.
  fetchRecentTrades: async (afterUnix) => { lookbacks.push(afterUnix); return afterUnix <= fillAt && Date.now() / 1000 >= fillAt ? [fill] : []; },
  fetchOpenOrders: async () => [],
  reconcileAfterReconnect: async () => { await new Promise((r) => setTimeout(r, 4500)); return true; },
}, Date.now() / 1000 + 60);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(300);
sockets[0]?.terminate();                         // connection 1 drops
while (sockets.length < 2) await wait(50);       // connection 2 reconnects (2 s later)
await wait(Math.max(0, (fillAt - Date.now() / 1000) * 1000));
sockets[1].send(JSON.stringify([fill]));         // the fill arrives during compensation...
await wait(50);
sockets[1].terminate();                          // ...and the socket dies
for (let i = 0; i < 100 && !events.some((e) => e.kind === "exchangeFill"); i += 1) await wait(150);
feed.stop(); server.close();
assert.ok(events.some((e) => e.kind === "exchangeFill" && e.tradeId === "t-gap"),
  `the fill pushed during compensation is booked; lookbacks ${lookbacks.map((x) => (x - start).toFixed(2))}`);
console.log("U1 OK");
process.exit(0);
