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
  document.getElementById('view-home')!.insertBefore((document.getElementById('latency-summary-template') as HTMLTemplateElement).content.cloneNode(true), document.getElementById('homeLog')!.closest('.panel'));
  document.getElementById('settings-system')!.append((document.getElementById('latency-details-template') as HTMLTemplateElement).content.cloneNode(true));
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
