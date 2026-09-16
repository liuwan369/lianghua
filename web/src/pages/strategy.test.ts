import { afterEach, expect, it } from 'vitest';
import { mountLayout } from '../layout';

afterEach(() => document.body.replaceChildren());

function mount() {
  document.body.innerHTML = '<div id="app"></div>';
  mountLayout(document.getElementById('app')!);
  return document.getElementById('view-strategy')!;
}

it('adds a strategy and keeps a separate parameter draft for each strategy', () => {
  const root = mount();
  root.querySelector<HTMLButtonElement>('[data-strategy-add]')!.click();
  (root.querySelector('#strategy-new-id') as HTMLInputElement).value = 'latency-maker';
  (root.querySelector('#strategy-new-name') as HTMLInputElement).value = '低延迟做市';
  root.querySelector<HTMLButtonElement>('[data-strategy-create-submit]')!.click();
  expect(root.querySelector('[data-strategy-active-id]')!.textContent).toBe('latency-maker');
  const params = root.querySelector<HTMLTextAreaElement>('[data-strategy-params]')!;
  params.value = '{"intervalMs":100}';
  params.dispatchEvent(new Event('change'));
  root.querySelector<HTMLButtonElement>('[data-strategy-id="stableLive"]')!.click();
  expect(params.value).toBe('{}');
  root.querySelector<HTMLButtonElement>('[data-strategy-id="latency-maker"]')!.click();
  expect(params.value).toBe('{"intervalMs":100}');
});

it('rejects invalid JSON and duplicate or malformed strategy IDs', () => {
  const root = mount();
  const params = root.querySelector<HTMLTextAreaElement>('[data-strategy-params]')!;
  params.value = '{invalid';
  params.dispatchEvent(new Event('change'));
  root.querySelector<HTMLButtonElement>('[data-strategy-add]')!.click();
  (root.querySelector('#strategy-new-id') as HTMLInputElement).value = 'x';
  (root.querySelector('#strategy-new-name') as HTMLInputElement).value = '无效';
  root.querySelector<HTMLButtonElement>('[data-strategy-create-submit]')!.click();
  expect(root.querySelector('[data-strategy-create-message]')!.textContent).toContain('有效');
  (root.querySelector('#strategy-new-id') as HTMLInputElement).value = 'stableLive';
  (root.querySelector('#strategy-new-name') as HTMLInputElement).value = '重复';
  root.querySelector<HTMLButtonElement>('[data-strategy-create-submit]')!.click();
  expect(root.querySelector('[data-strategy-create-message]')!.textContent).toContain('已存在');
  expect(params.value).toBe('{invalid');
});
