// 模拟交易页 (sim.html + sim-block.js), three variants. With stub data:
// the "三种做法对比" card has a row per variant (实盘现状 / 新规则·立即 /
// 新规则·停1秒) with its explanation line; variant pills (default 新规则·立即)
// switch the conclusion, stat cards, chart, rung table and round list by
// requesting /api/sim?variant=; the chart has one row for every value 0..max (no
// capping); the rung table has 下单次数 / 没买到(第1档不计) / 挂单后成交 /
// 0.70内平均可买量 columns; events show Chinese labels; the seven-coin table
// shows PnL for all three variants; the caveat names the 0.2 s fill model.
// sim.html loads the shell CSS.
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
const ev = (k, status) => ({ rung: k + 1, t: 10 + k, dir: k % 2 ? "DOWN" : "UP", ask: 0.68, want: 5, cap: 0.7,
  avail: 37, filled: status === "full" ? 5 : 2, avgPrice: 0.69, cost: 3.4, fee: 0.07, status });
const round = (i, firings, winner = "UP") => ({
  asset: "btc", roundId: String(base - i * 300), startsAt: base - i * 300, depthOk: true, winner, firings,
  rawSeconds: [], held: { UP: 5, DOWN: 0 }, cost: 3.5, pnl: firings ? 1 : 0,
  events: Array.from({ length: firings }, (_, k) => ev(k, k ? "partial" : "full")) });
const fillRow = (count, full, none = 0, maker = 0) => ({ count, full, partial: count - full - none, none, skipped: 0, gap: 0, maker,
  fullPct: count ? Math.round(full * 1000 / count) / 10 : 0, avgFilledPct: 45.5, avgAvail: 12.5 });
const summaryFor = (max, rounds) => {
  const distribution = {};
  for (let v = 0; v <= max; v += 1) distribution[String(v)] = 0;
  for (const r of rounds) distribution[String(r.firings)] += 1;
  return { rounds: rounds.length, withFiring: 5, maxFirings: max, maxRound: { roundId: String(base), startsAt: base, firings: max },
    avgFirings: 12.67, medianFirings: 1.5, over4: 2, distribution, pnlTotal: 5, pnlPerRound: 0.833, roundsWithPnl: 6,
    worstRound: { roundId: String(base), startsAt: base, pnl: -2 },
    rungFill: { "1": fillRow(5, 5), "2": fillRow(3, 1, 1, 7), "3": fillRow(0, 0), "4": fillRow(0, 0), "5+": fillRow(62, 0, 9) } };
};
const compare = {
  A: { avgFirings: 25.67, maxFirings: 80, over4: 6, rungFullPct: { 1: 90, 2: 70, 3: 40, 4: 10 }, pnlTotal: -42.5, pnlPerRound: -7.08, worstPnl: -30.2, roundsWithPnl: 6 },
  C: { avgFirings: 12.67, maxFirings: 67, over4: 2, rungFullPct: { 1: 100, 2: 33.3, 3: 0, 4: 0 }, pnlTotal: 5, pnlPerRound: 0.83, worstPnl: -2, roundsWithPnl: 6, rung1Skipped: 4 },
  C2: { avgFirings: 3.1, maxFirings: 9, over4: 1, rungFullPct: { 1: 95, 2: 50, 3: 20, 4: 0 }, pnlTotal: 1.25, pnlPerRound: 0.21, worstPnl: -4, roundsWithPnl: 6 } };
const bodies = {
  C: () => { const rounds = [round(0, 67), round(1, 0, "DOWN"), round(2, 1), round(3, 1), round(4, 2), round(5, 5)];
    return { schemaVersion: 4, assetId: "btc", variant: "C", rounds, summary: summaryFor(67, rounds), compare }; },
  A: () => { const rounds = [round(0, 80), round(1, 3)];
    return { schemaVersion: 4, assetId: "btc", variant: "A", rounds, summary: summaryFor(80, rounds), compare }; },
};
const COINS = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"];
const vrow = (pnl) => ({ maxFirings: 0, avgFirings: 0, over4: 0, pnlTotal: pnl, pnlPerRound: 0 });
const overviewBody = { schemaVersion: 4, days: 10, coins: COINS.map((assetId, i) => ({ assetId, rounds: i ? 0 : 6,
  variants: { A: vrow(i ? 0 : -42.5), C: vrow(i ? 0 : 5), C2: vrow(i ? 0 : 1.25) } })) };
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
  const body = String(url).includes("/api/sim/overview") ? overviewBody
    : String(url).includes("variant=A") ? bodies.A() : bodies.C();
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

assert.ok(requests.some((u) => u.includes("/api/sim?assetId=btc&days=10&variant=C")), "requested /api/sim with the default variant C");
assert.ok(requests.some((u) => u.includes("/api/sim/overview?days=10")), "requested /api/sim/overview");

// Shell: shared sidebar + nav, coin pills are buttons with aria-pressed.
assert.ok(root._html.includes("settings-preview") && root._html.includes("模拟交易"), "shared shell markup");
const pills = dom.lookup("[data-coins]")._html;
assert.equal((pills.match(/aria-pressed=/g) || []).length, 7, "seven coin pills");
assert.ok(pills.includes('data-coin="btc" aria-pressed="true"'), "BTC pill active");

