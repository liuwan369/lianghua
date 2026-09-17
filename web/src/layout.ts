import html from './approved-layout.html?raw';
import { mountSettings } from './pages/settings-layout';
import { mountRewards } from './pages/rewards';
import { mountTasks, taskPageMarkup } from './pages/tasks';
import { mountStrategy, strategyPageMarkup } from './pages/strategy';

export function mountLayout(root: HTMLElement) {
  // Approved markup only: demo execution and persistence scripts never run.
  root.innerHTML = html;
  const nav = document.querySelector('.nav');
  const taskNav = document.createElement('button');
  taskNav.type = 'button'; taskNav.dataset.view = 'tasks'; taskNav.textContent = '任务视图';
  const strategyNav = document.createElement('button');
  strategyNav.type = 'button'; strategyNav.dataset.view = 'strategy'; strategyNav.textContent = '策略';
  const earningsNav = nav?.querySelector<HTMLButtonElement>('[data-view="earnings"]');
  earningsNav ? nav?.insertBefore(strategyNav, earningsNav) : nav?.append(strategyNav);
  nav?.append(taskNav);
  const taskView = document.createElement('section');
  taskView.className = 'view'; taskView.id = 'view-tasks';
  taskView.innerHTML = taskPageMarkup;
  document.querySelector('.content')?.append(taskView);
  const strategyView = document.createElement('section');
  strategyView.className = 'view'; strategyView.id = 'view-strategy';
  strategyView.innerHTML = strategyPageMarkup;
  document.querySelector('.content')?.append(strategyView);
  const tradeDescription = document.querySelector('#view-trade .head p');
  if (tradeDescription) tradeDescription.textContent = '盘口、持仓、挂单和订单生命周期集中查看';
  const settingsHeading = document.querySelector('#view-settings .head h1');
  if (settingsHeading) settingsHeading.textContent = '账户与系统设置';
  const settingsDescription = document.querySelector('#view-settings .head p');
  if (settingsDescription) settingsDescription.textContent = '账户接入和系统诊断。策略参数集中在策略板块。';
  const systemPanel = document.createElement('section');
  systemPanel.className = 'panel system-metrics-panel';
  systemPanel.dataset.systemMetrics = '';
  systemPanel.innerHTML = '<div class="section-title"><h2>服务器状态</h2><span class="muted" data-system-state>读取中</span></div><div class="system-metric-grid"><div><span>CPU</span><strong data-system-cpu>--</strong></div><div><span>内存</span><strong data-system-memory>--</strong></div><div><span>磁盘</span><strong data-system-disk>--</strong></div><div><span>负载 1 / 5 / 15 分钟</span><strong data-system-load>--</strong></div></div><div class="system-services" data-system-services><span class="muted">进程状态读取中</span></div>';
  document.getElementById('view-home')!.insertBefore(systemPanel, document.getElementById('homeLog')!.closest('.panel'));
  document.getElementById('view-home')!.insertBefore((document.getElementById('latency-summary-template') as HTMLTemplateElement).content.cloneNode(true), document.getElementById('homeLog')!.closest('.panel'));
  document.getElementById('settings-system')!.append((document.getElementById('latency-details-template') as HTMLTemplateElement).content.cloneNode(true));
  const latencyHead=document.querySelectorAll('.latency-table thead th');
  if(latencyHead.length===7){
    latencyHead[3].textContent='p50 ms';latencyHead[4].textContent='p95 ms';
    const p99=document.createElement('th'),max=document.createElement('th');p99.textContent='p99 ms';max.textContent='最大 ms';
    latencyHead[5].before(p99,max);
    document.querySelectorAll('.latency-table tbody tr').forEach(row=>{const cells=row.querySelectorAll('td'),a=document.createElement('td'),b=document.createElement('td');a.textContent='--';b.textContent='--';cells[5].before(a,b);});
  }
  mountSettings();
  mountRewards();
  mountTasks();
  mountStrategy();
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${button.dataset.view}`));
    document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item === button));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-setting]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-setting]').forEach(item => item.classList.toggle('active', item === button));
    for (const name of ['account','system']) {
      const panel = document.getElementById(`settings-${name}`);
      if (panel) panel.style.display = name === button.dataset.setting ? 'block' : 'none';
    }
  }));
  document.getElementById('open-latency-details')!.addEventListener('click', () => {
    document.querySelector<HTMLButtonElement>('[data-view="settings"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-setting="system"]')!.click();
  });
}
