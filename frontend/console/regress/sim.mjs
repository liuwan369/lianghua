// 模拟交易页 (sim.html + sim-block.js): renders the firing-count statistics
// from /api/sim. With stub data whose max firing is 67, the big "单场最多触发"
// number and the distribution chart must both show 67 (no capping), the four
// coins/days controls exist, and a round row expands to its event list.
//
// Run:  node frontend/console/regress/sim.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// A tiny DOM that records textContent/innerHTML and supports the selectors the
// block uses: querySelector, addEventListener, closest, value.
function makeDom() {
  const nodes = new Map();
  const make = (selector) => {
    const listeners = {};
    const node = {
      selector, _html: "", _text: "", value: "", dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      dispatch(type, event) { for (const fn of listeners[type] || []) fn(event); },
      focus() {},
      querySelector: (sel) => lookup(sel),
      querySelectorAll: () => [],
      closest: () => null,
    };
    Object.defineProperty(node, "innerHTML", { get: () => node._html, set: (v) => { node._html = String(v); } });
    Object.defineProperty(node, "textContent", { get: () => node._text, set: (v) => { node._text = String(v); } });
    return node;
  };
  const lookup = (selector) => { if (!nodes.has(selector)) nodes.set(selector, make(selector)); return nodes.get(selector); };
  return { lookup, nodes };
}

const dom = makeDom();
const root = dom.lookup("#sim-block-root");
let lastRequest = null;
const simBody = {
  schemaVersion: 1, assetId: "btc",
  rounds: [
    { asset: "btc", roundId: "1799900100", startsAt: 1799900100, firings: 67, reversals: 66, winner: "UP",
      simPnl4: 1.23, events: [{ i: 1, t: 12, dir: "UP", ask: 0.68, shares: 5 }, { i: 2, t: 20, dir: "DOWN", ask: 0.67, shares: 20 }] },
    { asset: "btc", roundId: "1799899800", startsAt: 1799899800, firings: 0, reversals: 0, winner: "DOWN",
      simPnl4: 0, events: [] },
  ],
  summary: { rounds: 2, withFiring: 1, maxFirings: 67, maxRound: { roundId: "1799900100", startsAt: 1799900100, firings: 67 },
    avgFirings: 33.5, distribution: { "0": 1, "67": 1 }, winRateByFirings: {}, simPnl4Total: 1.23 },
};

const window = {
  location: { search: "?assetId=btc&days=10", origin: "http://x", href: "http://x/sim.html?assetId=btc&days=10", pathname: "/sim.html" },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  console, URLSearchParams, URL, AbortController, history: { replaceState() {} }, navigator: {},
  localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
  document: {
    querySelector: (sel) => dom.lookup(sel),
    querySelectorAll: () => [],
    addEventListener() {}, visibilityState: "visible",
  },
};
window.window = window; window.self = window;
window.fetch = async (url) => {
  lastRequest = String(url);
  return { ok: true, status: 200, json: async () => simBody };
};

const context = vm.createContext(window);
for (const file of ["preview-core.js", "stream.js"]) {
  vm.runInContext(readFileSync(new URL(`../shared/${file}`, import.meta.url), "utf8"), context, { filename: file });
}
window.PolyPreview.config.apiBase = "";
vm.runInContext(readFileSync(new URL("../sim-block.js", import.meta.url), "utf8"), context, { filename: "sim-block.js" });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(50);

// NAV includes the sim page.
assert.ok(window.PolyPreview.navMarkup("sim").includes("模拟交易"), "nav has 模拟交易");

// The request went to /api/sim for the selected coin and range.
assert.ok(lastRequest && lastRequest.includes("/api/sim?assetId=btc&days=10"), `requested /api/sim, got ${lastRequest}`);

// The big "单场最多触发" number shows 67 (no capping).
assert.equal(dom.lookup("[data-stat-max]")._text, "67", "max firings big number is 67");
assert.equal(dom.lookup("[data-stat-rounds]")._text, "2");
assert.equal(dom.lookup("[data-stat-withfiring]")._text, "1");

// The distribution chart renders a bar for every value 0..67 and shows 67.
const chart = dom.lookup("[data-chart]")._html;
assert.ok(chart.includes("触发 67 次"), "chart shows the 67-firing bucket");
const bars = (chart.match(/sim-bar-label/g) || []).length;
assert.equal(bars, 68, `chart has a bar for every value 0..67 (68 bars), got ${bars}`);

// The rounds table lists both rounds and the 67-firing one is present.
const rows = dom.lookup("[data-rounds]")._html;
assert.ok(rows.includes(">67<"), "a round shows 67 firings");
assert.ok(rows.includes("data-expand"), "rows are expandable");

console.log("frontend sim OK");
process.exit(0);
