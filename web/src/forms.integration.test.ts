import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from './layout';
import { connect } from './live-data';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop=undefined; vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const params = { mode:'paper', order_usd:2, maker_life_sec:15, duration_min:5, max_total_usd:100, max_orders:50, pair_cost_max:.99, decision_interval_ms:23, defensive_cancel_bps:12 };
async function setup() {
  vi.useFakeTimers();
  document.body.innerHTML='<div id="app"></div>';
  mountLayout(document.getElementById('app')!);
  let revision=3;
  const requests: {path:string; body:Record<string,unknown>}[]=[];
  const fetch=vi.fn(async (path:string, options:RequestInit) => {
    if(options.method==='POST') {
      requests.push({path,body:JSON.parse(options.body as string)});
      return new Response(JSON.stringify({ok:false,error:path.includes('/account/')?'请使用带登录保护的 HTTPS 页面接入账户':'配置版本已变化，请重新读取后保存',current_revision:4}),{status:path.includes('/account/')?403:409});
    }
    if(path==='/api/v1/config') return new Response(JSON.stringify({schemaVersion:1,revision,savedAt:null,params,capabilities:{supportedFields:Object.keys(params),demoFieldMappings:{order:'order_usd',life:'maker_life_sec',duration:'duration_min',submitted:'max_total_usd',maxOrders:'max_orders',mode:'mode'}}}));
    if(path==='/api/account/status') return new Response(JSON.stringify({wallet:'0x'+'1'.repeat(40),wallet_configured:true,owner_signer_configured:true,relayer_api_configured:false,config_error:null,last_check:null}));
    if(path.startsWith('/api/v1/runs')) return new Response(JSON.stringify({schemaVersion:1,runs:[],next_before_id:null}));
    return new Response('{}',{status:503});
  });
  vi.stubGlobal('fetch',fetch);stop=connect();await vi.advanceTimersByTimeAsync(100);
  return {requests,fetch,advanceRevision:()=>{revision=4;}};
}
function input(selector:string,value:string) {
  const el=document.querySelector<HTMLInputElement>(selector)!;
  expect(el.disabled).toBe(false);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));return el;
}
function click(selector:string) { const b=document.querySelector<HTMLButtonElement>(selector)!;expect(b.disabled).toBe(false);b.click(); }

it('keeps edited account and strategy values through ticks and polling without background writes',async()=>{
  const {requests}=await setup();
  const order=input('#setting-order','3');
  const capital=input('#setting-capital','200');
  const wallet=input('#settings-account input','0x'+'2'.repeat(40));
  await vi.advanceTimersByTimeAsync(11000);
  expect(order.value).toBe('3');expect(capital.value).toBe('200');expect(wallet.value).toBe('0x'+'2'.repeat(40));
  expect(requests).toHaveLength(0);
});

it('preserves hidden config fields and edit revision on conflict while keeping the draft',async()=>{
  const {requests,advanceRevision}=await setup();
  const order=input('#setting-order','3');advanceRevision();await vi.advanceTimersByTimeAsync(5100);
  click('#settings-strategy [data-settings-save]');await vi.advanceTimersByTimeAsync(100);
  expect(requests).toHaveLength(1);expect(requests[0]).toEqual({path:'/api/v1/config',body:{expected_revision:3,params:{...params,order_usd:3}}});
  expect(order.value).toBe('3');expect(document.querySelector('#settings-strategy [data-settings-message]')!.textContent).toContain('版本');
});

it('validates empty numeric inputs before sending config',async()=>{
  const {requests}=await setup();input('#setting-order','');
  click('#settings-strategy [data-settings-save]');await vi.advanceTimersByTimeAsync(100);
  expect(requests).toHaveLength(0);
});

it('round trips engine parameters through the versioned save without replacing separate risk drafts',async()=>{
  const {fetch}=await setup();const original=fetch.getMockImplementation()!;
  let saved:Record<string,unknown>|undefined;
  fetch.mockImplementation(async(path,options)=>{
    if(options.method==='POST') {
      saved=JSON.parse(options.body as string);
      return new Response(JSON.stringify({ok:true,status:{schemaVersion:1,revision:4,savedAt:null,params:saved!.params,capabilities:{}}}));
    }
    return original(path,options);
  });
  expect(document.querySelector<HTMLInputElement>('#setting-pairCost')!.value).toBe('0.99');
  input('#setting-pairCost','0.97');input('#setting-decisionInterval','120');input('#setting-defensiveCancel','8');
  input('#setting-cap','0.96');
  click('#settings-strategy [data-settings-save]');await vi.advanceTimersByTimeAsync(100);
  expect(saved).toEqual({expected_revision:3,params:{...params,pair_cost_max:.97,decision_interval_ms:120,defensive_cancel_bps:8}});
  expect(document.querySelector<HTMLInputElement>('#setting-pairCost')!.value).toBe('0.97');
  expect(document.querySelector<HTMLInputElement>('#setting-cap')!.dataset.persistence).toBe('draft');
  expect(document.querySelector('[data-settings-message]')!.textContent).toContain('版本 4');
});

