// BUGS P2-18: no page could change the strategy coin. Editing required the
// published config to already target the selected coin, so opening the
// strategy page for ETH while BTC was published disabled every input.
// Now: editable, warns about the switch, and saving submits the selected coin.
//
// Run:  node frontend/console/regress/P2-18.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const now = () => Date.now() / 1000;
const config = { assetId: "btc", triggerPrice: 0.67, confirmationPrice: 0.7, maxBuyPrice: 0.7, stageShares: [5], maxStages: 1,
  roundBudgetUsd: 5, totalBudgetUsd: 10, dailyLossUsd: 10, durationMinutes: 0, maxRounds: 3, mode: "live",
  maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 };
const posted = [];
const handlers = new Map();
const written = new Map(), inputs = [];
const element = (selector) => {
  const node = new Proxy({ dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, hasAttribute: () => false, getAttribute: () => null,
    addEventListener(type, fn) { if (type === "click" && selector) handlers.set(selector, fn); }, focus() {},
    closest: () => element(), insertAdjacentHTML() {}, appendChild() {}, remove() {}, children: [], value: "", disabled: false }, {
    get: (t, k) => k === "textContent" ? written.get(selector) ?? "" : k === "innerHTML" ? "" : k === "querySelector" ? lookup
      : k === "value" && selector in formValues ? formValues[selector] : k === "value" && selector === "stage0" ? "5"
      : k === "querySelectorAll" ? (s) => s.includes("[data-field]") ? inputs : s.includes("[data-stage]") ? [stage] : [] : k in t ? t[k] : undefined,
    set: (t, k, v) => { if (k === "textContent" && selector) written.set(selector, String(v)); else t[k] = v; return true; } });
  return node;
};
for (let i = 0; i < 4; i += 1) inputs.push(element(`input${i}`));
const nodes = new Map();
const lookup = (s) => { if (!nodes.has(s)) nodes.set(s, element(s)); return nodes.get(s); };
// A filled-in form, as the operator would leave it.
const formValues = { '[data-field="trigger"]': "67", '[data-field="confirm"]': "70", '[data-field="maxPrice"]': "70",
  "[data-stage-count]": "1", "[data-max-stages]": "1", '[data-runtime-field="roundBudget"]': "5",
  '[data-runtime-field="totalBudget"]': "10", '[data-runtime-field="lossLimit"]': "10", '[data-runtime-field="rounds"]': "3" };
const stage = element("stage0");
const window = { location: { search: "?assetId=eth", origin: "http://x", href: "http://x/strategy.html?assetId=eth", pathname: "/strategy.html" },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval, console, URLSearchParams, URL,
  AbortController, history: { replaceState() {} }, navigator: {}, HTMLElement: function () {},
  localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0), matchMedia: () => ({ matches: false, addEventListener() {} }) };
window.fetch = async (url, options = {}) => {
  if (options.method === "POST") posted.push({ url: String(url), body: JSON.parse(options.body) });
  const body = String(url).includes("/api/strategy/config")
    ? { schemaVersion: 1, source: "control-plane", asOf: now(), stale: false, error: null, strategyId: "btc-reversal", savedRevision: 22, revision: 22, config, draft: null }
    : String(url).includes("/api/strategy/drafts") ? { accepted: true, draftId: "d1", expectedRevision: 22, config: { ...config, assetId: "eth" } }
    : { schemaVersion: 1, asOf: now(), stale: false, items: [] };
  return { ok: true, status: 200, json: async () => body };
};
window.document = { hidden: false, visibilityState: "visible", readyState: "complete", addEventListener() {}, body: element(),
  createElement: () => ({ content: { firstElementChild: element() } }), querySelector: lookup, querySelectorAll: () => [] };
const context = vm.createContext(window); window.window = window; window.self = window;
for (const f of ["shared/preview-core.js", "shared/view-model.js", "shared/preview-store.js", "shared/api-adapter.js", "strategy-block.js"]) {
  vm.runInContext(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), context, { filename: f });
}
await new Promise((r) => setTimeout(r, 400));
assert.equal(lookup("[data-save]").disabled, false, "saving is allowed for a different coin");
assert.ok(inputs.every((input) => input.disabled === false), "inputs are editable");
// BUGS F1: arriving with ?assetId=eth must not retarget a save by itself.
const clicks = new Map();
const offer = [...written.values()].find((value) => value.includes("先点「切换为 ETH」")) || "";
assert.ok(offer, "the page offers the switch instead of assuming it");
assert.equal(lookup("[data-switch-asset]").hidden, false, "the switch button is shown");
const saveHandler = handlers.get("[data-save]"), switchHandler = handlers.get("[data-switch-asset]");
await saveHandler();
await new Promise((r) => setTimeout(r, 50));
assert.equal(posted.at(-1)?.body?.config?.assetId, "btc", "F1: a plain save keeps the published coin");
// P2-18: after the explicit switch, saving submits the new coin.
switchHandler();
await saveHandler();
await new Promise((r) => setTimeout(r, 50));
assert.equal(posted.at(-1)?.body?.config?.assetId, "eth", "P2-18: after 切换为 ETH the draft submits ETH");
console.log("P2-18 OK");
process.exit(0);
