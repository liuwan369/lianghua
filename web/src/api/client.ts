import type { Account, Config, Events, Markets, Obj, Runs, Status, SummaryResponse } from './types';

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
    throw new Error('数据来源不明确，已清空该板块');
  let valid = false;
  if (kind === 'config') valid = integer(data.revision) && nullableString(data.savedAt) && object(data.params) && object(data.capabilities);
  if (kind === 'status') valid = typeof data.running === 'boolean' && typeof data.live_unlocked === 'boolean' && num(data.asOf)
    && nullableString(data.run_id) && nullableString(data.account_id) && nullableString(data.mode)
    && nullableNumber(data.config_revision) && object(data.params) && object(data.stats) && object(data.stop_result)
    && (data.projection === null || object(data.projection));
  if (kind === 'status' && object(data.stats) && data.stats.events !== undefined) valid = valid
    && Array.isArray(data.stats.events) && data.stats.events.every(e=>object(e) && typeof e.event==='string'
      && nullableString(e.market) && ['time','shares','price'].every(k=>nullableNumber(e[k])));
  if (kind === 'markets') valid = typeof data.collector_online === 'boolean' && typeof data.node_label === 'string'
    && num(data.asOf) && nullableNumber(data.cache_age_seconds) && Array.isArray(data.current_markets)
    && data.current_markets.every(m => object(m) && typeof m.slug === 'string' && num(m.start) && num(m.end)
      && ['up_bid','up_ask','down_bid','down_ask','ask_sum'].every(k => nullableNumber(m[k])) && nullableString(m.quote_at));
  if (kind === 'account') valid = typeof data.wallet === 'string' && typeof data.wallet_configured === 'boolean'
    && typeof data.owner_signer_configured === 'boolean' && typeof data.relayer_api_configured === 'boolean'
    && (data.last_check === null || object(data.last_check)) && nullableString(data.config_error);
  if (kind === 'account-data') valid = data.read_only === true && typeof data.stale === 'boolean'
    && nullableString(data.wallet) && nullableString(data.checked_at)
    && ['collateral','open_orders','trades','positions','closed_positions','activity'].every(k => {
      const s=data[k];return (data.stale === true && s===undefined) || object(s) && typeof s.available==='boolean' && typeof s.complete==='boolean'
        && typeof s.checked_at==='string' && Array.isArray(s.items) && s.items.every(object);
    });
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
  if (!valid) throw new Error('接口数据不完整，已清空该板块');
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
    if (controller.signal.aborted) throw new Error('读取超时，已清空旧数据');
    throw error;
  } finally { window.clearTimeout(timeout); }
}

// Mutation errors may originate in proxies. Never display request bodies or credentials.
export async function post(path: string, payload: Obj, timeoutMs = 15000): Promise<Obj> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok || !object(value) || value.ok !== true) {
      let message = object(value) && typeof value.error === 'string' ? value.error : '服务器未确认操作成功';
      for (const key of ['owner_key', 'relayer_key']) {
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
  config: () => get<Config>('config', '/api/v1/config'),
  status: () => get<Status>('status', '/api/v1/status'),
  markets: () => get<Markets>('markets', '/api/v1/markets'),
  account: () => get<Account>('account', '/api/account/status'),
  saveConfig: async (params: Obj, revision: number): Promise<Config> => {
    const value = await post('/api/v1/config', { params, expected_revision: revision });
    validate('config', value.status);
    return value.status as unknown as Config;
  },
  checkAccount: (payload: Obj) => post('/api/account/check', payload, 55000),
  saveAccount: (payload: Obj) => post('/api/account/save', payload, 55000),
  runs: (before?: number) => get<Runs>('runs', `/api/v1/runs?limit=50${before == null ? '' : `&before_id=${before}`}`),
  events: (run: string, before?: number) => get<Events>('events', `/api/v1/events?run_id=${encodeURIComponent(run)}&limit=50${before == null ? '' : `&before_id=${before}`}`),
  summary: (run: string) => get<SummaryResponse>('summary', `/api/v1/summary?run_id=${encodeURIComponent(run)}`),
};
