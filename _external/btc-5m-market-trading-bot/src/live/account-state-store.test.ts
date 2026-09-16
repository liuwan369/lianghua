import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountEquityState } from './account-equity.js';
import { createReservationState, prepareReservation, transitionReservation } from './account-reservation.js';
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

  it('fails closed on a hot checkpoint error and still releases the owner lock', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'pm-account-')); roots.push(root);
    const ctx = initial(root);
    const store = new AccountStateStore(root, ctx.account, 'live', ctx.envelope);
    store.writeHot(ctx.envelope);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('injected hot write failure'); });
    expect(() => store.flushHot()).toThrow(/hot checkpoint failed/);
    rename.mockRestore();
    store.close();
    const reopened = new AccountStateStore(root, ctx.account, 'live');
    reopened.close();
  });

  it('fails closed when a durable checkpoint write fails', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'pm-account-')); roots.push(root);
    const ctx = initial(root);
    const store = new AccountStateStore(root, ctx.account, 'live', ctx.envelope);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('injected durable write failure'); });
    expect(() => store.write(ctx.envelope)).toThrow(/checkpoint failed/);
    rename.mockRestore();
    expect(() => store.verifyBeforeSubmission()).toThrow(/unavailable/);
    store.close();
  });

  it('coalesces lifecycle checkpoints without writing on the calling stack', async () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'pm-account-')); roots.push(root);
    const ctx = initial(root);
    const store = new AccountStateStore(root, ctx.account, 'live', ctx.envelope);
    const prepared = prepareReservation(ctx.envelope.reservation, 'order-1', 2_000_000, 0, 1000).state;
    store.write({ ...ctx.envelope, reservation: prepared });
    const before = fs.readFileSync(store.statePath, 'utf8');
    const rename = vi.spyOn(fs, 'renameSync');
    const sync = vi.spyOn(fs, 'fsyncSync');
    try {
      const submitted = transitionReservation(prepared, 'order-1', 'submitted', 1001).state;
      store.writeHot({ ...ctx.envelope, reservation: submitted });
      const latest = { ...ctx.envelope,
        reservation: transitionReservation(submitted, 'order-1', 'acknowledged', 1002).state };
      store.writeHot(latest);
      expect(store.read()).toEqual(latest);
      expect(fs.readFileSync(store.statePath, 'utf8')).toBe(before);
      expect(rename).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(JSON.parse(fs.readFileSync(store.statePath, 'utf8'))).toEqual(latest);
      expect(rename).toHaveBeenCalledTimes(process.platform === 'win32' ? 2 : 1);
      expect(sync).not.toHaveBeenCalled();
    } finally {
      rename.mockRestore();
      sync.mockRestore();
      store.close();
    }
  });
});
