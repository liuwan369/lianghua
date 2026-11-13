// 实盘 完整链路 panel (live.js renderChain) from lead_order rows:
// - the newest order's rows: offset from the exchange trade and the segment
//   since the previous shown row; the Tokyo row only for line "tokyo";
// - ask_gone null reads 「回复前一直在」; the reply row says 买到 x/y 股 or 没买到;
// - verdict: missed with both times -> 晚了 Z ms; filled -> 买到了; else 数据不全;
// - medians over the list (t_signal split by line, misses only for ask_gone/late_by);
// - nulls render "--", never NaN/undefined; server text is escaped.
//
// Run:  node frontend/console/regress/chain.mjs
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
const text = (markup) => String(markup).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const rowsOf = (markup) => [...String(markup).split("单中位数")[1].matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => text(m[1]));

// 2026-11-13 12:00:00.000 UTC = 20:00:00 Beijing.
const T = Date.UTC(2026, 10, 13, 12, 0, 0);
const tokyoMissed = { venue: "okx", line: "tokyo", direction: "UP", status: "REJECTED", shares: 5, filled_shares: 0,
  ask_at_signal: 0.55, limit_price: 0.58, error: "no orders found to match with FAK order",
  trade_time_ms: T, relay_recv_ms: T + 4, signal_recv_ms: T + 125, decision_ms: T + 127, post_sent_ms: T + 129,
  ask_gone_ms: T + 275, ack_ms: T + 637,
  t_signal_ms: 125, t_decide_ms: 2, t_post_ms: 2, t_ack_ms: 508, t_total_ms: 637, ask_gone_after_trade_ms: 275, late_by_ms: 362 };
const directFilled = { venue: "bybit", line: "direct", direction: "DOWN", status: "FILLED", shares: 10, filled_shares: 10,
  ask_at_signal: 0.6, limit_price: 0.63, error: null,
  trade_time_ms: T - 300000, relay_recv_ms: null, signal_recv_ms: T - 300000 + 9, decision_ms: T - 300000 + 10,
  post_sent_ms: T - 300000 + 11, ask_gone_ms: null, ack_ms: T - 300000 + 211,
  t_signal_ms: 9, t_decide_ms: 1, t_post_ms: 1, t_ack_ms: 200, t_total_ms: 211, ask_gone_after_trade_ms: null, late_by_ms: null };
const allNull = Object.fromEntries(Object.keys(tokyoMissed).map((key) => [key, null]));

// --- a Tokyo-relayed order that missed ---
{
  const markup = String(L.renderChain([tokyoMissed, directFilled, allNull]));
  const all = text(markup);
  assert.ok(all.includes("最近一单完整链路"), all);
  assert.ok(all.includes("11-13 20:00:00 北京时间 · 涨 UP · 信号时卖价 0.55 → 限价 0.58"), all);
  const rows = [...markup.split("最近 3 单中位数")[0].matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => text(m[1]));
  assert.deepEqual(rows, [
    "环节 距交易所成交 本段用时",
    "交易所成交（OKX） +0 ms --",
    "东京收到并转发 +4 ms 4 ms",
    "爱尔兰收到信号（东京转发） +125 ms 121 ms",
    "引擎决策 +127 ms 2 ms",
    "订单发出 +129 ms 2 ms",
    "便宜卖单消失（卖价超过限价） +275 ms 146 ms",
    "交易所回复：没买到 +637 ms 362 ms",
  ]);
  assert.ok(all.includes("卖单在第 275 ms 消失，我们第 637 ms 才到，晚了 362 ms"), all);
  assert.ok(all.includes("no orders found to match with FAK order"), "the venue's words");
}

