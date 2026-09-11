import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { mountLayout } from './layout';
import { connect, prepareReadOnly } from './live-data';

const docs = resolve(process.cwd(), '../docs');
const reference = readFileSync(resolve(docs,'demo-trading-console.html'), 'utf8');
function mount() { document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!); }
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();});

describe('approved six-page design regression',()=>{
  it('retains every approved section, heading, form and reward card',()=>{
    const baseline=new JSDOM(reference,{url:'http://localhost',runScripts:'outside-only'});
    baseline.window.HTMLElement.prototype.scrollIntoView=()=>{};
    for(const script of baseline.window.document.querySelectorAll('script')) {
      baseline.window.eval(script.src ? readFileSync(resolve(docs,script.getAttribute('src')!),'utf8') : script.textContent!);
    }
    mount();
    const signature=(doc:Document,selector:string)=>Array.from(doc.querySelectorAll(selector),e=>e.textContent?.trim());
    expect(signature(document,'.view h1,.view h2,.view h3:not([data-engine-extension]),details summary')).toEqual(signature(baseline.window.document,'.view h1,.view h2,.view h3,details summary'));
    expect(signature(document,'[data-view],[data-setting]')).toEqual(signature(baseline.window.document,'[data-view],[data-setting]'));
    expect(document.querySelectorAll('.reward-card')).toHaveLength(baseline.window.document.querySelectorAll('.reward-card').length);
    expect(Array.from(document.querySelectorAll('input,select')).filter(e=>!e.closest('[data-engine-extension]')).map(e=>e.id)).toEqual(Array.from(baseline.window.document.querySelectorAll('input,select'),e=>e.id));
    expect(Array.from(document.querySelectorAll('[data-engine-extension] input'),e=>e.id)).toEqual(['setting-pairCost','setting-decisionInterval','setting-defensiveCancel']);
    expect(document.querySelectorAll('.latency-table tbody tr')).toHaveLength(8);
    expect(document.querySelector('#view-home')!.querySelectorAll('.stat')).toHaveLength(8);
    const css=readFileSync(resolve(process.cwd(),'src/style.css'),'utf8');
    expect(css.replace(/\r\n/g, '\n')).toBe(reference.match(/<style>([\s\S]*?)<\/style>/)![1].replace(/\r\n/g, '\n'));
    baseline.window.close();
  });
  it('keeps six-page navigation and four settings tabs usable without replacing the DOM',()=>{
    mount();const input=document.getElementById('setting-order');
    for(const name of ['home','trade','markets','orders','earnings','settings']){
      document.querySelector<HTMLButtonElement>(`[data-view="${name}"]`)!.click();
      expect(document.querySelector('.view.active')!.id).toBe(`view-${name}`);
    }
    for(const name of ['strategy','run','account','system']){
      document.querySelector<HTMLButtonElement>(`[data-setting="${name}"]`)!.click();
      expect(document.getElementById(`settings-${name}`)!.style.display).toBe('block');
    }
    expect(document.getElementById('setting-order')).toBe(input);
  });
  it('keeps the rewards calculator and stops all demo execution and storage',()=>{
    mount();prepareReadOnly();
    const input=document.getElementById('reward-wv') as HTMLInputElement;
    input.value='12000';input.dispatchEvent(new Event('input'));
    expect(document.getElementById('reward-tier-result')!.textContent).toContain('8,000');
    expect(document.querySelectorAll('script')).toHaveLength(0);
    for(const b of document.querySelectorAll<HTMLButtonElement>('[data-start],[data-stop]'))expect(b.disabled).toBe(true);
    expect(document.querySelectorAll('#view-settings input:disabled,#view-settings select:disabled')).toHaveLength(0);
    expect((document.getElementById('setting-cap') as HTMLInputElement).value).toBe('');
  });
  it('shows unknown status when endpoints fail and only sends GET requests',async()=>{
    vi.useFakeTimers();mount();
    const fetch=vi.fn().mockResolvedValue(new Response('',{status:401}));vi.stubGlobal('fetch',fetch);
    const stop=connect();await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById('status')!.textContent).toContain('登录已失效');
    expect(document.getElementById('homeVolume')!.textContent).toBe('-- / --');
    expect(document.querySelector('#view-trade .quote b')!.textContent).toBe('-- / --');
    expect(document.querySelector('#view-markets tbody')!.textContent).toContain('登录已失效');
    expect(document.querySelectorAll('.reward-card').length).toBeGreaterThan(9);
    expect(fetch.mock.calls.every(([,opts])=>opts.method==='GET')).toBe(true);
    stop();
  });
  it('fills the original positions with server data and clears quotes after a failed refresh',async()=>{
    vi.useFakeTimers();mount();const now=Date.now()/1000;
    const fixtures: Record<string,unknown> = {
      '/api/v1/config':{schemaVersion:1,revision:3,savedAt:null,params:{mode:'paper',order_usd:2,maker_life_sec:15},capabilities:{}},
      '/api/v1/status':{schemaVersion:1,asOf:now,running:true,mode:'paper',run_id:'r1',account_id:null,config_revision:3,params:{max_total_usd:10},live_unlocked:false,stop_result:{},stats:{available:true,fills:2,fill_notional:4,events:[]},projection:{stale:false,state:'ready',run_id:'r1'}},
      '/api/v1/markets':{schemaVersion:1,asOf:now,node_label:'测试节点',collector_online:true,cache_age_seconds:0,current_markets:[{slug:'test-market',start:now-10,end:now+100,up_bid:.4,up_ask:.41,down_bid:.58,down_ask:.59,ask_sum:1,quote_at:new Date(now*1000).toISOString()}]},
      '/api/account/status':{wallet:'',wallet_configured:false,owner_signer_configured:false,relayer_api_configured:false,builder_api_configured:false,config_error:null,last_check:null},
      '/api/v1/runs':{schemaVersion:1,runs:[{id:1,run_id:'r1',mode:'paper',account_id:null,created_at:now,config_revision:3}],next_before_id:null},
      '/api/v1/events':{schemaVersion:1,run_id:'r1',events:[{id:1,event:'fill',market:'<img src=x onerror=alert(1)>',time:now,side:'UP',price:.4,shares:5,amount:2,fee:null,pnl:null}],next_before_id:null},
    };
    const fetch=vi.fn().mockImplementation((path:string)=>Promise.resolve(new Response(JSON.stringify(fixtures[path.split('?')[0]]))));
    vi.stubGlobal('fetch',fetch);const stop=connect();await vi.advanceTimersByTimeAsync(100);
    const source=document.querySelector<HTMLSelectElement>('#orders-source')!;
    source.value='run';source.dispatchEvent(new Event('change'));await vi.advanceTimersByTimeAsync(1000);
    expect(document.getElementById('homeVolume')!.textContent).toBe('2 / $4.00');
    expect(document.querySelector('#view-trade .quote b')!.textContent).toBe('0.4000 / 0.4100');
    expect((document.getElementById('setting-order') as HTMLInputElement).value).toBe('2');
    expect(document.querySelector('#view-orders tbody')!.textContent).toContain('<img src=x');
    expect(document.querySelector('#view-orders tbody img')).toBeNull();
    const eventPage=fixtures['/api/v1/events'] as {events: unknown[]};
    eventPage.events.push({...eventPage.events[0] as object,id:2,market:'new-event'});
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelector('#view-orders tbody')!.textContent).toContain('new-event');
    fetch.mockResolvedValue(new Response('',{status:503}));await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelector('#view-trade .quote b')!.textContent).toBe('-- / --');
    expect(document.getElementById('homeVolume')!.textContent).toBe('-- / --');
    expect(document.getElementById('reward-center')!.querySelectorAll('.reward-card').length).toBeGreaterThan(9);
    stop();
  });
});
