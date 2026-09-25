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
assert.match(autoTrade, /runtimeIdentityMatches = Boolean\(selectedRuntime && vm\.matchesIdentity\(selectedRuntime, context\)\)/, "stop and pause controls require current market identity");
assert.match(autoTrade, /action === "pause" && \(processRunning !== true \|\| selectedRuntime\?\.stale/, "stale runtime cannot pause or resume");
assert.match(autoTrade, /var activityList = document\.querySelector\("\[data-activity-list\]"\)/, "round reset clears activity events");
assert.match(autoTrade, /新场次事件读取中/, "round reset shows a new-round activity loading state");

console.log("runtime-controls: PASS");
