import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { Status, TaskView } from '../api/types';
import { mountTasks, taskPageMarkup } from './tasks';

vi.mock('../api/client', () => ({ api: { tasks: vi.fn(), status: vi.fn() } }));

const status: Status = { schemaVersion: 1, asOf: 1, running: false, mode: 'paper', run_id: 'paper-linked', account_id: null, config_revision: 1, params: {}, live_unlocked: false, stop_result: {}, stats: {}, projection: null };
function fixture(): TaskView {
  return {
    schemaVersion: 1, title: '交付', updatedAt: '2026-09-16T00:00:00Z', summary: '交付说明', hardRules: [],
    phases: [
      { id: 'P1', title: '第一阶段', owner: '执行 Agent', detail: '阶段一', status: 'REVIEW', tasks: [{ id: 'LIVE-03', title: '撤单验证', owner: '执行 Agent', detail: '第一阶段独有内容', next: '完成撤单', status: 'DONE' }, { id: 'PAPER-01', title: '模拟记录', owner: '策略 Agent', detail: '已完成的模拟批次', next: '分析', status: 'REVIEW', runId: 'paper-linked' }] },
      { id: 'P2', title: '第二阶段', owner: '测试 Agent', detail: '阶段二', status: 'TODO', tasks: [{ id: 'LIVE-03', title: '恢复验证', owner: '测试 Agent', detail: '第二阶段独有内容', next: '完成恢复', status: 'TODO' }] },
    ],
    architecture: { title: '交易系统功能架构', summary: '底座与策略分别显示', groups: [
      { id: 'CORE', title: '交易底座', owner: '执行 Agent', scope: 'CORE', detail: '独立执行', items: [
        { id: 'ORDER', title: '订单提交', status: 'DONE', detail: '订单功能说明', next: '无需新工作', verification: '真实订单 ACK 已验证' },
        { id: 'RECOVERY', title: '断线恢复', status: 'PARTIAL', detail: '恢复仍有缺口', next: '补齐真实断线测试', verification: '单测通过，真实测试待补' },
      ] },
      { id: 'STRATEGY', title: '策略模块', owner: '策略 Agent', scope: 'STRATEGY', detail: '插件', items: [
        { id: 'PLUGIN', title: '替换策略', status: 'TODO', detail: '替换策略说明', next: '测试接入', verification: '待验证' },
      ] },
      { id: 'DELIVERY', title: '交付增强', owner: '运维 Agent', scope: 'DELIVERY', detail: '增强', items: [
        { id: 'ARCHIVE', title: '长期归档', status: 'DEFERRED', detail: '后续增强', next: '以后再做', verification: '未执行' },
      ] },
    ] },
  };
}
let cleanup: (() => void) | undefined;
const select = (selector: string, value: string) => { const input = document.querySelector<HTMLSelectElement>(selector)!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
const nodes = () => [...document.querySelectorAll<HTMLButtonElement>('[data-task-key]')];
const detail = () => document.querySelector('[data-task-detail]')!.textContent;
async function mount() {
  document.body.innerHTML = `<button data-view="tasks">任务视图</button><section id="view-tasks" class="active">${taskPageMarkup}</section>`;
  cleanup = mountTasks();
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.tasks).mockReset().mockResolvedValue(fixture());
  vi.mocked(api.status).mockReset().mockResolvedValue({ ...status });
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); document.body.replaceChildren(); });