it('account buttons surface protected endpoint errors without saving or losing the public address',async()=>{
  const {requests}=await setup();const wallet=input('#settings-account input','0x'+'2'.repeat(40));
  click('[data-setting="account"]');
  const check=Array.from(document.querySelectorAll<HTMLButtonElement>('#settings-account button')).find(b=>b.textContent==='检查账户')!;
  expect(check.disabled).toBe(false);check.click();await vi.advanceTimersByTimeAsync(100);
  expect(requests).toHaveLength(1);expect(requests[0].path).toBe('/api/account/check');
  expect(document.querySelector('#settings-account')!.textContent).toContain('登录');
  expect(wallet.value).toBe('0x'+'2'.repeat(40));
  expect(requests.some(r=>r.path.includes('/trading/'))).toBe(false);
});

it('does not let an older account read overwrite a successful account save',async()=>{
  const {fetch}=await setup();
  const original=fetch.getMockImplementation()!;
  let release!:(value:Response)=>void, accountReads=0;
  const oldRead=new Promise<Response>(resolve=>{release=resolve;});
  const newWallet='0x'+'2'.repeat(40);
  fetch.mockImplementation(async(path,options)=>{
    if(options.method==='POST') {
      expect(path).toBe('/api/account/save');
      return new Response(JSON.stringify({ok:true,report:{wallet:newWallet,account_ready:false,signer_matches:false,approvals_ready:false}}));
    }
    if(path==='/api/account/status') {
      if(++accountReads===1)return oldRead;
      return new Response(JSON.stringify({wallet:newWallet,wallet_configured:true,owner_signer_configured:false,relayer_api_configured:false,config_error:null,last_check:null}));
    }
    return original(path,options);
  });
  await vi.advanceTimersByTimeAsync(5000);
  const wallet=input('#settings-account input',newWallet);click('[data-setting="account"]');click('[data-save]');
  await vi.advanceTimersByTimeAsync(100);
  release(new Response(JSON.stringify({wallet:'0x'+'1'.repeat(40),wallet_configured:true,owner_signer_configured:true,relayer_api_configured:false,config_error:null,last_check:null})));
  await vi.advanceTimersByTimeAsync(100);
  expect(wallet.value).toBe(newWallet);
  expect(document.querySelector('#settings-account .note')!.textContent).toContain('账户已保存');
});

it('confirms supported config saves, excludes unsupported drafts, and updates the saved revision',async()=>{
  const {fetch}=await setup();const original=fetch.getMockImplementation()!;
  let saved:Record<string,unknown>|undefined;
  fetch.mockImplementation(async(path,options)=>{
    if(options.method==='POST') {
      saved=JSON.parse(options.body as string);
      return new Response(JSON.stringify({ok:true,status:{schemaVersion:1,revision:4,savedAt:null,params:{...params,order_usd:3},capabilities:{}}}));
    }
    return original(path,options);
  });
  input('#setting-order','3');const capital=input('#setting-capital','200');
  click('#settings-strategy [data-settings-save]');await vi.advanceTimersByTimeAsync(100);
  expect(saved).toEqual({expected_revision:3,params:{...params,order_usd:3}});
  expect(document.querySelector('[data-effective-summary]')!.textContent).toContain('已保存版本 4');
  expect(document.querySelector('[data-settings-message]')!.textContent).toContain('不会保存或生效');
  await vi.advanceTimersByTimeAsync(5100);
  expect((document.querySelector('#setting-order') as HTMLInputElement).value).toBe('3');
  expect(capital.value).toBe('200');
});

it('discovers new runs while preserving the selected historical run and pagination',async()=>{
  const {fetch}=await setup();const original=fetch.getMockImplementation()!;
  const source=document.querySelector<HTMLSelectElement>('#orders-source')!;
  source.value='run';source.dispatchEvent(new Event('change'));
  let newest=false;
  const run=(id:number)=>({id,run_id:`run-${id}`,mode:'paper',account_id:null,config_revision:1,created_at:id});
  fetch.mockImplementation(async(path,options)=>{
    if(path.startsWith('/api/v1/runs'))return new Response(JSON.stringify({schemaVersion:1,
      runs:path.includes('before_id=2')?[run(1)]:newest?[run(3),run(2)]:[run(2)],
      next_before_id:path.includes('before_id=2')?null:2}));
    if(path.startsWith('/api/v1/events'))return new Response(JSON.stringify({schemaVersion:1,
      run_id:new URL(path,'https://example.test').searchParams.get('run_id'),events:[],next_before_id:null}));
    return original(path,options);
  });
  await vi.advanceTimersByTimeAsync(5100);
  click('#older-runs');await vi.advanceTimersByTimeAsync(100);
  const select=document.querySelector<HTMLSelectElement>('#history-run')!;
  select.value='run-1';select.dispatchEvent(new Event('change'));await vi.advanceTimersByTimeAsync(100);
  newest=true;await vi.advanceTimersByTimeAsync(5100);
  expect(Array.from(select.options).map(option=>option.value)).toEqual(['run-3','run-2','run-1']);
  expect(select.value).toBe('run-1');
  expect(document.querySelector('#history-state')!.textContent).toContain('run-1');
  expect(document.querySelector<HTMLButtonElement>('#older-runs')!.disabled).toBe(true);
});
