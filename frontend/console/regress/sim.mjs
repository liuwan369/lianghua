// 模拟交易页 (sim.html + sim-block.js). With stub data whose max firing is 67:
// the conclusion sentence names 67 and the >4 share, the chart has one row for
// every value 0..67 (no capping) with the 67 count printed, the seven-coin table
// renders from /api/sim/overview, and the ">4 次" filter leaves only rounds
// with more than 4 firings. sim.html loads the shared shell stylesheet.
//
// Run:  node frontend/console/regress/sim.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// A tiny DOM that records textContent/innerHTML for any selector the block asks for.
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

const html = readFileSync(new URL("../sim.html", import.meta.url), "utf8");
assert.ok(html.indexOf("settings-block.css") > -1 && html.indexOf("settings-block.css") < html.indexOf("sim-block.css"),
  "sim.html loads the shared shell (settings-block.css) before sim-block.css");

const dom = makeDom();
const root = dom.lookup("#sim-block-root");
const requests = [];
const base = 1799900100;
const round = (i, firings, winner = "UP") => ({
  asset: "btc", roundId: String(base - i * 300), startsAt: base - i * 300, firings, reversals: Math.max(0, firings - 1),
  firingsRaw: firings + 13, winner, simPnl4: firings ? 1 : 0, depthOk: true,
  events: Array.from({ length: firings }, (_, k) => ({ i: k + 1, t: 10 + k, dir: k % 2 ? "DOWN" : "UP", ask: 0.68, shares: 5,
    avail: 37, filled: k ? 2 : 5, cost: 3.4, status: k ? "partial" : "full" })),
});
const rounds = [round(0, 67), round(1, 0, "DOWN"), round(2, 1), round(3, 1), round(4, 2), round(5, 5)];
const distribution = {};
for (let v = 0; v <= 67; v += 1) distribution[String(v)] = 0;
for (const r of rounds) distribution[String(r.firings)] += 1;
const simBody = {
  schemaVersion: 1, assetId: "btc", rounds,
  summary: { rounds: 6, withFiring: 5, maxFirings: 67, maxRound: { roundId: String(base), startsAt: base, firings: 67 },
    avgFirings: 12.67, medianFirings: 1.5, distribution, winRateByFirings: {}, simPnl4Total: 5,
    rawAvg: 25.67, rawMax: 80, rawOver4: 6,
    rungFill: { "1": { count: 5, full: 5, partial: 0, none: 0, tooLate: 0, fullPct: 100, avgFilledPct: 100, avgAvail: 37 },
      "2": { count: 3, full: 1, partial: 1, none: 1, tooLate: 0, fullPct: 33.3, avgFilledPct: 45.5, avgAvail: 12.5 },
      "3": { count: 0, full: 0, partial: 0, none: 0, tooLate: 0, fullPct: 0, avgFilledPct: 0, avgAvail: 0 },
      "4": { count: 0, full: 0, partial: 0, none: 0, tooLate: 0, fullPct: 0, avgFilledPct: 0, avgAvail: 0 },
      "5+": { count: 62, full: 0, partial: 62, none: 0, tooLate: 0, fullPct: 0, avgFilledPct: 1.4, avgAvail: 2 } } },
};
const COINS = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"];
const overviewBody = { schemaVersion: 1, days: 10, coins: COINS.map((assetId, i) => ({
  assetId, rounds: i ? 0 : 6, avgFirings: i ? 0 : 12.67, medianFirings: i ? 0 : 1.5, maxFirings: i ? 0 : 67,
  over4: i ? 0 : 2, over4Pct: i ? 0 : 33.3, simPnl4Total: i ? 0 : 5 })) };

const window = {
  location: { search: "?assetId=btc&days=10", origin: "http://x", href: "http://x/sim.html?assetId=btc&days=10", pathname: "/sim.html" },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  console, URLSearchParams, URL, AbortController, history: { replaceState() {} }, navigator: {},
  localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
  document: { querySelector: (sel) => dom.lookup(sel), querySelectorAll: () => [], addEventListener() {}, visibilityState: "visible" },
};
window.window = window; window.self = window;
window.fetch = async (url) => {
  requests.push(String(url));
  const body = String(url).includes("/api/sim/overview") ? overviewBody : simBody;
  return { ok: true, status: 200, json: async () => body };
};

