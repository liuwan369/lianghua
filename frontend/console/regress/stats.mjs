// 统计 rendering (stats.js) from a /api/stats/lead fixture:
// - money with sign and 2 decimals, rates 1 decimal %, ms integers;
// - the late_by_ms histogram has its six buckets, bar widths relative to the largest;
// - the speed breakdown stacks the four stage medians;
// - nulls render "--", never 0 or NaN.
//
// Run:  node frontend/console/regress/stats.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const window = { location: { search: "", href: "http://x/stats.html" }, setTimeout, clearTimeout, setInterval, clearInterval,
  URLSearchParams, URL, AbortController, console, document: { hidden: false, addEventListener() {}, querySelector: () => null } };
window.window = window;
const context = vm.createContext(window);
for (const file of ["shared/preview-core.js", "stats.js"]) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const S = window.PolyStats;
const text = (markup) => String(markup).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");

const fixture = JSON.parse(readFileSync(new URL("./fixtures/stats-lead.json", import.meta.url), "utf8"));
const parts = S.renderAll(fixture);

// --- funnel ---
const funnel = text(parts.funnel);
for (const piece of ["信号 412", "窗口内信号 380", "下单 60", "买到 41", "买到率 68.3%", "已结算 39", "赢 25", "胜率 64.1%", "+$12.35", "手续费 $1.90", "官方结算"]) {
  assert.ok(funnel.includes(piece), `funnel shows ${piece}: ${funnel}`);
}
// --- misses ---
const misses = text(parts.misses);
for (const piece of ["19 单", "其中会赢 11 单", "-$3.42"]) assert.ok(misses.includes(piece), `misses: ${piece}: ${misses}`);

// --- rest after a miss: live rest orders, then the shadow; neither = an empty line ---
const rest = text(S.renderRest({ live: { orders: 4, filled: 3, fill_rate: 0.75, settled: 3, won: 2, win_rate: 2 / 3, pnl_usd: 1.5 },
  shadow: { misses: 10, would_fill: 4, would_fill_rate: 0.4, settled: 4, won: 3, win_rate: 0.75, pnl_if_filled_usd: 2.25 } }));
for (const piece of ["挂单补单 4 单", "买到 3 单 · 75.0%", "胜率 66.7%", "+$1.50", "模拟：没买到 10 单", "5 秒内会成交 4 单", "其中会赢 3 / 4 单", "+$2.25"]) {
  assert.ok(rest.includes(piece), `rest: ${piece}: ${rest}`);
}
assert.ok(text(S.renderRest({ live: { orders: 0 }, shadow: { misses: 0 } })).includes("还没有没买到的单"));
assert.ok(text(S.renderRest(null)).includes("没有数据"));

// --- the 3rd-reverse-signal shadow is retired (2026-11-17) ---
assert.equal(S.renderExit, undefined, "no renderer for it");
assert.ok(!("exit" in parts), "no stats section for it");

// --- shadow regime pause ---
const regime = text(S.renderRegime({ judged: 30, would_pause: 6, would_pause_rate: 0.2, by_signals: 4, by_vol: 2, paused_filled: 5,
  paused_settled: 5, paused_won: 1, paused_win_rate: 0.2, paused_pnl_usd: -12.5, kept_settled: 20, kept_win_rate: 0.55,
  kept_pnl_usd: 8.25, net_if_paused_usd: 12.5 }));
for (const piece of ["记录的单 30 单", "会暂停 6 单", "占 20.0%", "信号多 4 · 波动大 2", "赢 1 / 5 场", "-$12.50", "+$8.25", "+$12.50"]) {
  assert.ok(regime.includes(piece), `regime: ${piece}: ${regime}`);
}
assert.ok(text(S.renderRegime({ judged: 0 })).includes("还没有带行情记录的单"));

// --- exit on the first reverse signal: shadow while off, the sells while on ---
const first = text(S.renderExitFirst({ held_rounds: 12, settled: 11, triggered: 9, trigger_rate: 0.8, skips: { off: 5, no_bid: 1 },
  shadow: { rounds: 5, mistaken: 2, saved: 3, net_usd: 4.2 },
  live: { sells: 3, filled: 3, fill_rate: 1, settled: 3, mistaken: 1, saved: 2, proceeds_usd: 14.7, net_vs_hold_usd: 1.25 } }));
for (const piece of ["买到的场 12 场", "出现反向信号 9 场", "实盘卖出 3 / 3 单", "收回 +$14.70", "误卖 / 止损 1 / 2 场", "+$1.25",
  "模拟：会卖出 5 场", "误卖 2 · 止损 3", "+$4.20", "没有买一价 1 场"]) {
  assert.ok(first.includes(piece), `exit first: ${piece}: ${first}`);
}
assert.ok(!first.includes("开关关着 5 场"), "the off count is the shadow, not a skip");
const offOnly = text(S.renderExitFirst({ held_rounds: 2, settled: 2, triggered: 1, trigger_rate: 0.5, skips: { off: 1 },
  shadow: { rounds: 1, mistaken: 0, saved: 1, net_usd: 2 }, live: { sells: 0 } }));
