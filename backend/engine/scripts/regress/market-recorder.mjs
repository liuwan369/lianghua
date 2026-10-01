// Market recording (user decision 2026-10-01): every collector book event is
// kept for replay/backtests, one gzip'd JSON line per event, per asset per
// Beijing day, files older than the retention deleted.
//
// Run after `npm run build`:  node scripts/regress/market-recorder.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { MarketRecorder, recordedBook, beijingDay } from "../../dist/cli/market-recorder.js";

const dir = mkdtempSync(join(tmpdir(), "rec-"));
const now = 1_790_870_000;  // 2026-10-02 07:33 Beijing
// A stale day file from 12 days ago and a recent one from 3 days ago.
mkdirSync(join(dir, "btc"), { recursive: true });
writeFileSync(join(dir, "btc", `${beijingDay(now - 12 * 86400)}.jsonl.gz`), "");
writeFileSync(join(dir, "btc", `${beijingDay(now - 3 * 86400)}.jsonl.gz`), "");

const recorder = new MarketRecorder({ directory: dir, retentionDays: 10, now: () => now });
assert.ok(!existsSync(join(dir, "btc", `${beijingDay(now - 12 * 86400)}.jsonl.gz`)), "files older than 10 days are deleted");
assert.ok(existsSync(join(dir, "btc", `${beijingDay(now - 3 * 86400)}.jsonl.gz`)), "recent files stay");

// A real-shaped collector snapshot.
const snapshot = { marketId: "0xm", roundId: "1790869800", sequence: 41, upExchangeTsUnix: now - 0.2, downExchangeTsUnix: now - 0.2,
  upBid: 0.41, upAsk: 0.42, downBid: 0.58, downAsk: 0.59,
  upBidLevels: [[0.41, 120], [0.40, 50]], upAskLevels: [[0.42, 80]], downBidLevels: [[0.58, 80]], downAskLevels: [[0.59, 120]],
  YES: { assetId: "1" }, NO: { assetId: "2" }, receivedAtMonoMs: 123 };
for (let i = 0; i < 1000; i += 1) recorder.record(recordedBook("btc", { ...snapshot, sequence: i }, now + i / 100));
await recorder.close();

const file = join(dir, "btc", `${beijingDay(now)}.jsonl.gz`);
const lines = gunzipSync(readFileSync(file)).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
assert.equal(lines.length, 1000, "every event is one line");
assert.deepEqual(lines[0], { t: now, a: "btc", m: "0xm", r: "1790869800", q: 0, ue: now - 0.2, de: now - 0.2,
  ub: 0.41, ua: 0.42, db: 0.58, da: 0.59, ubl: [[0.41, 120], [0.40, 50]], ual: [[0.42, 80]], dbl: [[0.58, 80]], dal: [[0.59, 120]] },
  "the line keeps time, identity, best quotes and depth, nothing else");
const raw = 1000 * JSON.stringify(snapshot).length;
console.log(`compressed ${readFileSync(file).length} bytes for 1000 events (raw snapshots ${raw})`);

// A restart appends a second gzip member; the file still reads as one stream.
const again = new MarketRecorder({ directory: dir, retentionDays: 10, now: () => now });
again.record(recordedBook("btc", snapshot, now + 20));
await again.close();
assert.equal(gunzipSync(readFileSync(file)).toString("utf8").trim().split("\n").length, 1001, "an appended member reads on");
rmSync(dir, { recursive: true, force: true });
console.log("market-recorder OK");
