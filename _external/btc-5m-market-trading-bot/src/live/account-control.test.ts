import { afterEach, describe, expect, it } from 'vitest';
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
      gate.prepare('order-1', 2, 0);
      expect(store.read().reservation.reservations[0]).toMatchObject({ id: 'order-1', amountMicrousd: 2_000_000, feeReserveMicrousd: 0 });
    } finally { store.close(); }
  });
});
