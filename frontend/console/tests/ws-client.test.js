"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const sockets = [];
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    sockets.push(this);
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, event = {}) {
    (this.listeners.get(type) || []).forEach((listener) => listener(event));
  }
  send(value) { this.sent.push(value); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.emit("close"); }
}

global.window = { location: { href: "https://console.test/auto-trade.html" }, setTimeout, clearTimeout };
global.WebSocket = FakeWebSocket;
vm.runInThisContext(fs.readFileSync(path.join(root, "shared", "ws-client.js"), "utf8"), { filename: "ws-client.js" });

const received = [];
const states = [];
const stream = window.PolyPreviewStreams.createStream("markets", {
  url: "wss://console.test/api/stream/markets",
  reconnect: false,
  requireSequence: true,
  acceptFrame: (frame) => {
    const snapshot = frame.data?.snapshot || {};
    return snapshot.assetId === "btc" && snapshot.marketId === "market-btc";
  },
  onState: (state) => states.push(state),
  onMessage: (frame) => received.push(frame)
});
assert.strictEqual(stream.connect(), true, "stream connects with configured URL");
const socket = sockets[0];
socket.readyState = FakeWebSocket.OPEN;
socket.emit("open");
stream.subscribe({ assetId: "btc", marketId: "market-btc", roundId: "round-1" });
assert.strictEqual(JSON.parse(socket.sent.at(-1)).roundId, "round-1", "subscription carries round identity");

const emitFrame = (snapshot) => socket.emit("message", { data: JSON.stringify({ data: { snapshot } }) });
  emitFrame({ assetId: "btc", marketId: "market-btc", roundId: "round-1", sequence: 5, sourceAt: 1 });
  emitFrame({ assetId: "btc", marketId: "market-btc", roundId: "round-1", sequence: 4, sourceAt: 2 });
  emitFrame({ assetId: "btc", marketId: "market-btc", roundId: "round-2", sequence: 1, sourceAt: 3 });
  emitFrame({ assetId: "btc", marketId: "market-btc", roundId: "round-1", sourceAt: 4 });

assert.strictEqual(received.length, 2, "nested snapshots accept fresh frames and reject stale or missing sequences");
assert.strictEqual(received[0].data.snapshot.sequence, 5, "nested snapshot sequence is accepted");
assert.strictEqual(received[1].data.snapshot.roundId, "round-2", "watermarks are isolated by marketId and roundId");
assert.deepStrictEqual(states, ["connected"], "socket reports connected state");

console.log("ws-client: PASS");
