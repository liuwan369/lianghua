"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
let lastRequestUrl = null;
global.window = {
  __POLY_PREVIEW_CONFIG__: { apiBase: "", apiFlavor: "contract", selectedAssetId: null, streams: {} },
  location: { search: "", href: "https://console.test/auto-trade.html" },
  setTimeout,
  clearTimeout,
  history: { replaceState() {} }
};
global.fetch = async (url) => {
  lastRequestUrl = String(url);
  return { ok: true, status: 200, json: async () => ({ items: [] }) };
};
const load = (file) => vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });

load(path.join(root, "shared", "preview-core.js"));
global.PolyPreview = window.PolyPreview;
load(path.join(root, "shared", "view-model.js"));
load(path.join(root, "shared", "preview-store.js"));
load(path.join(root, "shared", "api-adapter.js"));

(async () => {
  window.PolyPreview.api.runtimeCommand = async () => ({
    accepted: true,
    commandStatus: "accepted",
    serviceState: "stopping",
    remoteOrdersState: "unconfirmed"
  });
  const command = await window.PolyPreviewAdapter.commandRuntime({
    action: "stop",
    assetId: "btc",
    marketIds: ["market-btc"],
    requestId: "adapter-test-request"
  });
  assert.strictEqual(command.accepted, true, "accepted command result is preserved");
  assert.strictEqual(command.commandStatus, "accepted", "top-level commandStatus is preserved");
  assert.strictEqual(command.serviceState, "stopping", "top-level serviceState is preserved");
  assert.strictEqual(command.remoteOrdersState, "unconfirmed", "top-level remoteOrdersState is preserved");

  await window.PolyPreview.api.events("cursor-2", { assetId: "btc", marketId: "market-btc", roundId: "round-2" });
  const url = new URL(lastRequestUrl, "https://console.test");
  assert.strictEqual(url.pathname, "/api/events", "events request uses the contract endpoint");
  assert.strictEqual(url.searchParams.get("assetId"), "btc", "events request is scoped by asset");
  assert.strictEqual(url.searchParams.get("marketId"), "market-btc", "events request is scoped by market");
  assert.strictEqual(url.searchParams.get("roundId"), "round-2", "events request is scoped by round");
  assert.strictEqual(url.searchParams.get("cursor"), "cursor-2", "events cursor is retained");
  console.log("adapter-boundaries: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
