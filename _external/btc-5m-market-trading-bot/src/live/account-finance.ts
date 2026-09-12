/** Confirmed on-chain evidence; rates and account activity alone are not cash receipts. */
import { PUSD, USDC_E, CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE } from './contracts.js';
import type { Section } from './account-data.js';

type Row = Record<string, unknown>;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FILLED = '0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee';
const moneyTokens = new Set([PUSD.toLowerCase(), USDC_E.toLowerCase()]);
const exchanges = new Set([CTF_EXCHANGE.toLowerCase(), NEG_RISK_CTF_EXCHANGE.toLowerCase()]);
const address = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
const topicAddress = (v: unknown) => typeof v === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(v) ? `0x${v.slice(-40)}`.toLowerCase() : null;
const amount = (raw: bigint) => raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) / 1e6 : null;
const number = (v: unknown) => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) ? Number(v) : null;

/** Hard account contract supplied by the owner for the first bounded validation. */
export const ACCOUNT_RISK_LIMITS = Object.freeze({ capitalUsd: 50, dailyLossUsd: 30 });

export interface AccountRiskContract {
  capital_limit_usd: number;
  daily_loss_limit_usd: number;
  risk_timezone: 'Asia/Shanghai';
  source: 'owner-bounded-validation';
  read_only: true;
  execution_ready: false;
  required_before_execution: string[];
}

export function accountRiskContract(): AccountRiskContract {
  return { capital_limit_usd: ACCOUNT_RISK_LIMITS.capitalUsd, daily_loss_limit_usd: ACCOUNT_RISK_LIMITS.dailyLossUsd,
    risk_timezone: 'Asia/Shanghai', source: 'owner-bounded-validation', read_only: true, execution_ready: false,
    required_before_execution: ['reconciled_account_snapshot', 'pending_submission_and_settlement_reservations',
      'fee_and_allowance_validation', 'account_equity_daily_baseline_and_external_cash_flows', 'atomic_pre_submission_gate'] };
}

export function receiptEvidence(receipt: unknown, wallet: string, tx: string, confirmedHead: number): Row {
  const r = receipt as Row;
  if (!r || String(r.transactionHash).toLowerCase() !== tx.toLowerCase() || r.status !== '0x1'
      || typeof r.blockNumber !== 'string' || !/^0x[0-9a-f]+$/i.test(r.blockNumber) || !Array.isArray(r.logs)) throw new Error('receipt_invalid');
  const block = Number.parseInt(r.blockNumber, 16);
  if (!Number.isSafeInteger(block) || block > confirmedHead) throw new Error('receipt_unconfirmed');
  const transfers: Row[] = [], fees: Row[] = [];
  const seen = new Set<string>();
  for (const raw of r.logs) {
    const log = raw as Row;
    if (!log || log.removed === true || String(log.transactionHash).toLowerCase() !== tx.toLowerCase()
        || log.blockNumber !== r.blockNumber || typeof log.logIndex !== 'string' || !/^0x[0-9a-f]+$/i.test(log.logIndex)
        || !Array.isArray(log.topics) || typeof log.data !== 'string') throw new Error('receipt_log_invalid');
    if (seen.has(log.logIndex)) throw new Error('receipt_duplicate_log');
    seen.add(log.logIndex);
    const token = address(log.address), topics = log.topics.map(t => String(t).toLowerCase());
    if (token && moneyTokens.has(token) && topics[0] === TRANSFER && topics.length === 3 && /^0x[0-9a-f]{64}$/i.test(log.data)) {
      const from = topicAddress(topics[1]), to = topicAddress(topics[2]);
      if (from === wallet.toLowerCase() || to === wallet.toLowerCase()) {
        const value = amount(BigInt(log.data));
        if (value === null) throw new Error('amount_overflow');
        transfers.push({ transaction_hash: tx, log_index: log.logIndex, token, from, to, amount: value,
          net_amount: (to === wallet.toLowerCase() ? value : 0) - (from === wallet.toLowerCase() ? value : 0) });
      }
    }
    // Exchange V2 OrderFilled: maker side, token ID, maker amount, taker amount, fee, builder, metadata.
    // The fee is charged to the event's maker; do not assign counterparties' fees to this account.
    if (token && exchanges.has(token) && topics[0] === FILLED && topics.length === 4 && topicAddress(topics[2]) === wallet.toLowerCase()) {
      if (!/^0x[0-9a-f]{448}$/i.test(log.data)) throw new Error('fill_event_invalid');
      const fee = amount(BigInt(`0x${log.data.slice(2 + 64 * 4, 2 + 64 * 5)}`));
      if (fee === null) throw new Error('amount_overflow');
      fees.push({ transaction_hash: tx, log_index: log.logIndex, order_id: topics[1], amount: fee, token: PUSD.toLowerCase(), source: 'exchange-v2-order-filled' });
    }
  }
  return { transaction_hash: tx, block, block_hash: r.blockHash, transfers, fees };
}

