import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectAtomicAccountReader, validateAtomicAccountCut } from './account-data.js';

const wallet = '0x1111111111111111111111111111111111111111';
const section = (token: string, items: Record<string, unknown>[] = []) => ({
  available: true, complete: true, items, pages: 1, checked_at: '2026-09-13T00:00:00.000Z', source: 'provider-atomic', snapshot_token: token,
});
const cut = (token: string, checkedAt = '2026-09-13T00:00:00.000Z') => ({
  schemaVersion: 2, wallet, read_only: true, pagination_atomic: true, checked_at: checkedAt, atomic_snapshot_token: token,
  collateral: section(token), positions: section(token, [{ conditionId: 'c1', asset: 'a1', size: '1', liquidation_bid: '0.4', valuation: 'liquidation_bid' }]),
});
const packet = () => ({
  schemaVersion: 1, wallet, bootstrap_token: 'bootstrap-20260913', opening: cut('opening-20260913'), current: cut('current-20260913', '2026-09-13T00:00:01.000Z'),
  cashFlows: { fromMs: Date.parse('2026-09-12T16:00:00.000Z'), toMs: Date.parse('2026-09-13T00:00:01.000Z'), complete: true, items: [] }, positionReleases: [],
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('provider-owned atomic account source', () => {
  it('accepts a complete cut with matching immutable section token', () => {
    expect(validateAtomicAccountCut(cut('cut-20260913'), wallet)).toMatchObject({ pagination_atomic: true, atomic_snapshot_token: 'cut-20260913' });
  });

  it('rejects a section from a different source transaction', () => {
    const value = cut('cut-20260913');
    value.positions.snapshot_token = 'other-cut';
    expect(() => validateAtomicAccountCut(value, wallet)).toThrow('atomic_positions_incomplete');
  });

  it('rejects estimated positions without explicit liquidation evidence', () => {
    const value = cut('cut-20260913');
    delete value.positions.items[0].liquidation_bid;
    expect(() => validateAtomicAccountCut(value, wallet)).toThrow('atomic_position_invalid');
  });

  it('fails closed when no provider source is configured', async () => {
    await expect(connectAtomicAccountReader(wallet)).rejects.toThrow('atomic_account_source_unavailable');
  });

  it('fetches and validates the provider bootstrap packet while binding the wallet', async () => {
    vi.stubEnv('PM_ATOMIC_ACCOUNT_URL', 'https://provider.example/atomic-bootstrap');
    const calls: { url: URL; method?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input, options) => {
      calls.push({ url: new URL(input as string), method: options?.method });
      return { ok: true, json: async () => packet() };
    }));
    const read = await connectAtomicAccountReader(wallet);
    const result = await read();
    expect(result).toMatchObject({ opening: { atomic_snapshot_token: 'opening-20260913' }, current: { atomic_snapshot_token: 'current-20260913' } });
    expect(calls[0]).toMatchObject({ method: 'GET' });
    expect(calls[0].url.searchParams.get('wallet')).toBe(wallet);
  });

  it('rejects a provider packet with missing cash-flow evidence', async () => {
    vi.stubEnv('PM_ATOMIC_ACCOUNT_URL', 'https://provider.example/atomic-bootstrap');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ...packet(), cashFlows: { complete: false, items: [] } }) })));
    const read = await connectAtomicAccountReader(wallet);
    await expect(read()).rejects.toThrow('atomic_cash_flow_evidence_missing');
  });
});
