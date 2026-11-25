// Polymarket Protocol V2 approvals (docs migrate/polymarket-v2): BUY needs pUSD
// approve(ExchangeV3); SELL needs PositionManager setApprovalForAll(ExchangeV3);
// our settlement's redeem needs PositionManager setApprovalForAll(Router).
// CTF approvals do not carry over. The account check reports them as their
// own line: V2 readiness never changes the V1 (CTF) verdict, so an account
// trading V1 markets today is not blocked by V2.
// - all three present: ready, nothing missing;
// - each missing one is named; a failed read is unknown (null), not "missing".
// Run after `npm run build`:  node scripts/regress/v2-approvals.mjs
import assert from "node:assert/strict";
import { v2ApprovalStatus, V2_APPROVALS } from "../../dist/live/account.js";

assert.deepEqual(V2_APPROVALS.map(a => a.key), ["pusd_exchange_v3", "positions_exchange_v3", "positions_router"]);
const all = { pusd_exchange_v3: true, positions_exchange_v3: true, positions_router: true };
assert.deepEqual(v2ApprovalStatus(all), { ready: true, missing: [] });
const noSell = v2ApprovalStatus({ ...all, positions_exchange_v3: false });
assert.equal(noSell.ready, false);
assert.deepEqual(noSell.missing, ["positions_exchange_v3"]);
assert.deepEqual(v2ApprovalStatus({ pusd_exchange_v3: false, positions_exchange_v3: false, positions_router: false }).missing,
  ["pusd_exchange_v3", "positions_exchange_v3", "positions_router"]);
const unknown = v2ApprovalStatus({ ...all, positions_router: null });
assert.equal(unknown.ready, null, "a failed read is unknown, never ready or missing");
assert.deepEqual(unknown.missing, []);
console.log("v2-approvals OK");
