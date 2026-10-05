// 反转统计页 (reversals.html + reversals-block.js): renders the counts from
// /api/reversals and /api/reversals/overview with a stub DOM. Checks the
// summary, the per-day table, a distribution row for every value 0..max, the
// 7-coin table, and that nothing about money (盈亏, 成交, 阶梯) appears.
//
// Run:  node frontend/console/regress/reversals.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = new Map();
const node = (selector) => {
  const listeners = {};
  return {
    selector, value: "", dataset: {}, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    closest: () => null, querySelectorAll: () => [],
    get innerHTML() { return html.get(selector) ?? ""; }, set innerHTML(v) { html.set(selector, String(v)); },
    get textContent() { return html.get(selector) ?? ""; }, set textContent(v) { html.set(selector, String(v)); },
  };
};
const nodes = new Map();
const lookup = (selector) => { if (!nodes.has(selector)) nodes.set(selector, node(selector)); return nodes.get(selector); };
const root = lookup("#reversals-block-root");
root.querySelector = lookup;

const distribution = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i), i === 10 ? 1 : i === 1 ? 140 : 3]));
const total = { rounds: 286, incomplete: 2, avgFirings: 1.83, medianFirings: 1, maxFirings: 10,
  maxRound: { roundId: "1790884500", startsAt: 1790884500 }, over4: 10, over4Pct: 3.5, firstFiringWinPct: 64.8,
  distribution, partialLastMinute: true };
const body = { schemaVersion: 1, assetId: "btc", days: [{ date: "2026-10-02", ...total }], total,
  rounds: [{ roundId: "1790884500", startsAt: 1790884500, firings: 10, reversals: 9, winner: "UP",
    sides: ["DOWN", "UP"], seconds: [0.6, 236.1], partialLastMinute: true }] };
const overview = { schemaVersion: 1, days: 7, coins: ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"].map((assetId) =>
  ({ assetId, rounds: 286, avgFirings: 1.8, medianFirings: 1, maxFirings: 10, over4: 10, over4Pct: 3.5, firstFiringWinPct: 64 })) };

const window = {
  location: { search: "?assetId=btc&days=7", href: "http://x/reversals.html", pathname: "/reversals.html" },
  history: { replaceState() {} }, addEventListener() {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  URL, URLSearchParams, console,
  document: { querySelector: lookup, querySelectorAll: () => [], addEventListener() {}, visibilityState: "visible" },
  PolyPreview: {
    navMarkup: () => "<button>nav</button>", navigate() {},
    format: { escape: (s) => String(s), clock: () => "12:00:00", readableError: (m, f) => m || f },
    request: async (path) => path.startsWith("/api/reversals/overview") ? overview : body,
  },
};
window.window = window;
vm.runInContext(readFileSync(new URL("../reversals-block.js", import.meta.url), "utf8"), vm.createContext(window), { filename: "reversals-block.js" });
await new Promise((resolve) => setTimeout(resolve, 50));

const all = [...html.values()].join("\n");
assert.ok(all.includes("286"), "summary shows the round count");
assert.ok(all.includes("1790884500"), "the round with the most firings is named");
assert.ok(/3\.5\s*%/.test(all), "over-4 share shown");
assert.ok(all.includes("2026-10-02"), "per-day table lists the day");
assert.ok(all.includes("缺最后约50秒盘口"), "old days are flagged");
for (let value = 0; value <= 10; value += 1) assert.ok(all.includes(`触发 ${value} 次`), `distribution has a row for ${value}`);
assert.ok(all.includes("HYPE") && all.includes("BNB"), "the 7-coin table renders");
assert.ok(!/盈亏|成交|阶梯/.test(all), "no money, fills or ladder on this page");
console.log("reversals page OK");
process.exit(0);
