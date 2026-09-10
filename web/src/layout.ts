import html from './approved-layout.html?raw';
import { mountSettings } from './pages/settings-layout';
import { mountRewards } from './pages/rewards';

export function mountLayout(root: HTMLElement) {
  // Approved markup only: demo execution and persistence scripts never run.
  root.innerHTML = html;
  document.getElementById('view-home')!.insertBefore((document.getElementById('latency-summary-template') as HTMLTemplateElement).content.cloneNode(true), document.getElementById('homeLog')!.closest('.panel'));
  document.getElementById('settings-system')!.append((document.getElementById('latency-details-template') as HTMLTemplateElement).content.cloneNode(true));
  mountSettings();
  mountRewards();
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