describe('system architecture task view', () => {
  it('uses server time for platform snapshot freshness despite a client clock offset', async () => {
    vi.mocked(api.status).mockResolvedValue({...status,asOf:1000,running:true,engine:'platform',execution:'observation',strategy_id:null,
      projection:{run_id:status.run_id,state:'ready',stale:false},stats:{runtime:{engine:'platform',status:'running',source_at:999,expires_at:1009,stale:false,fills_count:0}}});
    await mount();
    expect(document.querySelector('[data-task-live]')?.textContent).toContain('平台观察 · 运行中 · 未加载策略');
    expect(document.querySelector('[data-task-live]')?.textContent).toContain('成交 0');
    await vi.advanceTimersByTimeAsync(9000);
    expect(document.querySelector('[data-task-live]')?.textContent).toContain('快照待更新或仅有历史记录');
  });
  it('does not extend snapshot freshness while waiting for the slower task response', async () => {
    let finishTasks!: (value: TaskView) => void;
    vi.mocked(api.tasks).mockReturnValue(new Promise(resolve => {finishTasks=resolve;}));
    vi.mocked(api.status).mockResolvedValue({...status,asOf:1000,running:true,engine:'platform',strategy_id:null,
      projection:{run_id:status.run_id,state:'ready',stale:false},stats:{runtime:{engine:'platform',status:'running',source_at:1000,expires_at:1009,stale:false,fills_count:7}}});
    await mount();
    await vi.advanceTimersByTimeAsync(8000);finishTasks(fixture());await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[data-task-live]')?.textContent).toContain('成交 7');
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector('[data-task-live]')?.textContent).toContain('快照待更新或仅有历史记录');
  });
  it('defaults to architecture with independent completion, verification and remaining work', async () => {
    await mount();
    expect(document.querySelector('[data-task-tab="architecture"]')?.getAttribute('aria-selected')).toBe('true');
    expect(nodes()).toHaveLength(4);
    expect(document.querySelector('[data-task-progress]')?.textContent).toContain('1 / 4 项完成');
    expect(document.querySelector('[data-task-progress]')?.textContent).toContain('部分完成 1');
    expect(detail()).toContain('真实订单 ACK 已验证');
    expect(detail()).toContain('通用底座');
    expect(document.querySelectorAll('.task-group-count')).toHaveLength(3);
    vi.mocked(api.status).mockResolvedValue({ ...status, running: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(document.querySelector('[data-task-progress]')?.textContent).toContain('1 / 4 项完成');
  });
  it('combines completion and scope filters, with a truthful empty state', async () => {
    await mount();
    select('[data-task-filter]', 'incomplete');
    expect(nodes()).toHaveLength(3);
    expect(nodes().some(node => node.textContent?.includes('订单提交'))).toBe(false);
    select('[data-task-scope]', 'CORE');
    expect(nodes()).toHaveLength(1);
    expect(detail()).toContain('补齐真实断线测试');
    select('[data-task-filter]', 'done');
    expect(nodes()).toHaveLength(1);
    select('[data-task-scope]', 'STRATEGY');
    expect(nodes()).toHaveLength(0);
    expect(document.querySelector('[data-task-tree]')?.textContent).toContain('当前筛选下没有功能项');
    expect(detail()).not.toContain('补齐真实断线测试');
  });
  it('retains selection and collapse state while fresh server completion replaces old status', async () => {
    await mount();
    nodes().find(node => node.textContent?.includes('断线恢复'))!.click();
    click('[data-group-toggle="architecture:STRATEGY"]');
    const next = fixture();
    next.architecture!.groups[0].items[1] = { ...next.architecture!.groups[0].items[1], status: 'DONE', verification: '最新验证已经通过' };
    vi.mocked(api.tasks).mockResolvedValue(next);
    await vi.advanceTimersByTimeAsync(10000);
    expect(detail()).toContain('最新验证已经通过');
    expect(document.querySelector('[data-group-id="architecture:STRATEGY"]')?.classList.contains('collapsed')).toBe(true);
    expect(document.querySelector('[data-group-toggle="architecture:STRATEGY"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-task-progress]')?.textContent).toContain('2 / 4 项完成');
  });
  it('selects duplicated phase task IDs using the parent phase, and keeps tab selection on refresh', async () => {
    await mount();
    click('[data-task-tab="delivery"]');
    nodes().find(node => node.textContent?.includes('恢复验证'))!.click();
    expect(detail()).toContain('第二阶段独有内容');
    expect(detail()).not.toContain('第一阶段独有内容');
    await vi.advanceTimersByTimeAsync(10000);
    expect(detail()).toContain('第二阶段独有内容');
    expect(document.querySelector('[data-task-filters]')?.hasAttribute('hidden')).toBe(true);
  });
  it('does not promote a recorded paper task when another run or a live run is active', async () => {
    vi.mocked(api.status).mockResolvedValue({ ...status, running: true, run_id: 'unrelated' });
    await mount();
    click('[data-task-tab="delivery"]');
    const paper = () => nodes().find(node => node.textContent?.includes('PAPER-01'))!;
    expect(paper().textContent).toContain('复核中');
    vi.mocked(api.status).mockResolvedValue({ ...status, running: true, mode: 'live' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(paper().textContent).toContain('复核中');
    vi.mocked(api.status).mockResolvedValue({ ...status, running: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(paper().textContent).toContain('进行中');
  });
  it('supports old task data with no architecture field', async () => {
    const data = fixture(); delete data.architecture;
    vi.mocked(api.tasks).mockResolvedValue(data);
    await mount();
    expect(document.querySelector('[data-task-tab="delivery"]')?.getAttribute('aria-selected')).toBe('true');
    expect(nodes()).toHaveLength(3);
    click('[data-task-tab="architecture"]');
    expect(document.querySelector('[data-task-tree]')?.textContent).toContain('功能架构尚未发布');
  });
  it('shows paused work separately in both views and preserves the pause on live refresh', async () => {
    const data = fixture();
    data.phases[0].status = 'PAUSED';
    data.phases[0].tasks[1].status = 'PAUSED';
    data.architecture!.groups[1].items[0].status = 'PAUSED';
    vi.mocked(api.tasks).mockResolvedValue(data);
    vi.mocked(api.status).mockResolvedValue({ ...status, running: true });
    await mount();
    select('[data-task-filter]', 'incomplete');
    select('[data-task-scope]', 'STRATEGY');
    expect(nodes()).toHaveLength(1);
    expect(nodes()[0].classList.contains('paused')).toBe(true);
    expect(detail()).toContain('已暂停');
    expect(document.querySelector('[data-task-progress]')?.textContent).toContain('已暂停 1');
    expect(document.querySelector('[data-task-legend] .paused')?.textContent).toBe('已暂停');
    click('[data-task-tab="delivery"]');
    const paper = () => nodes().find(node => node.textContent?.includes('PAPER-01'))!;
    expect(paper().textContent).toContain('已暂停');
    expect(document.querySelector('[data-group-id="delivery:P1"] .task-phase-head .paused')?.textContent).toBe('已暂停');
    expect(document.querySelector('[data-task-progress]')?.textContent).toContain('已暂停 1');
    await vi.advanceTimersByTimeAsync(10000);
    expect(paper().textContent).toContain('已暂停');
    expect(document.querySelector('[data-task-live]')?.textContent).toContain('旧引擎纸面 · 运行中');
  });
  it('clears stale completed nodes on errors, recovers on refresh, and removes all listeners on cleanup', async () => {
    await mount();
    vi.mocked(api.tasks).mockRejectedValue(new Error('任务接口断开'));
    vi.mocked(api.status).mockRejectedValue(new Error('运行状态断开'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(nodes()).toHaveLength(0);
    expect(document.querySelector('[data-task-tree]')?.textContent).toContain('任务接口断开');
    expect(document.querySelector('[data-task-live]')?.textContent).toContain('运行状态断开');
    vi.mocked(api.tasks).mockResolvedValue(fixture());
    click('[data-task-refresh]'); await vi.advanceTimersByTimeAsync(0);
    expect(nodes()).toHaveLength(4);
    cleanup!(); cleanup = undefined;
    const count = vi.mocked(api.tasks).mock.calls.length;
    click('[data-task-refresh]'); click('[data-view="tasks"]');
    await vi.advanceTimersByTimeAsync(20000);
    expect(vi.mocked(api.tasks)).toHaveBeenCalledTimes(count);
  });
  it('renders feature details as text, not executable markup', async () => {
    const data = fixture();
    data.architecture!.groups[0].items[0].title = '<img src=x onerror=alert(1)>';
    data.architecture!.groups[0].items[0].verification = '<script>alert(1)</script>';
    vi.mocked(api.tasks).mockResolvedValue(data);
    await mount();
    expect(document.querySelector('#view-tasks img,#view-tasks script')).toBeNull();
    expect(detail()).toContain('<script>alert(1)</script>');
  });
});
