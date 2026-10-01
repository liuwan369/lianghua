// BUGS P3-5: the user feed attached its message listener only after the
// authentication check (and reconnect compensation) had finished, so a fill
// or cancellation the venue pushed in that window was dropped, with no log.
//
// Drives the real runUserFeed against a local WebSocket server; the server
// pushes a MATCHED fill right after the subscription, while verifyAuthenticated
// is still pending.
// Run after `npm run build`:  node scripts/regress/P3-5.mjs
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { runUserFeed } from "../../dist/live/feeds/user.js";

const wss = new WebSocketServer({ port: 0 });
await new Promise((resolve) => wss.once("listening", resolve));
const now = Math.floor(Date.now() / 1000);
wss.on("connection", (sock) => {
  sock.on("message", (data) => {
    if (String(data) === "PING") return;
    // Subscribed: push our fill at once, inside the authentication window.
    sock.send(JSON.stringify([{ event_type: "trade", id: "t1", taker_order_id: "ours", asset_id: "111", side: "BUY",
      price: "0.68", size: "5", status: "MATCHED", match_time: String(now) }]));
  });
});
const events = [];
const feed = runUserFeed((wrapped) => { if (wrapped.kind === "user") events.push(wrapped.event); }, {
  url: `ws://127.0.0.1:${wss.address().port}`,
  creds: { key: "k", secret: "s", passphrase: "p" }, conditionId: "0xm", upToken: "111", downToken: "222",
  isOurOrder: (id) => id === "ours",
  verifyAuthenticated: () => new Promise((resolve) => setTimeout(() => resolve(true), 400)),
}, now + 60);
const end = Date.now() + 3000;
while (Date.now() < end && !events.some((e) => e.kind === "exchangeFill")) await new Promise((r) => setTimeout(r, 25));
feed.stop(); wss.close();
assert.ok(events.some((e) => e.kind === "exchangeFill" && e.tradeId === "t1"),
  `a fill pushed during authentication reaches the engine; got ${JSON.stringify(events.map((e) => e.kind))}`);

// Review: the socket closes during authentication. The feed must not end up
// ready on a dead socket; it reconnects instead.
{
  const wss2 = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss2.once("listening", resolve));
  let connections = 0;
  wss2.on("connection", (sock) => { connections += 1; if (connections === 1) setTimeout(() => sock.terminate(), 50); sock.on("message", () => {}); });
  const statuses = [];
  const feed2 = runUserFeed((wrapped) => { if (wrapped.kind === "userStatus") statuses.push(wrapped.healthy); }, {
    url: `ws://127.0.0.1:${wss2.address().port}`, creds: { key: "k", secret: "s", passphrase: "p" }, conditionId: "0xm",
    upToken: "111", downToken: "222", isOurOrder: () => false,
    verifyAuthenticated: () => new Promise((resolve) => setTimeout(() => resolve(true), 300)),
  }, now + 60);
  const until = Date.now() + 5000;
  while (Date.now() < until && connections < 2) await new Promise((r) => setTimeout(r, 50));
  feed2.stop(); wss2.close();
  assert.ok(connections >= 2, "a socket that dies during authentication is reconnected, not waited on forever");
}
console.log("P3-5 OK");
process.exit(0);
