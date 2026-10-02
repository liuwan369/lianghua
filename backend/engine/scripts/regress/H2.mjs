// BUGS H2 (second audit) + review: a throw while booking a fill reported by
// the ACK reconciliation path (registerOrder -> reconcileTrades) was an
// unhandled rejection, which ends a Node 24 process; and after the fix stopped
// the crash, the trade stayed marked "seen", so compensation never booked it.
//
// The sink throws on the first delivery of the fill; the feed must survive,
// reconnect, and book the fill once.
//
// Run after `npm run build`:  node scripts/regress/H2.mjs
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { runUserFeed } from "../../dist/live/feeds/user.js";

let crashed = false;
process.on("unhandledRejection", () => { crashed = true; });
const server = new WebSocketServer({ port: 0 });
server.on("connection", (socket) => socket.on("message", () => {}));
const now = Date.now() / 1000;
const trade = { id: "t-ack", trader_side: "TAKER", taker_order_id: "ours", asset_id: "111", side: "BUY", price: "0.68", size: "5",
  status: "MATCHED", match_time: String(now), market: "0xm", maker_orders: [] };
let throwOnce = true;
const fills = [];
const feed = runUserFeed((wrapped) => {
  if (wrapped.kind !== "user" || wrapped.event.kind !== "exchangeFill") return;
  if (throwOnce) { throwOnce = false; throw new Error("journal write failed"); }
  fills.push(wrapped.event);
}, {
  url: `ws://127.0.0.1:${server.address().port}`, creds: { key: "k", secret: "c2VjcmV0", passphrase: "p" },
  conditionId: "0xm", upToken: "111", downToken: "222", isOurOrder: (id) => id === "ours",
  fetchTrades: async () => [trade],
  fetchRecentTrades: async () => [trade], fetchOpenOrders: async () => [],
  reconcileAfterReconnect: async () => true,
}, now + 60);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(400);
feed.registerOrder("ours", ["t-ack"]);           // the ACK names a trade the WS has not sent
for (let i = 0; i < 80 && fills.length === 0; i += 1) await wait(150);
feed.stop(); server.close();
assert.equal(crashed, false, "a throw while booking an ACK trade is not an unhandled rejection");
assert.equal(fills.filter((f) => f.tradeId === "t-ack").length, 1, "the fill is booked once after the failure");
console.log("H2 OK");
process.exit(0);
