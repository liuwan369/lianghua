// One-sided book near the close (2026-10-10): the winner's ask is empty, so
// the paired quote goes stale while the venue is live. The panel froze on the
// last two-sided quote and said "已过期 · 保留快照". It now shows the server's
// oneSided top as it is ("卖一：无") and still blocks nothing it did not block.
//
// Run:  node frontend/console/regress/one-sided.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const now = () => Date.now() / 1000;
const roundStart = () => Math.floor(now() / 300) * 300;
const written = new Map();
const element = (selector) => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelector: () => element(), querySelectorAll: () => [],
  closest: () => element(), insertAdjacentHTML() {}, replaceWith() {}, remove() {}, appendChild() {}, children: [], rows: [], value: "" }, {
  get: (target, key) => key === "textContent" ? written.get(selector) ?? "" : key === "innerHTML" ? written.get(`${selector}#html`) ?? "" : key in target ? target[key] : undefined,
  set: (target, key, value) => {
    if (key === "textContent" && selector) written.set(selector, String(value));
    else if (key === "innerHTML" && selector) written.set(`${selector}#html`, String(value));
    else target[key] = value;
    return true;
  },
});
const nodes = new Map();
const lookup = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element(selector)); return nodes.get(selector); };

let oneSided = false;
const market = () => {
  const start = roundStart(), pairedAt = now() - (oneSided ? 20 : 0);
  const side = (bid, ask) => ({ bid, ask, sourceAt: pairedAt, expiresAt: pairedAt + 2 });
  return { assetId: "sol", symbol: "SOL", supported: true, canEnable: true, cycle: "5m", marketId: "0xm",
    roundId: String(start), startAt: start, endAt: start + 300, current: true, sequence: 7,
    sourceAt: pairedAt, expiresAt: pairedAt + 2, stale: oneSided, error: oneSided ? "market_snapshot_expired" : null,
    yes: side(0.97, 0.99), no: side(0.01, 0.03), yesBid: 0.97, yesAsk: 0.99, noBid: 0.01, noAsk: 0.03,
    oneSided: oneSided ? { at: now() - 0.3, yesBid: 0.98, yesAsk: null, noBid: null, noAsk: 0.02 } : null };
};
const reply = (url) => {
  if (url.includes("/snapshot")) return { schemaVersion: 1, ...market() };
  if (url.includes("/api/markets")) return { schemaVersion: 1, items: [market()], asOf: now(), stale: oneSided };
  if (url.includes("/api/runtime/market-pool")) return { schemaVersion: 1, desiredIds: ["sol"], currentIds: [], asOf: now() };
  if (url.includes("/api/runtime/status")) return { schemaVersion: 1, asOf: now(), stale: false, status: "stopped", processRunning: false, processRunningFresh: true, markets: [] };
  return { schemaVersion: 1, asOf: now(), stale: false, items: [] };
};
const window = { location: { search: "?assetId=sol", origin: "http://127.0.0.1", href: "http://127.0.0.1/x.html", pathname: "/x.html" },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval, console, URLSearchParams, URL,
  AbortController, history: { replaceState() {} }, navigator: {}, HTMLElement: function () {}, confirm: () => false,
  localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0), matchMedia: () => ({ matches: false, addEventListener() {} }) };
window.fetch = async (url) => { const body = reply(String(url)); return { ok: true, status: 200, json: async () => body }; };
window.document = { hidden: false, visibilityState: "visible", readyState: "complete", addEventListener() {}, body: element(),
  createElement: () => ({ content: { firstElementChild: element() } }), querySelector: lookup, querySelectorAll: () => [] };
const context = vm.createContext(window);
window.window = window; window.self = window;
for (const file of ["shared/preview-core.js", "shared/view-model.js", "shared/preview-store.js", "shared/api-adapter.js", "auto-trade-block.js"]) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(1500);
assert.equal(written.get('[data-quote="yes-ask"]'), "0.990", "control: a two-sided book shows its ask");

oneSided = true;
await wait(1500);
const state = written.get("[data-book-live-state]") || "";
assert.ok(!state.includes("已过期"), `the live state no longer says expired; got "${state}"`);
assert.ok(state.includes("单边盘口"), `the live state names the one-sided book; got "${state}"`);
assert.equal(written.get('[data-quote="yes-ask"]'), "无", "the empty ask is shown as none, not the old 0.990");
assert.equal(written.get('[data-quote="yes-bid"]'), "0.980", "the live bid is the venue's current one");
assert.equal(written.get('[data-quote="no-bid"]'), "无");
assert.equal(written.get('[data-quote="no-ask"]'), "0.020");
assert.ok(!(written.get("[data-book-source]") || "").includes("已过期"), "the source line does not say expired either");
console.log("one-sided OK");
process.exit(0);