export function balanceOccupancy(collateral: Section, orders: Section, positions?: Section) {
  let reserved = 0;
  let ordersValid = orders.available && orders.complete;
  let pendingBuyCount = 0;
  const orderIds = new Set<string>();
  for (const order of orders.items) {
    if (typeof order.id === 'string') {
      if (orderIds.has(order.id)) ordersValid = false;
      orderIds.add(order.id);
    }
    if (String(order.side).toUpperCase() === 'SELL') continue;
    const size = number(order.original_size), matched = number(order.size_matched), price = number(order.price);
    if (String(order.side).toUpperCase() !== 'BUY' || size === null || matched === null || price === null || size < matched || matched < 0 || price < 0 || price > 1) { ordersValid = false; continue; }
    reserved += (size - matched) * price;
    if (size > matched) pendingBuyCount++;
  }
  ordersValid = ordersValid && Number.isFinite(reserved) && reserved <= Number.MAX_SAFE_INTEGER / 1e6;
  let openPositionNotional = 0;
  let positionCount = 0;
  let positionsValid = !!(positions?.available && positions.complete);
  const positionIds = new Set<string>();
  if (positions) {
    for (const position of positions.items) {
      const key = JSON.stringify([position.conditionId, position.asset]);
      if (typeof position.asset !== 'string' || !position.asset || typeof position.conditionId !== 'string'
          || !position.conditionId || positionIds.has(key)) { positionsValid = false; continue; }
      positionIds.add(key);
      const size = number(position.size), avgPrice = number(position.avgPrice);
      if (size === null || size < 0 || (size > 0 && (avgPrice === null || avgPrice < 0 || avgPrice > 1))) {
        positionsValid = false; continue;
      }
      // Redeemable holdings are still occupied until the cash receipt is reconciled.
      openPositionNotional += size > 0 ? size * avgPrice! : 0;
      if (size > 0) positionCount++;
    }
  }
  positionsValid = positionsValid && Number.isFinite(openPositionNotional) && openPositionNotional <= Number.MAX_SAFE_INTEGER / 1e6;
  const balance = collateral.value;
  const collateralValid = collateral.available && collateral.complete && typeof balance === 'number'
    && Number.isFinite(balance) && balance >= 0 && balance <= Number.MAX_SAFE_INTEGER / 1e6;
  const cashOrdersValid = collateralValid && ordersValid;
  const combinedCost = reserved + openPositionNotional;
  const capitalOccupied = ordersValid && positionsValid && Number.isFinite(combinedCost)
    && combinedCost <= Number.MAX_SAFE_INTEGER / 1e6 ? combinedCost : null;
  const sources = [collateral, orders, ...(positions ? [positions] : [])];
  const times = sources.map(s => Date.parse(s.checked_at));
  const timesValid = times.every(Number.isFinite);
  return { available: cashOrdersValid, complete: false, open_buy_notional: ordersValid ? reserved : null,
    balance_after_open_buy_notional: cashOrdersValid ? Math.max(0, balance! - reserved) : null,
    spendable_balance: null, source: 'clob-balance-and-open-orders',
    observed: {
      collateral_balance_usd: collateralValid ? balance : null,
      open_buy_count: ordersValid ? pendingBuyCount : null,
      position_cost_usd: positionsValid ? openPositionNotional : null,
      position_count: positionsValid ? positionCount : null,
      capital_occupied_estimate_usd: capitalOccupied,
      capital_headroom_estimate_usd: capitalOccupied === null ? null : ACCOUNT_RISK_LIMITS.capitalUsd - capitalOccupied,
      cash_shortfall_estimate_usd: cashOrdersValid ? Math.max(0, reserved - balance!) : null,
      source_checks: { collateral: collateral.checked_at, open_orders: orders.checked_at, positions: positions?.checked_at ?? null },
      source_skew_ms: timesValid ? Math.max(...times) - Math.min(...times) : null,
      position_cost_basis: 'data-api-size-times-average-price-including-redeemable-holdings',
      estimate_inputs_complete: collateralValid && capitalOccupied !== null && timesValid,
    },
    unaccounted: ['non_atomic_cross_source_snapshot', 'unknown_submission_acknowledgements',
      'matched_trades_pending_chain_confirmation', 'unreconciled_fills_between_snapshots', 'fees_and_allowance_reservations'],
    reason: '非原子快照；占用为观测估算，未覆盖在途提交、待确认成交与费用预留，不作为可下单额度' };
}

