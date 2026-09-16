import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, validate } from './client';

afterEach(()=>vi.unstubAllGlobals());

const market = { slug:'btc-1', start:100, end:400, up_bid:.49, up_ask:.5, down_bid:.49, down_ask:.5, ask_sum:1, quote_at:'2026-01-01T00:00:00Z' };
describe('versioned API validation', () => {
  it('accepts complete config and rejects unknown shape', () => {
    expect(() => validate('config', {schemaVersion:1, revision:2, savedAt:null, params:{}, capabilities:{}})).not.toThrow();
    expect(() => validate('config', {schemaVersion:1, revision:2, savedAt:null, params:{}})).toThrow();
  });
  it('rejects malformed market rows instead of rendering stale prices', () => {
    const valid = {schemaVersion:1, asOf:100, node_label:'Dublin', collector_online:true, cache_age_seconds:1, current_markets:[market]};
    expect(() => validate('markets', valid)).not.toThrow();
    expect(() => validate('markets', {...valid, current_markets:[{...market, up_ask:'0.5'}]})).toThrow();
  });
  it('requires the explicit account safety fields', () => {
    expect(() => validate('account', {wallet:'',wallet_configured:false,owner_signer_configured:false,relayer_api_configured:false,builder_api_configured:false,config_error:null,last_check:null})).not.toThrow();
    expect(() => validate('account', {wallet:'',wallet_configured:false})).toThrow();
  });
  it('uses no cached network response when the endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', {status:503})));
    const { api } = await import('./client');
    await expect(api.config()).rejects.toThrow('读取失败（HTTP 503）');
    vi.unstubAllGlobals();
  });
  it('rejects malformed or unscoped optional order history',()=>{
    const base={schemaVersion:1,read_only:true,stale:true,wallet:null,checked_at:null};
    const section={available:true,complete:true,checked_at:new Date().toISOString(),source:'clob-v2-order-detail',items:[],coverage:'observed_order_ids',historical_complete:false};
    expect(()=>validate('account-data',{...base,order_history:section})).not.toThrow();
    expect(()=>validate('account-data',{...base,order_history:{...section,items:[{}]}})).toThrow();
    expect(()=>validate('account-data',{...base,order_history:{...section,historical_complete:true}})).toThrow();
  });
  it('validates the read-only anti-signal sample contract',()=>{
    expect(()=>validate('anti-signal',{schemaVersion:1,status:'ONLINE',rule:'BOLL_BREAKOUT_20_1.5',mode:'read_only_no_orders',samples:{observed:3,skipped:1,forecasted:2,settled:1,pending:1,direct_hits:0,inverse_hits:1,direct_accuracy:0,inverse_accuracy:1},recent:[]})).not.toThrow();
    expect(()=>validate('anti-signal',{schemaVersion:1,status:'ONLINE',rule:'x',mode:'read_only_no_orders',samples:{observed:-1,skipped:0,forecasted:0,settled:0,pending:0,direct_hits:0,inverse_hits:0,direct_accuracy:null,inverse_accuracy:null}})).toThrow();
  });
  it('accepts old task data and validates optional architecture without deriving completion',()=>{
    const item = {id:'order',title:'下单',status:'DONE',detail:'已实现',next:'无',verification:'已验证'};
    const group = {id:'execution',title:'执行',owner:'执行 Agent',scope:'CORE',detail:'可复用',items:[item]};
    const base = {schemaVersion:1,title:'任务',updatedAt:'2026-09-16T00:00:00Z',summary:'说明',hardRules:[],phases:[]};
    const architecture = {title:'功能架构',summary:'各模块完成情况',groups:[group]};
    expect(()=>validate('tasks',base)).not.toThrow();
    expect(()=>validate('tasks',{...base,architecture})).not.toThrow();
    for(const invalid of [null,{}, {...architecture,groups:[{...group,scope:'UNKNOWN'}]}, {...architecture,groups:[{...group,items:[{...item,status:'RUNNING'}]}]}, {...architecture,groups:[{...group,items:[{...item,verification:null}]}]}]) {
      expect(()=>validate('tasks',{...base,architecture:invalid})).toThrow();
    }
    expect(()=>validate('tasks',{...base,architecture:{...architecture,groups:[group,group]}})).toThrow();
    expect(()=>validate('tasks',{...base,architecture:{...architecture,groups:[group,{...group,id:'other'}]}})).toThrow();
    expect(()=>validate('tasks',{...base,architecture:{...architecture,groups:[{...group,items:[item,item]}]}})).toThrow();
    expect(()=>validate('tasks',{...base,architecture:{...architecture,groups:[{...group,id:' '}]}})).toThrow();
  });
  it('allows repeated task IDs across phases but rejects duplicates within a phase',()=>{
    const item={id:'LIVE-03',title:'订单',owner:'执行',status:'TODO',detail:'测试',next:'下一步'};
    const phase={id:'P1',title:'阶段',owner:'执行',status:'TODO',detail:'说明',tasks:[item]};
    const base={schemaVersion:1,title:'任务',updatedAt:'2026-09-16T00:00:00Z',summary:'说明',hardRules:[],phases:[phase,{...phase,id:'P2'}]};
    expect(()=>validate('tasks',base)).not.toThrow();
    expect(()=>validate('tasks',{...base,phases:[{...phase,tasks:[item,item]}]})).toThrow();
    expect(()=>validate('tasks',{...base,phases:[phase,phase]})).toThrow();
  });
  it('does not reflect submitted credentials in an account failure', async () => {
    const owner_key='a'.repeat(64), relayer_key='synthetic-relayer-test-only', builder_secret='builder-secret-test-only';
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:false,error:`rejected ${owner_key} ${relayer_key} ${builder_secret}`} ),{status:400})));
    const error=await api.checkAccount({wallet:'',owner_key,relayer_key,builder_secret}).catch(e=>e as Error);
    expect((error as Error).message).toContain('HTTP 400');
    expect((error as Error).message).not.toContain(owner_key);
    expect((error as Error).message).not.toContain(relayer_key);
    expect((error as Error).message).not.toContain(builder_secret);
  });
  it('rejects proxy HTML and malformed save confirmations', async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response('<html>upstream failed</html>',{status:502}));
    vi.stubGlobal('fetch',fetch);
    await expect(api.saveConfig({},3)).rejects.toThrow('HTTP 502');
    fetch.mockResolvedValue(new Response(JSON.stringify({ok:true,status:{}})));
    await expect(api.saveConfig({},3)).rejects.toThrow();
  });
});
