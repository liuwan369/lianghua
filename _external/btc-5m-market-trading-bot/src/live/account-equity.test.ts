import { describe, expect, it } from 'vitest';
import { accountEquityView, createAccountEquityState, parseAccountEquityState, reduceAccountEquity,
  serializeAccountEquityState, type AccountEquityState, type EquityPosition, type EquityReconciliation,
  type EquitySnapshot, type ExternalCashFlow } from './account-equity.js';

const account = '0x1111111111111111111111111111111111111111';
const start = Date.parse('2026-09-12T16:00:00Z');
const nextDay = start + 86_400_000;
const scale = 1_000_000;
const maxAge = 5000;
const position = (quantity = 10, price = 0.5, atMs = start): EquityPosition => ({ conditionId: 'market', assetId: 'up',
  quantityMicros: quantity * scale, priceMicrousd: price * scale, pricedAtMs: atMs, valuation: 'liquidation_bid', complete: true });
const snapshot = (id: string, sequence: number, atMs: number, cash = 50, positions: EquityPosition[] = []): EquitySnapshot => ({
  id, sequence, account, mode: 'paper', atMs, complete: true, cashMicrousd: cash * scale, positions });
const flow = (id: string, kind: 'deposit' | 'withdrawal', amount: number, atMs = start + 1500): ExternalCashFlow => ({
  id, kind, amountMicrousd: amount * scale, atMs, confirmed: true });
const reconciliation = (previous: EquitySnapshot, current: EquitySnapshot, items: ExternalCashFlow[] = [], fromMs = start): EquityReconciliation => ({
  snapshot: current, previousSnapshotId: previous.id,
  cashFlows: { fromMs, toMs: current.atMs, complete: true, items }, positionReleases: [],
});
function initialize(cash = 50, positions: EquityPosition[] = []) {
  const opening = snapshot('opening', 0, start, cash, positions);
  const current = snapshot('current-1', 1, start + 1000, cash, positions.map(p => ({ ...p, pricedAtMs: start + 1000 })));
  return reduceAccountEquity(createAccountEquityState(account, 'paper'),
    { type: 'initialize', opening, current: reconciliation(opening, current) }, current.atMs, maxAge);
}
function advance(state: AccountEquityState, current: EquitySnapshot, items: ExternalCashFlow[] = []) {
  return reduceAccountEquity(state, { type: 'reconcile', current: reconciliation(state.day!.latest, current, items, state.day!.opening.atMs) }, current.atMs, maxAge);
}