export class AccountFinanceReader {
  private known = new Map<string, { checked: number; evidence?: Row }>();
  private cursor = 0;
  constructor(private readonly wallet: string) {}
  async read(rpc: Rpc, trades: Section, activity: Section, now = Date.now()) {
    const candidates = new Set<string>();
    for (const row of trades.items) if (row.status === 'CONFIRMED' && /^0x[0-9a-f]{64}$/i.test(String(row.transaction_hash))) candidates.add(String(row.transaction_hash).toLowerCase());
    for (const row of activity.items) if (/^0x[0-9a-f]{64}$/i.test(String(row.transactionHash))) candidates.add(String(row.transactionHash).toLowerCase());
    const dueAll = [...candidates].filter(tx => !this.known.get(tx)?.checked || now - this.known.get(tx)!.checked > 300_000);
    // Rotate the bounded batch so a stable first page cannot starve later hashes.
    const ordered = dueAll.slice(this.cursor).concat(dueAll.slice(0, this.cursor));
    const due = ordered.slice(0, 4);
    this.cursor = candidates.size ? (this.cursor + due.length) % candidates.size : 0;
    if (due.length) {
      try {
        const headRaw = await rpc('eth_blockNumber', []);
        if (typeof headRaw !== 'string' || !/^0x[0-9a-f]+$/i.test(headRaw)) throw new Error('head_invalid');
        const head = Number.parseInt(headRaw, 16) - 12;
        await Promise.all(due.map(async tx => {
          try { this.known.set(tx, { checked: now, evidence: receiptEvidence(await rpc('eth_getTransactionReceipt', [tx]), this.wallet, tx, head) }); }
          catch { this.known.set(tx, { checked: now }); }
        }));
      } catch { /* No successful receipt is fabricated on RPC failure. */ }
    }
    // Bound memory; only retain evidence for the current fetched account scope.
    for (const tx of this.known.keys()) if (!candidates.has(tx)) this.known.delete(tx);
    const evidence = [...candidates].flatMap(tx => {
      const entry = this.known.get(tx);
      return entry?.evidence && now - entry.checked <= 600_000 ? [entry.evidence] : [];
    });
    const fees = evidence.flatMap(row => row.fees as Row[]);
    const transfers = evidence.flatMap(row => row.transfers as Row[]);
    const payments: Row[] = [];
    // One receipt is matched once to the sum of the activity claims for that token transfer.
    for (const tx of candidates) {
      const claims = activity.items.filter(a => String(a.transactionHash).toLowerCase() === tx && ['REWARD', 'MAKER_REBATE', 'TAKER_REBATE'].includes(String(a.type)));
      if (!claims.length) continue;
      const values = claims.map(a => number(a.usdcSize));
      const expected = values.every(v => v !== null && v >= 0) ? values.reduce<number>((sum, v) => sum + v!, 0) : null;
      const incoming = transfers.filter(t => t.transaction_hash === tx && t.to === this.wallet.toLowerCase() && t.from !== this.wallet.toLowerCase());
      const tokens = new Set(incoming.map(t => t.token));
      const actual = incoming.reduce((sum, t) => sum + Number(t.amount), 0);
      const verified = expected !== null && expected > 0 && tokens.size === 1 && Math.abs(expected - actual) < 0.000001;
      payments.push({ transaction_hash: tx, timestamp: claims[0].timestamp, types: [...new Set(claims.map(a => a.type))], expected_amount: expected,
        received_amount: verified ? actual : null, token: verified ? [...tokens][0] : null, verified,
        status: verified ? 'confirmed_transfer_matches_activity' : 'unverified_or_mismatched' });
    }
    const base = { checked_at: new Date(now).toISOString(), source: 'polygon-confirmed-receipts', scope: 'transactions_in_fetched_account_data', historical_complete: false };
    return {
      fees: { ...base, available: fees.length > 0, complete: false, items: fees,
        known_amount: fees.length ? fees.reduce((sum, row) => sum + Number(row.amount), 0) : null, reason: '仅本钱包 OrderFilled 事件实际费用；未覆盖全部历史及所有收费路径' },
      rewards: { ...base, available: payments.some(p => p.verified), complete: false, items: payments, reason: '到账转账与活动金额核对；活动标签不证明项目资格或全历史完整' },
      reconciliation: { ...base, available: evidence.length > 0, complete: false, receipts_checked: evidence.length,
        receipts_pending: candidates.size - evidence.length, transfers, wallet_net_profit: null,
        reason: '只核对已获取交易哈希；尚无全历史资金转入转出及期初资产基线，不能生成钱包净收益' },
    };
  }
}
