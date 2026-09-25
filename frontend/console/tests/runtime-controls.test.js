"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
global.window = {};
vm.runInThisContext(fs.readFileSync(path.join(root, "shared", "view-model.js"), "utf8"), { filename: "view-model.js" });

const model = window.PolyPreviewViewModel;
assert.strictEqual(model.runtime({ processRunning: true, stale: true }).processRunning, true, "stale projections retain an explicit running process fact");
assert.strictEqual(model.runtime({ process_running: false, stale: true }).processRunning, false, "snake_case stopped process fact is normalized");
assert.strictEqual(model.runtime({ status: "running", stale: true }).processRunning, null, "missing process fact remains unknown");

const autoTrade = fs.readFileSync(path.join(root, "auto-trade-block.js"), "utf8");
const adapter = fs.readFileSync(path.join(root, "shared", "api-adapter.js"), "utf8");
assert.match(autoTrade, /runtimeIdentityMatches = Boolean\(selectedRuntime && vm\.matchesIdentity\(selectedRuntime, context\)\)/, "stop and pause controls require current market identity");
assert.match(autoTrade, /action === "pause" && \(processRunning !== true \|\| selectedRuntime\?\.stale/, "stale runtime cannot pause or resume");
assert.match(autoTrade, /var freshPaused = runtimeIdentityMatches && !selectedRuntime\.stale && processRunning === true/, "resume label requires fresh matching paused process state");
assert.match(autoTrade, /const canResume = button\.dataset\.action === "pause"[\s\S]*selectedRuntime\?\.processRunning === true[\s\S]*runtimeStateForAction === "paused"/, "resume command requires fresh matching paused process state");
assert.match(adapter, /const processOnly = vm\.runtime\(data\);[\s\S]*processRunning: processOnly\.processRunning[\s\S]*identityMismatch: true/, "identity mismatch keeps tri-state process fact without copying old market identity");
assert.match(autoTrade, /var activityList = document\.querySelector\("\[data-activity-list\]"\)/, "round reset clears activity events");
assert.match(autoTrade, /新场次事件读取中/, "round reset shows a new-round activity loading state");

Object.assign(global.window, {
  __POLY_PREVIEW_CONFIG__: { apiBase: "", apiFlavor: "contract", streams: {} },
  location: { search: "", href: "https://console.test/auto-trade.html", origin: "https://console.test", protocol: "https:", pathname: "/auto-trade.html" },
  history: { replaceState() {} },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  setTimeout,
  clearTimeout
});
global.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    status: "running",
    stale: true,
    processRunning: true,
    markets: [{ assetId: "eth", marketId: "market-eth", roundId: "round-eth" }]
  })
});
vm.runInThisContext(fs.readFileSync(path.join(root, "shared", "preview-core.js"), "utf8"), { filename: "preview-core.js" });
global.PolyPreview = window.PolyPreview;
vm.runInThisContext(fs.readFileSync(path.join(root, "shared", "preview-store.js"), "utf8"), { filename: "preview-store.js" });
vm.runInThisContext(fs.readFileSync(path.join(root, "shared", "api-adapter.js"), "utf8"), { filename: "api-adapter.js" });
window.PolyPreviewAdapter.loadRuntime({ assetId: "btc", marketId: "market-btc", roundId: "round-btc" }).then((runtime) => {
  assert.strictEqual(runtime.processRunning, true, "identity mismatch preserves global processRunning=true");
  assert.strictEqual(runtime.status, "unavailable", "identity mismatch keeps scoped runtime unavailable");
  assert.strictEqual(runtime.assetId, undefined, "identity mismatch does not copy the other market asset identity");
  assert.strictEqual(runtime.marketId, undefined, "identity mismatch does not copy the other market ID");
  assert.strictEqual(runtime.roundId, undefined, "identity mismatch does not copy the other round ID");
  console.log("runtime-adapter-identity: PASS");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

console.log("runtime-controls: PASS");
