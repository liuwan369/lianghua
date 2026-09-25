"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.resolve(__dirname, "..");
global.window = {};
vm.runInThisContext(fs.readFileSync(path.join(root, "shared", "view-model.js"), "utf8"), { filename: "view-model.js" });
const viewModel = window.PolyPreviewViewModel;
const now = Date.now();
const base = {
  assetId: "btc",
  marketId: "market-btc-5m",
  roundId: "round-42",
  sequence: 12,
  sourceAt: now - 250,
  expiresAt: now + 10_000,
  yesBid: 0.42,
  yesAsk: 0.44,
  noBid: 0.56,
  noAsk: 0.58
};

assert.strictEqual(viewModel.hasFreshBbo(base, now), true, "fresh dual-sided BBO is valid without depth");
assert.strictEqual(viewModel.hasFreshBbo({ ...base, sequence: null }, now), false, "missing sequence is invalid");
assert.strictEqual(viewModel.hasFreshBbo({ ...base, sequence: "" }, now), false, "empty sequence is invalid");
assert.strictEqual(viewModel.hasFreshBbo({ ...base, sequence: false }, now), false, "boolean sequence is invalid");
assert.strictEqual(viewModel.hasFreshBbo({ ...base, sequence: -1 }, now), false, "negative sequence is invalid");
assert.strictEqual(viewModel.hasFreshBbo({ ...base, sourceAt: now - 20_000 }, now), false, "old sourceAt is stale");
assert.strictEqual(viewModel.hasFreshBbo({ ...base, expiresAt: now - 1 }, now), false, "expired snapshot is invalid");
assert.strictEqual(viewModel.hasFreshBbo({ ...base, stale: true }, now), false, "server stale marker blocks BBO");
assert.strictEqual(viewModel.matchesIdentity({ ...base, assetId: "eth" }, base), false, "asset identity mismatch is rejected");
assert.strictEqual(viewModel.matchesIdentity(base, base), true, "matching market identity is accepted");

const overviewSource = fs.readFileSync(path.join(root, "overview-block.js"), "utf8");
const autoTradeSource = fs.readFileSync(path.join(root, "auto-trade-block.js"), "utf8");
const adapterSource = fs.readFileSync(path.join(root, "shared", "api-adapter.js"), "utf8");
const previewCoreSource = fs.readFileSync(path.join(root, "shared", "preview-core.js"), "utf8");
assert.match(overviewSource, /hasFreshBbo\(item\)/, "overview start gate uses BBO freshness");
assert.match(autoTradeSource, /vm\.hasFreshBbo\(source, now\)/, "auto-trade render uses BBO freshness");
assert.match(autoTradeSource, /深度暂不可用/, "BBO-only render labels unavailable depth");
assert.match(autoTradeSource, /depthPresent \? "五档深度 · 已接入" : "BBO 已更新 · 深度暂不可用"/, "depth-present and BBO-only states are distinct");
assert.match(previewCoreSource, /context\.cursor\) params\.set\("cursor", context\.cursor\)/, "event pagination cursor is retained with scoped identity");
assert.match(adapterSource, /remoteOrdersState: raw\.remoteOrdersState/, "command result preserves top-level remote order status");
assert.match(autoTradeSource, /var acceptedResult = false;[\s\S]*if \(acceptedResult\) commandCooldownUntil/, "accepted command cooldown survives try scope");

const depth = {
  yes: { bids: Array.from({ length: 5 }, (_, i) => [0.42 - i * 0.001, 10 + i]), asks: Array.from({ length: 5 }, (_, i) => [0.44 + i * 0.001, 9 + i]) },
  no: { bids: Array.from({ length: 5 }, (_, i) => [0.56 - i * 0.001, 8 + i]), asks: Array.from({ length: 5 }, (_, i) => [0.58 + i * 0.001, 7 + i]) }
};
assert.strictEqual(viewModel.market({ ...base, depthAvailable: true, orderBook: depth }).orderBook.yes.bids.length, 5, "real five-level depth remains available to the view model");
const canonical = viewModel.market({ ...base, yesBid: undefined, yesAsk: undefined, noBid: undefined, noAsk: undefined, YES: { assetId: "yes-token", bid: 0.42, ask: 0.44, bids: depth.yes.bids, asks: depth.yes.asks }, NO: { assetId: "no-token", bid: 0.56, ask: 0.58, bids: depth.no.bids, asks: depth.no.asks } });
assert.strictEqual(viewModel.hasFreshBbo({ ...base, yesBid: undefined, yesAsk: undefined, noBid: undefined, noAsk: undefined, YES: { bid: 0.42, ask: 0.44 }, NO: { bid: 0.56, ask: 0.58 } }, now), true, "canonical YES/NO BBO is accepted");
assert.strictEqual(canonical.yesToken, "yes-token", "canonical YES token is preserved");
assert.strictEqual(canonical.orderBook.yes.bids.length, 5, "canonical nested five-level depth is normalized");

console.log("bbo-gate: PASS");
