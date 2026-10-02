// P1-7: a reconcile that runs seconds after a fill uses an account
// snapshot the venue has not yet updated for that fill (MATCHED -> MINED ->
// CONFIRMED takes ~2-7s on chain). core.reconcile replaced cash/positions
// wholesale and flagged the fill accountingCashSuperseded by timestamp alone,
// so the fill's cash debit and position vanished and a later CONFIRMED could
// not restore them. Live: one real fill's position disappeared for the rest of
// the round, and a probe order then slipped past the capital cap.
//
// Two layers, tested where they live:
//   A. TradingCore.reconcile must not mark a NON-TERMINAL fill as superseded.
//   B. recoverAccount must not reconcile while any fill is non-terminal
//      (exported predicate `hasProvisionalFills`).
// Real TradingPlatform/Core/Store, only the gateway faked.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { PlatformStore } from "../../dist/platform/store.js";
import { hasProvisionalFills } from "../../dist/platform/polymarket.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), HASH = "0x" + "cd".repeat(32);
const btc = { id: "0xbtc", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xbtc", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xbtc", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const limits = { capitalUsd: 10, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null };
const settle = () => new Promise(r => setTimeout(r, 80));

function build() {
  const dir = mkdtempSync(join(tmpdir(), "p1-7-")); const s = new PlatformStore(join(dir, "state.json"));
  const gw = { mode: "live", durableIdentity: true,
    async submit(_r, _i, prep) { prep({ orderHash: HASH, signedPayload: { sig: "s" }, preparedAt: START + 1 }); return { status: "accepted", orderId: HASH, venueStatus: "LIVE" }; },
    async cancel() { return true; } };
  const p = new TradingPlatform({ account: { accountId: "t", at: START - 60, cashAt: START - 60, cashUsd: 208.04, positions: [], openOrders: [], complete: true },
    instruments: btc.instruments, limits, now: () => START + 10,
    adapters: { gateway: gw, estimateFee: () => 0, persist: (st, c) => s.save(st, c), deferPersistence: () => s.defer(), persistPreparedOrder: o => s.savePreparedOrder(o) } });
  p.ingest({ kind: "market", market: btc });
  return { p, s, dir };
}
const fill = (status, ts) => ({ kind: "fill", marketId: btc.id, roundId: btc.roundId, fill: { tradeId: "t1", orderId: HASH, marketId: btc.id, roundId: btc.roundId,
  tokenId: UP, direction: "BUY", price: 0.70, shares: 5, feeUsd: 0, status, feeSource: "reported", ts, isMaker: false } });
// Venue snapshot taken 1.5s AFTER the fill, but the venue has not yet applied it.
const staleAccount = { accountId: "t", at: START + 9.5, cashAt: START + 9.5, cashUsd: 208.04, positions: [], openOrders: [], complete: true };

// --- A: reconcile must not supersede a non-terminal (MATCHED) fill ---
{
  const { p, s, dir } = build();
  await p.core.submit({ clientOrderId: "btc:1", strategyId: "s", tokenId: UP, direction: "BUY", price: 0.70, shares: 5, timeInForce: "GTC", postOnly: false });
  await settle();
  p.ingest(fill("MATCHED", START + 8)); await settle();
  p.core.reconcile(staleAccount, 0, []);
  const f = p.core.snapshot().fills.find(x => x.tradeId === "t1");
  assert.notEqual(f.accountingCashSuperseded, true,
    "A: a MATCHED fill the venue has not settled must not be marked superseded by a stale snapshot");
  s.close(); rmSync(dir, { recursive: true, force: true });
  console.log("PASS A: a non-terminal fill is not superseded by a stale snapshot");
}
// --- A control: a CONFIRMED fill IS already in the venue balance, so it must be superseded ---
{
  const { p, s, dir } = build();
  await p.core.submit({ clientOrderId: "btc:1", strategyId: "s", tokenId: UP, direction: "BUY", price: 0.70, shares: 5, timeInForce: "GTC", postOnly: false });
  await settle();
  p.ingest(fill("CONFIRMED", START + 8)); await settle();
  p.core.reconcile({ ...staleAccount, cashUsd: 204.54, positions: [{ tokenId: UP, shares: 5, costUsd: 3.5, realizedPnlUsd: 0 }] }, 0, []);
  const f = p.core.snapshot().fills.find(x => x.tradeId === "t1");
  assert.equal(f.accountingCashSuperseded, true, "A control: a CONFIRMED fill is superseded so a late fee cannot double-charge");
  s.close(); rmSync(dir, { recursive: true, force: true });
  console.log("PASS A control: a CONFIRMED fill is still superseded");
}
// --- B: the recovery gate ---
{
  const NOW = 2_000_000_000;
  const mk = (ageSec, ...statuses) => statuses.map((status, i) => ({ tradeId: `t${i}`, status, ts: NOW - ageSec }));
  assert.equal(hasProvisionalFills(mk(3, "MATCHED"), NOW), true, "B: a fresh MATCHED is provisional");
  assert.equal(hasProvisionalFills(mk(3, "MINED"), NOW), true, "B: a fresh MINED is provisional");
  assert.equal(hasProvisionalFills(mk(3, "RETRYING"), NOW), true, "B: a fresh RETRYING is provisional");
  assert.equal(hasProvisionalFills(mk(3, "MATCHED_NOT_BROADCASTED"), NOW), true, "B: a fresh MATCHED_NOT_BROADCASTED is provisional");
  assert.equal(hasProvisionalFills(mk(3, "CONFIRMED", "FAILED"), NOW), false, "B: only terminal fills => not provisional");
  assert.equal(hasProvisionalFills([{ tradeId: "legacy", ts: NOW }], NOW), false, "B: a fill with no status (legacy) is treated as terminal");
  assert.equal(hasProvisionalFills([], NOW), false, "B: no fills => not provisional");
  // Boundary (found by the joint review): a fill stuck at MATCHED forever — a
  // crash mid-trade, or a venue RETRYING loop — must NOT make every recovery
  // defer forever, or an UNKNOWN order would never be reconciled. Past the age
  // bound it is treated as stuck and recovery proceeds.
  assert.equal(hasProvisionalFills(mk(61, "MATCHED"), NOW), false, "B: a MATCHED fill older than the bound no longer blocks recovery");
  assert.equal(hasProvisionalFills(mk(3600, "RETRYING"), NOW), false, "B: an hour-old RETRYING fill no longer blocks recovery");
  assert.equal(hasProvisionalFills([...mk(3600, "MATCHED"), ...mk(2, "MINED")], NOW), true, "B: one fresh provisional fill still defers");
  console.log("PASS B: recovery gate defers only for recent provisional fills, never forever");
}
console.log("P1-7 OK");
