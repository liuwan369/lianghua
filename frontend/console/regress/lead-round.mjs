// The auto-trade page shows the binance-lead round, on the real page modules in
// a vm with a stub DOM and a stub server:
// - waiting: the strategy's reason, the book in force (tradeable or why not)
//   and the Binance feed's health;
// - ordered: direction, limit, ask at the signal, Binance move in bp, filled
//   shares out of the order;
// - a signal that placed nothing: its reason from /api/runtime/status
//   leadSignals, so "why no order this round" is visible;
// - no reversal wording (阶段/确认反转) anywhere on the page.
//
// Run:  node frontend/console/regress/lead-round.mjs
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

let phase = "waiting";
let source = null;
const identity = () => ({ assetId: "btc", marketId: "0xm", roundId: String(roundStart()) });
const market = () => ({ ...identity(), symbol: "BTC", supported: true, canEnable: true, cycle: "5m", startAt: roundStart(),
  endAt: roundStart() + 300, current: true, sequence: 3, sourceAt: now(), expiresAt: now() + 2,
  yes: { bid: 0.56, ask: 0.57, sourceAt: now(), expiresAt: now() + 2 }, no: { bid: 0.43, ask: 0.45, sourceAt: now(), expiresAt: now() + 2 },
  yesBid: 0.56, yesAsk: 0.57, noBid: 0.43, noAsk: 0.45 });
const position = () => {
  const base = { schemaVersion: 1, available: true, stale: false, error: null, ...identity(), updatedAt: now(),
    roundStatus: "running", config: { shares: 5, thresholdBp: 2, windowMs: 250, limitPremium: 0.03, fromSec: 15, toSec: 265 },
    yesShares: 0, noShares: 0, occupiedUsd: 0, outcomePnl: { yes: 0, no: 0 } };
  if (phase === "waiting") return { ...base, attempt: null, reason: "当前盘口一边没有卖价，等下一个信号",
    latest: { upAsk: 0.57, downAsk: null, twoSided: false, freshOnArrival: false, staleReason: null } };
  return { ...base, yesShares: 3, occupiedUsd: 1.75, outcomePnl: { yes: 1.25, no: -1.75 }, reason: "本场已买到 3/5 股，持有到结算",
    latest: { upAsk: 0.58, downAsk: 0.44, twoSided: true, freshOnArrival: true, staleReason: null },
    attempt: { direction: "UP", price: 0.6, askAtSignal: 0.57, shares: 5, filledShares: 3, status: "FILLED", error: null,
      createdAt: now() - 5, moveBp: 2.9996, binancePrice: 100030, refPrice: 100000, signalAt: now() - 5 } };
};
const runtime = () => ({ schemaVersion: 1, asOf: now(), stale: false, source: "platform-runtime", status: "running", state: "running",
  processRunning: true, processRunningFresh: true, strategyId: "binance-lead", assetId: "btc", leadFeedHealthy: phase === "waiting",
  ...(source ? { leadSource: source } : {}),
  leadSignals: [{ trade_id: 41, direction: "DOWN", move_bp: -2.4, received_at: now() - 8, ...identity(),
    round_id: identity().roundId, market_id: "0xm", outcome: "skipped", reason: "当前盘口一边没有卖价，等下一个信号" }],
  markets: [{ ...identity(), id: "0xm", name: `btc-updown-5m-${roundStart()}`, startsAt: roundStart(), endsAt: roundStart() + 300 }] });
const reply = (url) => {
  if (url.includes("/position")) return position();
  if (url.includes("/snapshot")) return { schemaVersion: 1, ...market() };
  if (url.includes("/api/markets")) return { schemaVersion: 1, items: [market()], asOf: now(), stale: false };
  if (url.includes("/api/runtime/market-pool")) return { schemaVersion: 1, desiredIds: ["btc"], currentIds: ["btc"], asOf: now() };
  if (url.includes("/api/runtime/status")) return runtime();
  return { schemaVersion: 1, asOf: now(), stale: false, items: [] };
};
const window = { location: { search: "?assetId=btc", origin: "http://127.0.0.1", href: "http://127.0.0.1/x.html", pathname: "/x.html" },
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
const all = () => [...written.values()].join("\n");

await wait(2600);
assert.equal(written.get("[data-lead-state]"), "等待信号", "waiting: no order yet");
assert.equal(written.get("[data-lead-reason]"), "当前盘口一边没有卖价，等下一个信号", "the strategy's own reason");
assert.match(written.get("[data-lead-book]") || "", /一边没有卖价/, "the book in force says why a signal cannot trade");
assert.match(written.get("[data-lead-feed]") || "", /币安行情正常/, "an engine that does not name its source reads Binance");
// The engine reads Bybit perp: the feed line names the venue actually in use.
source = "bybit-perp";
await wait(2600);
assert.match(written.get("[data-lead-feed]") || "", /^Bybit 合约行情正常/);
source = null;
await wait(2600);
assert.match(written.get("[data-lead-signals]#html") || "", /当前盘口一边没有卖价/, "the skipped signal and its reason are listed");
assert.match(written.get("[data-lead-signals]#html") || "", /-2\.4/, "with its Binance move");

phase = "ordered";
await wait(2600);
assert.equal(written.get("[data-lead-state]"), "已下单 · 买 YES");
const detail = written.get("[data-lead-order]") || "";
for (const part of ["限价 0.600", "当时卖价 0.570", "币安 +3.0 bp", "成交 3.00 / 5.00 股"]) {
  assert.ok(detail.includes(part), `ordered: "${part}" in "${detail}"`);
}
assert.equal(written.get("[data-lead-reason]"), "本场已买到 3/5 股，持有到结算");
assert.match(written.get("[data-lead-feed]") || "", /币安行情中断/, "an unhealthy feed is said");
assert.equal(written.get('[data-holding="up"]'), "3.00");
assert.ok(!/阶段|确认反转|反转/.test(all()), "no reversal wording on the page");
console.log("lead-round OK");
process.exit(0);
