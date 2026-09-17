import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from './layout';
import { connect, prepareReadOnly } from './live-data';
let stop:(()=>void)|undefined;
afterEach(()=>{stop?.();stop=undefined;vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();});
function mount(){document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);}
it('has six direct navigation entries and keeps strategy parameters out of account settings',()=>{
  mount();expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'),b=>b.dataset.view)).toEqual(['home','trade','strategy','earnings','settings','tasks']);
  expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-setting]'),b=>b.dataset.setting)).toEqual(['account','system']);
  expect(document.querySelector('#view-settings #reversal-triggerPrice')).toBeNull();expect(document.querySelector('#view-strategy #reversal-triggerPrice')).not.toBeNull();expect(document.querySelectorAll('.latency-table tbody tr')).toHaveLength(8);
  expect(document.querySelector('#view-strategy')!.textContent).not.toMatch(/JSON|配对|做市|未配对/);expect(document.querySelector('#view-earnings')!.textContent).not.toMatch(/做市|专项奖励|Grants/);
});
it('switches views without replacing user input',()=>{
  mount();const input=document.querySelector<HTMLInputElement>('#reversal-triggerPrice')!;input.value='69';
  for(const name of ['home','trade','strategy','earnings','settings','tasks']){document.querySelector<HTMLButtonElement>(`[data-view="${name}"]`)!.click();expect(document.querySelector('.view.active')!.id).toBe(`view-${name}`);}
  expect(input.value).toBe('69');
});
it('does not run a strategy before server state and saved config are available',()=>{
  mount();prepareReadOnly();expect(document.querySelectorAll('script')).toHaveLength(0);
  for(const b of document.querySelectorAll<HTMLButtonElement>('[data-start],[data-stop],[data-pause]'))expect(b.disabled).toBe(true);
});
it('shows unavailable data honestly and makes only reads when endpoints fail',async()=>{
  vi.useFakeTimers();mount();const fetch=vi.fn().mockResolvedValue(new Response('',{status:401}));vi.stubGlobal('fetch',fetch);stop=connect();await vi.advanceTimersByTimeAsync(100);
  expect(document.getElementById('status')!.textContent).toContain('登录已失效');expect(document.getElementById('homeVolume')!.textContent).toBe('-- / --');expect(document.querySelector('#view-trade .quote b')!.textContent).toBe('-- / --');expect(fetch.mock.calls.every(([,opts])=>opts.method==='GET')).toBe(true);
});
