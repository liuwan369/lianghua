import { get, validate, mutationHeaders, mutationError } from '../api/client';
import type { Obj } from '../api/types';

export interface ReversalConfig extends Obj {
  triggerPrice: number; confirmationPrice: number; maxBuyPrice: number; stageShares: number[]; maxStages: number;
  roundBudgetUsd: number | null; totalBudgetUsd: number | null; dailyLossUsd: number | null;
  durationMinutes: number; mode: 'live'; maxQuoteAgeSeconds: number; maxQuoteSkewSeconds: number;
}
export interface StrategyConfig { schemaVersion: 1; strategyId: 'btc-reversal'; savedRevision: number; config: ReversalConfig; savedAt?: string | null; activeRevision?: number | null; nextRoundRevision?: number | null }
const input = (key: string, label: string, unit: string, help: string, optional = false) => `<div class="field"><label for="reversal-${key}">${label}</label><div class="settings-unit"><input id="reversal-${key}" data-reversal-field="${key}" type="number" step="any" min="${optional || key === 'durationMinutes' ? '0' : '0.01'}" ${optional ? 'placeholder="未设置"' : 'required'} ${key.includes('Price') ? 'max="99.99"' : ''}><span>${unit}</span></div><small>${help}</small></div>`;
export const strategyPageMarkup = `<div class="head"><div><h1>策略</h1><p>选择策略后设置参数，保存后由服务器持续执行。</p></div><span class="chip" data-strategy-state>读取配置中</span></div>
<nav class="strategy-list" aria-label="策略选择"><button type="button" class="strategy-list-item active" data-strategy-id="btc-reversal"><strong>BTC 五分钟反转</strong><span>跟随方向反转，分阶段买入</span></button></nav>
<section class="panel strategy-active"><div class="section-title"><h2>BTC 五分钟反转</h2><span class="muted" data-strategy-revision>等待服务器配置</span></div>
<nav class="subnav" aria-label="策略设置"><button type="button" class="active" data-strategy-tab="parameters" aria-selected="true">策略参数</button><button type="button" data-strategy-tab="run" aria-selected="false">运行设置</button></nav>
<form data-reversal-form><div data-strategy-panel="parameters"><div class="strategy-presets"><span>参考参数</span><button type="button" data-reversal-preset="70">70 美分参考</button><button type="button" data-reversal-preset="75">75 美分参考</button><small>填入后可继续修改，保存才会生效。</small></div><div class="settings-form"><h3 class="settings-group">触发与买入价格</h3><div class="form">${input('triggerPrice','触发价','美分','卖一从下方跨过此价格时触发。')}${input('confirmationPrice','反转确认价','美分','用于记录方向确认，不延迟下一阶段下单。')}${input('maxBuyPrice','最高买入价','美分','买入限价，不追高；未成交的余量继续挂单。')}</div><h3 class="settings-group">每阶段新增份额</h3><div class="section-title"><p class="muted">新方向反转时进入下一阶段，同方向不重复加仓。</p><label>阶段数 <input id="reversal-maxStages" type="number" min="1" max="100" step="1" required aria-label="最大阶段数"></label></div><div class="form stage-inputs" data-reversal-stages></div></div></div>
<div data-strategy-panel="run" hidden><div class="settings-form"><h3 class="settings-group">资金与运行时间</h3><div class="form">${input('roundBudgetUsd','单场资金上限','USD','包括本场持仓、未完成买单和费用预留；留空不设置额外上限。',true)}${input('totalBudgetUsd','策略总资金上限','USD','限制本策略同时占用的资金；仍受账户真实可用余额约束。',true)}${input('dailyLossUsd','每日亏损停止线','USD','可选。达到后暂停新增订单，继续处理已有订单与持仓。',true)}${input('durationMinutes','运行时长','分钟','0 表示持续运行，直到手动停止；修改运行时长在下次启动生效。')}</div><div class="note">真实交易 · 价格、阶段和预算下一场生效，运行时长下次启动生效；关闭页面不会停止服务器。暂停新增保留现有订单，停止会撤销余量，已成交持仓保留。</div></div></div>
<div class="settings-footer"><span data-reversal-dirty class="muted"></span><div class="settings-actions"><button type="button" data-reversal-reset>撤销修改</button><button type="submit" class="primary" data-reversal-save>保存策略</button></div></div><p class="settings-feedback" data-reversal-message role="status" aria-live="polite"></p></form></section>`;

