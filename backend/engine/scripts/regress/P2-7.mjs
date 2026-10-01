// BUGS.md P2-7: a failed start logged only its phase (platform_run_failed) and
// the CLI printed a generic "platform could not complete". Four failed starts on
// 09-29 could not be told apart. The real message is now kept, minus secrets.
//
// Run after `npm run build`:  node scripts/regress/P2-7.mjs
import assert from "node:assert/strict";
import { safeErrorMessage } from "../../dist/cli/platform.js";

// --- bug: the cause survives ---
assert.equal(safeErrorMessage("initial discovered market does not match requested marketId and roundId"),
  "initial discovered market does not match requested marketId and roundId");
assert.equal(safeErrorMessage("HTTP request failed. Status: 429"), "HTTP request failed. Status: 429");
// --- edge: secrets never pass ---
assert.equal(safeErrorMessage("invalid POLYMARKET_PRIVATE_KEY format"), "sensitive provider error");
assert.equal(safeErrorMessage("bad api key"), "sensitive provider error");
const key = "0x" + "ab".repeat(32);
assert.ok(!safeErrorMessage(`signer ${key} rejected`).includes("ab".repeat(32)), "a 64-hex value is redacted");
assert.ok(safeErrorMessage("x".repeat(2000)).length <= 500, "bounded");
// --- control: no message, no text ---
assert.equal(safeErrorMessage(""), undefined);
assert.equal(safeErrorMessage(undefined), undefined);
console.log("P2-7 OK");