describe('complete equity accounting contract', () => {
  it('starts unknown and keeps order authorization unavailable after valid accounting', () => {
    const empty = createAccountEquityState(account.toUpperCase(), 'paper');
    expect(accountEquityView(empty, start, maxAge)).toMatchObject({ execution_ready: false, accounting_ready: false,
      equity_microusd: null, daily_pnl_microusd: null, capital_limit_microusd: 50 * scale });
    const result = initialize(100, [position(40, 0.5)]);
    expect(result.applied).toBe(true);
    expect(result.view).toMatchObject({ accounting_ready: true, execution_ready: false, equity_microusd: 120 * scale,
      daily_pnl_microusd: 0, capital_limit_microusd: 50 * scale, daily_loss_limit_microusd: 30 * scale });
  });

  it('uses current per-position liquidation values and excludes deposits/withdrawals from PnL', () => {
    const state = initialize(40, [position(20, 0.5)]).state;
    const flows = [flow('deposit', 'deposit', 10), flow('withdrawal', 'withdrawal', 3)];
    const result = advance(state, snapshot('current-2', 2, start + 2000, 47, [position(20, 0.25, start + 2000)]), flows);
    expect(result.view.equity_microusd).toBe(52 * scale);
    expect(result.view.daily_pnl_microusd).toBe(-5 * scale);
    expect(result.state.knownCashFlows).toHaveLength(2);
  });

  it('does not subtract trading receipts or paid rewards as external capital', () => {
    const state = initialize().state;
    expect(advance(state, snapshot('reward', 2, start + 2000, 52)).view.daily_pnl_microusd).toBe(2 * scale);
    const invalid = advance(state, snapshot('invalid-reward', 2, start + 2000, 52),
      [{ ...flow('reward', 'deposit', 2), kind: 'reward' } as unknown as ExternalCashFlow]);
    expect(invalid.applied).toBe(false);
    expect(invalid.state.knownCashFlows).toEqual([]);
  });

  it('rejects non-string flow kinds instead of coercing array values', () => {
    const state = initialize().state;
    const invalid = advance(state, snapshot('invalid-kind', 2, start + 2000, 52),
      [{ ...flow('array-kind', 'deposit', 2), kind: ['deposit'] } as unknown as ExternalCashFlow]);
    expect(invalid.applied).toBe(false);
    expect(invalid.state.knownCashFlows).toEqual([]);
    expect(invalid.state.reconciliationIssue).toBe('unconfirmed_or_invalid_external_flow');
  });

  it('rejects non-string valuation kinds instead of coercing array values', () => {
    const state = initialize().state;
    const invalidPosition = { ...position(10, 0.25, start + 2000), valuation: ['confirmed_payout'] };
    const invalid = advance(state, snapshot('invalid-valuation', 2, start + 2000, 52,
      [invalidPosition as unknown as EquityPosition]));
    expect(invalid.applied).toBe(false);
    expect(invalid.state.day).toEqual(state.day);
    expect(invalid.state.reconciliationIssue).toBe('invalid_or_stale_position_valuation');
  });

  it('deduplicates identical flow IDs both within one packet and across cumulative windows', () => {
    const deposit = flow('same', 'deposit', 10);
    const first = advance(initialize().state, snapshot('current-2', 2, start + 2000, 60), [deposit, { ...deposit }]);
    expect(first.view.daily_pnl_microusd).toBe(0);
    expect(first.state.knownCashFlows).toHaveLength(1);
    const second = advance(first.state, snapshot('current-3', 3, start + 3000, 59), [deposit]);
    expect(second.view.daily_pnl_microusd).toBe(-scale);
    expect(second.state.knownCashFlows).toHaveLength(1);
    deposit.amountMicrousd = 999 * scale;
    expect(first.state.knownCashFlows[0].amountMicrousd).toBe(10 * scale);
  });

  it('rejects conflicting flow IDs and missing previously reconciled flows without changing the ledger', () => {
    const deposit = flow('same', 'deposit', 10);
    const state = advance(initialize().state, snapshot('current-2', 2, start + 2000, 59), [deposit]).state;
    for (const items of [[{ ...deposit, amountMicrousd: 20 * scale }], []]) {
      const rejected = advance(state, snapshot('current-3', 3, start + 3000, 60), items);
      expect(rejected.applied).toBe(false);
      expect(rejected.view.daily_pnl_microusd).toBeNull();
      expect(rejected.state.day).toEqual(state.day);
      expect(rejected.state.knownCashFlows).toEqual(state.knownCashFlows);
    }
  });

  it('requires confirmed flows and complete coverage of exactly the current day interval', () => {
    const state = initialize().state, current = snapshot('current-2', 2, start + 2000, 60);
    const packet = reconciliation(state.day!.latest, current, [flow('unconfirmed', 'deposit', 10)]);
    const cases = [
      { ...packet, cashFlows: { ...packet.cashFlows, complete: false } },
      { ...packet, cashFlows: { ...packet.cashFlows, fromMs: start + 1000 } },
      { ...packet, cashFlows: { ...packet.cashFlows, toMs: start + 1500 } },
      { ...packet, cashFlows: { ...packet.cashFlows, items: [{ ...flow('unconfirmed', 'deposit', 10), confirmed: false }] } },
      { ...packet, cashFlows: { ...packet.cashFlows, items: [flow('old', 'deposit', 10, start)] } },
      { ...packet, cashFlows: { ...packet.cashFlows, items: [flow('future', 'deposit', 10, start + 3000)] } },
    ];
    for (const current of cases) {
      const result = reduceAccountEquity(state, { type: 'reconcile', current }, start + 2000, maxAge);
      expect(result).toMatchObject({ applied: false, view: { execution_ready: false, accounting_ready: false, equity_microusd: null } });
      expect(result.state.day).toEqual(state.day);
    }
  });

  it('does not restate an already-complete historical interval with a newly discovered withdrawal', () => {
    const state = advance(initialize().state, snapshot('loss', 2, start + 2000, 30)).state;
    const result = advance(state, snapshot('late-correction', 3, start + 3000, 30), [flow('late-withdrawal', 'withdrawal', 20, start + 1500)]);
    expect(result.applied).toBe(false);
    expect(result.state.reconciliationIssue).toBe('external_flow_predates_complete_reconciliation');
    expect(result.state.day!.pnlMicrousd).toBe(-20 * scale);
    expect(result.state.knownCashFlows).toEqual([]);
  });

  it('requires reconciliation evidence for every position decrease, including full disappearance', () => {
    const state = initialize(45, [position()]).state;
    const current = snapshot('sold', 2, start + 2000, 49);
    const packet = reconciliation(state.day!.latest, current);
    const missing = reduceAccountEquity(state, { type: 'reconcile', current: packet }, current.atMs, maxAge);
    expect(missing.state.reconciliationIssue).toBe('unreconciled_position_reduction');
    expect(missing.state.day!.latest.positions).toHaveLength(1);
    packet.positionReleases = [{ conditionId: 'market', assetId: 'up', fromQuantityMicros: 10 * scale,
      toQuantityMicros: 0, evidenceId: 'confirmed-sale-receipt' }];
    const sold = reduceAccountEquity(missing.state, { type: 'reconcile', current: packet }, current.atMs, maxAge);
    expect(sold).toMatchObject({ applied: true, view: { accounting_ready: true, daily_pnl_microusd: -scale } });
    expect(sold.state.day!.latest.positions).toEqual([]);
    expect(state.day!.latest.positions).toHaveLength(1);
  });

  it('accepts confirmed zero payouts, zero quantity and conservative fractional valuation', () => {
    const state = initialize(49, [position(1, 1)]).state;
    const positions: EquityPosition[] = [
      { ...position(1, 0, start + 2000), valuation: 'confirmed_payout' },
      { ...position(0, 0, 0), assetId: 'empty', priceMicrousd: null },
      { ...position(0.000001, 0.5, start + 2000), assetId: 'fractional' },
    ];
    const result = advance(state, snapshot('zero-payout', 2, start + 2000, 49, positions));
    expect(result.applied).toBe(true);
    expect(result.view.equity_microusd).toBe(49 * scale);
    expect(result.view.daily_pnl_microusd).toBe(-scale);
  });

  it('preserves a sticky USD 30 loss stop after recovery, deposits and serialization', () => {
    const stopped = advance(initialize().state, snapshot('loss', 2, start + 2000, 20));
    expect(stopped.view).toMatchObject({ accounting_ready: true, paused: true, daily_pnl_microusd: -30 * scale });
    const restored = parseAccountEquityState(JSON.parse(serializeAccountEquityState(stopped.state)), account, 'paper');
    const recovered = advance(restored, snapshot('recovered', 3, start + 3000, 65), [flow('top-up', 'deposit', 10, start + 2500)]);
    expect(recovered.view.daily_pnl_microusd).toBe(5 * scale);
    expect(recovered.state.halted).toBe(true);
    expect(recovered.state.day!.lossLimitReached).toBe(true);
    expect(recovered.view).toMatchObject({ paused: true, reason: 'daily_loss_limit_reached', execution_ready: false });
  });

  it('does not halt one microdollar before the loss threshold', () => {
    const current = snapshot('near-loss', 2, start + 2000, 20);
    current.cashMicrousd!++;
    expect(advance(initialize().state, current).state.halted).toBe(false);
  });

  it('cannot replace the opening baseline after initialization', () => {
    const stopped = advance(initialize().state, snapshot('loss', 2, start + 2000, 20)).state;
    const opening = snapshot('new-opening', 3, start, 20);
    const result = reduceAccountEquity(stopped, { type: 'initialize', opening,
      current: reconciliation(opening, snapshot('new-current', 4, start + 3000, 20)) }, start + 3000, maxAge);
    expect(result.applied).toBe(false);
    expect(result.state.day!.pnlMicrousd).toBe(-30 * scale);
    expect(result.state.halted).toBe(true);
  });

  it('requires an explicit midnight baseline and does not seed one from a mid-day cash read', () => {
    const empty = createAccountEquityState(account, 'paper');
    const opening = snapshot('midday-opening', 0, start + 60_000);
    const current = snapshot('current', 1, start + 61_000);
    const result = reduceAccountEquity(empty, { type: 'initialize', opening,
      current: reconciliation(opening, current, [], opening.atMs) }, current.atMs, maxAge);
    expect(result.applied).toBe(false);
    expect(result.state.day).toBeNull();
    expect(result.view).toMatchObject({ equity_microusd: null, daily_pnl_microusd: null, execution_ready: false });
  });
});