export function mountStrategy() {
  const root = document.getElementById('view-strategy');
  if (!root) return;
  root.querySelectorAll<HTMLButtonElement>('[data-strategy-tab]').forEach(button => button.addEventListener('click', () => {
    root.querySelectorAll<HTMLButtonElement>('[data-strategy-tab]').forEach(tab => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
    root.querySelectorAll<HTMLElement>('[data-strategy-panel]').forEach(panel => panel.hidden = panel.dataset.strategyPanel !== button.dataset.strategyTab);
  }));
}

export function connectStrategy(saved?: (value: StrategyConfig) => void) {
  const root = document.getElementById('view-strategy')!;
  const form = root.querySelector<HTMLFormElement>('form')!;
  const count = root.querySelector<HTMLInputElement>('#reversal-maxStages')!;
  let latest: StrategyConfig | null = null, baseline: StrategyConfig | null = null, dirty = false, busy = false, closed = false, loading = false, revisionEpoch = 0;
  const listeners: Array<() => void> = [];
  const on = (el: Element, event: string, fn: EventListener) => { el.addEventListener(event, fn); listeners.push(() => el.removeEventListener(event, fn)); };
  const message = (value: string) => { root.querySelector('[data-reversal-message]')!.textContent = value; };
  const fields = Array.from(root.querySelectorAll<HTMLInputElement>('[data-reversal-field]'));
  const shares = () => Array.from(root.querySelectorAll<HTMLInputElement>('[data-reversal-share]'));
  function markDirty() { if (!dirty) baseline = latest; dirty = true; root.querySelector('[data-reversal-dirty]')!.textContent = '修改尚未保存'; }
  function stageInputs(values: Array<number | string>) {
    root.querySelector('[data-reversal-stages]')!.innerHTML = values.map((value, i) => `<div class="field"><label for="reversal-stage-${i}">第 ${i + 1} 阶段</label><div class="settings-unit"><input id="reversal-stage-${i}" data-reversal-share type="number" min="0.01" step="any" required value="${typeof value === 'number' && Number.isFinite(value) ? value : ''}"><span>份</span></div></div>`).join('');
  }
  function populate(config: ReversalConfig) {
    fields.forEach(field => { const value = config[field.dataset.reversalField!]; field.value = value === null || value === undefined ? '' : String(field.dataset.reversalField!.includes('Price') ? Math.round(Number(value) * 10000) / 100 : value); });
    count.value = String(config.maxStages); stageInputs(config.stageShares.slice(0, config.maxStages));
  }
  function controls() { root.querySelectorAll<HTMLButtonElement>('[data-reversal-save],[data-reversal-reset],[data-reversal-preset]').forEach(b => b.disabled = busy || !latest); fields.forEach(f => f.disabled = busy); count.disabled = busy; shares().forEach(f => f.disabled = busy); }
  function receive(value: StrategyConfig) {
    latest = value;
    if (!dirty) { baseline = value; populate(value.config); }
    root.querySelector('[data-strategy-state]')!.textContent = `已保存版本 ${value.savedRevision}`;
    root.querySelector('[data-strategy-revision]')!.textContent = `当前运行版本 ${value.activeRevision ?? '--'} · 下一场版本 ${value.nextRoundRevision ?? value.savedRevision}`;
    controls(); saved?.(value);
  }
  async function refresh() {
    if (closed || loading || busy) return; loading = true; const epoch = revisionEpoch;
    try { const value = await get<StrategyConfig>('strategy-config', '/api/strategy-config'); if (!closed && epoch === revisionEpoch && (!latest || value.savedRevision >= latest.savedRevision)) receive(value); }
    catch (error) { if (!closed && epoch === revisionEpoch) { root.querySelector('[data-strategy-state]')!.textContent = '配置读取失败'; message(error instanceof Error ? error.message : '配置读取失败，已保留修改'); } }
    finally { loading = false; }
  }
  on(form, 'input', markDirty);
  on(count, 'change', () => { if (!count.checkValidity()) return; const previous = shares().map(f => f.value.trim() ? Number(f.value) : ''); const n = Number(count.value); stageInputs(Array.from({length:n}, (_, i) => previous[i] ?? '')); markDirty(); });
  root.querySelectorAll<HTMLButtonElement>('[data-reversal-preset]').forEach(button => on(button, 'click', () => {
    if (!latest) return; markDirty();
    const preset = button.dataset.reversalPreset === '75' ? {triggerPrice:.70,confirmationPrice:.75,maxBuyPrice:.75,stageShares:[5,22,75,236]} : {triggerPrice:.67,confirmationPrice:.70,maxBuyPrice:.70,stageShares:[5,18,54,130]};
    for (const field of fields) if (field.dataset.reversalField!.includes('Price')) field.value = String(preset[field.dataset.reversalField! as 'triggerPrice'] * 100);
    count.value = '4'; stageInputs(preset.stageShares); message('参考价格与份额已填入，可继续修改。资金上限和运行时间保持你的设置。');
  }));
  on(root.querySelector('[data-reversal-reset]')!, 'click', () => { if (!latest || busy) return; dirty = false; baseline = latest; populate(latest.config); root.querySelector('[data-reversal-dirty]')!.textContent = ''; message('已恢复为服务器最近保存的配置。'); });
  on(form, 'submit', async event => {
    event.preventDefault(); if (busy || !latest || !baseline || !form.reportValidity()) return;
    const config: ReversalConfig = {...baseline.config, stageShares: shares().map(f => Number(f.value)), maxStages:Number(count.value), mode:'live'};
    fields.forEach(field => { const key = field.dataset.reversalField!; config[key] = field.value.trim() === '' ? null : Number(field.value) / (key.includes('Price') ? 100 : 1); });
    if (config.stageShares.length !== config.maxStages) { message('请填写每一阶段的份额。'); return; }
    if (config.triggerPrice > config.maxBuyPrice) { message('触发价不能高于最高买入价。'); return; }
    busy = true; revisionEpoch++; controls(); message('正在保存…');
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/strategy-config', {method:'PUT', credentials:'same-origin', cache:'no-store', headers:mutationHeaders(), signal:controller.signal, body:JSON.stringify({expectedRevision:baseline.savedRevision,config})});
      const value = await response.json();
      if (!response.ok) throw new Error(response.status === 409 ? '其他页面已修改配置，请撤销修改后重新填写，当前输入仍保留' : mutationError(value,response.status));
      validate('strategy-config', value);
      if (closed) return; dirty = false; receive(value); root.querySelector('[data-reversal-dirty]')!.textContent = '';
      message(`版本 ${value.savedRevision} 已保存，下一场生效。保存不会启动交易。`);
    } catch (error) { if (!closed) message(controller.signal.aborted ? '保存结果尚未确认，请刷新核对；当前输入已保留。' : error instanceof Error ? error.message : '保存失败，当前输入已保留。'); }
    finally { window.clearTimeout(timeout); busy = false; if (!closed) controls(); }
  });
  controls();
  return {refresh, close(){closed = true; listeners.forEach(remove => remove());}, get current(){return latest;}};
}
