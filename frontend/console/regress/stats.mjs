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
