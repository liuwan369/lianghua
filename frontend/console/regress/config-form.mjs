// 设置 strategy form (settings.js): form inputs -> the draft body.
// - the config carries exactly strategy_config.py's fields (no retired ones:
//   makerHoldSec, leadSource, edge tiers, reverse leg);
// - leadVenues is an array in a fixed order, tokyoRelay a boolean, empty
//   budgets are null, maxRounds/durationMinutes/mode are kept;
// - validation: at least one venue, fromSec < toSec, numbers in range;
// - save = POST /api/strategy/drafts {strategyId, config, expectedRevision},
//   then POST /api/strategy/activate {expectedRevision, draftId}.
//
// Run:  node frontend/console/regress/config-form.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const posted = [];
const window = { location: { search: "", href: "http://x/settings.html" }, setTimeout, clearTimeout, setInterval, clearInterval,
  URLSearchParams, URL, AbortController, console, document: { hidden: false, addEventListener() {}, querySelector: () => null } };
window.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  posted.push({ url: String(url), body });
  const reply = String(url).endsWith("/drafts") ? { accepted: true, draftId: "8f5d0a5e-3c55-4c43-9c43-6a1b2e2d2f10", expectedRevision: body.expectedRevision }
    : { accepted: true, savedRevision: body.expectedRevision + 1 };
  return { ok: true, status: 200, json: async () => reply };
};
window.window = window;
const context = vm.createContext(window);
for (const file of ["shared/preview-core.js", "settings.js"]) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const S = window.PolySettings;

// strategy_config.py default_config() keys.
const SERVER_KEYS = ["assetId", "shares", "thresholdBp", "windowMs", "limitPremium", "fromSec", "toSec", "maxAsk", "leadVenues", "tokyoRelay",
  "openBandBp", "openLine", "restAfterMissSec", "restShadow", "entryOrder", "regimePause", "maxQuoteAgeSeconds", "maxQuoteSkewSeconds", "roundBudgetUsd", "totalBudgetUsd", "dailyLossUsd",
  "durationMinutes", "maxRounds", "mode"].sort();
const published = { assetId: "btc", shares: 5, thresholdBp: 2, windowMs: 250, limitPremium: 0.03, fromSec: 15, toSec: 265, maxAsk: 0.8,
  leadVenues: ["bybit", "binance", "okx"], tokyoRelay: true, openBandBp: 5, openLine: "mean60", restAfterMissSec: 0, restShadow: true, entryOrder: "fak", regimePause: false, maxQuoteAgeSeconds: 2,
  maxQuoteSkewSeconds: 1.5, roundBudgetUsd: null, totalBudgetUsd: 200, dailyLossUsd: 50, durationMinutes: 0, maxRounds: 12, mode: "live" };

// --- the published config round-trips unchanged ---
const inputs = S.inputsFrom(published);
assert.equal(inputs.roundBudgetUsd, "", "null budget shows as empty (不限)");
const same = S.buildConfig(inputs, published);
assert.deepEqual({ ...same.errors }, {});
assert.deepEqual(JSON.parse(JSON.stringify(same.config)), published, "published values come back exactly");
assert.deepEqual(Object.keys(same.config).sort(), SERVER_KEYS, "exactly the server's fields");
for (const retired of ["makerHoldSec", "leadSource", "midEdge", "midShares", "highEdge", "highShares", "reverseMaxAsk", "reverseToSec"]) {
  assert.ok(!(retired in same.config), `no ${retired}`);
}

// --- edits ---
const edited = S.buildConfig({ ...inputs, shares: "10", leadVenues: ["okx", "bybit"], tokyoRelay: false, openLine: "tick",
  dailyLossUsd: "", maxRounds: "3" }, published);
