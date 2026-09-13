import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccountEquityState } from './account-equity.js';
import { createReservationState } from './account-reservation.js';
import { accountStateEnvelope, AccountStateStore } from './account-state-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function initial(root: string) {
  const account = '0x0000000000000000000000000000000000000001';
  return { root, account, envelope: accountStateEnvelope(account, 'live',
    createAccountEquityState(account, 'live'), createReservationState()) };
}

describe('account state store', () => {
  it('initializes, reopens and atomically writes one account/mode state', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'pm-account-')); roots.push(root);
    const ctx = initial(root);
    const store = new AccountStateStore(root, ctx.account, 'live', ctx.envelope);
    expect(store.read().account).toBe(ctx.account);
    store.write({ ...ctx.envelope, reservation: { ...ctx.envelope.reservation, halted: false } });
    store.close();
    const reopened = new AccountStateStore(root, ctx.account, 'live');
    expect(reopened.read()).toEqual(ctx.envelope);
    reopened.close();
  });

  it('fails closed when the checkpoint is changed or missing', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'pm-account-')); roots.push(root);
    const ctx = initial(root);
    const store = new AccountStateStore(root, ctx.account, 'live', ctx.envelope);
    fs.writeFileSync(store.statePath, '{}');
    expect(() => store.verifyBeforeSubmission()).toThrow(/checkpoint is missing or changed/);
    store.close();
  });

  it('prevents a second owner from acquiring the same account lock', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'pm-account-')); roots.push(root);
    const ctx = initial(root);
    const first = new AccountStateStore(root, ctx.account, 'live', ctx.envelope);
    expect(() => new AccountStateStore(root, ctx.account, 'live')).toThrow();
    first.close();
  });
});
