// Each page boots on a stub DOM and a stub server without throwing, reads the
// endpoints it is meant to, and puts the server's data on screen:
// - 实盘: runtime status, book, position, orders, config, account, stats;
// - 统计: /api/stats/lead?range=run; the range buttons switch the range;
// - 设置: config fills the form, account/health/events are shown.
// The sidebar has exactly 实盘 / 统计 / 历史 / 设置.
//
// Run:  node frontend/console/regress/pages.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const NOW = Date.now() / 1000;
const ROUND = Math.floor(NOW / 300) * 300;
const config = { assetId: "btc", shares: 5, thresholdBp: 2, windowMs: 250, limitPremium: 0.03, fromSec: 15, toSec: 265, maxAsk: 0.8,
  leadVenues: ["bybit", "binance", "okx"], tokyoRelay: true, openBandBp: 5, openLine: "mean60", maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5,
  roundBudgetUsd: null, totalBudgetUsd: null, dailyLossUsd: 40, durationMinutes: 0, maxRounds: 0, mode: "live" };
const side = (bid, ask) => ({ bid, ask, bidSize: 100, askSize: 50, bids: [[bid, 100]], asks: [[ask, 50]] });
const REPLIES = {
  "/api/runtime/status": { processRunning: true, status: "running", commandStatus: "confirmed", runId: "r1", configRevision: 4, startedAt: ROUND - 890,
    risk: { dailyPnlUsd: -12.5 }, leadVenues: ["bybit"], leadRelay: true,
    leadLines: { venues: { bybit: { direct: { delivered: 5, lastAt: NOW * 1000 - 500 }, tokyo: { delivered: 15, lastAt: NOW * 1000 - 300, leadMeanMs: 6 } } }, relay: { listening: true, port: 9555 } },
    leadSignals: [{ round_id: String(ROUND), received_at: NOW - 3, venue: "bybit", line: "tokyo", direction: "UP", move_bp: 2.3, outcome: "skipped", reason: "卖价 0.86 高于上限 0.80" }],
    currentRound: { marketId: "0xm", roundId: String(ROUND), startsAt: ROUND, endsAt: ROUND + 300, status: "running", reason: "等待信号", config } },
  "/api/runtime/book": { running: true, available: true, stale: false, ageMs: 900, twoSided: true, up: side(0.51, 0.53), down: side(0.46, 0.48) },
  "/api/strategy/config": { strategyId: "binance-lead", config, savedRevision: 4, savedAt: NOW - 3600, activeRevision: 4 },
  "/api/account/snapshot": { asOf: NOW, stale: false, collateral: { available: true, value: 321.5 }, occupancy: { available: true, balance_after_open_buy_notional: 300.25 },
    positions: { available: true, items: [{ title: "BTC Up or Down", outcome: "Up", size: 5, avgPrice: 0.5, curPrice: 1, currentValue: 5, redeemable: true }] },
    open_orders: { available: true, items: [] } },
  "/api/account/status": { wallet: "0x1234567890abcdef1234567890abcdef12345678", account_check_state: "ready", last_check_at: NOW - 60,
    last_check: { approvals_ready: true, signer_matches: true }, execution_credentials_ready: true, settlement_credentials_ready: true, server_live_enabled: true },
  "/api/diagnostics/health": { status: "ok", nodeLabel: "爱尔兰", resources: { cpu: { percent: 12, cores: 4 }, memory: { used_bytes: 2e9, total_bytes: 4e9, percent: 50 }, disk: { used_bytes: 1e10, total_bytes: 4e10, percent: 25 } },
    services: { engine: { running: true, process: { state: "running", pid: 42 } }, accountBridge: { stale: false }, projection: { state: "ready", stale: false } },
    leadFeed: { running: true, relayConfigured: true, lines: { bybit: { direct: { lastTradeAgeSeconds: 0.5, delivered: 5 } } }, relayListener: { listening: true, port: 9555, accepted: 3 } } },
  "/api/events": { available: true, items: [{ kind: "error", code: "market_feed_unhealthy", message: "行情断开", time: NOW - 10 }, { kind: "platform_status", message: "running", time: NOW - 20 }] },
  "/api/stats/lead": { available: true, run_count: 1, to: NOW, funnel: { signals: 3, signals_in_window: 3, orders: 1, filled: 1, fill_rate: 1, settled: 0, won: 0, win_rate: null, pnl_usd: null, fees_usd: 0.07 } },
  "/api/orders/lead": { available: true, items: [{ round_id: String(ROUND), open_line: "mean60", open_value: 98000.5, band_bp: 1.25 }], next_before: null },
  "/api/rounds/": { available: true, attempt: { direction: "UP", price: 0.56, askAtSignal: 0.53, shares: 5, filledShares: 5, status: "FILLED", venue: "bybit", line: "tokyo", moveBp: 2.1, signalAt: NOW - 30 },
    yesShares: 5, noShares: 0, averagePrice: 0.54, occupiedUsd: 2.77, outcomePnl: { yes: 2.23, no: -2.77 }, orders: [] },
};

