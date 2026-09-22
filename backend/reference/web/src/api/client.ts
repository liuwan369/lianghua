import type { Account, Events, Markets, Obj, Runs, Status, SummaryResponse, SystemMetrics } from './types';

const object = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const nullableNumber = (v: unknown) => v === null || num(v);
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const integer = (v: unknown) => num(v) && Number.isInteger(v) && (v as number) >= 0;
export function validate(kind: string, data: unknown): void {
  if (!object(data) || (kind !== 'account' && data.schemaVersion !== 1)) throw new Error('接口版本或数据格式不兼容');
  if (data.control_source !== undefined && (!object(data.control_source)
    || !['local_preview','collector_host'].includes(String(data.control_source.scope))
    || typeof data.control_source.label !== 'string' || typeof data.control_source.market_node !== 'string'))
    throw new Error('数据来源不明确，保留上次快照并标记失败');
  let valid = false;
  if (kind === 'strategy-config') {
    const c = data.config;
    valid = data.strategyId === 'btc-reversal' && integer(data.savedRevision) && object(c)
      && ['triggerPrice','confirmationPrice','maxBuyPrice'].every(k => num(c[k]) && Number(c[k]) > 0 && Number(c[k]) < 1)
      && Array.isArray(c.stageShares) && c.stageShares.length > 0 && c.stageShares.every(v => num(v) && Number(v) > 0)
      && integer(c.maxStages) && c.maxStages === c.stageShares.length
      && ['roundBudgetUsd','totalBudgetUsd','dailyLossUsd'].every(k => nullableNumber(c[k]) && (c[k] === null || Number(c[k]) > 0))
      && num(c.durationMinutes) && Number(c.durationMinutes) >= 0 && c.mode === 'live'
      && num(c.maxQuoteAgeSeconds) && num(c.maxQuoteSkewSeconds);
  }
  if (kind === 'status') valid = typeof data.running === 'boolean' && typeof data.live_unlocked === 'boolean' && num(data.asOf)
    && nullableString(data.run_id) && nullableString(data.account_id) && nullableString(data.mode)
    && nullableNumber(data.config_revision) && object(data.params) && object(data.stats) && object(data.stop_result)
    && (data.projection === null || object(data.projection));
  if (kind === 'status' && object(data.stats) && data.stats.events !== undefined) valid = valid
    && Array.isArray(data.stats.events) && data.stats.events.every(e=>object(e) && typeof e.event==='string'
      && nullableString(e.market) && ['time','shares','price'].every(k=>nullableNumber(e[k])));
  if (kind === 'status') {
    valid = valid && (data.execution_target === undefined || data.execution_target === 'platform')
      && (data.engine === undefined || data.engine === null || data.engine === 'platform')
      && (data.execution === undefined || data.execution === null || ['observation','strategy'].includes(String(data.execution)))
      && (data.strategy_id === undefined || nullableString(data.strategy_id));
    const runtime = object(data.stats) ? data.stats.runtime : undefined;
    if (runtime !== undefined && runtime !== null) valid = valid && object(runtime) && runtime.engine === 'platform'
      && ['observation','strategy'].includes(String(runtime.execution)) && nullableString(runtime.strategy_id)
      && typeof runtime.status === 'string' && typeof runtime.mode === 'string'
      && num(runtime.source_at) && num(runtime.expires_at) && typeof runtime.stale === 'boolean'
      && ['cash_usd','positions_count','orders_count','active_orders','fills_count'].every(k => nullableNumber(runtime[k]))
      && (runtime.risk === null || object(runtime.risk)) && (runtime.limits === null || object(runtime.limits))
      && Array.isArray(runtime.markets) && runtime.markets.every(object) && Array.isArray(runtime.books) && runtime.books.every(object);
  }
  if (kind === 'markets') valid = typeof data.collector_online === 'boolean' && typeof data.node_label === 'string'
    && (data.collector_connected === undefined || typeof data.collector_connected === 'boolean')
    && (data.stale_reason === undefined || typeof data.stale_reason === 'string')
    && num(data.asOf) && nullableNumber(data.cache_age_seconds) && Array.isArray(data.current_markets)
    && data.current_markets.every(m => object(m) && typeof m.slug === 'string' && num(m.start) && num(m.end)
      && ['up_bid','up_ask','down_bid','down_ask','ask_sum'].every(k => nullableNumber(m[k])) && nullableString(m.quote_at));
  if (kind === 'account') valid = typeof data.wallet === 'string' && typeof data.wallet_configured === 'boolean'
    && typeof data.owner_signer_configured === 'boolean' && typeof data.relayer_api_configured === 'boolean'
    && typeof data.builder_api_configured === 'boolean'
    && (data.last_check === null || object(data.last_check)) && nullableString(data.config_error);
  if (kind === 'account-data') valid = data.read_only === true && typeof data.stale === 'boolean' && (data.error_code === undefined || typeof data.error_code === 'string')
    && nullableString(data.wallet) && nullableString(data.checked_at)
    && ['collateral','open_orders','trades','positions','closed_positions','activity'].every(k => {
      const s=data[k];return (data.stale === true && s===undefined) || object(s) && typeof s.available==='boolean' && typeof s.complete==='boolean'
        && typeof s.checked_at==='string' && Array.isArray(s.items) && s.items.every(object);
    });
  if (kind === 'account-data' && data.order_history !== undefined) {
    const s=data.order_history;
    valid=valid&&object(s)&&typeof s.available==='boolean'&&typeof s.complete==='boolean'
      &&typeof s.checked_at==='string'&&typeof s.source==='string'&&Array.isArray(s.items)
      &&s.items.every(o=>object(o)&&typeof o.id==='string'&&typeof o.status==='string'
        &&typeof o.status_stale==='boolean'&&typeof o.status_checked_at==='string')
      &&s.coverage==='observed_order_ids'&&s.historical_complete===false;
  }
  if (kind === 'account-data') {
    for (const key of ['fees','rewards','reconciliation']) {
      const s=data[key];
      if (s !== undefined && (!object(s) || typeof s.available!=='boolean' || typeof s.complete!=='boolean' || typeof s.checked_at!=='string' || !Number.isFinite(Date.parse(s.checked_at)) || (s.known_amount!==undefined && !nullableNumber(s.known_amount)) || (s.items!==undefined && (!Array.isArray(s.items)||!s.items.every(object))))) valid=false;
    }
    const tx=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
    if(object(data.fees)&&(!Array.isArray(data.fees.items)||!data.fees.items.every(f=>object(f)&&tx(f.transaction_hash)&&num(f.amount)&&(f.amount as number)>=0&&typeof f.token==='string')))valid=false;
    if(object(data.rewards)&&(!Array.isArray(data.rewards.items)||!data.rewards.items.every(p=>object(p)&&tx(p.transaction_hash)&&typeof p.verified==='boolean'&&nullableNumber(p.received_amount)&&(!p.verified||num(p.received_amount)&&(p.received_amount as number)>=0&&typeof p.token==='string'))))valid=false;
    if(object(data.reconciliation)&&(!integer(data.reconciliation.receipts_checked)||!integer(data.reconciliation.receipts_pending)||!nullableNumber(data.reconciliation.wallet_net_profit)))valid=false;
    const o=data.occupancy;
    if (o!==undefined && (!object(o)||typeof o.available!=='boolean'||typeof o.complete!=='boolean'||!nullableNumber(o.open_buy_notional)||!nullableNumber(o.balance_after_open_buy_notional)||!nullableNumber(o.spendable_balance))) valid=false;
  }
  if (kind === 'orders') valid = Array.isArray(data.orders) && data.orders.every(o => object(o) && typeof o.status === 'string' && typeof o.client_order_id === 'string' && nullableString(o.order_id)) && integer(data.total) && integer(data.limit) && integer(data.offset) && typeof data.has_more === 'boolean' && num(data.asOf) && integer(data.snapshotEventId);
  if (kind === 'runs') valid = nullableNumber(data.next_before_id) && Array.isArray(data.runs) && data.runs.every(r => object(r)
    && integer(r.id) && typeof r.run_id === 'string' && typeof r.mode === 'string' && nullableString(r.account_id) && num(r.created_at));
  if (kind === 'events') valid = typeof data.run_id === 'string' && nullableNumber(data.next_before_id) && Array.isArray(data.events)
    && data.events.every(e => object(e) && integer(e.id) && typeof e.event === 'string' && nullableString(e.market)
      && nullableString(e.side) && ['time','price','shares','amount','fee','pnl'].every(k => nullableNumber(e[k])));
  if (kind === 'summary') {
    const s = data.summary;
    valid = object(s) && typeof s.run_id === 'string' && typeof s.mode === 'string' && nullableString(s.account_id)
      && integer(s.fill_count) && integer(s.settled_markets) && ['fill_notional','fees','settled_pnl'].every(k => nullableNumber(s[k]))
      && typeof s.completeness === 'string' && typeof s.pnl_semantics === 'string' && typeof s.order_lifecycle_available === 'boolean';
  }
  if (kind === 'system-metrics') {
    const metric=(v:unknown,keys:string[])=>object(v)&&keys.every(key=>key in v&&nullableNumber(v[key]));
    const nonnegative=(v:unknown)=>v===null||integer(v);
    valid=nullableNumber(data.asOf)&&metric(data.cpu,['percent','cores'])&&metric(data.load,['one','five','fifteen'])
      &&metric(data.memory,['used_bytes','total_bytes','percent'])&&metric(data.disk,['used_bytes','total_bytes','free_bytes','percent'])
      &&object(data.services)&&Object.values(data.services).every(s=>object(s)&&typeof s.state==='string'
        &&nonnegative(s.pid)&&nullableNumber(s.rss_bytes)&&nullableNumber(s.uptime_seconds))
      &&nullableNumber(data.journal_backlog)&&nullableNumber(data.event_loop_lag_ms);
  }
  if (!valid) throw new Error('接口数据不完整，保留上次快照并标记失败');
}

