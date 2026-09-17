import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from '../layout';
import { connectStrategy, type StrategyConfig } from './strategy';

const config={triggerPrice:.67,confirmationPrice:.70,maxBuyPrice:.70,stageShares:[5,18,54,130],maxStages:4,roundBudgetUsd:null,totalBudgetUsd:null,dailyLossUsd:null,durationMinutes:0,mode:'live',maxQuoteAgeSeconds:2,maxQuoteSkewSeconds:1.5};
const envelope=(revision=3)=>({schemaVersion:1,strategyId:'btc-reversal',savedRevision:revision,config,activeRevision:2,nextRoundRevision:revision});
let ui:ReturnType<typeof connectStrategy>|undefined;
afterEach(()=>{ui?.close();ui=undefined;vi.unstubAllGlobals();document.body.replaceChildren();});
function mount(){document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);return document.getElementById('view-strategy')!;}
function input(id:string,value:string){const el=document.querySelector<HTMLInputElement>(id)!;el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));return el;}
async function setup(){const root=mount();const fetch=vi.fn().mockImplementation(async()=>new Response(JSON.stringify(envelope())));vi.stubGlobal('fetch',fetch);ui=connectStrategy();await ui.refresh();return {root,fetch};}
it('shows one strategy with independently selected settings panels and no JSON or maker inputs',()=>{
  const root=mount();expect(root.querySelectorAll('[data-strategy-id]')).toHaveLength(1);expect(root.querySelector('textarea')).toBeNull();expect(document.querySelector('#setting-pairCost')).toBeNull();
  expect(root.querySelector<HTMLElement>('[data-strategy-panel="run"]')!.hidden).toBe(true);root.querySelector<HTMLButtonElement>('[data-strategy-tab="run"]')!.click();expect(root.querySelector<HTMLElement>('[data-strategy-panel="parameters"]')!.hidden).toBe(true);expect(root.querySelector<HTMLElement>('[data-strategy-panel="run"]')!.hidden).toBe(false);
});
it('preserves edited values across polling and reports optimistic version conflict without losing input',async()=>{
  const {root,fetch}=await setup();const price=input('#reversal-triggerPrice','66');fetch.mockResolvedValueOnce(new Response(JSON.stringify(envelope(4))));await ui!.refresh();expect(price.value).toBe('66');
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({error:'conflict'}),{status:409}));root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await vi.waitFor(()=>expect(root.querySelector('[data-reversal-message]')!.textContent).toContain('其他页面'));
  const sent=JSON.parse(fetch.mock.calls.at(-1)![1]!.body);expect(sent.expectedRevision).toBe(3);expect(sent.config.triggerPrice).toBe(.66);expect(sent.config.totalBudgetUsd).toBeNull();expect(price.value).toBe('66');
});
it('presets change editable prices and shares while preserving budgets, then save actual config',async()=>{
  const {root,fetch}=await setup();input('#reversal-totalBudgetUsd','160');root.querySelector<HTMLButtonElement>('[data-reversal-preset="75"]')!.click();expect(document.querySelector<HTMLInputElement>('#reversal-totalBudgetUsd')!.value).toBe('160');input('#reversal-triggerPrice','71');
  fetch.mockImplementationOnce(async(_path,options)=>new Response(JSON.stringify({...envelope(4),config:JSON.parse(options.body).config})));
  root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await vi.waitFor(()=>expect(root.querySelector('[data-reversal-message]')!.textContent).toContain('版本 4'));
  const sent=JSON.parse(fetch.mock.calls.at(-1)![1]!.body);expect(sent.config).toMatchObject({triggerPrice:.71,maxBuyPrice:.75,totalBudgetUsd:160,stageShares:[5,22,75,236]});expect(fetch.mock.calls.at(-1)![1]!.method).toBe('PUT');
});
it('rejects invalid prices and blank stage values before saving',async()=>{
  const {root,fetch}=await setup();input('#reversal-triggerPrice','80');root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));expect(fetch).toHaveBeenCalledTimes(1);expect(root.querySelector('[data-reversal-message]')!.textContent).toContain('不能高于');
  input('#reversal-triggerPrice','67');input('#reversal-stage-0','');root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));expect(fetch).toHaveBeenCalledTimes(1);
});
it('supports user-selected stage count without a fixed four-stage choice',async()=>{
  await setup();const n=input('#reversal-maxStages','5');n.dispatchEvent(new Event('change'));expect(document.querySelectorAll('[data-reversal-share]')).toHaveLength(5);expect(document.querySelector<HTMLInputElement>('#reversal-stage-0')!.value).toBe('5');expect(document.querySelector<HTMLInputElement>('#reversal-stage-4')!.value).toBe('');
});