function boot(script) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) {
      nodes.set(selector, { selector, innerHTML: "", textContent: "", value: "", checked: false, hidden: false, disabled: false, dataset: {}, handlers: {},
        classList: { toggle() {}, add() {}, remove() {} }, addEventListener(type, fn) { this.handlers[type] = fn; },
        querySelector: (s) => node(s), querySelectorAll: (s) => s === "[data-range]" ? ["run", "today", "7d", "all"].map((key) => ({ ...node(`[data-range="${key}"]`), dataset: { range: key } })) : [] });
    }
    return nodes.get(selector);
  };
  const requests = [];
  const errors = [];
  const window = { location: { search: "", href: `http://x/${script}` }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    URLSearchParams, URL, AbortController, console, confirm: () => false,
    document: { hidden: false, addEventListener() {}, querySelector: (s) => node(s) } };
  window.fetch = async (url) => {
    const path = String(url);
    requests.push(path);
    const key = Object.keys(REPLIES).find((prefix) => path.startsWith(prefix));
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(REPLIES[key] || { available: false })) };
  };
  window.window = window;
  const context = vm.createContext(window);
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (error) => errors.push(error));
  for (const file of ["shared/preview-core.js", script]) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  return { node, requests, errors, html: () => [...nodes.values()].map((n) => `${n.innerHTML} ${n.textContent}`).join("\n") };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

// --- 实盘 ---
{
  const page = boot("live.js");
  await wait(50);
  assert.deepEqual(page.errors, []);
  const nav = text(page.node("#app").innerHTML);
  assert.ok(/实盘 .*统计 .*历史 .*设置/.test(nav), nav.slice(0, 200));
  assert.ok(!/市场|策略页|运行池|控制密码/.test(page.node("#app").innerHTML), "no removed pages or features in the shell");
  for (const path of ["/api/runtime/status", "/api/runtime/book", `/api/rounds/${ROUND}/position?marketId=0xm`, `/api/rounds/${ROUND}/orders?marketId=0xm&limit=10`,
    "/api/strategy/config", "/api/account/snapshot", "/api/stats/lead?range=today", "/api/stats/lead?range=run", "/api/orders/lead?range=run&limit=20"]) {
    assert.ok(page.requests.includes(path), `实盘 reads ${path}: ${page.requests}`);
  }
  const shown = text(page.html());
  for (const piece of ["运行中", "本次第 3 场 / 不限场数", "已发布 r4", "离每日止损还剩", "$27.50", "$300.25", "1 / 1",
    "东京先到 75.0% · 平均早 6 ms", "0.53", "0.48", "0.9 秒前的盘口", "卖价 0.86 高于上限 0.80", "开盘前 60 秒均价）98000.50", "1.3 bp",
    "全部买到", "如果涨 +$2.23", "一场最多一笔"]) {
    assert.ok(shown.includes(piece), `实盘 shows ${piece}: ${shown.slice(0, 600)}`);
  }
}
// --- 统计 ---
{
  const page = boot("stats.js");
  await wait(50);
  assert.deepEqual(page.errors, []);
  assert.ok(page.requests.includes("/api/stats/lead?range=run"));
  assert.ok(text(page.node('[data-part="funnel"]').innerHTML).includes("下单 1"));
  page.node('[data-range="7d"]').handlers.click?.();
}
// --- 设置 ---
{
  const page = boot("settings.js");
  await wait(50);
  assert.deepEqual(page.errors, []);
  for (const path of ["/api/strategy/config", "/api/account/status", "/api/account/snapshot", "/api/diagnostics/health", "/api/events?limit=200"]) {
    assert.ok(page.requests.includes(path), `设置 reads ${path}`);
  }
  assert.equal(page.node('[data-field="shares"]').value, "5", "the form shows the published shares");
  assert.equal(page.node('[data-field="openLine"]').value, "mean60");
  assert.equal(page.node('[data-field="roundBudgetUsd"]').value, "", "null budget is empty");
  assert.equal(page.node('[data-venue="okx"]').checked, true);
  const shown = text(page.html());
  for (const piece of ["0x1234…5678", "检查通过", "已授权", "可赎回", "账户密钥只在服务器上配置，网页不输入、不显示", "一切正常", "监听中", "行情断开", "已发布 r4"]) {
    assert.ok(shown.includes(piece), `设置 shows ${piece}`);
  }
  assert.ok(!/type="password"|私钥输入|控制密码/.test(page.node("#app").innerHTML), "no credential or password inputs");
}
console.log("pages OK");
process.exit(0);
