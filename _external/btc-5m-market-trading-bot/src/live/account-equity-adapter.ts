import type { EquitySnapshot } from './account-equity.js';

type Row = Record<string, unknown>;
const SCALE = 1_000_000;

function row(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function amount(value: unknown, name: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  const micros = Math.round(n * SCALE);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(micros)) throw new Error(`invalid_${name}`);
  return micros;
}

/** Converts one account-data read into a conservative, same-cut equity snapshot. */
export function accountDataToEquitySnapshot(value: unknown, account: string, atMs = Date.now(), sequence = 1): EquitySnapshot {
  if (!row(value) || value.wallet !== account || value.read_only !== true || !Number.isSafeInteger(atMs) || atMs < 0
      || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('untrusted_account_snapshot');
  const collateral = value.collateral;
  const positions = value.positions;
  if (!row(collateral) || collateral.available !== true || collateral.complete !== true
      || typeof collateral.value !== 'number' || !Array.isArray(positions) || value.pagination_atomic !== false) {
    throw new Error('incomplete_account_snapshot');
  }
  const mapped = positions.map((item): NonNullable<EquitySnapshot['positions']>[number] => {
    if (!row(item) || typeof item.conditionId !== 'string' || typeof item.asset !== 'string'
        || item.size == null || item.curPrice == null) throw new Error('incomplete_position_snapshot');
    const quantityMicros = amount(item.size, 'position_size');
    const priceMicrousd = amount(item.curPrice, 'position_price');
    if (priceMicrousd > SCALE) throw new Error('invalid_position_price');
    return { conditionId: item.conditionId, assetId: item.asset, quantityMicros, priceMicrousd,
      pricedAtMs: atMs, valuation: 'liquidation_bid', complete: true };
  });
  return { id: `account-${account.toLowerCase()}-${atMs}-${sequence}`, account, mode: 'live', sequence, atMs,
    complete: true, cashMicrousd: amount(collateral.value, 'collateral'), positions: mapped };
}
