import type { Market, Markets, PlatformRuntime, Resource, Status } from './api/types';
export const esc = (v: unknown) => String(v ?? '--').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
export const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export const number = (n: unknown, digits = 0) => finite(n) ? n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '--';
export const money = (n: unknown) => finite(n) ? `${n < 0 ? '-' : ''}$${number(Math.abs(n), 2)}` : '--';
export const price = (n: unknown) => finite(n) ? n.toFixed(4) : '--';
export const date = (s: unknown) => finite(s) ? new Date(s * 1000).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false}) : '--';
export const modeName = (mode: unknown) => mode === 'live' ? '实盘' : '未确定模式';
export function executionName(status: Status): string {
  if (status.engine === 'platform') return status.execution === 'strategy' ? '平台策略运行' : '平台观察';
  return status.execution_target === 'platform' ? '平台观察' : modeName(status.mode);
}
export function projectionUsable(status: Status | null) {
  const state = status?.projection?.state;
  return state === 'ready' || state === 'catching_up';
}
export function platformRuntime(status: Status | null, nowSeconds = Date.now() / 1000) {
  const candidate = status?.stats.runtime;
  const runtime = status?.engine === 'platform' && candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as PlatformRuntime).engine === 'platform' ? candidate as PlatformRuntime : null;
  const matched = !!status?.run_id && status.projection?.run_id === status.run_id;
  const freshSnapshot = !!runtime && matched && projectionUsable(status) && status.projection!.stale === false
    && runtime.stale === false && finite(runtime.source_at) && finite(runtime.expires_at)
    && runtime.source_at <= nowSeconds + 2 && runtime.expires_at >= runtime.source_at && nowSeconds < runtime.expires_at;
  return { runtime, current: freshSnapshot && status?.running === true && runtime?.status === 'running', freshSnapshot };
}
export const row = (label: string, value: string) => `<div class="row"><span>${esc(label)}</span><b>${value}</b></div>`;
export const stat = (label: string, value: string, caption: string) => `<div class="stat"><label>${esc(label)}</label><strong>${value}</strong><small>${esc(caption)}</small></div>`;
export const errorNote = (r: Resource<unknown>) => r.error ? `<p class="note bad" role="status">${esc(r.error)}</p>` : '';
export const empty = (message: string) => `<div class="empty">${esc(message)}</div>`;
export function set(id: string, html: string) { const node = document.getElementById(id); if (node) node.innerHTML = html; }
export const fresh = <T>(r: Resource<T>, now = Date.now()): T | null => r.data && now - r.receivedAt < 15000 ? r.data : null;
export function serverNow(r: Resource<Markets>, now = Date.now()) { return r.data ? r.data.asOf + (now - r.receivedAt) / 1000 : now / 1000; }
export function usableMarket(m: Market, r: Resource<Markets>, now = Date.now()): boolean {
  const data = fresh(r, now), clock = serverNow(r, now), quote = Date.parse(m.quote_at || '') / 1000;
  return !!data && data.collector_online && data.cache_age_seconds !== null && data.cache_age_seconds + (now-r.receivedAt)/1000 <= 15
    && [m.up_bid,m.up_ask,m.down_bid,m.down_ask].every(v=>finite(v)&&v>=0&&v<=1)
    && m.up_bid! <= m.up_ask! && m.down_bid! <= m.down_ask!
    && clock >= m.start && clock < m.end && Number.isFinite(quote) && clock - quote >= -2 && clock - quote <= 15;
}
export function marketMessage(r: Resource<Markets>, now = Date.now()) {
  if (r.error) return r.error;
  const data=fresh(r,now);
  if (!data) return '行情快照尚未获取或已过期';
  if (data.error_code === 'collector_connection_failed') return `${data.node_label}连接失败 · 请检查 SSH 配置或采集服务`;
  if (!data.collector_online) {
    if (data.cache_age_seconds === null || data.cache_age_seconds + (now-r.receivedAt)/1000 > 15)
      return `${data.node_label} · 行情快照已过期`;
    const reason = data.stale_reason || (data.collector_connected === false ? '行情连接已断开' : '等待有效盘口');
    return `${data.node_label} · ${data.collector_connected === true ? '已连接 · ' : ''}${reason}`;
  }
  if (!activeMarkets(r,now).length) return `${data.node_label} · 等待当前市场`;
  if (usableMarket(activeMarkets(r,now)[0],r,now)) return `行情已更新 · ${data.node_label}`;
  return `${data.node_label} · 盘口缺边、过期或价格异常`;
}
export function quotePair(m: Market, side: 'up' | 'down', usable: boolean) {
  return usable ? `${price(m[`${side}_bid`])} / ${price(m[`${side}_ask`])}` : '-- / --';
}
export function activeMarkets(r: Resource<Markets>, now = Date.now()) {
  const clock = serverNow(r, now);
  return (fresh(r,now)?.current_markets || []).filter(m => m.start <= clock && m.end > clock).sort((a,b) => a.end-b.end || a.slug.localeCompare(b.slug));
}
