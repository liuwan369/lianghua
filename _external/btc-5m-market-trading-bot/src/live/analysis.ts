import { readFileSync } from "node:fs";
import { httpClient } from "./index.js";
import { nowUnix, sleep } from "./feeds/index.js";

const REF_LO = 11.0;
const REF_HI = 23.0;

interface Rec {
  event?: string;
  session_id?: string;
  recv_ts?: number;
  market_slug?: string;
  side?: string;
  price?: number;
  shares?: number;
  is_maker?: boolean;
  pnl?: number;
  fills?: number;
  pair_cost?: number;
  up_shares?: number;
  down_shares?: number;
  daily_halted?: boolean;
}

function load(path: string): Rec[] {
  const text = readFileSync(path, "utf8");
  const recs = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Rec;
      } catch {
        return null;
      }
    })
    .filter((r): r is Rec => r != null && r.event != null);

  const last = [...recs].reverse().find((r) => r.session_id)?.session_id;
  if (last) return recs.filter((r) => r.session_id === last);
  return recs;
}

function isEv(r: Rec, e: string): boolean {
  return r.event === e;
}

/** Analyze subcommand — fill rate, PnL, verdict. */
export function analyze(path: string): void {
  let recs: Rec[];
  try {
    recs = load(path);
    if (recs.length === 0) {
      console.log(`${path} is empty — run live first.`);
      return;
    }
  } catch {
    console.log(`no log at ${path} — run live first.`);
    return;
  }

  const quotes = recs.filter((r) => isEv(r, "quote"));
  const fills = recs.filter((r) => isEv(r, "fill"));
  const makerFills = fills.filter((f) => f.is_maker === true);
  const takerFills = fills.length - makerFills.length;
  const cancels = recs.filter((r) => isEv(r, "cancel")).length;
  const resolved = recs.filter((r) => isEv(r, "resolved"));
  const resets = recs.filter((r) => isEv(r, "reset")).length;
  const errors = recs.filter((r) => isEv(r, "error")).length;
  const slugs = new Set(
    recs.map((r) => r.market_slug).filter((s): s is string => s != null),
  );
  const nMkts = Math.max(resets, resolved.length, slugs.size, 1);

  const ts = recs.map((r) => r.recv_ts).filter((t): t is number => t != null);
  const lo = ts.length ? Math.min(...ts) : Number.POSITIVE_INFINITY;
  const hi = ts.length ? Math.max(...ts) : 0;
  const span = lo < hi ? hi - lo : 0;

  console.log("================ MAKER LOG ANALYSIS ================");
  console.log(
    `log: ${path} | span ${(span / 60).toFixed(1)} min | markets ${nMkts}`,
  );

  const qsides = new Set(
    quotes.map((q) => q.side).filter((s): s is string => s != null),
  );
  console.log("\n-- (a) QUOTING --");
  console.log(
    `  quotes ${quotes.length} | quotes/market ${(quotes.length / nMkts).toFixed(1)} | sides ${[...qsides].sort().join(", ")}`,
  );

  const fr = quotes.length ? makerFills.length / quotes.length : 0;
  const er = quotes.length ? cancels / quotes.length : 0;
  console.log("\n-- (b) FILL RATE [PAPER/REPLAY UPPER-BOUND] --");
  console.log(
    `  maker fill rate = ${makerFills.length}/${quotes.length} = ${(fr * 100).toFixed(1)}%`,
  );
  console.log(
    `  expire rate     = ${cancels}/${quotes.length} = ${(er * 100).toFixed(1)}%`,
  );

  const mfPer = makerFills.length / nMkts;
  console.log("\n-- (c) FILLS / MARKET --");
  console.log(
    `  maker fills/market ${mfPer.toFixed(1)} | all fills/market ${(fills.length / nMkts).toFixed(1)}`,
  );
  console.log(
    `  reference traders (REAL): ${REF_LO.toFixed(0)}-${REF_HI.toFixed(0)}/mkt`,
  );

  console.log("\n-- (d) PER-SIDE --");
  for (const s of ["UP", "DOWN"]) {
    const qn = quotes.filter((q) => q.side === s).length;
    const fnn = makerFills.filter((f) => f.side === s).length;
    console.log(
      `  ${s.padEnd(4)} quotes ${String(qn).padStart(4)} | maker fills ${String(fnn).padStart(4)} | rate ${qn > 0 ? ((fnn / qn) * 100).toFixed(1) : "0.0"}%`,
    );
  }
  if (takerFills > 0) {
    console.log(
      `\n  forced taker crosses: ${takerFills} (${((takerFills / Math.max(fills.length, 1)) * 100).toFixed(0)}% of fills)`,
    );
  }

  if (resolved.length > 0) {
    const pnls = resolved.map((r) => r.pnl).filter((p): p is number => p != null);
    const total = pnls.reduce((s, p) => s + p, 0);
    const mean = total / Math.max(pnls.length, 1);
    const wins = pnls.filter((p) => p > 0).length;
    const pcs = resolved
      .map((r) => r.pair_cost)
      .filter((p): p is number => p != null && p > 0);
    console.log("\n-- (e) PnL / structure --");
    console.log(
      `  total $${total.toFixed(2)} | mean/market $${mean.toFixed(2)} | win rate ${((wins / Math.max(pnls.length, 1)) * 100).toFixed(0)}%`,
    );
    if (pcs.length > 0) {
      const pcMean = pcs.reduce((s, p) => s + p, 0) / pcs.length;
      const under1 =
        (pcs.filter((x) => x < 1).length / pcs.length) * 100;
      console.log(
        `  pair cost mean ${pcMean.toFixed(4)} | %markets <1.0: ${under1.toFixed(0)}%`,
      );
    }
  }

  console.log(`\n-- DATA QUALITY --  errors: ${errors}`);
  console.log("\n================ VERDICT ================");
  if (quotes.length === 0) {
    if (errors > 0) {
      console.log(`FAIL — 0 quotes AND ${errors} errors.`);
    } else if (resolved.length > 0 || resets > 0) {
      console.log("0 QUOTES — likely CORRECT SIT-OUT (tight books).");
    } else {
      console.log("FAIL — 0 quotes, no markets cycled.");
    }
  } else if (qsides.has("UP") && qsides.has("DOWN")) {
    console.log("STEP 1 ✅ quotes BOTH sides on real feeds.");
    console.log(
      `STEP 2 — opportunity ceiling: ${mfPer.toFixed(1)} PAPER maker-fills/market (OPTIMISTIC UPPER BOUND).`,
    );
    if (mfPer < REF_LO) {
      console.log(
        `  ⮕ NOT VIABLE: ceiling (${mfPer.toFixed(1)}) below reference floor (${REF_LO.toFixed(0)}/mkt).`,
      );
    } else {
      console.log("  ⮕ OPPORTUNITY PRESENT (optimistic). NEXT: tiny live test.");
    }
  } else {
    console.log(
      `STEP 1 ⚠ quotes only on ${[...qsides].sort()} — one-sided.`,
    );
  }
  console.log(
    "\nNEVER: paper does not validate queue position or live PnL.",
  );
}

