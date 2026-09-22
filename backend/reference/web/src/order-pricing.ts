import type { Obj } from './api/types';

function numeric(value: unknown): number | null {
  const result = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? result : null;
}

/** Calculates the weighted average from confirmed fill records, never from the limit price. */
export function weightedAverageFillPrice(fills: Obj[]): number | null {
  let shares = 0;
  let notional = 0;
  for (const fill of fills) {
    const status = String(fill.trade_status ?? fill.status ?? '').toUpperCase();
    if (status !== 'CONFIRMED') continue;
    const quantity = numeric(fill.shares ?? fill.size);
    const fillPrice = numeric(fill.price);
    if (quantity === null || quantity <= 0 || fillPrice === null || fillPrice < 0) continue;
    shares += quantity;
    notional += quantity * fillPrice;
  }
  return shares > 0 ? notional / shares : null;
}
