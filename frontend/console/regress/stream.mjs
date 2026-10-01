// Console push client (shared/stream.js + preview-core request()).
// - GETs the page makes are subscribed on one EventSource to /api/stream;
// - while the stream is open a pushed path is answered without the network;
// - onUpdate listeners fire on each pushed body;
// - when the stream errors, request() goes back to the network.
//
// Run:  node frontend/console/regress/stream.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const fetched = [];
const sources = [];
class FakeEventSource {
  constructor(url) { this.url = url; sources.push(this); }
  close() { this.closed = true; }
  emit(path, body) { this.onmessage?.({ data: JSON.stringify({ path, version: 1, body }) }); }
}
const window = { location: { search: "", origin: "http://127.0.0.1", href: "http://127.0.0.1/auto-trade.html", pathname: "/auto-trade.html" },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval, EventSource: FakeEventSource,
  console, URLSearchParams, URL, AbortController, history: { replaceState() {} },
  document: { addEventListener() {}, visibilityState: "visible", querySelector: () => null, querySelectorAll: () => [] },
  navigator: {}, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} } };
window.fetch = async (url) => {
  fetched.push(String(url));
  return { ok: true, status: 200, json: async () => ({ source: "network", url: String(url) }) };
};
const context = vm.createContext(window);
window.window = window; window.self = window;
for (const file of ["preview-core.js", "stream.js"]) {
  vm.runInContext(readFileSync(new URL(`../shared/${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const api = window.PolyPreview.api;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- before the stream exists, requests go to the network and are noted ---
assert.equal((await api.runtimeStatus()).source, "network");
await api.markets();
await api.strategyDraft({});           // a POST is never noted or answered from push
await wait(400);
assert.equal(sources.length, 1, "one EventSource for the page");
const url = new URL(sources[0].url, "http://x");
assert.equal(url.pathname, "/api/stream");
assert.deepEqual(url.searchParams.getAll("p").sort(), ["/api/markets?asset=crypto&duration=5m", "/api/runtime/status"]);

// --- once open, a pushed path is answered from the push, without a fetch ---
const heard = [];
window.PolyPreviewStream.onUpdate("/api/runtime/status", (path) => heard.push(path));
sources[0].onopen();
sources[0].emit("/api/runtime/status", { status: "running", source: "push" });
assert.deepEqual(heard, ["/api/runtime/status"], "the page hears the change at once");
fetched.length = 0;
assert.equal((await api.runtimeStatus()).source, "push", "served from the pushed body");
assert.equal(fetched.length, 0, "no network request");
// a path not pushed yet still uses the network
assert.equal((await api.markets()).source, "network");

// --- a stream error falls back to the network immediately ---
sources[0].onerror();
assert.equal((await api.runtimeStatus()).source, "network", "stream down: polling as before");

// --- a new path re-subscribes with the union of paths ---
await api.accountSnapshot();
await wait(400);
assert.equal(sources.length, 2, "re-subscribed for the new path");
assert.ok(sources[0].closed, "the old stream is closed");
assert.ok(new URL(sources[1].url, "http://x").searchParams.getAll("p").includes("/api/account/snapshot"));
console.log("stream OK");
process.exit(0);