describe('unknown data, ordering and persisted state', () => {
  it('rejects unknown/incomplete snapshots, duplicate holdings and cost prices masquerading as marks', () => {
    const state = initialize().state, base = snapshot('bad', 2, start + 2000, 50, [position(10, 0.5, start + 2000)]);
    const cases: EquitySnapshot[] = [
      { ...base, cashMicrousd: null }, { ...base, positions: null }, { ...base, complete: false },
      { ...base, cashMicrousd: -1 }, { ...base, cashMicrousd: 1.5 },
      { ...base, positions: [base.positions![0], base.positions![0]] },
      { ...base, positions: [{ ...base.positions![0], quantityMicros: null }] },
      { ...base, positions: [{ ...base.positions![0], priceMicrousd: null }] },
      { ...base, positions: [{ ...base.positions![0], complete: false }] },
      { ...base, positions: [{ ...base.positions![0], valuation: 'cost' } as unknown as EquityPosition] },
      { ...base, positions: [{ ...base.positions![0], valuation: 'confirmed_payout' }] },
      { ...base, positions: [{ ...base.positions![0], priceMicrousd: Number.NaN }] },
      { ...base, cashMicrousd: Number.MAX_SAFE_INTEGER },
    ];
    for (const current of cases) {
      const result = advance(state, current);
      expect(result).toMatchObject({ applied: false, view: { accounting_ready: false, equity_microusd: null, daily_pnl_microusd: null } });
      expect(result.state.day).toEqual(state.day);
    }
  });

  it('rejects stale/future snapshots or stale per-position marks and expires a once-valid view', () => {
    const state = initialize(45, [position()]).state;
    const current = snapshot('current-2', 2, start + 2000, 45, [position(10, 0.5, start + 2000)]);
    for (const now of [current.atMs - 1, current.atMs + maxAge + 1]) {
      const result = reduceAccountEquity(state, { type: 'reconcile', current: reconciliation(state.day!.latest, current) }, now, maxAge);
      expect(result.applied).toBe(false);
      expect(result.view.equity_microusd).toBeNull();
    }
    const staleMark = snapshot('stale-mark', 2, start + 10_000, 45, [position()]);
    expect(advance(state, staleMark).applied).toBe(false);
    expect(accountEquityView(state, start + 7000, maxAge)).toMatchObject({ equity_microusd: null, accounting_ready: false });
    const agingMark = snapshot('aging-mark', 2, start + 4000, 45, [position()]);
    const accepted = advance(state, agingMark).state;
    expect(accountEquityView(accepted, start + 6000, maxAge).reason).toBe('stale_position_valuation');
  });

  it('rejects duplicate and out-of-order reconciliation without changing daily losses', () => {
    const state = advance(initialize().state, snapshot('loss', 2, start + 2000, 20)).state;
    const cases = [snapshot('loss', 3, start + 3000, 50), snapshot('old-sequence', 1, start + 3000, 50),
      snapshot('old-time', 3, start + 1000, 50)];
    for (const current of cases) {
      const result = advance(state, current);
      expect(result.applied).toBe(false);
      expect(result.state.day!.pnlMicrousd).toBe(-30 * scale);
      expect(result.state.halted).toBe(true);
      expect(result.view.execution_ready).toBe(false);
    }
    const current = snapshot('wrong-link', 3, start + 3000, 50);
    const packet = { ...reconciliation(state.day!.latest, current), previousSnapshotId: 'unknown' };
    expect(reduceAccountEquity(state, { type: 'reconcile', current: packet }, current.atMs, maxAge).applied).toBe(false);
  });

  it('strictly validates serialized account identity, schema, budget, PnL and sticky stop', () => {
    const state = advance(initialize().state, snapshot('loss', 2, start + 2000, 20)).state;
    const mutate = (change: (value: AccountEquityState) => void) => { const value = structuredClone(state); change(value); return value; };
    const cases = [
      { ...state, extra: true }, { ...state, schemaVersion: 2 }, { ...state, capitalLimitMicrousd: 100 * scale },
      { ...state, dailyLossLimitMicrousd: 31 * scale }, { ...state, riskTimezone: 'UTC' }, { ...state, halted: false },
      mutate(v => { v.day!.pnlMicrousd = 0; }), mutate(v => { v.day!.lossLimitReached = false; }),
      mutate(v => { v.seenSnapshotIds.push(v.seenSnapshotIds[0]); }),
    ];
    for (const value of cases) expect(() => parseAccountEquityState(value, account, 'paper')).toThrow();
    expect(() => parseAccountEquityState(state, account, 'live')).toThrow();
    expect(() => parseAccountEquityState(state, `0x${'2'.repeat(40)}`, 'paper')).toThrow();
    const restored = parseAccountEquityState(JSON.parse(serializeAccountEquityState(state)), account, 'paper');
    expect(restored).toEqual(state);
    restored.day!.latest.cashMicrousd = 0;
    expect(state.day!.latest.cashMicrousd).toBe(20 * scale);
  });

  it('persists a transient reconciliation pause until a new valid packet arrives', () => {
    const initial = initialize().state;
    const rejected = advance(initial, { ...snapshot('missing', 2, start + 2000), cashMicrousd: null });
    const restored = parseAccountEquityState(JSON.parse(serializeAccountEquityState(rejected.state)), account, 'paper');
    expect(accountEquityView(restored, start + 2000, maxAge).accounting_ready).toBe(false);
    expect(advance(restored, snapshot('valid', 2, start + 3000)).view.accounting_ready).toBe(true);
  });
});

