// The strategy page edits binance-lead's config, on the real page modules in a
// vm with a stub DOM and a stub server that stores what is saved:
// - the form shows the published values (份额, 阈值 bp, 窗口 ms, 限价加价 and
//   卖价上限 in cents, 开盘后起止秒, 挂单秒数, 预算/日亏损上限, 运行场次);
// - an edit is saved -> read back -> the form shows exactly the saved values,
//   and the draft body carries exactly binance-lead's fields (no reversal ones);
// - nothing published yet (revision 0): the defaults are shown and editable,
//   so the first binance-lead config can be saved and published;
// - out-of-range input is refused before anything is sent.
//
// Run:  node frontend/console/regress/lead-form.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const FIELDS = ["assetId", "shares", "thresholdBp", "windowMs", "limitPremium", "fromSec", "toSec", "maxAsk", "makerHoldSec",
  "maxQuoteAgeSeconds", "maxQuoteSkewSeconds", "roundBudgetUsd", "totalBudgetUsd", "dailyLossUsd",
  "durationMinutes", "maxRounds", "mode"];
const DEFAULTS = { assetId: "btc", shares: 5, thresholdBp: 2, windowMs: 250, limitPremium: 0.03, fromSec: 15, toSec: 265,
  maxAsk: 0.8, makerHoldSec: 0, maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5, roundBudgetUsd: null, totalBudgetUsd: null, dailyLossUsd: null,
  durationMinutes: 0, maxRounds: 0, mode: "live" };
const INPUTS = { shares: "[data-lead=\"shares\"]", thresholdBp: "[data-lead=\"thresholdBp\"]", windowMs: "[data-lead=\"windowMs\"]",
  limitCents: "[data-lead=\"limitPremium\"]", fromSec: "[data-lead=\"fromSec\"]", toSec: "[data-lead=\"toSec\"]",
  maxAskCents: "[data-lead=\"maxAsk\"]", makerHoldSec: "[data-lead=\"makerHoldSec\"]",
  roundBudget: '[data-runtime-field="roundBudget"]', totalBudget: '[data-runtime-field="totalBudget"]',
  lossLimit: '[data-runtime-field="lossLimit"]', rounds: '[data-runtime-field="rounds"]' };

function page(server) {
  const handlers = new Map(), values = new Map(), written = new Map(), nodes = new Map();
  const element = (selector) => new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, hasAttribute: () => false, getAttribute: () => null, toggleAttribute() {},
    addEventListener(type, fn) { if (selector) handlers.set(`${type}:${selector}`, fn); }, focus() {},
    closest: () => element(), insertAdjacentHTML() {}, appendChild() {}, remove() {}, children: [], disabled: false }, {
    get: (target, key) => key === "textContent" ? written.get(selector) ?? "" : key === "innerHTML" ? ""
      : key === "value" ? values.get(selector) ?? "" : key === "querySelector" ? lookup
      : key === "querySelectorAll" ? (s) => s.includes("[data-lead]") || s.includes("[data-runtime-field]")
        ? Object.values(INPUTS).map(lookup) : [] : key in target ? target[key] : undefined,
    set: (target, key, value) => {
      if (key === "textContent" && selector) written.set(selector, String(value));
      else if (key === "value" && selector) values.set(selector, String(value));
      else target[key] = value;
      return true;
    } });
  const lookup = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element(selector)); return nodes.get(selector); };
  const window = { location: { search: "", origin: "http://x", href: "http://x/strategy.html", pathname: "/strategy.html" },
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval, console, URLSearchParams, URL,
    AbortController, history: { replaceState() {} }, navigator: {}, HTMLElement: function () {},
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0), matchMedia: () => ({ matches: false, addEventListener() {} }) };
  window.fetch = async (url, options = {}) => {
    const body = server(String(url), options.body ? JSON.parse(options.body) : null);
    return { ok: !body.__status, status: body.__status || 200, json: async () => body };
  };
  window.document = { hidden: false, visibilityState: "visible", readyState: "complete", addEventListener() {}, body: element(),
    createElement: () => ({ content: { firstElementChild: element() } }), querySelector: lookup, querySelectorAll: () => [] };
  const context = vm.createContext(window); window.window = window; window.self = window;
  for (const file of ["shared/preview-core.js", "shared/view-model.js", "shared/preview-store.js", "shared/api-adapter.js", "strategy-block.js"]) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  const type = (name, value) => { values.set(INPUTS[name], String(value)); handlers.get(`input:${INPUTS[name]}`)?.(); };
  const click = async (selector) => { await handlers.get(`click:${selector}`)(); await wait(30); };
  const read = (name) => values.get(INPUTS[name]) ?? "";
  return { window, type, click, read, written, lookup };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now() / 1000;

