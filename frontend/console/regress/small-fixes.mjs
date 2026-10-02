// BUGS P3-11, P3-13, P3-16, checked on the real page modules in a vm with a
// stub DOM that records what each selector was set to, and a stub server.
//
// P3-11: the auto-trade header balance came from two sources (account check's
//        gross balance and the snapshot's net), so it flipped between them.
// P3-13: a position answered from fills (live snapshot unavailable) always
//        said "本场已结束" even with minutes left in the round.
// P3-16: the strategy page kept "策略接口断开" after the API recovered with the
//        same revision.
//
// Run:  node frontend/console/regress/small-fixes.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const now = () => Date.now() / 1000;
const roundStart = () => Math.floor(now() / 300) * 300;

function page(files, rootId, reply) {
  const written = new Map();
  const element = (selector) => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelector: () => element(), querySelectorAll: () => [],
    closest: () => element(), insertAdjacentHTML() {}, replaceWith() {}, remove() {}, appendChild() {}, children: [], value: "" }, {
    get: (target, key) => key === "textContent" ? written.get(selector) ?? "" : key === "innerHTML" ? "" : key in target ? target[key] : undefined,
    set: (target, key, value) => { if (key === "textContent" && selector) written.set(selector, String(value)); else target[key] = value; return true; },
  });
  const nodes = new Map();
  const lookup = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element(selector)); return nodes.get(selector); };
  const window = { location: { search: "?assetId=btc", origin: "http://127.0.0.1", href: "http://127.0.0.1/x.html", pathname: "/x.html" },
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval, console, URLSearchParams, URL,
    AbortController, history: { replaceState() {} }, navigator: {}, HTMLElement: function () {}, confirm: () => false,
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0), matchMedia: () => ({ matches: false, addEventListener() {} }) };
  window.fetch = async (url) => { const body = reply(String(url)); return { ok: body.__status ? false : true, status: body.__status || 200, json: async () => body }; };
  window.document = { hidden: false, visibilityState: "visible", readyState: "complete", addEventListener() {}, body: element(),
    createElement: () => ({ content: { firstElementChild: element() } }),
    querySelector: lookup, querySelectorAll: () => [] };
  const context = vm.createContext(window);
  window.window = window; window.self = window;
  for (const file of files) vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  return { written, window };
}
const shared = ["shared/preview-core.js", "shared/view-model.js", "shared/preview-store.js", "shared/api-adapter.js"];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- auto-trade: P3-11 and P3-13 ----------
{
  const market = () => ({ assetId: "btc", symbol: "BTC", supported: true, canEnable: true, cycle: "5m", marketId: "0xm",
    roundId: String(roundStart()), startAt: roundStart(), endAt: roundStart() + 300, current: true,
    yes: { bid: 0.4, ask: 0.41, sourceAt: now(), expiresAt: now() + 2 }, no: { bid: 0.58, ask: 0.59, sourceAt: now(), expiresAt: now() + 2 } });
  const reply = (url) => {
    if (url.includes("/api/markets")) return { schemaVersion: 1, items: [market()], asOf: now(), stale: false };
    if (url.includes("/api/account/status")) return { schemaVersion: 1, asOf: now(), stale: false, account_ready: true,
      last_check: { balance: 213.64 }, collateral: { available: true, value: 213.64 } };
    if (url.includes("/api/account/snapshot")) return { schemaVersion: 1, asOf: now(), stale: false, available: true,
      collateral: { available: true, value: 210.14 }, open_orders: { available: true, items: [] }, positions: { available: true, items: [] },
      occupancy: { available: true, open_buy_notional_usd: 3.5, available_usd: 210.14 }, available_usd: 210.14, balance_usd: 210.14 };
    if (url.includes("/position")) return { schemaVersion: 1, asOf: now(), stale: false, source: "fills",
      roundId: String(roundStart()), marketId: "0xm", assetId: "btc", yesShares: 5, noShares: 0, totalShares: 5 };
    if (url.includes("/api/runtime/status")) return { schemaVersion: 1, asOf: now(), stale: false, status: "stopped", processRunning: false, processRunningFresh: true, markets: [] };
    // P3-12: the only settlement belongs to the previous round, as it always
    // does: a round settles after it ends. The server filters by roundId.
    if (url.includes("/api/settlements")) {
      const prev = String(roundStart() - 300);
      const wantsRound = /[?&]roundId=/.test(url);
      return { schemaVersion: 1, asOf: now(), stale: false, available: true, status: "ready",
        items: wantsRound && !url.includes(`roundId=${prev}`) ? [] : [{ kind: "settlement", assetId: "btc", marketId: "0xprev",
          roundId: prev, state: "confirmed", payoutVerified: true, pnl: 1.62, accountingState: "confirmed" }] };
    }
    return { schemaVersion: 1, asOf: now(), stale: false, items: [] };
  };
  const { written } = page([...shared, "auto-trade-block.js"], "auto-trade-block-root", reply);
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) { await wait(100); seen.add(written.get("[data-auto-account-available]")); }
  seen.delete(undefined);
  assert.ok(![...seen].some((value) => value.startsWith("213.64")), `P3-11: the header never shows the account check's gross balance; saw ${[...seen]}`);
  const settlement = written.get("[data-settlement-state]") || "";
  assert.ok(settlement.includes("最近结算"), `P3-12: the latest settlement is shown with its round; got "${settlement}"`);
  const state = written.get("[data-position-state]") || "";
  assert.ok(!state.includes("本场已结束"), `P3-13: mid-round fills fallback must not say the round ended; got "${state}"`);
}

