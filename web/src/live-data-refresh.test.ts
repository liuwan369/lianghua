import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from './layout';
import { connect } from './live-data';

let close: (() => void) | undefined;
afterEach(() => {
  close?.();close=undefined;vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();
});
function mount() {
  vi.useFakeTimers();vi.setSystemTime(1_800_003_600_000);
  document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);
}
const stopped = () => ({schemaVersion:1,asOf:1_800_000_000,running:false,mode:null,run_id:null,
  account_id:null,config_revision:null,params:{},live_unlocked:true,stop_result:{},stats:{},projection:null,engine:null});
const market = (at=1_800_000_000) => ({schemaVersion:1,asOf:at,node_label:'Dublin',collector_online:true,cache_age_seconds:0.1,
  current_markets:[{slug:'btc',start:at-100,end:at+200,up_bid:.4,up_ask:.41,down_bid:.59,down_ask:.6,
    ask_sum:1.01,quote_at:new Date((at-.2)*1000).toISOString()}]});
const response=(body:unknown)=>new Response(JSON.stringify(body));

it('uses the server clock for public quote age when the browser clock is an hour ahead',async()=>{
  mount();
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path==='/api/v1/status'?response(stopped()):
    path==='/api/v1/markets'?response(market()):new Response('{}',{status:503})));
  close=connect();await vi.advanceTimersByTimeAsync(10);
  expect(document.querySelector('[data-book-age]')!.textContent).toBe('约 200 ms');
  expect(document.querySelector('[data-book-source]')!.textContent).toContain('公开行情 · 策略未运行');
  expect(document.querySelector('#view-trade .quote b')!.textContent).toBe('0.4000 / 0.4100');
});

it('refreshes public quotes every second while a status request is slow without overlapping it',async()=>{
  mount();let marketCalls=0;
  const fetch=vi.fn((path:string)=>{
    if(path==='/api/v1/status'||path==='/api/v1/config')return new Promise<Response>(()=>{});
    if(path==='/api/v1/markets')return Promise.resolve(response(market(1_800_000_000+marketCalls++)));
    return Promise.resolve(new Response('{}',{status:503}));
  });
  vi.stubGlobal('fetch',fetch);close=connect();await vi.advanceTimersByTimeAsync(10);
  expect(marketCalls).toBe(1);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(marketCalls).toBe(4);
  expect(fetch.mock.calls.filter(([path])=>path==='/api/v1/status')).toHaveLength(1);
  expect(document.querySelector('[data-book-age]')!.textContent).toBe('约 200 ms');
  close();close=undefined;await vi.advanceTimersByTimeAsync(2_000);
  expect(marketCalls).toBe(4);
});
