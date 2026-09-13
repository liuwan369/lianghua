import { describe, expect, it } from 'vitest';
import { accountDataToEquitySnapshot } from './account-equity-adapter.js';

const base = {
  wallet: '0x0000000000000000000000000000000000000001', read_only: true, pagination_atomic: false,
  collateral: { available: true, complete: true, value: 12.5 },
  positions: { available: true, complete: true, items: [{ conditionId: 'c1', asset: 'a1', size: '3.5', liquidation_bid: 0.4, valuation: 'liquidation_bid' }] },
};

describe('account data equity adapter', () => {
  it('maps collateral and every position at one observation cut', () => {
    const snapshot = accountDataToEquitySnapshot({ ...base, pagination_atomic: true }, base.wallet, 1_700_000_000_000, 4);
    expect(snapshot).toMatchObject({ account: base.wallet, cashMicrousd: 12_500_000, sequence: 4, atMs: 1_700_000_000_000 });
    expect(snapshot.positions?.[0]).toMatchObject({ conditionId: 'c1', quantityMicros: 3_500_000, priceMicrousd: 400_000, pricedAtMs: snapshot.atMs });
  });

  it.each([
    ['wrong wallet', { ...base, wallet: '0x0000000000000000000000000000000000000002' }],
    ['incomplete collateral', { ...base, collateral: { ...base.collateral, complete: false } }],
    ['missing position price', { ...base, pagination_atomic: true, positions: { ...base.positions, items: [{ ...base.positions.items[0], liquidation_bid: null, valuation: 'liquidation_bid' }] } }],
    ['current price is not liquidation evidence', { ...base, pagination_atomic: true, positions: { ...base.positions, items: [{ ...base.positions.items[0], liquidation_bid: undefined, curPrice: 0.4, valuation: 'liquidation_bid' }] } }],
    ['non-atomic pagination', { ...base }],
    ['current estimate without liquidation marker', { ...base, pagination_atomic: true, positions: { ...base.positions, items: [{ ...base.positions.items[0], valuation: undefined }] } }],
    ['incomplete positions section', { ...base, pagination_atomic: true, positions: { ...base.positions, complete: false } }],
  ])('rejects %s evidence', (_name, value) => {
    expect(() => accountDataToEquitySnapshot(value, base.wallet, 1_700_000_000_000)).toThrow();
  });
});
