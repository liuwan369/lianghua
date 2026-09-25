"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

class FakeNode {
  constructor(selector = "") {
    this.selector = selector;
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
    this.title = "";
    this.dataset = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.children = [];
  }
  addEventListener() {}
  setAttribute() {}
  remove() {}
  replaceWith() {}
  querySelector(selector) { return new FakeNode(selector); }
  querySelectorAll() { return []; }
}

class FakeRow extends FakeNode {
  constructor() {
    super("[data-coin-row]");
    this.dataset = { coinRow: "btc" };
    this.nextElementSibling = null;
    this.button = new FakeNode("[data-enable-coin]");
    this.button.dataset = { enableCoin: "btc" };
    this.quotes = [new FakeNode(), new FakeNode()];
  }
  querySelector(selector) {
    if (selector === "[data-enable-coin]") return this.button;
    if (selector === "[data-enable-coin] span") return new FakeNode(selector);
    if (selector === ".coin-volume strong" || selector === ".coin-market-meta span") return new FakeNode(selector);
    return new FakeNode(selector);
  }
  querySelectorAll(selector) { return selector === ".coin-quotes b" ? this.quotes : []; }
}

const nodes = new Map();
const root = new FakeNode("#market-block-root");
const list = new FakeNode("[data-coin-list]");
list.querySelectorAll = () => [];
list.insertBefore = () => {};
nodes.set("#market-block-root", root);
nodes.set("[data-coin-list]", list);
nodes.set("[data-detail-enable]", new FakeNode("[data-detail-enable]"));
const document = global.document = {
  hidden: false,
  querySelector(selector) { return nodes.get(selector) || new FakeNode(selector); },
  querySelectorAll() { return []; },
  createElement(type) {
    if (type !== "template") return new FakeNode(type);
    const template = new FakeNode(type);
    template.content = { firstElementChild: new FakeRow() };
    Object.defineProperty(template, "innerHTML", { set() {} });
    return template;
  },
  addEventListener() {}
};

const window = global.window = {
  __POLY_PREVIEW_CONFIG__: { apiBase: "", apiFlavor: "contract", selectedAssetId: "btc", streams: {} },
  location: { search: "?assetId=btc", href: "https://console.test/market.html?assetId=btc" },
  history: { replaceState() {} },
  setTimeout: () => 1,
  clearTimeout() {}
};
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
const load = (file) => vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
const rootPath = require("path").resolve(__dirname, "..");
const autoTradeSource = fs.readFileSync(`${rootPath}/auto-trade-block.js`, "utf8");
assert.ok(autoTradeSource.includes("strategyAssetId"), "auto-trade start reads the active strategy asset");
assert.ok(autoTradeSource.includes("激活策略与所选市场不一致"), "auto-trade blocks strategy/market asset mismatch");
load(`${rootPath}/shared/preview-core.js`);
load(`${rootPath}/shared/view-model.js`);
load(`${rootPath}/shared/preview-store.js`);
const store = window.PolyPreviewStore;
window.PolyPreviewAdapter = {
  async loadMarkets() { return store.getState().marketCatalog; },
  async loadMarketPool() { return store.getState().marketPool; },
  async saveMarketPool() { return { accepted: true, status: "ready" }; }
};
store.setMarketCatalog({ items: [{ assetId: "btc", symbol: "BTC", name: "Bitcoin", supported: true, canEnable: true, marketId: "m-btc", roundId: "r-btc", cycle: "5m", yesBid: 0.4, noBid: 0.6 }] });
store.setSlice("marketPool", { desiredIds: ["btc", "eth"], currentIds: [], nextRoundIds: [], status: "ready", stale: false, receivedAt: 1, initialUnavailable: false });

assert.doesNotThrow(() => load(`${rootPath}/market-block.js`), "market directory and detail render do not throw");
assert.strictEqual(nodes.get("[data-detail-enable]").disabled, false, "fresh detail remains operable when pool is ready");

const previous = store.getState().marketCatalog.items;
store.setMarketCatalog({
  stale: true,
  partial: true,
  items: [
    { assetId: "btc", symbol: "BTC", supported: true, canEnable: true, marketId: "m-btc", roundId: "r-btc", cycle: "5m", stale: true, yesBid: 0.3, noBid: 0.7 },
    { assetId: "eth", symbol: "ETH", supported: true, canEnable: true, marketId: "m-eth", roundId: "r-eth", cycle: "5m", stale: false, yesBid: 0.2, noBid: 0.8 }
  ]
});
const merged = store.getState().marketCatalog;
assert.strictEqual(merged.status, "partial", "partial catalog remains distinguishable");
assert.strictEqual(merged.items.find((item) => item.assetId === "btc").stale, true, "stale asset stays stale");
assert.strictEqual(merged.items.find((item) => item.assetId === "btc").yesBid, 0.4, "stale asset keeps last successful values");
assert.strictEqual(merged.items.find((item) => item.assetId === "eth").yesBid, 0.2, "healthy sibling updates by assetId");
assert.ok(previous.find((item) => item.assetId === "btc"), "previous catalog remains available for stale asset");
assert.strictEqual(nodes.get("[data-detail-enable]").disabled, true, "stale selected asset cannot be modified");
store.setMarketCatalog({ stale: true, error: "network down", items: [] });
assert.strictEqual(store.getState().marketCatalog.items.find((item) => item.assetId === "eth").yesBid, 0.2, "global catalog failure retains the merged snapshot");
assert.strictEqual(store.getState().marketCatalog.status, "stale", "global catalog failure is marked stale");

console.log("market-render: PASS");
