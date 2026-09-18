import { afterEach, expect, it, vi } from 'vitest';
import { connectTradingControls } from './trading-controls';
import { mountLayout } from './layout';
import type { Config, Status } from './api/types';
afterEach(()=>{vi.unstubAllGlobals();document.body.replaceChildren();});
const config={schemaVersion:1,revision:3,savedAt:null,params:{mode:'paper'},capabilities:{}} as Config;
const status={running:false,mode:'paper'} as Status;
function setup(){document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);return connectTradingControls(async()=>{});}
const strategy={schemaVersion:1,strategyId:'btc-reversal',savedRevision:3,config:{mode:'live'}} as any;
it('requires saved strategy config and connects actual live control without paper gating',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true})));vi.stubGlobal('fetch',fetch);const control=setup();control.receive({...config,params:{mode:'live'}},status);
  const start=document.querySelector<HTMLButtonElement>('[data-start]')!;expect(start.disabled).toBe(true);
  control.receiveStrategy(strategy);expect(start.disabled).toBe(false);start.click();await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
  expect(fetch.mock.calls[0][0]).toBe('/api/trading/control');expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({action:'start',mode:'live',strategy_id:'btc-reversal',revision:3});control.close();
});
it('reuses request identity after an ambiguous network failure and blocks double clicks',async()=>{
  const fetch=vi.fn().mockRejectedValue(new TypeError('offline'));vi.stubGlobal('fetch',fetch);const control=setup();control.receive(config,status);control.receiveStrategy(strategy);
  const start=document.querySelector<HTMLButtonElement>('[data-start]')!;start.click();start.click();await vi.waitFor(()=>expect(start.disabled).toBe(false));expect(fetch).toHaveBeenCalledTimes(1);
  start.click();await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);control.close();
});
it('drops a rejected revision so a new saved revision can start',async()=>{
  const fetch=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({ok:false,error:'配置版本已变化'}),{status:409}));vi.stubGlobal('fetch',fetch);
  const control=setup();control.receive(config,status);control.receiveStrategy(strategy);const start=document.querySelector<HTMLButtonElement>('[data-start]')!;
  start.click();await vi.waitFor(()=>expect(start.disabled).toBe(false));control.receive({...config,revision:4},status);control.receiveStrategy({...strategy,savedRevision:4});start.click();
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));expect(JSON.parse(fetch.mock.calls[1][1].body).revision).toBe(4);
  expect(JSON.parse(fetch.mock.calls[1][1].body).request_id).not.toBe(JSON.parse(fetch.mock.calls[0][1].body).request_id);control.close();
});
it.each([401,400,403,409])('shows an HTTP %s start rejection on both overview and automatic trading pages',async(status)=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:false,error:'启动未接受'}),{status}));vi.stubGlobal('fetch',fetch);
  const control=setup();control.receive({...config,params:{mode:'live'}},{...({running:false,mode:'paper'} as Status),live_unlocked:true});control.receiveStrategy(strategy);
  const start=document.querySelector<HTMLButtonElement>('[data-start]')!;start.click();
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
  await vi.waitFor(()=>expect(document.querySelectorAll<HTMLElement>('[data-trading-message]')).toHaveLength(2));
  await vi.waitFor(()=>expect(document.querySelector<HTMLElement>('[data-trading-message]')?.textContent).toContain(`HTTP ${status}`));
  const messages=Array.from(document.querySelectorAll<HTMLElement>('[data-trading-message]')).map(node=>node.textContent);
  expect(messages[0]).toContain(`HTTP ${status}`);expect(messages[1]).toBe(messages[0]);
  expect(document.querySelectorAll<HTMLElement>('[data-trading-message]')[0].getAttribute('aria-live')).toBe('polite');
  if(status===401){
    start.click();await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetch.mock.calls[1][1].body).request_id).not.toBe(JSON.parse(fetch.mock.calls[0][1].body).request_id);
  }
  control.close();
});