interface Snapshot {
  quotes: number;
  fills: number;
  errors: number;
  markets: number;
  pnl: number;
  winRate: number;
  halted: boolean;
  staleSec: number;
}

function snapshot(path: string, now: number): Snapshot | undefined {
  let recs: Rec[];
  try {
    recs = load(path);
  } catch {
    return undefined;
  }
  const g = (e: string) => recs.filter((r) => isEv(r, e)).length;
  const resolved = recs.filter((r) => isEv(r, "resolved"));
  const pnls = resolved.map((r) => r.pnl).filter((p): p is number => p != null);
  const lastTs = recs
    .map((r) => r.recv_ts)
    .filter((t): t is number => t != null)
    .reduce((m, t) => Math.max(m, t), 0);
  return {
    quotes: g("quote"),
    fills: recs.filter((r) => isEv(r, "fill") && r.is_maker === true).length,
    errors: g("error"),
    markets: g("reset"),
    pnl: pnls.reduce((s, p) => s + p, 0),
    winRate: pnls.length
      ? (pnls.filter((p) => p > 0).length / pnls.length) * 100
      : 0,
    halted: resolved.some((r) => r.daily_halted === true),
    staleSec: lastTs > 0 ? now - lastTs : 1e9,
  };
}

async function alert(
  webhook: string | undefined,
  msg: string,
): Promise<void> {
  console.error(`\x1b[31m[ALERT] ${msg}\x1b[0m`);
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(httpClient().headers as Record<string, string>),
        },
        body: JSON.stringify({ text: `[btc5m-bot] ${msg}` }),
        signal: httpClient().signal,
      });
    } catch {
      /* ignore webhook errors */
    }
  }
}

/** Monitor subcommand — live status + alerts. */
export async function monitor(
  path: string,
  intervalSec: number,
  once: boolean,
  lossFloor: number,
  staleSec: number,
): Promise<void> {
  const webhook = process.env.MONITOR_WEBHOOK;
  const fired = new Set<string>();

  for (;;) {
    const now = nowUnix();
    const s = snapshot(path, now);
    if (!s) {
      console.log(`waiting for ${path} …`);
    } else {
      const fr = s.quotes > 0 ? (s.fills / s.quotes) * 100 : 0;
      console.log(
        `mkts ${s.markets} | quotes ${s.quotes} fills ${s.fills} (${fr.toFixed(0)}%) | PnL $${s.pnl.toFixed(2)} win ${s.winRate.toFixed(0)}% | errors ${s.errors} | halt ${s.halted} | last event ${s.staleSec.toFixed(0)}s ago`,
      );
      if (s.errors > 0 && fired.add("err")) {
        await alert(webhook, `${s.errors} engine error event(s)`);
      }
      if (s.halted && fired.add("halt")) {
        await alert(webhook, "DAILY CIRCUIT BREAKER tripped");
      }
      if (s.pnl <= -lossFloor && fired.add("loss")) {
        await alert(
          webhook,
          `PnL $${s.pnl.toFixed(2)} below floor -$${lossFloor.toFixed(0)}`,
        );
      }
      if (s.staleSec > staleSec && s.markets > 0 && fired.add("stale")) {
        await alert(
          webhook,
          `no events for ${s.staleSec.toFixed(0)}s — feed/engine may be stuck`,
        );
      }
      if (s.staleSec <= staleSec) fired.delete("stale");
    }

    if (once) return;
    await sleep(Math.max(intervalSec, 1) * 1000);
  }
}
