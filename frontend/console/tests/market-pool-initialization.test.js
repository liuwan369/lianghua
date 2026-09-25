"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const calls = [];
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const window = global.window = {
  __POLY_PREVIEW_CONFIG__: { apiBase: "", apiFlavor: "contract", selectedAssetId: null, streams: {} },
  location: { search: "", href: "https://console.test/market.html", protocol: "https:", origin: "https://console.test" },
  history: { replaceState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  setTimeout,
  clearTimeout
};
global.document = {};
global.fetch = async (_url, options = {}) => {
  calls.push(options);
  if (options.method === "PUT") return response({ available: true, desiredIds: ["btc"], currentIds: [], nextRoundIds: [], effectiveRoundId: null });
  return response({ available: false, desiredIds: [], currentIds: [], nextRoundIds: [], effectiveRoundId: null, stale: true, error: "market_pool_unavailable" });
};

const load = (file) => vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
const root = require("path").resolve(__dirname, "..");
const autoTradeSource = fs.readFileSync(`${root}/auto-trade-block.js`, "utf8");
const overviewSource = fs.readFileSync(`${root}/overview-block.js`, "utf8");
assert.ok(!autoTradeSource.includes("asset?.strategyEligible !== true"), "auto-trade start gate does not require collector strategyEligible");
assert.ok(!overviewSource.includes("item.strategyEligible !== true"), "overview start gate does not require collector strategyEligible");
load(`${root}/shared/preview-core.js`);
global.PolyPreview = window.PolyPreview;
load(`${root}/shared/view-model.js`);
load(`${root}/shared/preview-store.js`);
load(`${root}/shared/api-adapter.js`);

const normalizedDepth = window.PolyPreviewViewModel.market({
  assetId: "btc",
  supported: true,
  up_bid_levels: [[0.48, 10], [0.47, 9], [0.46, 8], [0.45, 7], [0.44, 6]],
  up_ask_levels: [[0.49, 8], [0.50, 9], [0.51, 10], [0.52, 11], [0.53, 12]],
  down_bid_levels: [[0.51, 9], [0.50, 8], [0.49, 7], [0.48, 6], [0.47, 5]],
  down_ask_levels: [[0.52, 11], [0.53, 12], [0.54, 13], [0.55, 14], [0.56, 15]]
});
assert.strictEqual(normalizedDepth.orderBook.yes.bids.length, 5, "snake_case up bid levels normalize to YES depth");
assert.strictEqual(normalizedDepth.orderBook.no.asks.length, 5, "snake_case down ask levels normalize to NO depth");

const store = window.PolyPreviewStore;
const adapter = window.PolyPreviewAdapter;
store.setMarketCatalog({ items: [{ assetId: "btc", symbol: "BTC", name: "BTC", cycle: "5m", canEnable: true, supported: true, marketId: "market-btc", roundId: "round-btc", yesBid: 0.4, noBid: 0.6 }] });

(async () => {
  await adapter.loadMarketPool();
  assert.strictEqual(store.canInitializeMarketPool(store.getState().marketPool), true, "explicit empty-pool response enables first initialization");
  await adapter.saveMarketPool({ desiredIds: ["btc"] });
  assert.strictEqual(calls.filter((call) => call.method === "PUT").length, 1, "first initialization sends exactly one PUT");
  assert.strictEqual(calls[1].credentials, "same-origin", "first PUT keeps same-origin control-session credentials");
  assert.strictEqual(store.getState().marketPool.initialUnavailable, false, "successful PUT clears initialization marker");

  store.setSlice("marketPool", { desiredIds: [], currentIds: [], nextRoundIds: [], receivedAt: 0, status: "unavailable", stale: true, initialUnavailable: true, error: "market_pool_unavailable" });
  global.fetch = async () => { throw new Error("network down"); };
  await adapter.loadMarketPool();
  assert.strictEqual(store.canInitializeMarketPool(store.getState().marketPool), false, "network error cannot open initialization");

  store.setSlice("marketPool", { desiredIds: [], currentIds: [], nextRoundIds: [], receivedAt: 0, status: "unavailable", stale: true, initialUnavailable: true, error: "market_pool_unavailable" });
  global.fetch = async (_url, options = {}) => options.method === "PUT" ? response({ error: "control session required" }, 401) : response({});
  await assert.rejects(() => adapter.saveMarketPool({ desiredIds: ["btc"] }), /control session required/);
  assert.strictEqual(store.getState().marketPool.initialUnavailable, false, "authentication failure closes the one-shot initialization gate");

  store.setSlice("marketPool", { desiredIds: ["btc"], currentIds: [], nextRoundIds: [], receivedAt: 1, status: "stale", stale: true, initialUnavailable: false, error: "runtime_snapshot_stale" });
  const callsBeforeStale = calls.length;
  await assert.rejects(() => adapter.saveMarketPool({ desiredIds: ["btc"] }), /最近确认状态不可用/);
  assert.strictEqual(calls.length, callsBeforeStale, "existing stale pool cannot write");

  store.setSlice("marketPool", { desiredIds: [], currentIds: [], nextRoundIds: [], receivedAt: 0, status: "unavailable", stale: true, initialUnavailable: true, error: "market_pool_unavailable" });
  store.setMarketCatalog({ items: [{ assetId: "btc", symbol: "BTC", name: "BTC", cycle: "5m", canEnable: false, supported: false, marketId: null, roundId: null }] });
  const callsBeforeUnsupported = calls.length;
  await assert.rejects(() => adapter.saveMarketPool({ desiredIds: ["btc"] }), /缺少新鲜目录中的服务器运行资格或 marketId \+ roundId/);
  assert.strictEqual(calls.length, callsBeforeUnsupported, "unsupported or incomplete asset cannot initialize pool");

  console.log("market-pool-initialization: PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
