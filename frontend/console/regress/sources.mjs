// 实盘 信号源 panel (live.js renderSources) from a runtime leadLines fixture:
// - each venue × line: a green dot when the last trade is < 10 s old, red
//   otherwise or with no trade; the age; how many trades it delivered first;
// - per venue "东京先到 x% · 平均早 y ms";
// - a venue the run did not enable says so; with tokyoRelay off the Tokyo
//   line says 未开启 and there is no Tokyo share;
// - the relay listener's state;
// - the strategy note is built from the config values, not fixed text.
//
// Run:  node frontend/console/regress/sources.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const window = { location: { search: "", href: "http://x/" }, setTimeout, clearTimeout, setInterval, clearInterval,
  URLSearchParams, URL, AbortController, console, document: { hidden: false, addEventListener() {}, querySelector: () => null } };
window.window = window;
const context = vm.createContext(window);
for (const file of ["shared/preview-core.js", "live.js"]) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const L = window.PolyLive;
const NOW = 1763000000000;
const text = (markup) => String(markup).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const line = (lastAgoMs, delivered, leadSumMs = 0, leadCount = 0) => ({ frames: 900, trades: 800, delivered, lastAt: lastAgoMs === null ? 0 : NOW - lastAgoMs, leadSumMs, leadCount });
const status = {
  processRunning: true, leadVenues: ["bybit", "binance"], leadRelay: true,
  leadLines: {
    venues: {
      bybit: { direct: line(1200, 300), tokyo: line(400, 700, 5600, 700) },     // tokyo first 70%, 8 ms early
      binance: { direct: line(15000, 90), tokyo: line(null, 10, 30, 10) },     // stale direct, no Tokyo trade
    },
    relay: { listening: true, port: 9555, error: null, messages: 2000, accepted: 1990, badSource: 0, badFormat: 4, badMac: 6, tcpClients: 1 },
  },
};
const markup = String(L.renderSources(status, NOW));
const cards = markup.split('<div class="source">').slice(1);
assert.equal(cards.length, 3, "Bybit, 币安合约, OKX");

const bybit = cards[0];
assert.ok(text(bybit).startsWith("Bybit"));
const dots = (card) => [...card.matchAll(/class="dot( \w+)?"/g)].map((m) => (m[1] || "").trim());
assert.deepEqual(dots(bybit), ["ok", "ok"], "both lines traded within 10 s");
assert.ok(text(bybit).includes("爱尔兰直连 1.2 秒前 先到 300 笔"), text(bybit));
assert.ok(text(bybit).includes("东京转发 0.4 秒前 先到 700 笔"), text(bybit));
assert.ok(text(bybit).includes("东京先到 70.0% · 平均早 8 ms"), text(bybit));

const binance = cards[1];
assert.ok(text(binance).startsWith("币安合约"));
assert.deepEqual(dots(binance), ["bad", "bad"], "15 s old and never: both red");
assert.ok(text(binance).includes("爱尔兰直连 15 秒前"), text(binance));
assert.ok(text(binance).includes("东京转发 没有成交"), text(binance));
assert.ok(text(binance).includes("东京先到 10.0% · 平均早 3 ms"), text(binance));

assert.ok(text(cards[2]).includes("OKX 本次运行没有启用"), "a venue the run did not enable");
const relay = text(markup.split("</div></div>").at(-1));
assert.ok(relay.includes("东京转发监听：正在监听 端口 9555 · 收到 2000 条 · 接受 1990 条 · 被拒 10 条"), relay);

// --- tokyoRelay off ---
const off = String(L.renderSources({ ...status, leadRelay: false, leadVenues: ["bybit"] }, NOW));
const offBybit = off.split('<div class="source">')[1];
assert.ok(text(offBybit).includes("东京转发 未开启"), text(offBybit));
assert.ok(!text(offBybit).includes("东京先到"), "no Tokyo share when the relay is off");
assert.ok(text(off).includes("东京转发：本次运行没有开启"));

// --- relay listener down and engine stopped ---
const down = text(L.renderSources({ ...status, leadLines: { ...status.leadLines, relay: { listening: false, port: 9555, messages: 0, accepted: 0 } } }, NOW));
assert.ok(down.includes("没有监听"), down);
assert.ok(text(L.renderSources({ processRunning: false, leadLines: null }, NOW)).includes("引擎没在运行"));

// --- strategy note from the config ---
const note = L.strategyNote({ leadVenues: ["okx"], tokyoRelay: false, thresholdBp: 3, windowMs: 400, fromSec: 20, toSec: 250,
  openBandBp: 5, openLine: "mean60", maxAsk: 0.75, limitPremium: 0.02, shares: 10 });
for (const piece of ["OKX", "400 ms", "≥ 3 bp", "只用爱尔兰直连", "第 20–250 秒", "±5 bp", "开盘前 60 秒均价", "≤ 0.75", "+ 0.02", "买 10 股", "一场最多一笔"]) {
  assert.ok(note.includes(piece), `note has ${piece}: ${note}`);
}
assert.ok(!L.strategyNote({ ...{ leadVenues: ["bybit"], tokyoRelay: true, thresholdBp: 2, windowMs: 250, fromSec: 15, toSec: 265, openBandBp: 0, openLine: "tick", maxAsk: 0.8, limitPremium: 0.03, shares: 5 } }).includes("±"), "no band text when openBandBp is 0");

console.log("sources OK");
process.exit(0);
