// P1-1: saving the strategy from the console silently cleared maxRounds.
// saveStrategy rebuilt the config from a fixed whitelist that missed maxRounds,
// and the backend filled the gap with 0 = run forever. Live: revision 22 had
// maxRounds=3, the draft saved from the page had 0.
//
// Loads the real shared modules in a vm with a stub fetch and checks the body
// actually sent to /api/strategy/drafts.
//
// Run:  node frontend/console/regress/P1-1.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sent = [];
const window = {
  location: { search: "", origin: "http://127.0.0.1", href: "http://127.0.0.1/strategy.html", pathname: "/strategy.html" },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
};
window.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
  const reply = { accepted: true, draftId: "d1", expectedRevision: 22, config: JSON.parse(init.body || "{}").config };
  return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => reply, text: async () => JSON.stringify(reply) };
};
// In a browser the global object IS window, and the modules use both spellings.
Object.assign(window, { console, URLSearchParams, URL, AbortController,
  document: { addEventListener() {}, visibilityState: "visible", querySelector: () => null, querySelectorAll: () => [] },
  navigator: {}, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} } });
const context = vm.createContext(window);
window.window = window;
window.self = window;
for (const file of ["preview-core.js", "view-model.js", "preview-store.js", "api-adapter.js"]) {
  vm.runInContext(readFileSync(new URL(`../shared/${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const adapter = window.PolyPreviewAdapter;
const form = { strategyId: "binance-lead", assetId: "btc", expectedRevision: 22, shares: 5, thresholdBp: 2, windowMs: 250,
  limitPremium: 0.03, fromSec: 15, toSec: 265, maxAsk: 0.8, makerHoldSec: 0, leadSource: "binance-spot", roundBudgetUsd: 5, totalBudgetUsd: 10, dailyLossUsd: 10,
  durationMinutes: 0, mode: "live", maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 };

// --- bug: "run 3 rounds" reaches the server as 3 ---
await adapter.saveStrategy({ ...form, maxRounds: 3 });
const draft = sent.find((item) => item.url.includes("/api/strategy/drafts"));
assert.ok(draft, "the draft request is sent");
assert.equal(draft.body.config.maxRounds, 3, "maxRounds is part of the saved config");
// --- control: unlimited stays 0 ---
sent.length = 0;
await adapter.saveStrategy({ ...form, maxRounds: 0 });
assert.equal(sent.find((item) => item.url.includes("/api/strategy/drafts")).body.config.maxRounds, 0);
// --- the same whitelist must carry every binance-lead field, and nothing else ---
sent.length = 0;
await adapter.saveStrategy({ ...form, maxRounds: 0, fromSec: 60, toSec: 240, thresholdBp: 3 });
const body = sent.find((item) => item.url.includes("/api/strategy/drafts")).body;
assert.equal(body.strategyId, "binance-lead");
assert.equal(body.config.fromSec, 60, "fromSec is part of the saved config");
assert.equal(body.config.toSec, 240);
assert.equal(body.config.thresholdBp, 3);
assert.equal(body.config.maxAsk, 0.8, "maxAsk is part of the saved config");
assert.deepEqual(Object.keys(body.config).sort(), ["assetId", "dailyLossUsd", "durationMinutes", "fromSec", "leadSource", "limitPremium",
  "makerHoldSec", "maxAsk", "maxQuoteAgeSeconds", "maxQuoteSkewSeconds", "maxRounds", "mode", "roundBudgetUsd", "shares", "thresholdBp", "toSec",
  "totalBudgetUsd", "windowMs"], "exactly binance-lead's fields");
console.log("P1-1 OK");
