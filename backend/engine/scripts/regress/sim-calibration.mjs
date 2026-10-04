// Fill-model calibration against five real live BTC rung-1 orders (5 shares,
// GTC limit 0.70; fixtures/sim-calibration-orders.mjs). The simulator's venue
// (the A-variant fill model) replays the real recorded frames around each
// decision (fixtures/sim-calibration.jsonl.gz, decision −2 s .. +3 s) and must
// reproduce what the venue did: all five filled, 5 shares each, three resting
// fills at 0.70 (maker) and two immediate fills at 0.67 (taker). No trade
// prints were recorded then, so the resting fills come from the proxy.
//
// Run after `npm run build`:  node scripts/regress/sim-calibration.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { SimVenue } from "../../dist/sim/reversal-sim.js";
import { simBookFromRecord } from "../../dist/cli/sim-replay.js";
import { CALIBRATION_ORDERS } from "./fixtures/sim-calibration-orders.mjs";

const rows = gunzipSync(readFileSync(new URL("./fixtures/sim-calibration.jsonl.gz", import.meta.url)))
  .toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

for (const real of CALIBRATION_ORDERS) {
  const frames = rows.filter((row) => row.r === real.roundId).sort((a, b) => a.t - b.t);
  assert.ok(frames.length > 10, `${real.roundId}: fixture frames present`);
  const venue = new SimVenue();
  const event = { rung: 1, t: 0, dir: real.dir, ask: 0, want: 5, cap: 0.7, avail: null, filled: 0, avgPrice: null,
    cost: 0, fee: 0, maker: 0, status: "none" };
  let placed = false;
  for (const row of frames) {
    if (!placed && row.t >= real.decidedAt) { venue.place(event, real.decidedAt, Number(real.roundId) + 300); placed = true; }
    const book = simBookFromRecord(row);
    if (book) venue.frame(book, row.t);
  }
  const got = `${real.roundId} ${real.dir}: filled ${event.filled} @ ${event.avgPrice} maker ${event.maker} (${event.status})`;
  assert.equal(event.status, "full", got);
  assert.equal(event.filled, 5, got);
  assert.equal(event.avgPrice, real.real.price, `${got}; real ${real.real.price}`);
  assert.equal(event.maker, real.real.maker, `${got}; real maker ${real.real.maker}`);
  console.log(`  ${got}  = real`);
}
console.log("sim-calibration OK");
process.exit(0);
