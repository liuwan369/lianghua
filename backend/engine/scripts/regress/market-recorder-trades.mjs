// Trade prints in the recording (user 2026-10-03): the collector writes every
// feed marketTrade of the round's tokens into the same day file as a row
// {t,a,m,r,k:"t",tok:"u"|"d",p,s,side}, and sim-replay reads those rows back:
// a SELL print at <= 0.70 fills a resting hedge (maker).
//
// Run after `npm run build`:  node scripts/regress/market-recorder-trades.mjs
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { runMarketSnapshot } from "../../dist/cli/market-snapshot.js";
import { runSimReplay } from "../../dist/cli/sim-replay.js";

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

// 2. Replay reads trade rows: the DOWN hedge rests (no asks <= 0.70, bid 0.69) and an 8-share SELL print fills 8.
{
  const rows = [];
  const frame = (t, ua, da, extra = {}) => rows.push({ t: R + t, a: "btc", m: "0xr", r: String(R), q: rows.length, ue: R + t, de: R + t,
    ub: ua - 0.01, ua, db: extra.db ?? da - 0.01, da, ual: [[ua, 1000]], dal: extra.dal ?? [[da, 1000]] });
  const up = { dal: [[0.72, 100]] };
  frame(1, 0.5, 0.51); frame(10, 0.68, 0.30); frame(10.4, 0.68, 0.30);
  frame(19, 0.30, 0.50, up); frame(20, 0.30, 0.68, up); frame(20.4, 0.30, 0.72, { ...up, db: 0.69 });
  rows.push({ t: R + 21, a: "btc", m: "0xr", r: String(R), k: "t", tok: "d", p: 0.70, s: 8, side: "SELL" });
  frame(22, 0.30, 0.72, { ...up, db: 0.70 });                     // with prints, the bid proxy is off
  frame(299, 0.99, 0.02, up);
  rows.push({ t: R + 301, a: "btc", m: "0xr2", r: String(R + 300), q: 1, ue: R + 301, de: R + 301, ub: 0.5, ua: 0.5, db: 0.5, da: 0.5 });
  const day = new Date((R + 8 * 3600) * 1000).toISOString().slice(0, 10);
  mkdirSync(join(dir, "history", "btc"), { recursive: true });
  writeFileSync(join(dir, "history", "btc", `${day}.jsonl.gz`), gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  await runSimReplay({ historyDir: join(dir, "history"), simDir: join(dir, "sim"), retentionDays: 10 });
  const [line] = readFileSync(join(dir, "sim", "btc.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const hedge = line.variants.C.events[1];
  assert.equal(hedge.dir, "DOWN"); assert.equal(hedge.want, 20);
  assert.equal(hedge.filled, 8, "the print filled 8 of the resting hedge"); assert.equal(hedge.maker, 8);
}
rmSync(dir, { recursive: true, force: true });
console.log("market-recorder-trades OK");
process.exit(0);
