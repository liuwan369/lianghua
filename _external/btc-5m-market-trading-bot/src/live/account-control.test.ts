import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountExecutionGate } from './account-control.js';
import { createAccountEquityState, reduceAccountEquity, type EquitySnapshot } from './account-equity.js';
import { accountStateEnvelope, AccountStateStore } from './account-state-store.js';
import { createReservationState } from './account-reservation.js';

const account = '0x1111111111111111111111111111111111111111';
const openingAt = Date.parse('2026-09-12T16:00:00Z');
const currentAt = openingAt + 1000;
const snapshot = (id: string, sequence: number, atMs: number): EquitySnapshot => ({
  id, account, mode: 'live', sequence, atMs, complete: true, cashMicrousd: 50_000_000, positions: [],
});

let roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('account execution gate', () => {
  it('initializes from an explicit atomic opening/current account cut', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-account-gate-')); roots.push(root);
    const store = new AccountStateStore(root, account, 'live', accountStateEnvelope(
      account, 'live', createAccountEquityState(account, 'live'), createReservationState()));
    const gate = new AccountExecutionGate(store, Number.MAX_SAFE_INTEGER);
    const data = (checked_at: string, value = 50) => ({ wallet: account, read_only: true, pagination_atomic: true,
      checked_at, collateral: { available: true, complete: true, value }, positions: { available: true, complete: true, items: [] } });
    await gate.initialize(() => Promise.resolve({
      opening: data('2026-09-12T16:00:00.000Z'), current: data('2026-09-12T16:00:01.000Z'),
      cashFlows: { fromMs: openingAt, toMs: currentAt, complete: true, items: [] }, positionReleases: [],
    }), currentAt);
    expect(store.read().equity.day).toMatchObject({ riskDay: '2026-09-13', pnlMicrousd: 0 });
    store.close();
  });

  it('rejects an opening cut without its authoritative timestamp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-account-gate-')); roots.push(root);
    const store = new AccountStateStore(root, account, 'live', accountStateEnvelope(
      account, 'live', createAccountEquityState(account, 'live'), createReservationState()));
    const gate = new AccountExecutionGate(store, 30_000);
    const data = { wallet: account, read_only: true, pagination_atomic: true,
      collateral: { available: true, complete: true, value: 50 }, positions: { available: true, complete: true, items: [] } };
    await expect(gate.initialize(() => Promise.resolve({ opening: data, current: data,
      cashFlows: { fromMs: openingAt, toMs: currentAt, complete: true, items: [] }, positionReleases: [] }), currentAt)).rejects.toThrow('checked_at');
    store.close();
  });

  it('rejects a normal account read without a complete cash-flow evidence window', async () => {
    const opening = snapshot('opening', 1, openingAt);
    const current = snapshot('current', 2, currentAt);
    const equity = createAccountEquityState(account, 'live');
    const initialized = reduceAccountEquity(equity, {
      type: 'initialize', opening,
      current: { snapshot: current, previousSnapshotId: opening.id,
        cashFlows: { fromMs: openingAt, toMs: currentAt, complete: true, items: [] }, positionReleases: [] },
    }, currentAt, 30_000);
    const root = mkdtempSync(join(tmpdir(), 'pm-account-gate-')); roots.push(root);
    const store = new AccountStateStore(root, account, 'live', accountStateEnvelope(account, 'live', initialized.state, createReservationState()));
    const gate = new AccountExecutionGate(store, 30_000);
    const data = { wallet: account, read_only: true, pagination_atomic: true, checked_at: new Date(currentAt).toISOString(),
      collateral: { available: true, complete: true, value: 50 }, positions: { available: true, complete: true, items: [] } };
    await expect(gate.refresh(() => Promise.resolve(data), currentAt)).rejects.toThrow('reconciliation evidence');
    store.close();
  });

  it('preserves a reservation created while account reconciliation is awaiting the reader', async () => {
    const opening = snapshot('opening', 1, openingAt);
    const current = snapshot('current', 2, currentAt);
    const equity = createAccountEquityState(account, 'live');
    const initialized = reduceAccountEquity(equity, {
      type: 'initialize', opening,
      current: { snapshot: current, previousSnapshotId: opening.id,
        cashFlows: { fromMs: openingAt, toMs: currentAt, complete: true, items: [] }, positionReleases: [] },
    }, currentAt, 30_000);
    const root = mkdtempSync(join(tmpdir(), 'pm-account-gate-')); roots.push(root);
    const store = new AccountStateStore(root, account, 'live', accountStateEnvelope(account, 'live', initialized.state, createReservationState()));
    const gate = new AccountExecutionGate(store, Number.MAX_SAFE_INTEGER);
    const data = { wallet: account, read_only: true, pagination_atomic: true,
      checked_at: new Date(currentAt + 1000).toISOString(), collateral: { available: true, complete: true, value: 50 },
      positions: { available: true, complete: true, items: [] },
      cashFlows: { fromMs: openingAt, toMs: currentAt + 1000, complete: true, items: [] }, positionReleases: [] };
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    // The reader returns its checked_at after the await; the gate must use the
    // returned cut time rather than rejecting it as a future snapshot.
    const refreshing = gate.refresh(async () => { await pending; return data; }, currentAt);
    gate.prepare('during-refresh', 2, 0, currentAt + 500);
    release();
    await refreshing;
    expect(store.read().reservation.reservations[0]).toMatchObject({ id: 'during-refresh', amountMicrousd: 2_000_000 });
    store.close();
  });

  it('accepts a zero fee reserve while preserving the principal reservation', () => {
    const opening = snapshot('opening', 1, openingAt);
    const current = snapshot('current', 2, currentAt);
    const equity = createAccountEquityState(account, 'live');
    const initialized = reduceAccountEquity(equity, {
      type: 'initialize', opening,
      current: { snapshot: current, previousSnapshotId: opening.id,
        cashFlows: { fromMs: openingAt, toMs: currentAt, complete: true, items: [] }, positionReleases: [] },
    }, currentAt, 30_000);
    expect(initialized.applied).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'pm-account-gate-')); roots.push(root);
    const store = new AccountStateStore(root, account, 'live', accountStateEnvelope(account, 'live', initialized.state, createReservationState()));
    try {
      const gate = new AccountExecutionGate(store, Number.MAX_SAFE_INTEGER);
      gate.prepare('order-1', 2, 0, currentAt + 500);
      expect(store.read().reservation.reservations[0]).toMatchObject({ id: 'order-1', amountMicrousd: 2_000_000, feeReserveMicrousd: 0 });
    } finally { store.close(); }
  });

  it('does not stop a live market when the slow account read model ages past its TTL', () => {
    const opening = snapshot('opening', 1, openingAt);
    const current = snapshot('current', 2, currentAt);
    const equity = createAccountEquityState(account, 'live');
    const initialized = reduceAccountEquity(equity, {
      type: 'initialize', opening,
      current: { snapshot: current, previousSnapshotId: opening.id,
        cashFlows: { fromMs: openingAt, toMs: currentAt, complete: true, items: [] }, positionReleases: [] },
    }, currentAt, 30_000);
    const root = mkdtempSync(join(tmpdir(), 'pm-account-gate-')); roots.push(root);
    const store = new AccountStateStore(root, account, 'live', accountStateEnvelope(account, 'live', initialized.state, createReservationState()));
    const gate = new AccountExecutionGate(store, 30_000);
    expect(() => gate.verifyBeforeSubmissionFast(currentAt + 60_000)).not.toThrow();
    gate.prepare('after-reader-ttl', 2, 0, currentAt + 60_000);
    expect(store.read().reservation.reservations[0]).toMatchObject({
      id: 'after-reader-ttl', status: 'prepared', amountMicrousd: 2_000_000,
    });
    store.close();
  });

  it('durably records a reservation before a network submission can start', () => {
    const opening = snapshot('opening', 1, openingAt);
    const current = snapshot('current', 2, currentAt);
    const equity = createAccountEquityState(account, 'live');
    const initialized = reduceAccountEquity(equity, {
      type: 'initialize', opening,
      current: { snapshot: current, previousSnapshotId: opening.id,
        cashFlows: { fromMs: openingAt, toMs: currentAt, complete: true, items: [] }, positionReleases: [] },
    }, currentAt, 30_000);
    const root = mkdtempSync(join(tmpdir(), 'pm-account-gate-')); roots.push(root);
    const store = new AccountStateStore(root, account, 'live', accountStateEnvelope(account, 'live', initialized.state, createReservationState()));
    const gate = new AccountExecutionGate(store, Number.MAX_SAFE_INTEGER);
    gate.prepare('crash-window', 2, 0, currentAt + 500);
    expect(JSON.parse(fs.readFileSync(store.statePath, 'utf8')).reservation.reservations[0]).toMatchObject({
      id: 'crash-window', status: 'prepared', amountMicrousd: 2_000_000,
    });
    gate.transition('crash-window', 'submitted', currentAt + 501);
    expect(store.read().reservation.reservations[0].status).toBe('submitted');
    store.flushHot();
    expect(JSON.parse(fs.readFileSync(store.statePath, 'utf8')).reservation.reservations[0].status).toBe('submitted');
    store.close();
    expect(() => new AccountStateStore(root, account, 'live')).toThrow(/unresolved/);
  });
});
