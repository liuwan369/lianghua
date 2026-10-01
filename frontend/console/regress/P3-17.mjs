// BUGS P3-17: once the engine stopped mid-session, the global runtime slice
// kept the last "running" snapshot: a stopped engine's runtime snapshot is
// stale, and a stale response kept the old one. processRunning=false is a
// fresh fact and must replace it.
//
// Run:  node frontend/console/regress/P3-17.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const now = () => Date.now() / 1000;
let running = true;
const window = { location: { search: "", origin: "http://x", href: "http://x/a.html", pathname: "/a.html" },
  addEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval, console, URLSearchParams, URL, AbortController,
  history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} } };
window.fetch = async () => ({ ok: true, status: 200, json: async () => running
  ? { schemaVersion: 1, asOf: now(), stale: false, status: "running", state: "running", processRunning: true, runId: "r1", markets: [] }
  : { schemaVersion: 1, asOf: now() - 60, stale: true, status: "stopped", state: "stopped", processRunning: false, runId: "r1", markets: [],
      error: "runtime_snapshot_stale" } });
window.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
const context = vm.createContext(window); window.window = window; window.self = window;
for (const f of ["shared/preview-core.js", "shared/view-model.js", "shared/preview-store.js", "shared/api-adapter.js"]) {
  vm.runInContext(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), context, { filename: f });
}
const adapter = window.PolyPreviewAdapter, store = window.PolyPreviewStore;
await adapter.loadRuntime();
assert.equal(store.getState().runtime.processRunning, true);
running = false;
await adapter.loadRuntime();
const runtime = store.getState().runtime;
assert.equal(runtime.processRunning, false, "the stop is seen");
assert.notEqual(runtime.runtimeState ?? runtime.status, "running", `the slice no longer says running; got ${runtime.runtimeState ?? runtime.status}`);
console.log("P3-17 OK");
