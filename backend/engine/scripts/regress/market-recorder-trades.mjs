// Trade prints in the recording (user 2026-10-03): the collector writes every
// feed marketTrade of the round's tokens into the same day file as a row
// {t,a,m,r,k:"t",tok:"u"|"d",p,s,side}.
//
// Run after `npm run build`:  node scripts/regress/market-recorder-trades.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { runMarketSnapshot } from "../../dist/cli/market-snapshot.js";

const dir = mkdtempSync(join(tmpdir(), "rec-trades-"));
const R = (Math.floor(Date.now() / 1000 / 300) - 3) * 300;

// 1. The collector records a marketTrade of the round's down token as a trade row.
{
  const now = R + 20;
  const market = { asset: "btc", slug: `btc-updown-5m-${R}`, conditionId: "0xm", roundId: String(R),
    start: R, end: R + 300, upToken: "UPTOK", downToken: "DOWNTOK", tickSize: 0.01, minOrderSize: 5 };
  const abort = new AbortController();
  let sink;
  const run = runMarketSnapshot({ assets: ["btc"], output: join(dir, "snap.json"), durationSec: 0, staleAfterMs: 2000,
    publishMs: 1000, discoveryMs: 50, recordDays: 10, recordDir: join(dir, "rec") }, {
    now: () => now, discover: async () => market, feed: (s) => { sink = s; return { stop() {} }; }, publish: () => {},
  }, abort.signal);
  await new Promise((resolve) => setTimeout(resolve, 100));
  sink({ kind: "marketTrade", token: "DOWNTOK", price: 0.7, shares: 12.5, takerSide: "SELL", tsUnix: now });
  sink({ kind: "marketTrade", token: "OTHER", price: 0.7, shares: 1, takerSide: "SELL", tsUnix: now });
  abort.abort();
  await run.catch(() => {});
  const files = readdirSync(join(dir, "rec", "btc"));
  const rows = gunzipSync(readFileSync(join(dir, "rec", "btc", files[0]))).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows, [{ t: now, a: "btc", m: "0xm", r: String(R), k: "t", tok: "d", p: 0.7, s: 12.5, side: "SELL" }],
    "one trade row for the round's token; a foreign token is not recorded");
}

rmSync(dir, { recursive: true, force: true });
console.log("market-recorder-trades OK");
process.exit(0);
