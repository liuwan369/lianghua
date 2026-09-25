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
assert.strictEqual(viewModel.hasFreshBbo({ ...base, sourceAt: now - 20_000 }, now), false, "old sourceAt is stale");
assert.strictEqual(viewModel.hasFreshBbo({ ...base, expiresAt: now - 1 }, now), false, "expired snapshot is invalid");
assert.strictEqual(viewModel.hasFreshBbo({ ...base, stale: true }, now), false, "server stale marker blocks BBO");
assert.strictEqual(viewModel.matchesIdentity({ ...base, assetId: "eth" }, base), false, "asset identity mismatch is rejected");
assert.strictEqual(viewModel.matchesIdentity(base, base), true, "matching market identity is accepted");

const overviewSource = fs.readFileSync(path.join(root, "overview-block.js"), "utf8");
const autoTradeSource = fs.readFileSync(path.join(root, "auto-trade-block.js"), "utf8");
assert.match(overviewSource, /hasFreshBbo\(item\)/, "overview start gate uses BBO freshness");
assert.match(autoTradeSource, /vm\.hasFreshBbo\(source, now\)/, "auto-trade render uses BBO freshness");
assert.match(autoTradeSource, /深度暂不可用/, "BBO-only render labels unavailable depth");
assert.match(autoTradeSource, /depthPresent \? "五档深度 · 已接入" : "BBO 已更新 · 深度暂不可用"/, "depth-present and BBO-only states are distinct");

const depth = {
  yes: { bids: Array.from({ length: 5 }, (_, i) => [0.42 - i * 0.001, 10 + i]), asks: Array.from({ length: 5 }, (_, i) => [0.44 + i * 0.001, 9 + i]) },
  no: { bids: Array.from({ length: 5 }, (_, i) => [0.56 - i * 0.001, 8 + i]), asks: Array.from({ length: 5 }, (_, i) => [0.58 + i * 0.001, 7 + i]) }
};
assert.strictEqual(viewModel.market({ ...base, depthAvailable: true, orderBook: depth }).orderBook.yes.bids.length, 5, "real five-level depth remains available to the view model");

console.log("bbo-gate: PASS");
