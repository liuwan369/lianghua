import { afterEach, expect, it, vi } from 'vitest';
import { connectTradingControls } from './trading-controls';
import { mountLayout } from './layout';
import type { Config, Status } from './api/types';
afterEach(()=>{vi.unstubAllGlobals();document.body.replaceChildren();});
const config={schemaVersion:1,revision:3,savedAt:null,params:{mode:'paper'},capabilities:{}} as Config;
const status={running:false,mode:'paper'} as Status;
function setup(){document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);return connectTradingControls(async()=>{});}
it('never offers live execution or sends a request from live configuration',()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const control=setup();control.receive({...config,params:{mode:'live'}},status);
  const start=document.querySelector<HTMLButtonElement>('[data-start]')!;expect(start.disabled).toBe(true);start.click();expect(fetch).not.toHaveBeenCalled();control.close();
});
it('reuses request identity after an ambiguous network failure and blocks double clicks',async()=>{
  const fetch=vi.fn().mockRejectedValue(new TypeError('offline'));vi.stubGlobal('fetch',fetch);const control=setup();control.receive(config,status);
  const start=document.querySelector<HTMLButtonElement>('[data-start]')!;start.click();start.click();await vi.waitFor(()=>expect(start.disabled).toBe(false));expect(fetch).toHaveBeenCalledTimes(1);
  start.click();await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);control.close();
});
it('drops a rejected revision so a new saved revision can start',async()=>{
  const fetch=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({ok:false,error:'配置版本已变化'}),{status:409}));vi.stubGlobal('fetch',fetch);
  const control=setup();control.receive(config,status);const start=document.querySelector<HTMLButtonElement>('[data-start]')!;
  start.click();await vi.waitFor(()=>expect(start.disabled).toBe(false));control.receive({...config,revision:4},status);start.click();
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));expect(JSON.parse(fetch.mock.calls[1][1].body).revision).toBe(4);
  expect(JSON.parse(fetch.mock.calls[1][1].body).request_id).not.toBe(JSON.parse(fetch.mock.calls[0][1].body).request_id);control.close();
});
