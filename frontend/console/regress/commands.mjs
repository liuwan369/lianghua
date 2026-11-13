// 实盘 run control (live.js): the state shown for each server status, which
// buttons it allows, and the exact POST /api/runtime/commands bodies.
// - start and stop ask for confirmation (real money); declining sends nothing;
// - pause and resume send at once;
// - every command carries a UUID requestId and the published revision;
// - start without a published revision is refused before anything is sent.
//
// Run:  node frontend/console/regress/commands.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const posted = [];
const window = { location: { search: "", href: "http://x/auto-trade.html" }, setTimeout, clearTimeout, setInterval, clearInterval,
  URLSearchParams, URL, AbortController, crypto: webcrypto, console,
  document: { hidden: false, addEventListener() {}, querySelector: () => null } };
window.fetch = async (url, options = {}) => {
  posted.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null, type: options.headers?.["Content-Type"] });
  return { ok: true, status: 200, json: async () => ({ accepted: true }) };
};
window.window = window;
const context = vm.createContext(window);
for (const file of ["shared/preview-core.js", "live.js"]) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const L = window.PolyLive;

// --- state for each server status ---
const cases = [
  [{ processRunning: true, status: "running" }, "running", { start: false, pause: true, resume: false, stop: true }],
  [{ processRunning: true, status: "paused" }, "paused", { start: false, pause: false, resume: true, stop: true }],
  [{ processRunning: true, status: "starting" }, "starting", { start: false, pause: false, resume: false, stop: true }],
  [{ processRunning: false, status: "stopped" }, "stopped", { start: true, pause: false, resume: false, stop: false }],
  [{ processRunning: false, status: "failed" }, "failed", { start: true, pause: false, resume: false, stop: false }],
];
for (const [status, state, buttons] of cases) {
  assert.equal(L.runState(status), state, JSON.stringify(status));
  assert.deepEqual({ ...L.allowed(state) }, buttons, state);
}
assert.equal(L.runState({ processRunning: true, status: "running" }, true), "stopping", "a stop in flight reads 停止中");
assert.equal(L.STATES.stopping.text, "停止中");
assert.equal(L.STATES.starting.text, "启动中");
assert.deepEqual({ ...L.allowed("stopping") }, { start: false, pause: false, resume: false, stop: false });

// --- payload shapes ---
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const config = { shares: 5 };
const asked = [];
const yes = (text) => { asked.push(text); return true; };
const no = (text) => { asked.push(text); return false; };

for (const action of ["start", "pause", "resume", "stop"]) {
  posted.length = 0; asked.length = 0;
  await L.command(action, 7, config, yes);
  assert.equal(posted.length, 1, `${action}: one POST`);
  const [sent] = posted;
  assert.equal(sent.url, "/api/runtime/commands");
  assert.equal(sent.method, "POST");
  assert.equal(sent.type, "application/json");
  assert.deepEqual(Object.keys(sent.body).sort(), ["action", "requestId", "revision"], `${action}: exactly action, requestId, revision`);
  assert.equal(sent.body.action, action);
  assert.equal(sent.body.revision, 7);
  assert.match(sent.body.requestId, UUID, `${action}: requestId is a v4 UUID`);
  assert.equal(asked.length, action === "start" || action === "stop" ? 1 : 0, `${action}: confirmation asked only for start/stop`);
}
const first = L.commandPayload("start", 3).requestId;
assert.notEqual(first, L.commandPayload("start", 3).requestId, "a new requestId per press");

// --- confirmation text says it is real money; declining sends nothing ---
for (const action of ["start", "stop"]) {
  posted.length = 0; asked.length = 0;
  const result = await L.command(action, 7, config, no);
  assert.equal(result, null, `${action}: declined`);
  assert.equal(posted.length, 0, `${action}: nothing sent when declined`);
  assert.match(asked[0], /真钱/, `${action}: the dialog says it is real money`);
}
assert.match(L.confirmText("start", 7, config), /r7/);
assert.match(L.confirmText("start", 7, config), /5 股/);

// --- start needs a published revision ---
posted.length = 0;
await assert.rejects(() => L.command("start", 0, config, yes), /发布/);
await assert.rejects(() => L.command("start", undefined, config, yes), /发布/);
await assert.rejects(() => L.command("flatten", 7, config, yes), /未知/);
assert.equal(posted.length, 0, "nothing sent for a refused command");

// --- 本次第几场: the first full round after the start is 1 ---
assert.equal(L.roundNumber(1000 * 300 + 17, 1001 * 300), 1);
assert.equal(L.roundNumber(1000 * 300, 1000 * 300), 1, "started on a boundary: that round counts");
assert.equal(L.roundNumber(1000 * 300 + 17, 1003 * 300), 3);
assert.equal(L.roundNumber(1000 * 300 + 17, 1000 * 300), null, "the round already running at start is not counted");

console.log("commands OK");
process.exit(0);