// A control plane that keeps what is saved and published.
function controlPlane(published, revision) {
  const state = { published, revision, draft: null, drafts: [] };
  const handler = (url, body) => {
    if (url.includes("/api/strategy/config")) return { schemaVersion: 1, source: "control-plane", asOf: now(), stale: false, error: null,
      strategyId: "binance-lead", savedRevision: state.revision, revision: state.revision, config: state.published, draft: state.draft };
    if (url.includes("/api/strategy/drafts")) {
      state.drafts.push(body);
      state.draft = { schemaVersion: 1, strategyId: "binance-lead", draftId: `d${state.drafts.length}`,
        expectedRevision: body.expectedRevision, savedAt: now(), config: body.config };
      return { accepted: true, ...state.draft };
    }
    if (url.includes("/api/strategy/activate")) {
      state.published = state.draft.config; state.revision += 1; state.draft = null;
      return { accepted: true, strategyId: "binance-lead", revision: state.revision, savedRevision: state.revision };
    }
    if (url.includes("/api/runtime/status")) return { schemaVersion: 1, asOf: now(), stale: false, risk: { dailyLossStatus: "disabled" } };
    return { schemaVersion: 1, asOf: now(), stale: false, items: [] };
  };
  return { state, handler };
}

// ---------- published config is shown, edited, saved, published, read back ----------
{
  const plane = controlPlane({ ...DEFAULTS, roundBudgetUsd: 5, dailyLossUsd: 10, maxRounds: 3 }, 4);
  const ui = page(plane.handler);
  await wait(300);
  assert.equal(ui.read("shares"), "5");
  assert.equal(ui.read("thresholdBp"), "2");
  assert.equal(ui.read("windowMs"), "250");
  assert.equal(ui.read("limitCents"), "3", "the limit premium is shown in cents");
  assert.equal(ui.read("fromSec"), "15");
  assert.equal(ui.read("toSec"), "265");
  assert.equal(ui.read("maxAskCents"), "80", "the ask cap is shown in cents");
  assert.equal(ui.read("makerHoldSec"), "0", "0 = the FAK rule");
  assert.equal(ui.read("roundBudget"), "5");
  assert.equal(ui.read("totalBudget"), "", "unset stays empty");
  assert.equal(ui.read("lossLimit"), "10");
  assert.equal(ui.read("rounds"), "3");
  assert.equal(ui.lookup("[data-save]").disabled, false);

  ui.type("shares", 7); ui.type("thresholdBp", 2.5); ui.type("windowMs", 300); ui.type("limitCents", 2);
  ui.type("fromSec", 20); ui.type("toSec", 260); ui.type("totalBudget", 50); ui.type("rounds", 12);
  // 卖价上限 out of range is refused before anything is sent.
  for (const bad of [0, 100, -5, 120, ""]) {
    ui.type("maxAskCents", bad);
    await ui.click("[data-save]");
    assert.equal(plane.state.drafts.length, 0, `卖价上限 ${JSON.stringify(bad)} ¢ is not sent`);
    assert.ok([...ui.written.values()].some((text) => text.includes("卖价上限")), "and the page says which field");
  }
  ui.type("maxAskCents", 75);
  // 挂单秒数 out of range is refused too.
  for (const bad of [-1, 301, ""]) {
    ui.type("makerHoldSec", bad);
    await ui.click("[data-save]");
    assert.equal(plane.state.drafts.length, 0, `挂单秒数 ${JSON.stringify(bad)} is not sent`);
    assert.ok([...ui.written.values()].some((text) => text.includes("挂单秒数")), "and the page says which field");
  }
  ui.type("makerHoldSec", 3);
  await ui.click("[data-save]");
  const sent = plane.state.drafts.at(-1);
  assert.ok(sent, "a draft is sent");
  assert.equal(plane.state.drafts.length, 1);
  assert.equal(sent.strategyId, "binance-lead");
  assert.equal(sent.expectedRevision, 4);
  assert.deepEqual(Object.keys(sent.config).sort(), [...FIELDS].sort(), "exactly binance-lead's fields");
  assert.deepEqual(sent.config, { ...DEFAULTS, shares: 7, thresholdBp: 2.5, windowMs: 300, limitPremium: 0.02, fromSec: 20, toSec: 260,
    maxAsk: 0.75, makerHoldSec: 3, roundBudgetUsd: 5, totalBudgetUsd: 50, dailyLossUsd: 10, maxRounds: 12 });
  assert.equal(ui.lookup("[data-activate]").disabled, false, "the saved draft can be published");
  await ui.click("[data-activate]");
  assert.equal(plane.state.revision, 5, "published");

  // A fresh page reads the published revision back.
  const again = page(plane.handler);
  await wait(300);
  assert.deepEqual(["shares", "thresholdBp", "windowMs", "limitCents", "fromSec", "toSec", "maxAskCents", "makerHoldSec", "roundBudget", "totalBudget",
    "lossLimit", "rounds"].map(again.read), ["7", "2.5", "300", "2", "20", "260", "75", "3", "5", "50", "10", "12"], "read back exactly as saved");
  assert.equal(plane.state.published.maxAsk, 0.75, "the published config carries the cap");
  assert.equal(plane.state.published.makerHoldSec, 3, "and the maker hold");
  assert.ok(![...again.written.values()].some((text) => /反转|阶段|确认价|触发价/.test(text)), "no reversal wording on the page");
}

