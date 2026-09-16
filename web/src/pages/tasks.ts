import { api } from '../api/client';
import { esc, date, money, number } from '../ui';
import type { ArchitectureGroup, ArchitectureScope, Resource, Status, TaskPhase, TaskView } from '../api/types';

const labels: Record<string, string> = { DONE: '已完成', PARTIAL: '部分完成', DEFERRED: '延期增强', RUNNING: '进行中', REVIEW: '复核中', TODO: '待完成', BLOCKED: '已阻塞' };
const scopes: Record<ArchitectureScope, string> = { CORE: '通用底座', STRATEGY: '独立策略', DELIVERY: '交付与增强' };
const statusClass = (status: string) => Object.prototype.hasOwnProperty.call(labels, status) ? status.toLowerCase() : 'todo';
const key = (parentId: string, itemId: string) => JSON.stringify([parentId, itemId]);
function badge(status: string) {
  const safe = Object.prototype.hasOwnProperty.call(labels, status) ? status : 'TODO';
  return `<span class="task-badge ${statusClass(safe)}"><i aria-hidden="true"></i>${esc(labels[safe])}</span>`;
}

export const taskPageMarkup = `<div class="head task-overview"><div><div class="eyebrow">SYSTEM MAP</div><h1>系统架构与任务</h1><p data-task-summary>任务数据读取中</p><p class="task-progress" data-task-progress>-- / -- 项完成</p></div><div class="head-actions"><span class="chip" data-task-updated>规划读取中</span><button type="button" data-task-refresh>刷新状态</button></div><div class="task-live" data-task-live>实时运行状态尚未获取</div></div>
<div class="task-toolbar"><div class="task-tabs" role="tablist" aria-label="任务视图"><button type="button" id="task-tab-architecture" role="tab" data-task-tab="architecture" aria-controls="task-content" aria-selected="true">功能架构</button><button type="button" id="task-tab-delivery" role="tab" data-task-tab="delivery" aria-controls="task-content" aria-selected="false">交付任务</button></div><div class="task-filters" data-task-filters><label>完成情况<select data-task-filter><option value="all">全部</option><option value="incomplete">未完成</option><option value="done">已完成</option></select></label><label>模块范围<select data-task-scope><option value="all">全部模块</option><option value="CORE">通用底座</option><option value="STRATEGY">独立策略</option><option value="DELIVERY">交付与增强</option></select></label></div></div>
<div class="task-legend" data-task-legend></div><div class="task-layout" id="task-content" role="tabpanel" aria-labelledby="task-tab-architecture"><section class="task-tree"><div class="section-title"><h2 data-task-tree-title>功能架构</h2><span class="muted" data-task-visible></span></div><div data-task-tree></div></section><section class="task-detail-panel" aria-label="节点详情"><div data-task-detail></div></section></div>`;

function liveLine(status: Status | null, error: string | null) {
  if (!status) return error ? `实时运行状态读取失败：${error}` : '实时运行状态尚未获取';
  const stats = status.stats || {};
  const run = status.run_id ? `运行 ${status.run_id}` : '暂无运行';
  return `${status.running ? '服务器正在运行' : '服务器未运行'} · ${status.mode || '未知模式'} · ${run} · ${status.mode === 'paper' ? '模拟' : ''}成交 ${number(stats.fills)} · 成交额 ${money(stats.fill_notional)}${status.live_unlocked ? ' · 实盘开关已开' : ' · 实盘开关关闭'}`;
}

