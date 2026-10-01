// BUGS P3-4: occupancy counted resolved losers (redeemable, worth 0) as held
//            capital: 20 such positions, $66.89 of dead history.
// BUGS P3-18: trade-report latency was measured on every status revision;
//            MINED/CONFIRMED arrive seconds after MATCHED against the same
//            match_time and inflated the metric.
//
// Run after `npm run build`:  node scripts/regress/P3-4-P3-18.mjs
import assert from "node:assert/strict";
import { balanceOccupancy } from "../../dist/live/account-finance.js";
import { parseUserMessage } from "../../dist/live/feeds/user.js";

// ---- P3-4 ----
const at = new Date().toISOString();
const section = (items) => ({ available: true, complete: true, items, pages: 1, checked_at: at });
const collateral = { ...section([]), value: 210 };
const positions = section([
  { asset: "1", conditionId: "0xa", size: 5, avgPrice: 0.66, redeemable: true, currentValue: 0 },     // resolved loser
  { asset: "2", conditionId: "0xb", size: 5, avgPrice: 0.70, redeemable: true, currentValue: 5 },     // winner, cash not yet in
  { asset: "3", conditionId: "0xc", size: 10, avgPrice: 0.50, redeemable: false, currentValue: 4.2 }, // live position
]);
const occ = balanceOccupancy(collateral, section([]), positions);
assert.equal(occ.observed.position_cost_usd, 5 * 0.70 + 10 * 0.50, "the dead loser is not occupied capital; winners and live positions are");

// ---- P3-18 ----
const opts = { upToken: "111", downToken: "222", isOurOrder: (id) => id === "ours" };
const seen = new Set();
const match = Date.now() / 1000 - 0.2;
const trade = (status, delay) => ({ event_type: "trade", id: "t1", taker_order_id: "ours", asset_id: "111", side: "BUY",
  price: "0.68", size: "5", status, match_time: String(Math.floor(match)), __receivedAtUnix: match + delay });
const latencies = [];
for (const [status, delay] of [["MATCHED", 0.3], ["MINED", 4], ["CONFIRMED", 9]]) {
  for (const event of parseUserMessage([trade(status, delay)], opts, new Map(), seen)) {
    if (event.kind === "exchangeFill" && event.reportLatencyMs != null) latencies.push(Math.round(event.reportLatencyMs / 1000));
  }
}
assert.equal(latencies.length, 1, `latency is measured once per trade, on its first report; got ${latencies}`);
console.log("P3-4-P3-18 OK");