// ---------- nothing published (the server only ever had btc-reversal) ----------
{
  const plane = controlPlane(DEFAULTS, 0);
  const ui = page(plane.handler);
  await wait(300);
  assert.equal(ui.read("shares"), "5", "the defaults are shown");
  assert.equal(ui.read("limitCents"), "3");
  assert.equal(ui.read("maxAskCents"), "80", "the default cap 0.80 is shown as 80 ¢");
  assert.equal(ui.lookup("[data-save]").disabled, false, "the first binance-lead config can be saved");
  assert.ok([...ui.written.values()].some((text) => text.includes("还没有发布过币安领先参数")), "the page says a publish is needed");
  ui.type("toSec", 301);
  await ui.click("[data-save]");
  assert.equal(plane.state.drafts.length, 0, "an out-of-range value is refused before sending");
  assert.ok([...ui.written.values()].some((text) => text.includes("截止秒")), "and the page says which field");
  ui.type("toSec", 265); ui.type("thresholdBp", 0);
  await ui.click("[data-save]");
  assert.equal(plane.state.drafts.length, 0, "a zero threshold is refused");
  ui.type("thresholdBp", 2);
  await ui.click("[data-save]");
  assert.equal(plane.state.drafts.length, 1);
  assert.equal(plane.state.drafts[0].expectedRevision, 0);
  assert.equal(plane.state.drafts[0].config.maxAsk, 0.8, "the untouched default goes out as 0.80");
  assert.equal(plane.state.drafts[0].config.makerHoldSec, 0, "and the FAK rule");
  await ui.click("[data-activate]");
  assert.equal(plane.state.revision, 1, "the first binance-lead revision is published");
}
console.log("lead-form OK");
process.exit(0);
