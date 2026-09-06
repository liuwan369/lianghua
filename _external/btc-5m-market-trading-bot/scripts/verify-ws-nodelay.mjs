#!/usr/bin/env node
import net from "node:net";

const calls = [];
const original = net.Socket.prototype.setNoDelay;
net.Socket.prototype.setNoDelay = function setNoDelay(value = true) {
  calls.push(Boolean(value));
  return original.call(this, value);
};

const { default: WebSocket } = await import("ws");
const ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket open timed out")), 10_000);
  ws.once("open", () => {
    clearTimeout(timeout);
    resolve();
  });
  ws.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});
ws.terminate();

console.log(JSON.stringify({
  tcp_nodelay_enabled: calls.includes(true),
  set_no_delay_calls: calls,
}));
