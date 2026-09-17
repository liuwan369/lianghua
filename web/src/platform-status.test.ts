import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from './layout';
import { connect } from './live-data';
import { executionName, platformRuntime } from './ui';
import { validate } from './api/client';
import type { Status } from './api/types';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop=undefined; vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function fixture(now=Date.now()/1000): Status {
  return {schemaVersion:1,asOf:now,running:true,mode:'paper',run_id:'platform-one',account_id:null,config_revision:1,params:{max_total_usd:10},live_unlocked:false,stop_result:{},execution_target:'platform',engine:'platform',execution:'observation',strategy_id:null,
    control_source:{scope:'collector_host',label:'都柏林服务器',market_node:'Dublin'},
    projection:{run_id:'platform-one',state:'ready',stale:false},stats:{available:true,fills:0,fill_notional:0,events:[],runtime:{engine:'platform',execution:'observation',strategy_id:null,status:'running',mode:'paper',source_at:now,expires_at:now+10,stale:false,cash_usd:1000,positions_count:0,orders_count:0,active_orders:0,fills_count:0,risk:{halted:false},limits:{capitalUsd:1000},markets:[],books:[]}}};
}
it('accepts platform snapshots while preserving legacy status compatibility',()=>{
  const status=fixture();
  expect(()=>validate('status',status)).not.toThrow();
  expect(()=>validate('status',{...status,engine:'legacy',execution:'legacy',stats:{runtime:null}})).not.toThrow();
  expect(()=>validate('status',{...status,stats:{runtime:{...(status.stats.runtime as object),source_at:'yesterday'}}})).toThrow();
  expect(executionName({...status,engine:'legacy'})).toBe('旧引擎纸面');
});
it('rejects expired, cross-run and stopped snapshots as current even with a fresh API response',()=>{
  const status=fixture(1000);
  expect(platformRuntime(status,1001).current).toBe(true);
  expect(platformRuntime({...status,asOf:1011},1011).current).toBe(false);
  expect(platformRuntime({...status,projection:{run_id:'old',state:'ready',stale:false}},1001).current).toBe(false);
  expect(platformRuntime({...status,running:false},1001).current).toBe(false);
  expect(platformRuntime({...status,stats:{runtime:null}},1001).current).toBe(false);
});
it('renders simulated platform values separately and removes current values when the snapshot ages',async()=>{
  vi.useFakeTimers();
  document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);
  const status=fixture();
  const fixtures:Record<string,unknown>={
    '/api/v1/status':status,
    '/api/v1/config':{schemaVersion:1,revision:1,savedAt:null,params:{mode:'paper',duration_min:0},capabilities:{executionTarget:'platform',executionMode:'observation',runtimeAppliedFields:['mode','duration_min'],preservedLegacyFields:[]}},
    '/api/v1/runs':{schemaVersion:1,runs:[],next_before_id:null},
  };
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>new Response(JSON.stringify(fixtures[path.split('?')[0]]||{}),{status:fixtures[path.split('?')[0]]?200:503})));
  stop=connect();await vi.advanceTimersByTimeAsync(100);
  expect(document.querySelector('#homeStrategy')!.textContent).toContain('平台观察 · 运行中 · 未加载策略');
  expect(document.querySelector('[data-runtime-cash]')!.textContent).toBe('$1,000.00 · 模拟资金');
  expect(document.querySelector('[data-runtime-source]')!.textContent).toContain('都柏林服务器');
  expect(document.querySelector('[data-runtime-counts]')!.textContent).toBe('0 / 0');
  expect(document.querySelector('#homeOrders')!.textContent).toBe('--');
  expect(document.querySelector('[data-start]')!.textContent).toBe('启动 BTC 反转');
  status.asOf+=11;
  await vi.advanceTimersByTimeAsync(5100);
  expect(document.querySelector('[data-runtime-cash]')!.textContent).not.toContain('$1,000');
  expect(document.querySelector('[data-runtime-source]')!.textContent).toContain('已过期');
  expect(document.querySelector('#homeVolume')!.textContent).toBe('-- / --');
  status.running=false;
  await vi.advanceTimersByTimeAsync(5100);
  expect(document.querySelector('[data-runtime-source]')!.textContent).toContain('历史最终快照');
  expect(document.querySelector('#homeStrategy')!.textContent).toContain('已停止');
});
