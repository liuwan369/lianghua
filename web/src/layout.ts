import html from './approved-layout.html?raw';
import { mountSettings } from './pages/settings-layout';
import { mountRewards } from './pages/rewards';
import { mountTasks } from './pages/tasks';
import { api } from './api/client';

export function mountLayout(root: HTMLElement) {
  // Approved markup only: demo execution and persistence scripts never run.
  root.innerHTML = html;
  const nav = document.querySelector('.nav');
  const taskNav = document.createElement('button');
  taskNav.type = 'button'; taskNav.dataset.view = 'tasks'; taskNav.textContent = '任务视图';
  nav?.append(taskNav);
  const strategyNav = document.createElement('button');
  strategyNav.type = 'button'; strategyNav.dataset.view = 'strategies'; strategyNav.textContent = 'H1 / H2 对比';
  nav?.append(strategyNav);
  const taskView = document.createElement('section');
  taskView.className = 'view'; taskView.id = 'view-tasks';
  taskView.innerHTML = `<div class="head task-overview"><div><div class="eyebrow">DELIVERY MAP · LIVE STATUS</div><h1>任务视图</h1><p data-task-summary>任务数据读取中</p><p class="task-progress" data-task-progress>-- / -- 项完成</p></div><div class="head-actions"><span class="chip" data-task-updated>规划读取中</span><button type="button" data-task-refresh>刷新状态</button></div><div class="task-live" data-task-live>实时运行状态尚未获取</div><div class="task-legend"><span class="done"><i></i>已完成</span><span class="running"><i></i>进行中</span><span class="review"><i></i>复核中</span><span><i></i>待开始</span><span class="blocked"><i></i>已阻塞</span></div></div><div class="task-layout"><div class="panel task-tree"><div class="section-title"><h2>阶段与任务</h2><span class="muted">点击节点查看</span></div><div data-task-tree></div></div><div class="panel task-detail-panel"><div data-task-detail><div class="task-empty">选择左侧任务查看详情</div></div></div></div>`;
  document.querySelector('.content')?.append(taskView);
  const strategyView = document.createElement('section');
  strategyView.className = 'view'; strategyView.id = 'view-strategies';
  strategyView.innerHTML = `<div class="head"><div><div class="eyebrow">LIVE RESEARCH · BTC 5 分钟</div><h1>H1 / H2 实时策略对比</h1><p>只读观察预测方向与 Polymarket 官方结算结果，当前不下单。</p></div><div class="head-actions"><span class="chip" data-strategy-updated>等待数据</span><button type="button" data-strategy-refresh>立即刷新</button></div></div><div class="stats strategy-stats"><div class="stat"><label>当前场次</label><strong data-strategy-market>--</strong><small data-strategy-countdown>--</small></div><div class="stat"><label>已结算样本</label><strong data-strategy-settled>--</strong><small data-strategy-pending>待结算 --</small></div><div class="stat"><label>实时数据状态</label><strong data-strategy-status>读取中</strong><small data-strategy-source>来源待确认</small></div><div class="stat"><label>最近更新时间</label><strong data-strategy-time>--</strong><small>5 秒自动刷新</small></div></div><div class="grid strategy-grid"><div class="panel strategy-card" data-strategy-card="H1"><div class="section-title"><h2>H1 · 3/7/15 秒动量</h2><span class="pill">基准策略</span></div><div class="strategy-direction" data-strategy-direction="H1">等待</div><div class="row"><span>实时判断</span><b data-strategy-reason="H1">--</b></div><div class="row"><span>已结算命中率</span><b data-strategy-rate="H1">--</b></div><div class="row"><span>命中 / 样本</span><b data-strategy-record="H1">--</b></div><div class="row"><span>最近一场</span><b data-strategy-last="H1">--</b></div></div><div class="panel strategy-card" data-strategy-card="H2"><div class="section-title"><h2>H2 · H1 + 60 秒主动量</h2><span class="pill">增强策略</span></div><div class="strategy-direction" data-strategy-direction="H2">等待</div><div class="row"><span>实时判断</span><b data-strategy-reason="H2">--</b></div><div class="row"><span>已结算命中率</span><b data-strategy-rate="H2">--</b></div><div class="row"><span>命中 / 样本</span><b data-strategy-record="H2">--</b></div><div class="row"><span>最近一场</span><b data-strategy-last="H2">--</b></div></div></div><div class="panel"><div class="section-title"><h2>场次记录</h2><span class="muted">预测冻结后等待官方结算</span></div><div class="table-wrap"><table class="table"><thead><tr><th>策略</th><th>方向</th><th>场次</th><th>结果</th><th>状态</th><th>更新时间</th></tr></thead><tbody data-strategy-ledger><tr><td colspan="6" class="empty">等待实时记录</td></tr></tbody></table></div></div><div class="note">命中率只统计已获得 Polymarket 官方结果的场次；未结算、缺少行情或规则不匹配的记录不会计入。H1/H2 是方向研究策略，不能保证下一场结果，也不代表收益率。</div>`;
  document.querySelector('.content')?.append(strategyView);
  document.getElementById('view-home')!.insertBefore((document.getElementById('latency-summary-template') as HTMLTemplateElement).content.cloneNode(true), document.getElementById('homeLog')!.closest('.panel'));
  document.getElementById('settings-system')!.append((document.getElementById('latency-details-template') as HTMLTemplateElement).content.cloneNode(true));
  mountSettings();
  mountRewards();
  mountTasks();
  mountStrategies();
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${button.dataset.view}`));
    document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item === button));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-setting]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-setting]').forEach(item => item.classList.toggle('active', item === button));
    for (const name of ['strategy','run','account','system']) document.getElementById(`settings-${name}`)!.style.display = name === button.dataset.setting ? 'block' : 'none';
  }));
  document.getElementById('open-latency-details')!.addEventListener('click', () => {
    document.querySelector<HTMLButtonElement>('[data-view="settings"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-setting="system"]')!.click();
  });
}

function mountStrategies() {
  let busy = false;
  let activated = false;
  const text = (selector: string, value: unknown) => { const el = document.querySelector(selector); if (el) el.textContent = String(value ?? '--'); };
  const sourceValue = (sources: Record<string, unknown>[], keys: string[]) => { for (const source of sources) { let value: unknown = source; for (const key of keys) { if (!value || typeof value !== 'object') { value = undefined; break; } value = (value as Record<string, unknown>)[key]; } if (value !== undefined && value !== null) return value; } return undefined; };
  const direction = (value: unknown) => { const s = String(value ?? '').toUpperCase(); return s === 'UP' || s === 'DOWN' ? s : 'SKIP'; };
  const render = (payload: { receivedAt: number; sources: Record<string, unknown>[] }) => {
    const sources = payload.sources;
    const market = sourceValue(sources, ['market']) as Record<string, unknown> | undefined;
    const settled = sourceValue(sources, ['accuracy', 'samples']) ?? sourceValue(sources, ['evaluation', 'settled']) ?? sourceValue(sources, ['collection', 'settlements']);
    const pending = sourceValue(sources, ['accuracy', 'pending']) ?? sourceValue(sources, ['collection', 'pending']);
    text('[data-strategy-market]', market?.slug ?? sourceValue(sources, ['slug']) ?? '--');
    text('[data-strategy-settled]', typeof settled === 'number' ? settled : '--'); text('[data-strategy-pending]', `待结算 ${pending ?? '--'}`);
    text('[data-strategy-status]', sources.length ? '已连接' : '无数据'); text('[data-strategy-source]', '预测 / 评估 / edge-v2'); text('[data-strategy-updated]', `更新于 ${new Date(payload.receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}`); text('[data-strategy-time]', new Date(payload.receivedAt).toLocaleTimeString('zh-CN', { hour12: false }));
    for (const name of ['H1', 'H2']) {
      const directionValue = direction(sourceValue(sources, ['candidates', name, 'direction']) ?? sourceValue(sources, ['decisions', name, 'direction']) ?? sourceValue(sources, ['prediction', name]) ?? sourceValue(sources, [name, 'direction']) ?? (name === 'H1' ? sourceValue(sources, ['prediction', 'direction']) : undefined));
      const rate = sourceValue(sources, ['candidates', name, 'live_accuracy']) ?? sourceValue(sources, ['candidates', name, 'historical_accuracy']) ?? sourceValue(sources, ['accuracy', name, 'rate']) ?? sourceValue(sources, ['accuracy', `${name.toLowerCase()}_rate`]) ?? sourceValue(sources, ['evaluation', name, 'rate']);
      const hits = sourceValue(sources, ['candidates', name, 'live_hits']) ?? sourceValue(sources, ['candidates', name, 'historical_hits']) ?? sourceValue(sources, ['accuracy', name, 'hits']) ?? sourceValue(sources, ['evaluation', name, 'hits']); const samples = sourceValue(sources, ['candidates', name, 'live_signals']) ?? sourceValue(sources, ['candidates', name, 'historical_signals']) ?? sourceValue(sources, ['accuracy', name, 'samples']) ?? sourceValue(sources, ['evaluation', name, 'samples']);
      const reason = sourceValue(sources, ['candidates', name, 'reason']) ?? sourceValue(sources, ['decisions', name, 'reason']);
      text(`[data-strategy-direction="${name}"]`, directionValue); text(`[data-strategy-reason="${name}"]`, directionValue === 'SKIP' ? (reason ?? '条件不足') : (reason ?? '方向已冻结')); text(`[data-strategy-rate="${name}"]`, typeof rate === 'number' ? `${(rate <= 1 ? rate * 100 : rate).toFixed(2)}%` : '--'); text(`[data-strategy-record="${name}"]`, hits != null && samples != null ? `${hits} / ${samples}` : '--'); text(`[data-strategy-last="${name}"]`, directionValue === 'SKIP' ? '无有效信号' : directionValue);
    }
  };
  const refresh = async () => { if (busy) return; busy = true; try { render(await api.strategyComparison()); } catch (error) { text('[data-strategy-status]', '暂不可用'); text('[data-strategy-source]', error instanceof Error ? error.message : '读取失败'); } finally { busy = false; } };
  const activate = () => { if (activated) return; activated = true; void refresh(); };
  document.querySelector('[data-view="strategies"]')?.addEventListener('click', activate);
  document.querySelector('[data-strategy-refresh]')?.addEventListener('click', () => { activate(); void refresh(); });
  window.setInterval(() => { if (activated && document.getElementById('view-strategies')?.classList.contains('active')) void refresh(); }, 5000);
}