// Compare card: three rows, each with its plain-Chinese explanation.
const cmp = dom.lookup("[data-compare]")._html;
assert.equal((cmp.match(/<tr/g) || []).length, 3, "three variant rows");
for (const label of ["实盘现状", "新规则·立即", "新规则·停1秒"]) assert.ok(cmp.includes(label), `compare row ${label}`);
assert.ok(!cmp.includes("建议") && !root._html.includes("超过保本价"), "the B variants are gone");
assert.ok(cmp.includes("25.67") && cmp.includes("80") && cmp.includes("-42.50") && cmp.includes("-30.20"), "A numbers");
assert.ok(cmp.includes("33.3%") && cmp.includes("+0.83"), "C numbers");
assert.ok(cmp.includes("sim-variant-note"), "each variant has an explanation line");

// Variant pills: default 新规则·立即.
const vpills = dom.lookup("[data-variants]")._html;
assert.equal((vpills.match(/aria-pressed=/g) || []).length, 3, "three variant pills");
assert.ok(vpills.includes('data-variant="C" aria-pressed="true"'), "新规则·立即 is the default");

// Conclusion (C): names the variant, 67 and the >4 share (2 of 6 = 33%).
let conclusion = dom.lookup("[data-conclusion]")._text;
assert.ok(conclusion.includes("新规则·立即") && conclusion.includes("67") && conclusion.includes("33%"), `conclusion: ${conclusion}`);
assert.equal(dom.lookup("[data-stat-max]")._text, "67");
assert.equal(dom.lookup("[data-stat-rounds]")._text, "6");

// Rung table: five rows and the agreed columns; the caveat names the fill model.
const fill = dom.lookup("[data-fill]")._html;
assert.equal((fill.match(/<tr/g) || []).length, 5, "five fill rows");
for (const head of ["档位", "下单次数", "全部买到", "部分", "没买到(第1档不计)", "挂单后成交", "平均买到比例", "0.70内平均可买量"]) {
  assert.ok(root._html.includes(`<th scope="col">${head}</th>`), `rung column ${head}`);
}
assert.ok(fill.includes("<td>7</td>"), "the resting-fill count is shown");
assert.ok(root._html.includes("模拟：订单 0.2 秒到达；挂单在买价涨到 0.70 以上或有成交打到 0.70 时算成交；没考虑排队先后，实盘可能更差。"), "caveat");
assert.ok(fill.includes("第 1 档") && fill.includes("第 5 档及以后") && fill.includes("33.3%"), "rung labels and numbers");

// Chart: one row for every value 0..67.
const rowsOf = () => dom.lookup("[data-chart]")._html.match(/<li class="sim-row[^"]*"[^>]*>[^]*?<\/li>/g) || [];
assert.equal(rowsOf().length, 68, `a row for every value 0..67, got ${rowsOf().length}`);
assert.ok(rowsOf().find((r) => r.includes("出手 67 次")).includes(">1 场<"), "the 67 row prints its count");

// Seven-coin table: PnL for the three variants.
const overview = dom.lookup("[data-overview]")._html;
assert.equal((overview.match(/data-coin-row=/g) || []).length, 7, "seven coin rows");
assert.ok(overview.includes("-42.50") && overview.includes("+5.00") && overview.includes("+1.25"), "three PnL columns");

// Rounds and events: Chinese labels.
const roundRows = () => (dom.lookup("[data-rounds]")._html.match(/data-round="/g) || []).length;
assert.equal(roundRows(), 6);
const click = (attr, value) => root.dispatch("click", { target: { closest: (sel) => (sel === `[${attr}]` ? { getAttribute: () => value } : null) } });
click("data-filter", "over4");
assert.equal(roundRows(), 2, "the >4 filter shows only rounds with firings > 4");
click("data-expand", String(base));
const detail = dom.lookup("[data-rounds]")._html;
assert.ok(detail.includes("第 2 档") && detail.includes("第 11 秒") && detail.includes("卖价 0.68") && detail.includes("要买 5")
  && detail.includes("上限 0.70") && detail.includes("可买 37") && detail.includes("买到 2") && detail.includes("均价 0.69")
  && detail.includes("部分"), `event labels: ${detail.slice(0, 400)}`);
click("data-filter", "all");

// Switching to 实盘现状 reloads with variant=A and re-renders the chart and conclusion.
let before = requests.length;
click("data-variant", "A");
await wait(30);
assert.ok(requests.slice(before).some((u) => u.includes("variant=A")), "a variant pill requests that variant");
conclusion = dom.lookup("[data-conclusion]")._text;
assert.ok(conclusion.includes("实盘现状") && conclusion.includes("80"), `A conclusion: ${conclusion}`);
assert.equal(rowsOf().length, 81, "the chart follows the variant");
assert.equal(roundRows(), 2, "the round list follows the variant");

// Clicking a coin row switches the coin, keeping the variant.
before = requests.length;
click("data-coin-row", "eth");
await wait(30);
assert.ok(requests.slice(before).some((u) => u.includes("/api/sim?assetId=eth") && u.includes("variant=A")), "coin switch keeps the variant");

console.log("frontend sim OK");
process.exit(0);
