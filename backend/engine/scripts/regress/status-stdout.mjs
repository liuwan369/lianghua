// stdout status spam: the engine printed the whole platform_status line every
// --status-sec (2 s), 42,851 lines (~90 MB) in two days. The control plane
// (scripts/system-dashboard-server.py _console_terminal_status /
// _automatic_stop_result) reads the console log only for the LAST stopped/failed
// platform_status, so stdout now prints on a status change, a reason change, or
// once a minute; a terminal status always prints. The journal still gets all.
//
// Run after `npm run build`:  node scripts/regress/status-stdout.mjs
import assert from "node:assert/strict";
import { statusStdoutDue, STATUS_STDOUT_EVERY_MS } from "../../dist/cli/platform.js";

const T = 1_800_000_000_000;
assert.equal(statusStdoutDue(undefined, "starting", null, T), true, "the first status prints");

const running = { status: "running", reason: null, atMs: T };
assert.equal(statusStdoutDue(running, "running", null, T + 2_000), false, "an unchanged 2 s tick stays off stdout");
assert.equal(statusStdoutDue(running, "running", null, T + STATUS_STDOUT_EVERY_MS - 1), false);
assert.equal(statusStdoutDue(running, "running", null, T + STATUS_STDOUT_EVERY_MS), true, "once a minute it prints");
assert.equal(statusStdoutDue({ status: "starting", reason: null, atMs: T }, "running", null, T + 1), true,
  "a status change prints");
assert.equal(statusStdoutDue(running, "running", "SIGTERM", T + 1), true, "a reason change prints");

for (const terminal of ["stopped", "failed"]) {
  const last = { status: terminal, reason: "SIGTERM", atMs: T };
  assert.equal(statusStdoutDue(last, terminal, "SIGTERM", T + 1), true, `${terminal} always prints, even repeated`);
}

console.log("status-stdout: ok");