function phaseMarkup(phase: TaskPhase, selected: string, collapsed: Set<string>) {
  const id = `delivery:${phase.id}`;
  const tasks = phase.tasks.map(task => {
    const taskKey = key(phase.id, task.id);
    return `<button class="task-node ${statusClass(task.status)} ${selected === taskKey ? 'selected' : ''}" type="button" data-task-key="${esc(taskKey)}" aria-pressed="${selected === taskKey}"><span class="task-node-dot" aria-hidden="true"></span><span class="task-node-copy"><strong>${esc(task.id)} · ${esc(task.title)}</strong><small>${esc(task.owner)} · ${esc(labels[task.status] || task.status)}</small></span></button>`;
  }).join('');
  return `<section class="task-phase ${collapsed.has(id) ? 'collapsed' : ''}" data-group-id="${esc(id)}"><button class="task-phase-head" type="button" data-group-toggle="${esc(id)}" aria-expanded="${!collapsed.has(id)}"><span class="task-chevron" aria-hidden="true">›</span><span class="task-phase-title"><strong>${esc(phase.id)} · ${esc(phase.title)}</strong><small>${esc(phase.owner)}</small></span>${badge(phase.status)}</button><p class="task-phase-detail">${esc(phase.detail)}</p><div class="task-children">${tasks}</div></section>`;
}

function architectureMarkup(group: ArchitectureGroup, selected: string, collapsed: Set<string>, visibleIds: Set<string>) {
  const id = `architecture:${group.id}`;
  const done = group.items.filter(item => item.status === 'DONE').length;
  const items = group.items.filter(item => visibleIds.has(item.id)).map(item => {
    const itemKey = key(group.id, item.id);
    return `<button class="task-node ${statusClass(item.status)} ${selected === itemKey ? 'selected' : ''}" type="button" data-task-key="${esc(itemKey)}" aria-pressed="${selected === itemKey}"><span class="task-node-dot" aria-hidden="true"></span><span class="task-node-copy"><strong>${esc(item.title)}</strong><small>${esc(labels[item.status])}</small></span></button>`;
  }).join('');
  return `<section class="task-phase ${collapsed.has(id) ? 'collapsed' : ''}" data-group-id="${esc(id)}"><button class="task-phase-head" type="button" data-group-toggle="${esc(id)}" aria-expanded="${!collapsed.has(id)}"><span class="task-chevron" aria-hidden="true">›</span><span class="task-phase-title"><strong>${esc(group.title)}</strong><small>${scopes[group.scope]} · ${esc(group.owner)}</small></span><span class="task-group-count ${done === group.items.length && done ? 'done' : ''}">${done} / ${group.items.length}<small>已完成</small></span></button><p class="task-phase-detail">${esc(group.detail)}</p><div class="task-children">${items}</div></section>`;
}

