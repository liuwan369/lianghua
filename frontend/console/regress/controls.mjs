// UI-REDESIGN U10-U12: the three control buttons follow the server's real
// process state. Loads the real shared modules and auto-trade-block.js in a vm
// with a stub DOM and a stub server, then checks the button texts and enabled
// states for a stopped, a running and a paused process.
//
// Run:  node frontend/console/regress/controls.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const now = () => Date.now() / 1000;
const roundStart = () => Math.floor(now() / 300) * 300;
let runtime = { status: "stopped", state: "stopped", processRunning: false, processRunningFresh: true, markets: [] };
const market = () => ({ assetId: "btc", symbol: "BTC", supported: true, canEnable: true, cycle: "5m",
  marketId: "0xm", roundId: String(roundStart()), startAt: roundStart(), endAt: roundStart() + 300, current: true,
  yes: { bid: 0.4, ask: 0.41, sourceAt: now(), expiresAt: now() + 2 }, no: { bid: 0.58, ask: 0.59, sourceAt: now(), expiresAt: now() + 2 } });
const reply = (url) => {
  if (url.includes("/api/runtime/status")) return { schemaVersion: 1, asOf: now(), stale: false, source: "platform-runtime", ...runtime };
  if (url.includes("/api/markets")) return { schemaVersion: 1, items: [market()], markets: [market()], asOf: now(), stale: false };
  return { schemaVersion: 1, asOf: now(), stale: false, items: [] };
};
const buttons = {};
const element = (key) => new Proxy({ dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  style: {}, textContent: "", disabled: false, title: "", setAttribute() {}, addEventListener() {}, querySelector: () => null,
  querySelectorAll: () => [], closest: () => null, innerHTML: "" }, { get: (target, prop) => prop in target ? target[prop] : () => element() });
for (const action of ["start", "pause", "stop"]) { buttons[action] = element(); buttons[action].dataset.action = action; }
const feedback = element();
const window = { location: { search: "?assetId=btc", origin: "http://127.0.0.1", href: "http://127.0.0.1/auto-trade.html", pathname: "/auto-trade.html" },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval, console, URLSearchParams, URL, AbortController,
  history: { replaceState() {} }, navigator: {}, HTMLElement: function () {},
  localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0), matchMedia: () => ({ matches: false, addEventListener() {} }) };
window.fetch = async (url) => { const body = reply(String(url)); return { ok: true, status: 200, json: async () => body }; };
window.document = { hidden: false, visibilityState: "visible", readyState: "complete", addEventListener() {}, body: element(),
  querySelector: (selector) => selector === "[data-control-feedback]" ? feedback : selector === "#auto-trade-block-root" ? element() : element(),
  querySelectorAll: (selector) => selector === "[data-action]" ? Object.values(buttons) : [] };
const context = vm.createContext(window);
window.window = window; window.self = window;
for (const file of ["shared/preview-core.js", "shared/view-model.js", "shared/preview-store.js", "shared/api-adapter.js", "auto-trade-block.js"]) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 2600));

await settle();
assert.equal(buttons.pause.disabled, true, "stopped: pause disabled");
assert.equal(buttons.stop.disabled, true, "stopped: stop disabled");
assert.equal(buttons.stop.textContent, "请求停止");

runtime = { status: "running", state: "running", processRunning: true, processRunningFresh: true, markets: [] };
await settle();
assert.equal(buttons.start.textContent, "运行中", "running: start shows 运行中");
assert.equal(buttons.start.disabled, true, "running: start cannot be clicked again");
assert.equal(buttons.pause.disabled, false, "running: pause is available without a per-round snapshot");
assert.equal(buttons.pause.textContent, "暂停新增");
assert.match(buttons.pause.title, /已挂的单照常/, "pause explains it only stops new stages");
assert.equal(buttons.stop.disabled, false, "running: stop is available");
assert.match(feedback.textContent, /运行中/);

runtime = { status: "paused", state: "paused", processRunning: true, processRunningFresh: true, markets: [] };
await settle();
assert.equal(buttons.pause.textContent, "恢复新增", "paused: pause turns into resume");
assert.equal(buttons.start.textContent, "运行中");

runtime = { status: "stopping", state: "stopping", processRunning: true, processRunningFresh: true, markets: [] };
await settle();
assert.equal(buttons.stop.textContent, "停止中…", "stopping: stop shows progress");
assert.equal(buttons.stop.disabled, true);
assert.equal(buttons.start.textContent, "停止中…");
console.log("controls OK");
process.exit(0);