assert.ok(!offOnly.includes("实盘卖出"), "no live cards while off");
assert.ok(text(S.renderExitFirst({ held_rounds: 0 })).includes("还没有持仓的场"));
// --- size by edge: the tiers, the shadow and the live result ---
const edge = text(S.renderEdge({ judged: 10, tiers: { low: { settled: 3, won: 1, win_rate: 1 / 3, pnl_usd: -4 },
  mid: { settled: 5, won: 3, win_rate: 0.6, pnl_usd: 2 }, high: { settled: 2, won: 2, win_rate: 1, pnl_usd: 6 } },
  shadow: { settled: 10, actual_pnl_usd: 4, sized_pnl_usd: 9 }, live: { settled: 0, pnl_usd: null } }));
for (const piece of ["优势 < -0.04（买 5 股） 3 33.3% -$4.00", "中间（原股数） 5 60.0% +$2.00", "优势 ≥ 0.07（买 15 股） 2 100.0% +$6.00",
  "模拟：按优势定股 +$9.00", "原股数 +$4.00", "如果开了 +$5.00"]) {
  assert.ok(edge.includes(piece), `edge: ${piece}: ${edge}`);
}
assert.ok(!edge.includes("实盘按优势定股"), "no live card before it is on");
assert.ok(text(S.renderEdge({ judged: 0 })).includes("还没有带优势记录的单"));
assert.ok(text(S.renderEdge({ judged: 1, tiers: {}, shadow: { settled: 1, actual_pnl_usd: null, sized_pnl_usd: null }, live: {} })).includes("--"),
  "nulls render --");

// --- late_by_ms ---
const late = String(parts.late);
const lateText = text(late);
assert.ok(lateText.includes("卖单消失之后我们的单才到交易所的时间差"));
assert.ok(lateText.includes("-12 ms / 87 ms / 352 ms"), `p10/p50/p90 as integers: ${lateText}`);
for (const bucket of ["< 0 ms", "0–50 ms", "50–100 ms", "100–200 ms", "200–400 ms", "> 400 ms"]) assert.ok(lateText.includes(bucket), bucket);
const widths = [...late.matchAll(/class="warn" style="width:([\d.]+)%"/g)].map((m) => Number(m[1]));
assert.deepEqual(widths, [25, 50, 100, 75, 25, 0], "bar widths relative to the largest bucket (2,4,8,6,2,0)");
assert.ok(lateText.includes("没买到的 中位 41 ms"), lateText);
assert.ok(lateText.includes("买到的 中位 --"), "missing quantile is --");

// --- latency ---
const latency = String(parts.latency);
const latencyText = text(latency);
const stack = [...latency.matchAll(/<i class="c(\d)" title="[^"]*" style="width:([\d.]+)%"/g)].map((m) => Number(m[2]));
assert.equal(stack.length, 4, "four stacked stages");
assert.ok(Math.abs(stack.reduce((a, b) => a + b, 0) - 100) < 0.5, "stack sums to 100%");
assert.deepEqual(stack, [10, 1, 1, 88].map((x) => x), "median shares 10:1:1:88 ms of 100");
for (const piece of ["成交→爱尔兰收到 10 ms", "收到→决策 1 ms", "决策→发出 1 ms", "发出→交易所回复 88 ms", "总计（成交→交易所回复） 60 101 ms 190 ms"]) {
  assert.ok(latencyText.includes(piece), `latency: ${piece}: ${latencyText}`);
}

// --- by source ---
const sources = text(parts.sources);
assert.ok(sources.includes("Bybit 东京转发 30 22 73.3% 15 71.4% +$9.10"), sources);
assert.ok(sources.includes("币安合约 爱尔兰直连 30 19 63.3% 10 52.6% -$0.75"), sources);
assert.ok(sources.includes("Bybit：东京先到 61.0%，平均早 7 ms"), sources);

// --- skips ---
const skips = text(parts.skips);
assert.ok(skips.includes("卖价高于上限 120 次") && skips.includes("其他 0 次"), skips);

// --- by hour: 24 rows, Beijing hours, null pnl as -- ---
const hours = String(parts.hours);
assert.equal((hours.match(/<tr>/g) || []).length, 25, "header + 24 hours");
const hoursText = text(hours);
assert.ok(hoursText.includes("09:00 12 9 6 +$4.20"), hoursText);
assert.ok(hoursText.includes("00:00 0 0 0 --"), "an hour with no pnl shows --");

// --- unavailable: placeholders, no NaN ---
const empty = S.renderAll(null);
for (const markup of Object.values(empty)) assert.ok(!/NaN|undefined/.test(String(markup)));
const zero = text(S.renderFunnel({ signals: 0, signals_in_window: 0, orders: 0, filled: 0, fill_rate: null, settled: 0, won: 0, win_rate: null, pnl_usd: null, fees_usd: null }));
assert.ok(zero.includes("买到率 --") && zero.includes("盈亏 --"), zero);

console.log("stats OK");
process.exit(0);
