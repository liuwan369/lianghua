// Builds sim-calibration.jsonl.gz: the real BTC recording frames from
// decision−2 s to +3 s around the five real live rung-1 orders that
// sim-calibration.mjs replays. One-off; the output is checked in.
//
// Usage: node scripts/regress/fixtures/build-sim-calibration.mjs <btc day .jsonl.gz>
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";
import { CALIBRATION_ORDERS } from "./sim-calibration-orders.mjs";

const source = process.argv[2];
if (!source) throw new Error("usage: build-sim-calibration.mjs <recording.jsonl.gz>");
const gunzip = createGunzip();
gunzip.on("error", () => { /* multi-member file still being written: stop at the truncated member */ });
const lines = createInterface({ input: createReadStream(source).pipe(gunzip), crlfDelay: Infinity });
const kept = [];
try {
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (CALIBRATION_ORDERS.some((o) => row.r === o.roundId && row.t >= o.decidedAt - 2 && row.t <= o.decidedAt + 3)) kept.push(line);
  }
} catch { /* EOF of a truncated member */ }
writeFileSync(new URL("./sim-calibration.jsonl.gz", import.meta.url), gzipSync(`${kept.join("\n")}\n`));
console.log(`kept ${kept.length} frames`);