describe('explicit Beijing day rollover', () => {
  it('does not silently reset losses or discard inventory at 16:00 UTC', () => {
    const state = advance(initialize(45, [position()]).state,
      snapshot('loss', 2, start + 2000, 15, [position(10, 0.5, start + 2000)])).state;
    const implicit = advance(state, snapshot('next-day', 3, nextDay + 1000, 20));
    expect(implicit.applied).toBe(false);
    expect(implicit.state.day!.riskDay).toBe('2026-09-13');
    expect(implicit.state.day!.pnlMicrousd).toBe(-30 * scale);
    expect(implicit.state.day!.latest.positions).toHaveLength(1);
    expect(accountEquityView(state, nextDay, maxAge).accounting_ready).toBe(false);
  });

  it('closes the previous day, carries all positions, and preserves the halt and cash-flow IDs across restart', () => {
    const state = advance(initialize(45, [position()]).state,
      snapshot('loss', 2, start + 2000, 15, [position(10, 0.5, start + 2000)])).state;
    const deposit = flow('midnight-deposit', 'deposit', 5, nextDay);
    const boundary = snapshot('boundary', 3, nextDay, 20, [position(10, 0.5, nextDay)]);
    const current = snapshot('next-day', 4, nextDay + 1000, 20, [position(10, 0.4, nextDay + 1000)]);
    const result = reduceAccountEquity(state, { type: 'rollover',
      boundary: reconciliation(state.day!.latest, boundary, [deposit]),
      current: reconciliation(boundary, current, [], nextDay) }, current.atMs, maxAge);
    expect(result.applied).toBe(true);
    expect(result.state.closedDays[0]).toMatchObject({ riskDay: '2026-09-13', pnlMicrousd: -30 * scale,
      externalNetFlowMicrousd: 5 * scale, lossLimitReached: true });
    expect(result.state.day).toMatchObject({ riskDay: '2026-09-14', pnlMicrousd: -scale, lossLimitReached: false });
    expect(result.state.day!.opening.positions).toHaveLength(1);
    expect(result.state.halted).toBe(true);
    const restored = parseAccountEquityState(JSON.parse(serializeAccountEquityState(result.state)), account, 'paper');
    expect(restored).toEqual(result.state);
    expect(restored.knownCashFlows).toEqual([deposit]);
    expect(result.view.execution_ready).toBe(false);
  });

  it('requires the exact next midnight and fails the whole rollover atomically on missing position evidence or stale current data', () => {
    const state = initialize(45, [position()]).state;
    const boundary = snapshot('boundary', 2, nextDay, 50);
    const current = snapshot('next-day', 3, nextDay + 1000, 50);
    const event = { type: 'rollover', boundary: reconciliation(state.day!.latest, boundary),
      current: reconciliation(boundary, current, [], nextDay) };
    const dropped = reduceAccountEquity(state, event, current.atMs, maxAge);
    expect(dropped.applied).toBe(false);
    expect(dropped.state.day).toEqual(state.day);
    expect(dropped.state.closedDays).toEqual([]);
    event.boundary.positionReleases = [{ conditionId: 'market', assetId: 'up', fromQuantityMicros: 10 * scale,
      toQuantityMicros: 0, evidenceId: 'midnight-redemption' }];
    expect(reduceAccountEquity(state, event, current.atMs + maxAge + 1, maxAge).applied).toBe(false);
    expect(reduceAccountEquity(state, { ...event, boundary: { ...event.boundary, snapshot: { ...boundary, atMs: nextDay + 1 } } }, current.atMs, maxAge).applied).toBe(false);
    const accepted = reduceAccountEquity(state, event, current.atMs, maxAge);
    expect(accepted.applied).toBe(true);
    expect(accepted.state.closedDays[0].pnlMicrousd).toBe(0);
  });
});
