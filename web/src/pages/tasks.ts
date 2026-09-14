import { api } from '../api/client';
import { esc, date, money, number } from '../ui';
import type { Resource, Status, TaskPhase, TaskView } from '../api/types';

const labels: Record<string, string> = { DONE: '已完成', RUNNING: '进行中', REVIEW: '复核中', TODO: '待开始', BLOCKED: '已阻塞' };
const statusClass = (status: string) => Object.prototype.hasOwnProperty.call(labels, status) ? status.toLowerCase() : 'todo';
function badge(status: string) { const safe = Object.prototype.hasOwnProperty.call(labels, status) ? status : 'TODO'; return `<span class="task-badge ${statusClass(safe)}"><i></i>${esc(labels[safe])}</span>`; }
function liveLine(status: Status | null, error: string | null) {
  if (!status) return error ? `实时运行状态读取失败：${error}` : '实时运行状态尚未获取';
  const stats = status.stats || {};
  const run = status.run_id ? `运行 ${status.run_id}` : '暂无运行';
  return `${status.running ? '服务器正在运行' : '服务器未运行'} · ${status.mode || '未知模式'} · ${run} · 模拟成交 ${number(stats.fills)} · 成交额 ${money(stats.fill_notional)}${status.live_unlocked ? ' · 实盘开关已开' : ' · 实盘开关关闭'}`;
}
function phaseMarkup(phase: TaskPhase) {
  const tasks = phase.tasks.map(task => `<button class="task-node ${statusClass(task.status)}" type="button" data-task-id="${esc(task.id)}"><span class="task-node-dot"></span><span class="task-node-copy"><strong>${esc(task.id)} · ${esc(task.title)}</strong><small>${esc(task.owner)} · ${esc(labels[task.status] || task.status)}</small></span></button>`).join('');
  return `<section class="task-phase ${statusClass(phase.status)}" data-phase-id="${esc(phase.id)}"><button class="task-phase-head" type="button" data-phase-toggle="${esc(phase.id)}"><span class="task-chevron">›</span><span class="task-phase-title"><strong>${esc(phase.id)} · ${esc(phase.title)}</strong><small>${esc(phase.owner)}</small></span>${badge(phase.status)}</button><p class="task-phase-detail">${esc(phase.detail)}</p><div class="task-children">${tasks}</div></section>`;
}
export function mountTasks() {
  const root = document.getElementById('view-tasks');
  if (!root) return () => undefined;
  const taskResource: Resource<TaskView> = { data: null, error: null, receivedAt: 0, loading: false };
  const statusResource: Resource<Status> = { data: null, error: null, receivedAt: 0, loading: false };
  let selected = 'PAPER-01'; let closed = false; let activated = false; let busy = false;
  const collapsed = new Set<string>();
  const bind = () => {
    root.querySelectorAll<HTMLButtonElement>('[data-task-id]').forEach(button => button.onclick = () => { selected = button.dataset.taskId || selected; render(); });
    root.querySelectorAll<HTMLButtonElement>('[data-phase-toggle]').forEach(button => button.onclick = () => {
      const id = button.dataset.phaseToggle || '';
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      button.closest('.task-phase')?.classList.toggle('collapsed', collapsed.has(id));
    });
  };
  const render = () => {
    const data = taskResource.data;
    const liveRunning = statusResource.data?.running === true;
    const liveKnown = statusResource.data !== null;
    const phases = (data?.phases || []).map(phase => ({ ...phase, tasks: phase.tasks.map(task => {
      if (task.id !== 'PAPER-01' || !liveKnown) return task;
      return { ...task, status: liveRunning ? 'RUNNING' : 'TODO' };
    }) }));
    const allTasks = phases.flatMap(p => p.tasks);
    const completed = allTasks.filter(task => task.status === 'DONE').length;
    const running = allTasks.filter(task => task.status === 'RUNNING').length;
    root.querySelector('[data-task-updated]')!.textContent = data?.updatedAt ? `规划更新 ${date(Date.parse(data.updatedAt) / 1000)}` : '规划读取中';
    root.querySelector('[data-task-live]')!.textContent = liveLine(statusResource.data, statusResource.error);
    root.querySelector('[data-task-summary]')!.textContent = data?.summary || taskResource.error || '任务数据读取中';
    root.querySelector('[data-task-progress]')!.textContent = `${completed} / ${allTasks.length} 项完成 · ${running} 项进行中`;
    root.querySelector('[data-task-tree]')!.innerHTML = phases.length ? phases.map(phaseMarkup).join('') : `<div class="task-empty">${esc(taskResource.error || '暂无任务数据')}</div>`;
    root.querySelectorAll<HTMLElement>('[data-phase-id]').forEach(node => node.classList.toggle('collapsed', collapsed.has(node.dataset.phaseId || '')));
    const current = phases.flatMap(p => p.tasks).find(t => t.id === selected) || phases[0]?.tasks[0];
    const phase = phases.find(p => p.tasks.some(t => t.id === current?.id));
    const detail = root.querySelector('[data-task-detail]')!;
    if (!current || !phase) detail.innerHTML = '<div class="task-empty">选择左侧任务查看详情</div>';
    else detail.innerHTML = `<div class="task-detail-top"><div><span class="task-kicker">${esc(phase.id)} · ${esc(phase.title)}</span><h2>${esc(current.id)} · ${esc(current.title)}</h2></div>${badge(current.status)}</div><div class="task-detail-grid"><div><span>负责人</span><strong>${esc(current.owner)}</strong></div><div><span>阶段状态</span><strong>${badge(phase.status)}</strong></div></div><div class="task-detail-block"><span>当前说明</span><p>${esc(current.detail)}</p></div><div class="task-detail-block"><span>下一步</span><p>${esc(current.next)}</p></div>${current.runId ? `<div class="task-detail-block"><span>关联运行</span><p class="mono">${esc(current.runId)}</p></div>` : ''}`;
    bind();
  };
  const load = async () => {
    if (closed) return;
    if (busy) return;
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
  root.querySelector<HTMLButtonElement>('[data-task-refresh], [data-refresh]')?.addEventListener('click', () => { activated = true; void load(); });
  document.querySelector<HTMLButtonElement>('[data-view="tasks"]')?.addEventListener('click', activate);
  render();
  const timer = window.setInterval(() => { if (activated && root.classList.contains('active')) void load(); }, 10000);
  return () => { closed = true; window.clearInterval(timer); document.querySelector<HTMLButtonElement>('[data-view="tasks"]')?.removeEventListener('click', activate); };
}