// ---------- strategy page: P3-16 ----------
{
  let phase = "ok";
  const config = { assetId: "btc", triggerPrice: 0.67, confirmationPrice: 0.7, maxBuyPrice: 0.7, stageShares: [5], maxStages: 1,
    roundBudgetUsd: 5, totalBudgetUsd: 10, dailyLossUsd: 10, durationMinutes: 0, maxRounds: 3, mode: "live",
    maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 };
  const reply = (url) => {
    if (url.includes("/api/strategy/config")) return phase === "down" ? { __status: 503, error: "down" }
      : { schemaVersion: 1, source: "control-plane", asOf: now(), stale: false, error: null, strategyId: "btc-reversal",
        savedRevision: 22, revision: 22, config, draft: null };
    return { schemaVersion: 1, asOf: now(), stale: false, items: [] };
  };
  const { written, window } = page([...shared, "strategy-block.js"], "strategy-block-root", reply);
  await wait(300);
  const adapter = window.PolyPreviewAdapter;
  phase = "down"; await adapter.loadStrategy(); await wait(50);
  const lost = [...written.values()].some((value) => value.includes("策略接口断开"));
  assert.ok(lost, "control: the disconnect is reported");
  phase = "ok"; await adapter.loadStrategy(); await wait(50);
  const stuck = [...written.values()].some((value) => value.includes("策略接口断开"));
  assert.ok(!stuck, "P3-16: after the API recovers the disconnect notice is gone");
}
// ---------- settings run log: BUGS F2 ----------
{
  let runId = "RUN-OLD";
  const asked = [];
  const reply = (url) => {
    if (url.includes("/api/runtime/status")) return { schemaVersion: 1, asOf: now(), stale: false, status: "running", processRunning: true, processRunningFresh: true, runId, markets: [] };
    if (url.includes("/api/events")) { asked.push(new URL(url, "http://x").searchParams.get("runId")); return { schemaVersion: 1, asOf: now(), stale: false, items: [] }; }
    return { schemaVersion: 1, asOf: now(), stale: false, items: [] };
  };
  const { window } = page([...shared, "settings-block.js", "event-log.js"], "settings-block-root", reply);
  await wait(300);
  runId = "RUN-NEW";                        // a new run starts while the page is open
  await new Promise((r) => setTimeout(r, 15500));
  assert.ok(asked.includes("RUN-NEW"), `F2: the run log follows the new run; asked ${[...new Set(asked)]}`);
}
console.log("small-fixes OK");
process.exit(0);
