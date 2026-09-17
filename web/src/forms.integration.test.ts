import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from './layout';
import { connect } from './live-data';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop=undefined; vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const params = { mode:'paper', order_usd:2, maker_life_sec:15, duration_min:5, max_total_usd:100, max_orders:50, pair_cost_max:.99, decision_interval_ms:23, defensive_cancel_bps:12 };
async function setup(capabilities:Record<string,unknown> = {}) {
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
    if(path==='/api/v1/config') return new Response(JSON.stringify({schemaVersion:1,revision,savedAt:null,params,capabilities:{supportedFields:Object.keys(params),demoFieldMappings:{order:'order_usd',life:'maker_life_sec',duration:'duration_min',submitted:'max_total_usd',maxOrders:'max_orders',mode:'mode'},...capabilities}}));
    if(path==='/api/account/status') return new Response(JSON.stringify({wallet:'0x'+'1'.repeat(40),wallet_configured:true,owner_signer_configured:true,relayer_api_configured:false,builder_api_configured:false,config_error:null,last_check:null}));
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
      return new Response(JSON.stringify({wallet:newWallet,wallet_configured:true,owner_signer_configured:false,relayer_api_configured:false,builder_api_configured:false,config_error:null,last_check:null}));
    }
    return original(path,options);
  });
  await vi.advanceTimersByTimeAsync(5000);
  const wallet=input('#settings-account input',newWallet);click('[data-setting="account"]');click('[data-save]');
  await vi.advanceTimersByTimeAsync(100);
  release(new Response(JSON.stringify({wallet:'0x'+'1'.repeat(40),wallet_configured:true,owner_signer_configured:true,relayer_api_configured:false,builder_api_configured:false,config_error:null,last_check:null})));
  await vi.advanceTimersByTimeAsync(100);
  expect(wallet.value).toBe(newWallet);
  expect(document.querySelector('#settings-account .note')!.textContent).toContain('账户已保存');
});