// --- a direct order that filled: no Tokyo row, ask stayed until the reply ---
{
  const markup = String(L.renderChain([directFilled]));
  const rows = [...markup.split("最近 1 单中位数")[0].matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => text(m[1]));
  assert.deepEqual(rows, [
    "环节 距交易所成交 本段用时",
    "交易所成交（Bybit） +0 ms --",
    "爱尔兰收到信号（爱尔兰直连） +9 ms 9 ms",
    "引擎决策 +10 ms 1 ms",
    "订单发出 +11 ms 1 ms",
    "便宜卖单消失（卖价超过限价） 回复前一直在 --",
    "交易所回复：买到 10/10 股 +211 ms 200 ms",
  ]);
  const all = text(markup);
  assert.ok(all.includes("买到了，卖单在回复前没消失"), all);
  assert.ok(all.includes("跌 DOWN") && all.includes("0.60 → 限价 0.63"), all);
}

// --- an order with nothing known ---
{
  const markup = String(L.renderChain([allNull]));
  assert.ok(!/NaN|undefined|null/.test(markup), markup);
  const all = text(markup);
  assert.ok(all.includes("数据不全"), all);
  assert.ok(all.includes("-- 北京时间 · -- · 信号时卖价 -- → 限价 --"), all);
  assert.ok(all.includes("交易所成交（--） -- --"), all);
  assert.ok(all.includes("交易所回复：-- -- --"), all);
  assert.ok(!all.includes("东京收到并转发"), "line unknown: no Tokyo row");
}

// --- medians over the last orders ---
{
  const second = { ...tokyoMissed, t_signal_ms: 135, t_decide_ms: 4, t_post_ms: 2, t_ack_ms: 300, t_total_ms: 441,
    ask_gone_after_trade_ms: 225, late_by_ms: 216 };
  const list = [tokyoMissed, directFilled, second, allNull];
  const stats = Object.fromEntries(L.chainMedians(list).map(([name, s]) => [name, [s.n, s.median]]));
  assert.deepEqual(stats["成交→爱尔兰收到（爱尔兰直连）"], [1, 9]);
  assert.deepEqual(stats["成交→爱尔兰收到（东京转发）"], [2, 130]);
  assert.deepEqual(stats["收到→决策"], [3, 2]);
  assert.deepEqual(stats["决策→发出"], [3, 1 + 1]);
  assert.deepEqual(stats["发出→交易所回复"], [3, 300]);
  assert.deepEqual(stats["总计（成交→交易所回复）"], [3, 441]);
  assert.deepEqual(stats["成交→卖单消失（没买到的）"], [2, 250], "misses only: the filled order is left out");
  assert.deepEqual(stats["晚了多少（没买到的）"], [2, 289]);
  const rows = rowsOf(L.renderChain(list));
  assert.ok(rows.includes("成交→爱尔兰收到（东京转发） 2 130 ms"), rows.join("\n"));
  assert.ok(rows.includes("晚了多少（没买到的） 2 289 ms"), rows.join("\n"));
  assert.ok(text(L.renderChain(list)).includes("最近 4 单中位数"));
}

// --- no orders yet: placeholder, medians with n 0 and -- ---
{
  const markup = String(L.renderChain(undefined));
  assert.ok(!/NaN|undefined|null/.test(markup), markup);
  const all = text(markup);
  assert.ok(all.includes("本次运行还没有下单"), all);
  assert.ok(all.includes("收到→决策 0 --"), all);
}

// --- server text is escaped ---
{
  const evil = { ...tokyoMissed, error: "<img src=x onerror=alert(1)>", venue: "<b>x</b>", direction: "<script>" };
  const markup = String(L.renderChain([evil]));
  assert.ok(!markup.includes("<img") && !markup.includes("<script>") && !markup.includes("<b>x</b>"), markup);
  assert.ok(markup.includes("&lt;img src=x onerror=alert(1)&gt;"), "error shown escaped");
  assert.ok(markup.includes("&lt;b&gt;x&lt;/b&gt;"), "unknown venue shown escaped");
}

// --- the page reads 20 lead orders on its existing 3 s poll ---
{
  const source = readFileSync(new URL("../live.js", import.meta.url), "utf8");
  assert.ok(source.includes('P.api.ordersLead({ range: "run", limit: 20 })'), "limit=20");
  assert.equal((source.match(/P\.api\.ordersLead\(/g) || []).length, 1, "one poll, reused");
}

console.log("chain OK");
process.exit(0);
