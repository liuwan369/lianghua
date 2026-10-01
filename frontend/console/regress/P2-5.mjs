// BUGS P2-5 (decided 2026-10-01): in a round's last ~60 s the venue stops quoting
// and the catalog already serves the next round. The page keeps that behaviour
// (the next round is the one you can start) and now says why, instead of
// showing a round that has not opened as if it were live.
//
// Run:  node frontend/console/regress/P2-5.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const now = () => Date.now() / 1000;
const next = Math.floor(now() / 300) * 300 + 300;   // the round that opens next
const written = new Map();
const element = (selector) => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelector: () => element(), querySelectorAll: () => [],
  closest: () => element(), insertAdjacentHTML() {}, children: [], value: "" }, {
  get: (t, k) => k === "textContent" ? written.get(selector) ?? "" : k === "innerHTML" ? "" : k in t ? t[k] : undefined,
  set: (t, k, v) => { if (k === "textContent" && selector) written.set(selector, String(v)); else t[k] = v; return true; } });
const nodes = new Map();
const lookup = (s) => { if (!nodes.has(s)) nodes.set(s, element(s)); return nodes.get(s); };
const market = { assetId: "btc", symbol: "BTC", supported: true, canEnable: true, cycle: "5m", marketId: "0xnext",
  roundId: String(next), startAt: next, endAt: next + 300, current: false,
  yes: { bid: 0.5, ask: 0.51, sourceAt: now(), expiresAt: now() + 2 }, no: { bid: 0.48, ask: 0.49, sourceAt: now(), expiresAt: now() + 2 } };
const window = { location: { search: "?assetId=btc", origin: "http://x", href: "http://x/a.html", pathname: "/a.html" },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval, console, URLSearchParams, URL,
  AbortController, history: { replaceState() {} }, navigator: {}, HTMLElement: function () {},
  localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0), matchMedia: () => ({ matches: false, addEventListener() {} }) };
window.fetch = async (url) => ({ ok: true, status: 200, json: async () => String(url).includes("/api/markets")
  ? { schemaVersion: 1, items: [market], asOf: now(), stale: false } : { schemaVersion: 1, asOf: now(), stale: false, items: [] } });
window.document = { hidden: false, visibilityState: "visible", readyState: "complete", addEventListener() {}, body: element(),
  createElement: () => ({ content: { firstElementChild: element() } }), querySelector: lookup, querySelectorAll: () => [] };
const context = vm.createContext(window); window.window = window; window.self = window;
for (const f of ["shared/preview-core.js", "shared/view-model.js", "shared/preview-store.js", "shared/api-adapter.js", "auto-trade-block.js"]) {
  vm.runInContext(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), context, { filename: f });
}
await new Promise((r) => setTimeout(r, 1500));
const countdown = written.get("[data-countdown]") || "";
assert.match(countdown, /已切到下一场/, `the countdown explains the early switch; got "${countdown}"`);
console.log("P2-5 OK");
process.exit(0);