assert.deepEqual({ ...edited.errors }, {});
assert.equal(edited.config.shares, 10);
assert.deepEqual([...edited.config.leadVenues], ["bybit", "okx"], "venues as an array in the fixed order");
assert.equal(edited.config.tokyoRelay, false);
assert.equal(edited.config.openLine, "tick");
assert.equal(edited.config.dailyLossUsd, null, "empty = null");
assert.equal(edited.config.maxRounds, 3);
assert.equal(edited.config.mode, "live");
assert.equal(edited.config.durationMinutes, 0);
// Rest after a miss: seconds 0..30, shadow switch.
const rest = S.buildConfig({ ...inputs, restAfterMissSec: "5", restShadow: false }, published);
assert.deepEqual({ ...rest.errors }, {});
assert.equal(rest.config.restAfterMissSec, 5);
assert.equal(rest.config.restShadow, false);
for (const bad of ["-1", "31", ""]) {
  assert.ok("restAfterMissSec" in S.buildConfig({ ...inputs, restAfterMissSec: bad }, published).errors, `rest ${bad}`);
}
// The first order: FAK (+ rest) or one GTC; a GTC needs seconds > 0.
assert.equal(S.inputsFrom(published).entryOrder, "fak");
assert.equal(S.inputsFrom({ ...published, entryOrder: "gtc" }).entryOrder, "gtc");
const gtc = S.buildConfig({ ...inputs, entryOrder: "gtc", restAfterMissSec: "5" }, published);
assert.deepEqual({ ...gtc.errors }, {});
assert.equal(gtc.config.entryOrder, "gtc");
assert.ok("restAfterMissSec" in S.buildConfig({ ...inputs, entryOrder: "gtc", restAfterMissSec: "0" }, published).errors, "gtc with 0 s");
assert.equal(S.buildConfig({ ...inputs, entryOrder: "ioc" }, published).config.entryOrder, "fak", "anything else is fak");
// The regime pause: off by default, a checkbox.
assert.equal(S.inputsFrom(published).regimePause, false);
assert.equal(S.buildConfig({ ...inputs, regimePause: true }, published).config.regimePause, true);
assert.equal(S.buildConfig({ ...inputs, regimePause: "yes" }, published).config.regimePause, false, "only true turns it on");

// --- validation ---
const errorsOf = (patch) => Object.keys(S.buildConfig({ ...inputs, ...patch }, published).errors).sort();
assert.deepEqual(errorsOf({ leadVenues: [] }), ["leadVenues"], "at least one venue");
assert.deepEqual(errorsOf({ leadVenues: ["kraken"] }), ["leadVenues"], "unknown venues are dropped, so none left");
assert.deepEqual(errorsOf({ fromSec: "200", toSec: "200" }), ["toSec"], "fromSec < toSec");
assert.deepEqual(errorsOf({ fromSec: "250", toSec: "100" }), ["toSec"]);
assert.deepEqual(errorsOf({ toSec: "301" }), ["toSec"]);
assert.deepEqual(errorsOf({ shares: "" }), ["shares"]);
assert.deepEqual(errorsOf({ shares: "abc" }), ["shares"]);
assert.deepEqual(errorsOf({ maxAsk: "1" }), ["maxAsk"]);
assert.deepEqual(errorsOf({ limitPremium: "-0.01" }), ["limitPremium"]);
assert.deepEqual(errorsOf({ totalBudgetUsd: "0" }), ["totalBudgetUsd"]);
assert.deepEqual(errorsOf({ maxRounds: "1.5" }), ["maxRounds"]);
assert.deepEqual(errorsOf({ maxQuoteAgeSeconds: "0" }), ["maxQuoteAgeSeconds"]);
assert.ok(S.buildConfig({ ...inputs, leadVenues: [] }, published).errors.leadVenues.includes("至少"));

// --- save: draft then activate ---
const revision = await S.save(edited.config, 9);
assert.equal(revision, 10);
assert.equal(posted.length, 2);
assert.equal(posted[0].url, "/api/strategy/drafts");
assert.deepEqual(Object.keys(posted[0].body).sort(), ["config", "expectedRevision", "strategyId"]);
assert.equal(posted[0].body.strategyId, "binance-lead");
assert.equal(posted[0].body.expectedRevision, 9);
assert.deepEqual(posted[0].body.config, JSON.parse(JSON.stringify(edited.config)));
assert.equal(posted[1].url, "/api/strategy/activate");
assert.deepEqual(posted[1].body, { strategyId: "binance-lead", expectedRevision: 9, draftId: "8f5d0a5e-3c55-4c43-9c43-6a1b2e2d2f10" });

console.log("config-form OK");
process.exit(0);
