// 2026-10-26 live: the state file's risk read baselineEquityUsd 209.526599,
// day "2026-10-26", baselineAt = the start-up instant, but equityUsd
// 164.350863 (the real balance) and dailyPnlUsd -45.18 from the first
// second. 209.53 was the cash of 2026-10-02, the restored state's last read.
//
// On restore the constructor rolled the day over against the restored
// (stale) cash; the start-up account read arrives through reconcile() only
// later. The new day's start must be the equity of the account read that
// opens it, and a restart within the same day must keep the day's start
// (otherwise a restart erases the day's loss).
//
// Real TradingPlatform/TradingCore, only the gateway faked.
// Run after `npm run build`:  node scripts/regress/daily-baseline.mjs
import assert from "node:assert/strict";
import { TradingPlatform } from "../../dist/platform/platform.js";

const OCT02 = 1790932503, OCT26 = 1792977409.836;       // the two live baselines, Beijing days 10-02 and 10-26
const limits = { capitalUsd: 1000, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: 20 };
const gateway = { mode: "live", durableIdentity: true, async submit() {}, async cancel() { return true; } };
const read = (cash, at, positions = []) => ({ accountId: "t", at, cashAt: at, cashUsd: cash, positions, openOrders: [], complete: true });
// The connector's start-up order: read the account, build the platform on the
// restored state, then reconcile against that same read (account recovery).
function start(cash, at, restored, clock = { now: at }) {
  const platform = new TradingPlatform({ account: read(cash, at), instruments: [], limits, restored, now: () => clock.now, adapters: { gateway } });
  platform.core.reconcile(read(cash, at + 1));
  return { platform, clock };
}
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);

// --- live: a 10-02 state restored on 10-26 with a smaller balance ---
{
  const old = start(209.526599, OCT02).platform.core.snapshot();
  assert.equal(old.risk.day, "2026-10-02");
  close(old.risk.baselineEquityUsd, 209.526599, "precondition: the old day's start");
  const { platform } = start(164.350863, OCT26, old);
  const risk = platform.core.risk();
  assert.equal(risk.day, "2026-10-26");
  close(risk.baselineEquityUsd, 164.350863, "the new day starts at the balance read that opens it");
  close(risk.dailyPnlUsd, 0, "no loss on the first second of the day");
  assert.equal(risk.halted, false, "no daily-loss halt from a stale start");
}
// --- a restart later the same day keeps the day's start (and its loss) ---
{
  const morning = start(164.350863, OCT26).platform.core.snapshot();
  const { platform } = start(150, OCT26 + 3600, morning);
  const risk = platform.core.risk();
  assert.equal(risk.day, "2026-10-26");
  close(risk.baselineEquityUsd, 164.350863, "same day: the morning's start stays");
  close(risk.dailyPnlUsd, 150 - 164.350863, "same day: the loss since the morning stays");
}
// --- the day turns while running: the start is the equity at that moment ---
{
  const eveningAt = OCT26 + 13 * 3600;                // OCT26 is 09:16 Beijing: 22:16, midnight ~1.7 h later
  const { platform, clock } = start(100, eveningAt);
  platform.core.reconcile(read(90, eveningAt + 60));
  close(platform.core.risk().dailyPnlUsd, -10, "precondition: 10-26 lost 10");
  clock.now = eveningAt + 3 * 3600;                   // 01:16 on 10-27
  const risk = platform.core.risk();
  assert.equal(risk.day, "2026-10-27");
  close(risk.baselineEquityUsd, 90, "the next day starts at the equity it began with");
  close(risk.dailyPnlUsd, 0, "and has lost nothing yet");
}
// --- a deposit after the new day's start still moves the start ---
{
  const old = start(209.526599, OCT02).platform.core.snapshot();
  const { platform } = start(164.350863, OCT26, old);
  const flowAt = OCT26 + 100;
  platform.core.reconcile(read(214.350863, flowAt + 10), 50);
  const risk = platform.core.risk();
  close(risk.baselineEquityUsd, 214.350863, "a 50 deposit moves the start with the cash");
  close(risk.dailyPnlUsd, 0, "a deposit is not profit");
}
console.log("daily-baseline OK");
