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
const order = (patch) => ({ client_order_id: "c1", market_id: `0xm-${patch.client_order_id ?? "c1"}`, order_id: "0xabc", round_id: String(T0 - 100), round_start: T0 - 100, recv_ts: T0,
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
assert.equal(rowTexts[0], "11-13 10:15:00 10:13 Bybit · 东京转发 涨 UP 0.55 0.58 5 / 5 -- 赢 +$2.12 100 ms --");
assert.ok(rowTexts[1].includes("OKX · 爱尔兰直连 跌 DOWN") && rowTexts[1].includes("没买到（买到会赢）") && rowTexts[1].endsWith("-- 100 ms 40 ms"), rowTexts[1]);
assert.ok(rowTexts[2].includes("待结算") && rowTexts[2].includes(" -- "), rowTexts[2]);
assert.ok(rowTexts[3].includes("输 -$2.90"), rowTexts[3]);
assert.ok(!rows().includes('class="detail"'), "collapsed at first");
assert.equal(node("[data-more]").hidden, false, "another page exists");

// --- click a row: its detail opens ---
const click = (key) => node("[data-rows]").handlers.click({ target: { closest: () => ({ dataset: { key } }) } });
click("0xm-c2");
const detail = text(rows().match(/<tr class="detail">[\s\S]*?<\/tr>/)[0]);
for (const piece of ["成交→收到 t_signal 12 ms", "收到→决策 t_decide 1 ms", "决策→发出 t_post 1 ms", "发出→回复 t_ack 86 ms", "总计 t_total 100 ms",
  "开盘线 开盘前 60 秒均价 98700.12", "离开盘线 1.8 bp", "卖单消失（我们收到） 10:14:59.940", "成交后多久卖单消失 60 ms", "晚了 40 ms",
  "交易所成交 10:14:59.880", "错误：no orders found to match with FAK order"]) {
  assert.ok(detail.includes(piece), `detail has ${piece}: ${detail}`);
}
assert.equal((rows().match(/<tr class="detail">/g) || []).length, 1, "only that row expands");
const index = rows().indexOf('data-key="0xm-c2"');
assert.ok(rows().indexOf('class="detail"') > index && rows().indexOf('class="detail"') < rows().indexOf('data-key="0xm-c3"'), "the detail sits under its row");
click("0xm-c2");
assert.ok(!rows().includes('class="detail"'), "a second click closes it");

// --- next page ---
await node("[data-more]").handlers.click();
await wait(10);
assert.equal(requests.at(-1), `/api/orders/lead?range=run&limit=100&before=${T0 - 500}`);
assert.equal((rows().match(/class="row-click"/g) || []).length, 5, "appended");
assert.equal(node("[data-more]").hidden, true, "no further page");

// --- one row per round: the buy and its reverse-signal sell together (user 2026-11-19) ---
const H = window.PolyHistory;
// 17:35 on 11-19: UP bought 10 at 0.59, sold 10 at 0.81 on the reverse signal, UP lost: +2.90.
const buy = order({ client_order_id: "b1", market_id: "0xr", stage: "gtc", round_start: T0 - 90, recv_ts: T0 - 60, ask_at_signal: 0.51, limit_price: 0.59,
  shares: 10, filled_shares: 10, avg_fill_price: 0.59, outcome: "lost", pnl: 2.9, exit_shares: 10, exit_proceeds_usd: 8.78,
  fair: 0.66, edge: 0.012, edge_shares: 10, edge_sizing: false });
const sell = { stage: "exit", client_order_id: "b1x", market_id: "0xr", recv_ts: T0 - 40, round_start: T0 - 90, direction: "UP", status: "FILLED",
  bid_at_signal: 0.89, limit_price: 0.81, shares: 10, filled_shares: 10, avg_fill_price: 0.81, outcome: "lost", pnl: null,
  proceeds_usd: 8.78, exit_vs_hold_usd: 8.78 };
const rounds = H.groupRounds([sell, buy]);
assert.equal(rounds.length, 1, "the buy and its sell are one round");
const one = text(H.renderRows(rounds));
assert.equal((String(H.renderRows(rounds)).match(/class="row-click"/g) || []).length, 1, "one row");
for (const piece of ["Bybit · 东京转发 涨 UP 0.51 0.59 10 / 10", "卖 10 股 @0.81", "卖了（拿着会输）", "+$2.90"]) {
  assert.ok(one.includes(piece), `round row: ${piece}: ${one}`);
}
assert.ok(!one.includes("反向卖出 卖出持仓"), "no separate sell row");
// The other results.
const res = (b, s) => H.roundResult({ buy: b, sell: s }).text;
assert.equal(res({ ...buy, outcome: "won" }, { ...sell, outcome: "won" }), "卖了（拿着会赢）", "sold, would have won");
assert.equal(res({ ...buy, outcome: "won", pnl: 4.1 }, null), "赢");
assert.equal(res(buy, { ...sell, filled_shares: 0, status: "REJECTED" }), "输", "the sell did not fill: held to the close");
assert.ok(text(H.renderRows(H.groupRounds([buy, { ...sell, filled_shares: 0, status: "REJECTED" }]))).includes("没卖掉（限 0.81）"));
assert.equal(res({ ...buy, filled_shares: 0, status: "CANCELLED", outcome: "lost", pnl: null, would_have_won: true }, null), "没买到（买到会赢）");
// Its detail shows both orders.
const open = String(H.renderRows(rounds, new Set(["0xr"])));
const opened = text(open.match(/<tr class="detail">[\s\S]*?<\/tr>/)[0]);
for (const piece of ["买入", "反向信号卖出", "信号时买一 0.89 · 收回 $8.78 · 比拿到结算 +$8.78", "公允价 0.66 · 优势 +0.012 · 会按 10 股"]) {
  assert.ok(opened.includes(piece), `detail: ${piece}: ${opened}`);
}
assert.ok(text(H.detail({ ...buy, edge: -0.05, edge_shares: 5, edge_sizing: true })).includes("优势 -0.050 · 已按 5 股"));

console.log("history OK");
process.exit(0);
