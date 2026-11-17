// 历史 (history.js): rows from /api/orders/lead and a click that expands one.
// - a row shows time (Beijing), round, venue/line, direction, ask, limit,
//   shares, filled, result (赢/输/待结算/未成交), PnL, total ms, late ms;
// - clicking a row adds its detail row (all t_* fields, open line, ask gone
//   times, error text); clicking again closes it;
// - 再看 100 条 asks for the next page with before = next_before.
//
// Run:  node frontend/console/regress/history.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const T0 = 1763000100; // 2025-11-13 02:15:00 UTC = 10:15:00 北京时间
const order = (patch) => ({ client_order_id: "c1", order_id: "0xabc", round_id: String(T0 - 100), round_start: T0 - 100, recv_ts: T0,
  direction: "UP", venue: "bybit", line: "tokyo", ask_at_signal: 0.55, limit_price: 0.58, shares: 5, filled_shares: 5, status: "FILLED",
  outcome: "won", pnl: 2.1234, pnl_source: "official", avg_fill_price: 0.56, fee_usd: 0.07, move_bp: 2.4, signal_price: 98765.4,
  open_line: "mean60", open_value: 98700.12, band_bp: 1.8, sec_since_open: 100.2, trade_time_ms: T0 * 1000 - 120, relay_recv_ms: T0 * 1000 - 113,
  signal_recv_ms: T0 * 1000 - 108, decision_ms: T0 * 1000 - 107, post_sent_ms: T0 * 1000 - 106, ack_ms: T0 * 1000 - 20,
  t_signal_ms: 12, t_decide_ms: 1, t_post_ms: 1, t_ack_ms: 86, t_total_ms: 100, ask_gone_ms: null, ask_gone_venue_ms: null,
  ask_gone_after_trade_ms: null, late_by_ms: null, error: null, would_have_won: null, ...patch });
const page1 = { available: true, items: [
  order({}),
  order({ client_order_id: "c2", direction: "DOWN", venue: "okx", line: "direct", filled_shares: 0, status: "CANCELLED", outcome: "lost", pnl: null,
    would_have_won: true, ask_gone_ms: T0 * 1000 - 60, ask_gone_after_trade_ms: 60, late_by_ms: 40, error: "no orders found to match with FAK order" }),
  order({ client_order_id: "c3", outcome: "pending", pnl: null }),
  order({ client_order_id: "c4", outcome: "lost", pnl: -2.9 }),
], next_before: T0 - 500 };
const page2 = { available: true, items: [order({ client_order_id: "c5", recv_ts: T0 - 600 })], next_before: null };

// --- a stub DOM: nodes by selector, innerHTML recorded, handlers kept ---
const nodes = new Map();
const node = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, { selector, innerHTML: "", textContent: "", hidden: false, handlers: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) { this.handlers[type] = fn; }, querySelector: (s) => node(s), querySelectorAll: () => [] });
  return nodes.get(selector);
};
const requests = [];
const window = { location: { search: "", href: "http://x/history.html" }, setTimeout, clearTimeout, setInterval, clearInterval,
  URLSearchParams, URL, AbortController, console, document: { hidden: false, addEventListener() {}, querySelector: (s) => node(s) } };
window.fetch = async (url) => {
  requests.push(String(url));
  const body = String(url).includes("before=") ? page2 : page1;
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
};
window.window = window;
const context = vm.createContext(window);
for (const file of ["shared/preview-core.js", "history.js"]) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(20);
const text = (markup) => String(markup).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rows = () => node("[data-rows]").innerHTML;

// --- first page ---
assert.equal(requests[0], "/api/orders/lead?range=run&limit=100");
const rowTexts = [...rows().matchAll(/<tr class="row-click"[\s\S]*?<\/tr>/g)].map((m) => text(m[0]));
assert.equal(rowTexts.length, 4);
assert.equal(rowTexts[0], "11-13 10:15:00 10:13 Bybit · 东京转发 涨 UP 0.55 0.58 5 5 赢 +$2.12 100 ms --");
assert.ok(rowTexts[1].includes("OKX · 爱尔兰直连 跌 DOWN") && rowTexts[1].includes("未成交（买到会赢）") && rowTexts[1].endsWith("-- 100 ms 40 ms"), rowTexts[1]);
assert.ok(rowTexts[2].includes("待结算") && rowTexts[2].includes(" -- "), rowTexts[2]);
assert.ok(rowTexts[3].includes("输 -$2.90"), rowTexts[3]);
assert.ok(!rows().includes('class="detail"'), "collapsed at first");
assert.equal(node("[data-more]").hidden, false, "another page exists");