export async function get<T>(kind: string, path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(path, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 401 ? '登录已失效，请重新登录后刷新' : `读取失败（HTTP ${response.status}）`);
    const value: unknown = await response.json();
    validate(kind, value);
    return value as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('读取超时，保留上次快照并标记失败');
    throw error;
  } finally { window.clearTimeout(timeout); }
}

export function mutationHeaders(): Record<string,string> {
  const tokenField=document.querySelector<HTMLInputElement>('#controlToken');
  const token=tokenField?.dataset.applied==='true' ? tokenField.value.trim() : '';
  return {'Content-Type':'application/json',...(token?{'X-PM-Control-Token':token}:{})};
}
export function mutationError(value:unknown,status:number):string {
  if(status===401) return '交易控制会话已失效，请在设置 → 账户接入重新保存交易控制密码';
  let message=object(value)&&typeof value.error==='string'?value.error:`操作失败（HTTP ${status}）`;
  const token=document.querySelector<HTMLInputElement>('#controlToken')?.value.trim();
  if(token)message=message.split(token).join('[已隐藏]');
  return message.replace(/(?:0x)?[a-fA-F0-9]{64}/g,'[已隐藏]').slice(0,240);
}

// Mutation errors may originate in proxies. Never display request bodies or credentials.
export async function post(path: string, payload: Obj, timeoutMs = 15000, extraHeaders: Record<string,string> = {}): Promise<Obj> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {...mutationHeaders(), ...extraHeaders}, body: JSON.stringify(payload), signal: controller.signal });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok || !object(value) || value.ok !== true) {
      let message = mutationError(value,response.status);
      for (const key of ['owner_key', 'relayer_key', 'builder_api_key', 'builder_secret', 'builder_passphrase']) {
        const secret = payload[key];
        if (typeof secret === 'string' && secret) message = message.split(secret).join('[已隐藏]');
      }
      message = message.replace(/(?:0x)?[a-fA-F0-9]{64}/g, '[已隐藏]').slice(0, 240);
      throw new Error(`${message}（HTTP ${response.status}）`);
    }
    return value;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('请求超时，结果尚未确认；请刷新核对后重试，草稿已保留');
    if (error instanceof TypeError) throw new Error('网络请求失败，结果尚未确认；草稿已保留');
    throw error;
  } finally { window.clearTimeout(timeout); }
}
export const api = {
  status: () => get<Status>('status', '/api/v1/status'),
  markets: () => get<Markets>('markets', '/api/v1/markets'),
  account: () => get<Account>('account', '/api/account/status'),
  checkAccount: (payload: Obj) => post('/api/account/check', payload, 55000),
  saveAccount: (payload: Obj) => post('/api/account/save', payload, 55000),
  saveControlSession: (token: string) => post('/api/trading/auth/session', {}, 15000, {'X-PM-Control-Token': token}),
  runs: (before?: number) => get<Runs>('runs', `/api/v1/runs?limit=50${before == null ? '' : `&before_id=${before}`}`),
  events: (run: string, before?: number) => get<Events>('events', `/api/v1/events?run_id=${encodeURIComponent(run)}&limit=50${before == null ? '' : `&before_id=${before}`}`),
  summary: (run: string) => get<SummaryResponse>('summary', `/api/v1/summary?run_id=${encodeURIComponent(run)}`),
  systemMetrics: () => get<SystemMetrics>('system-metrics', '/api/v1/system-metrics'),
};
