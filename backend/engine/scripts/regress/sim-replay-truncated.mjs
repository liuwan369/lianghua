// The current day's recording is still being written, so its last gzip member
// is incomplete. Reading it threw "unexpected end of file" and aborted the
// whole backfill: on the server only the first coin (bnb) was replayed.
// A truncated file must end that file only; every other coin is still read.
// Run after `npm run build`:  node scripts/regress/sim-replay-truncated.mjs
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { runSimReplay } from "../../dist/cli/sim-replay.js";

const dir = mkdtempSync(join(tmpdir(), "sim-trunc-"));
const R = (Math.floor(Date.now() / 1000 / 300) - 3) * 300;
const round = (asset) => {
  const rows = []; let t = R + 1; let up = true;
  rows.push({ t, a: asset, m: `0x${asset}`, r: String(R), q: 1, ue: t, de: t, ub: 0.5, ua: 0.5, db: 0.5, da: 0.5 });
  for (let i = 0; i < 4; i += 1) {
    t += 2; rows.push({ t, a: asset, m: `0x${asset}`, r: String(R), q: i + 2, ue: t, de: t,
      ub: up ? 0.68 : 0.5, ua: up ? 0.68 : 0.5, db: up ? 0.5 : 0.68, da: up ? 0.5 : 0.68 });
    t += 2; rows.push({ t, a: asset, m: `0x${asset}`, r: String(R), q: 100 + i, ue: t, de: t, ub: 0.4, ua: 0.4, db: 0.4, da: 0.4 });
    up = !up;
  }
  rows.push({ t: R + 299, a: asset, m: `0x${asset}`, r: String(R), q: 999, ue: R + 299, de: R + 299, ub: 0.99, ua: 0.99, db: 0.02, da: 0.02 });
  return gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const day = new Date((R + 8 * 3600) * 1000).toISOString().slice(0, 10);
for (const asset of ["aaa", "bbb"]) {
  mkdirSync(join(dir, "history", asset), { recursive: true });
  let body = round(asset);
  if (asset === "aaa") body = Buffer.concat([body, round(asset).subarray(0, 40)]);   // a member still being written
  writeFileSync(join(dir, "history", asset, `${day}.jsonl.gz`), body);
}
const result = await runSimReplay({ historyDir: join(dir, "history"), simDir: join(dir, "sim"), retentionDays: 10 });
const lines = (asset) => { try { return readFileSync(join(dir, "sim", `${asset}.jsonl`), "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
const counts = { aaa: lines("aaa"), bbb: lines("bbb") };
rmSync(dir, { recursive: true, force: true });
assert.equal(counts.aaa, 1, "the complete part of a file still being written is replayed");
assert.equal(counts.bbb, 1, "a truncated file does not stop the other coins");
assert.equal(result.rounds, 2);
console.log("sim-replay-truncated OK");