// --- click a row: its detail opens ---
const click = (key) => node("[data-rows]").handlers.click({ target: { closest: () => ({ dataset: { key } }) } });
click("c2");
const detail = text(rows().match(/<tr class="detail">[\s\S]*?<\/tr>/)[0]);
for (const piece of ["成交→收到 t_signal 12 ms", "收到→决策 t_decide 1 ms", "决策→发出 t_post 1 ms", "发出→回复 t_ack 86 ms", "总计 t_total 100 ms",
  "开盘线 开盘前 60 秒均价 98700.12", "离开盘线 1.8 bp", "卖单消失（我们收到） 10:14:59.940", "成交后多久卖单消失 60 ms", "晚了 40 ms",
  "交易所成交 10:14:59.880", "错误：no orders found to match with FAK order"]) {
  assert.ok(detail.includes(piece), `detail has ${piece}: ${detail}`);
}
assert.equal((rows().match(/<tr class="detail">/g) || []).length, 1, "only that row expands");
const index = rows().indexOf('data-key="c2"');
assert.ok(rows().indexOf('class="detail"') > index && rows().indexOf('class="detail"') < rows().indexOf('data-key="c3"'), "the detail sits under its row");
click("c2");
assert.ok(!rows().includes('class="detail"'), "a second click closes it");

// --- next page ---
await node("[data-more]").handlers.click();
await wait(10);
assert.equal(requests.at(-1), `/api/orders/lead?range=run&limit=100&before=${T0 - 500}`);
assert.equal((rows().match(/class="row-click"/g) || []).length, 5, "appended");
assert.equal(node("[data-more]").hidden, true, "no further page");

// --- the exit sell (exitOnReverse) and the edge record ---
const H = window.PolyHistory;
const sellRow = { stage: "exit", client_order_id: "c9x", recv_ts: T0, round_start: T0 - 90, direction: "UP", status: "FILLED",
  bid_at_signal: 0.5, limit_price: 0.42, shares: 10, filled_shares: 10, outcome: "lost", pnl: null, proceeds_usd: 4.9, exit_vs_hold_usd: 4.9 };
const sellText = text(H.renderRows([sellRow]));
for (const piece of ["反向卖出", "卖出持仓", "0.50 0.42 10 10", "已卖（拿着会输）"]) assert.ok(sellText.includes(piece), `sell row: ${piece}: ${sellText}`);
assert.ok(!sellText.includes("Bybit"), "no signal venue on the sell row");
assert.equal(H.result({ ...sellRow, outcome: "won" }).text, "已卖（拿着会赢）");
assert.equal(H.result({ ...sellRow, filled_shares: 0, status: "CANCELLED" }).text, "没卖掉");
assert.ok(text(H.detail(sellRow)).includes("信号时买一 0.50 · 收回 $4.90 · 比拿到结算 +$4.90"), text(H.detail(sellRow)));
const bought = { stage: "gtc", client_order_id: "c9", direction: "UP", status: "FILLED", filled_shares: 10, shares: 10, outcome: "lost", pnl: -1.2,
  exit_shares: 10, exit_proceeds_usd: 4.9, fair: 0.66, edge: 0.012, edge_shares: 10, edge_sizing: false };
const boughtDetail = text(H.detail(bought));
for (const piece of ["卖了 10 股 · 收回 $4.90（已算进盈亏）", "公允价 0.66 · 优势 +0.012 · 会按 10 股"]) {
  assert.ok(boughtDetail.includes(piece), `buy detail: ${piece}: ${boughtDetail}`);
}
assert.ok(text(H.detail({ ...bought, edge: -0.05, edge_shares: 5, edge_sizing: true })).includes("优势 -0.050 · 已按 5 股"));

console.log("history OK");
process.exit(0);