export function mountTasks() {
  const root = document.getElementById('view-tasks');
  if (!root) return () => undefined;
  const taskResource: Resource<TaskView> = { data: null, error: null, receivedAt: 0, loading: false };
  const statusResource: Resource<Status> = { data: null, error: null, receivedAt: 0, loading: false };
  let tab: 'architecture' | 'delivery' = 'architecture';
  let tabChosen = false;
  let statusFilter = 'all';
  let scopeFilter = 'all';
  const selected = { architecture: '', delivery: '' };
  let closed = false; let activated = false; let busy = false;
  const collapsed = new Set<string>();
  const text = (selector: string, value: string) => { const node = root.querySelector(selector); if (node) node.textContent = value; };
  const render = () => {
    const data = taskResource.data;
    const architecture = data?.architecture;
    if (data && !tabChosen) tab = architecture ? 'architecture' : 'delivery';
    const phases = (data?.phases || []).map(phase => ({ ...phase, tasks: phase.tasks.map(task => {
      const status = statusResource.data;
      // Only the linked paper run can alter the display of this delivery task.
      if (task.id !== 'PAPER-01' || !task.runId || task.runId !== status?.run_id || status.mode !== 'paper') return task;
      if (status.running) return { ...task, status: 'RUNNING' };
      return task.status === 'RUNNING' ? { ...task, status: 'REVIEW' } : task;
    }) }));
    const architectureActive = tab === 'architecture';
    const allTasks = architectureActive ? (architecture?.groups.flatMap(group => group.items) || []) : phases.flatMap(phase => phase.tasks);
    const completed = allTasks.filter(item => item.status === 'DONE').length;
    const counts = architectureActive
      ? `部分完成 ${allTasks.filter(item => item.status === 'PARTIAL').length} · 待完成 ${allTasks.filter(item => item.status === 'TODO').length} · 延期增强 ${allTasks.filter(item => item.status === 'DEFERRED').length}`
      : `进行中 ${allTasks.filter(item => item.status === 'RUNNING').length} · 复核中 ${allTasks.filter(item => item.status === 'REVIEW').length}`;
    text('[data-task-updated]', data?.updatedAt ? `规划更新 ${date(Date.parse(data.updatedAt) / 1000)}` : taskResource.error ? '规划读取失败' : '规划读取中');
    text('[data-task-live]', liveLine(statusResource.data, statusResource.error));
    text('[data-task-summary]', taskResource.error || (architectureActive ? architecture?.summary : data?.summary) || (data ? '暂无功能架构数据' : '任务数据读取中'));
    text('[data-task-progress]', `${completed} / ${allTasks.length} 项完成 · ${counts}`);
    text('[data-task-tree-title]', architectureActive ? architecture?.title || '功能架构' : '阶段与任务');
    root.querySelectorAll<HTMLButtonElement>('[data-task-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.taskTab === tab)));
    root.querySelector('[role="tabpanel"]')?.setAttribute('aria-labelledby', `task-tab-${tab}`);
    const filters = root.querySelector<HTMLElement>('[data-task-filters]');
    if (filters) filters.hidden = !architectureActive;
    const legend = root.querySelector('[data-task-legend]');
    if (legend) legend.innerHTML = (architectureActive ? ['DONE','PARTIAL','TODO','DEFERRED'] : ['DONE','RUNNING','REVIEW','TODO','BLOCKED']).map(badge).join('');
    const tree = root.querySelector('[data-task-tree]')!;
    const detail = root.querySelector('[data-task-detail]')!;
    if (architectureActive) {
      const groups = (architecture?.groups || []).filter(group => scopeFilter === 'all' || group.scope === scopeFilter);
      const visible = groups.flatMap(group => group.items.filter(item => statusFilter === 'all' || (statusFilter === 'done' ? item.status === 'DONE' : item.status !== 'DONE')).map(item => ({ group, item })));
      const current = visible.find(({ group, item }) => key(group.id, item.id) === selected.architecture) || visible[0];
      selected.architecture = current ? key(current.group.id, current.item.id) : '';
      const visibleIds = new Set(visible.map(({ item }) => item.id));
      tree.innerHTML = visible.length ? groups.filter(group => group.items.some(item => visibleIds.has(item.id))).map(group => architectureMarkup(group, selected.architecture, collapsed, visibleIds)).join('') : `<div class="task-empty">${esc(taskResource.error || (architecture ? '当前筛选下没有功能项' : data ? '功能架构尚未发布，可查看交付任务' : '功能架构读取中'))}</div>`;
      text('[data-task-visible]', architecture ? `显示 ${visible.length} / ${allTasks.length} 项` : '');
      if (!current) detail.innerHTML = '<div class="task-empty">暂无可显示的功能详情</div>';
      else {
        const { group, item } = current;
        detail.innerHTML = `<div class="task-detail-top"><div><span class="task-kicker">${esc(group.title)}</span><h2>${esc(item.title)}</h2></div>${badge(item.status)}</div><dl class="task-detail-grid"><div><dt>模块范围</dt><dd>${scopes[group.scope]}</dd></div><div><dt>负责人</dt><dd>${esc(group.owner)}</dd></div></dl><div class="task-detail-block"><h3>当前说明</h3><p>${esc(item.detail)}</p></div><div class="task-detail-block"><h3>验证情况</h3><p>${esc(item.verification)}</p></div><div class="task-detail-block"><h3>剩余工作</h3><p>${esc(item.next)}</p></div><button class="task-return" type="button" data-task-return>返回功能树</button>`;
      }
    } else {
      const entries = phases.flatMap(phase => phase.tasks.map(item => ({ phase, item })));
      const current = entries.find(({ phase, item }) => key(phase.id, item.id) === selected.delivery)
        || entries.find(({ item }) => item.id === 'PAPER-01') || entries[0];
      selected.delivery = current ? key(current.phase.id, current.item.id) : '';
      tree.innerHTML = phases.length ? phases.map(phase => phaseMarkup(phase, selected.delivery, collapsed)).join('') : `<div class="task-empty">${esc(taskResource.error || '暂无交付任务数据')}</div>`;
      text('[data-task-visible]', phases.length ? `${phases.length} 个阶段` : '');
      if (!current) detail.innerHTML = '<div class="task-empty">暂无可显示的任务详情</div>';
      else {
        const { phase, item } = current;
        detail.innerHTML = `<div class="task-detail-top"><div><span class="task-kicker">${esc(phase.id)} · ${esc(phase.title)}</span><h2>${esc(item.id)} · ${esc(item.title)}</h2></div>${badge(item.status)}</div><dl class="task-detail-grid"><div><dt>负责人</dt><dd>${esc(item.owner)}</dd></div><div><dt>阶段状态</dt><dd>${badge(phase.status)}</dd></div></dl><div class="task-detail-block"><h3>当前说明</h3><p>${esc(item.detail)}</p></div><div class="task-detail-block"><h3>下一步</h3><p>${esc(item.next)}</p></div>${item.runId ? `<div class="task-detail-block"><h3>关联运行</h3><p class="mono">${esc(item.runId)}</p></div>` : ''}<button class="task-return" type="button" data-task-return>返回任务树</button>`;
      }
    }
  };
  const load = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      const [tasksResult, statusResult] = await Promise.allSettled([api.tasks(), api.status()]);
      if (closed) return;
      if (tasksResult.status === 'fulfilled') {
        taskResource.data = tasksResult.value; taskResource.error = null; taskResource.receivedAt = Date.now();
      } else {
        taskResource.data = null; taskResource.receivedAt = 0;
        taskResource.error = tasksResult.reason instanceof Error ? tasksResult.reason.message : '任务读取失败';
      }
      if (statusResult.status === 'fulfilled') {
        statusResource.data = statusResult.value; statusResource.error = null; statusResource.receivedAt = Date.now();
      } else {
        statusResource.data = null;
        statusResource.error = statusResult.reason instanceof Error ? statusResult.reason.message : '实时状态读取失败';
      }
    } finally { busy = false; if (!closed) render(); }
  };
  const activate = () => { if (activated || closed) return; activated = true; void load(); };
  const onClick = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!target || !root.contains(target)) return;
    if (target.hasAttribute('data-task-refresh')) { activated = true; void load(); }
    if (target.dataset.taskTab === 'architecture' || target.dataset.taskTab === 'delivery') {
      tab = target.dataset.taskTab; tabChosen = true; render();
    }
    if (target.dataset.taskKey) {
      selected[tab] = target.dataset.taskKey; render();
      if (window.innerWidth <= 900) root.querySelector('[data-task-detail]')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
    if (target.dataset.groupToggle) {
      const id = target.dataset.groupToggle;
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      target.closest('.task-phase')?.classList.toggle('collapsed', collapsed.has(id));
      target.setAttribute('aria-expanded', String(!collapsed.has(id)));
    }
    if (target.hasAttribute('data-task-return')) root.querySelector('[data-task-tree]')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
  const onChange = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.hasAttribute('data-task-filter')) statusFilter = target.value;
    else if (target.hasAttribute('data-task-scope')) scopeFilter = target.value;
    else return;
    render();
  };
  const nav = document.querySelector<HTMLButtonElement>('[data-view="tasks"]');
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  nav?.addEventListener('click', activate);
  render();
  if (root.classList.contains('active')) activate();
  const timer = window.setInterval(() => { if (activated && root.classList.contains('active')) void load(); }, 10000);
  return () => {
    closed = true; window.clearInterval(timer);
    root.removeEventListener('click', onClick); root.removeEventListener('change', onChange);
    nav?.removeEventListener('click', activate);
  };
}