const context = vm.createContext(window);
for (const file of ["preview-core.js", "stream.js"]) {
  vm.runInContext(readFileSync(new URL(`../shared/${file}`, import.meta.url), "utf8"), context, { filename: file });
}
window.PolyPreview.config.apiBase = "";
vm.runInContext(readFileSync(new URL("../sim-block.js", import.meta.url), "utf8"), context, { filename: "sim-block.js" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(50);

assert.ok(requests.some((u) => u.includes("/api/sim?assetId=btc&days=10")), "requested /api/sim");
assert.ok(requests.some((u) => u.includes("/api/sim/overview?days=10")), "requested /api/sim/overview");

// Shell: shared sidebar + nav, coin pills are buttons with aria-pressed.
assert.ok(root._html.includes("settings-preview") && root._html.includes("模拟交易"), "shared shell markup");
const pills = dom.lookup("[data-coins]")._html;
assert.equal((pills.match(/aria-pressed=/g) || []).length, 7, "seven coin pills");
assert.ok(pills.includes('data-coin="btc" aria-pressed="true"'), "BTC pill active");

// Conclusion sentence: names 67 and the >4 share (2 of 6 = 33%).
const conclusion = dom.lookup("[data-conclusion]")._text;
assert.ok(conclusion.includes("67"), `conclusion names 67: ${conclusion}`);
assert.ok(conclusion.includes("33%"), `conclusion names the >4 share: ${conclusion}`);

// Stat cards.
assert.equal(dom.lookup("[data-stat-max]")._text, "67");
assert.equal(dom.lookup("[data-stat-rounds]")._text, "6");
assert.ok(dom.lookup("[data-stat-over4]")._text.includes("2"), "over-4 card shows 2 rounds");

// Raw (unfiltered) numbers ride along as comparison text.
assert.ok(conclusion.includes("实盘规则原样数（不过滤）最多 80 次"), `conclusion names the raw max: ${conclusion}`);
assert.ok(dom.lookup("[data-stat-maxround]")._text.includes("不过滤 80"), "max card sub-text shows raw");
assert.ok(dom.lookup("[data-stat-avg-sub]")._text.includes("不过滤 25.67"), "avg card sub-text shows raw");
assert.ok(root._html.includes("已过滤：两边卖价和 >1.05 的乱价"), "the filters are explained");

// Fill table: one row per rung 1..4 and 5+.
const fill = dom.lookup("[data-fill]")._html;
assert.equal((fill.match(/<tr/g) || []).length, 5, "five fill rows");
assert.ok(fill.includes("第 1 档") && fill.includes("第 5 档及以后"), "rung labels");
assert.ok(fill.includes("33.3%") && fill.includes("45.5%") && fill.includes("12.5"), "rung 2 fill numbers");

// Chart: one row for every value 0..67, the 67 row prints its count.
const chart = dom.lookup("[data-chart]")._html;
const rows = chart.match(/<li class="sim-row[^"]*"[^>]*>[^]*?<\/li>/g) || [];
assert.equal(rows.length, 68, `a row for every value 0..67, got ${rows.length}`);
const row67 = rows.find((r) => r.includes("出手 67 次"));
assert.ok(row67 && row67.includes(">1 场<"), "the 67 row prints its count");
assert.ok(row67.includes("sim-over"), "the 67 row is tinted as ladder exhausted");
assert.ok(rows.find((r) => r.includes("出手 3 次")).includes("sim-ladder"), "rows 1..4 are tinted as covered");

// Seven-coin table.
const overview = dom.lookup("[data-overview]")._html;
assert.equal((overview.match(/data-coin-row=/g) || []).length, 7, "seven coin rows");
assert.ok(overview.includes("HYPE") && overview.includes("33.3%"), "overview shows coins and >4 share");

// Rounds table: all six, then the >4 filter leaves only 67 and 5.
const roundRows = () => (dom.lookup("[data-rounds]")._html.match(/data-round="/g) || []).length;
assert.equal(roundRows(), 6);
const click = (attr, value) => root.dispatch("click", { target: { closest: (sel) => (sel === `[${attr}]` ? { getAttribute: () => value } : null) } });
click("data-filter", "over4");
assert.equal(roundRows(), 2, "the >4 filter shows only rounds with firings > 4");
assert.ok(!dom.lookup("[data-rounds]")._html.includes('data-firings="1"'), "no 1-firing round under >4");
assert.ok(dom.lookup("[data-rounds]")._html.includes("原 80"), "round row shows the raw count in grey");
click("data-expand", String(base));
const detail = dom.lookup("[data-rounds]")._html;
assert.ok(detail.includes("0.70内可买 37") && detail.includes("实际买到 2") && detail.includes("部分"), "event shows depth and fill");
click("data-filter", "zero");
assert.equal(roundRows(), 1, "the 0 filter shows only rounds with no firing");

// Clicking a coin row switches the coin.
const before = requests.length;
click("data-coin-row", "eth");
await wait(30);
assert.ok(requests.slice(before).some((u) => u.includes("/api/sim?assetId=eth")), "a coin row switches the coin");

console.log("frontend sim OK");
process.exit(0);
