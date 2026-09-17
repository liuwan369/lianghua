import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from '../layout';
import { connectAccountData,aggregateOrders } from '../account-data';
import { connectStrategyOrders } from './strategy-orders';
let close:()=>void=()=>{};
afterEach(()=>{close();vi.unstubAllGlobals();document.body.replaceChildren();});
const orders=(n:number)=>Array.from({length:n},(_,i)=>({event:'order',market:'btc-five',side:'UP',time:100-i,client_order_id:`client-${i}`,order_id:`order-${i}`,direction:'BUY',status:'OPEN',shares:5,price:.7,filled_shares:0,amount:0,...(i===0?{cancel_ack_latency_ms:125}:{})}));
it('aggregates repeated partial fills and cancel evidence into one exchange order',()=>{
  const trade={id:'fill-1',trader_side:'TAKER',taker_order_id:'one',status:'CONFIRMED',size:2,price:.6,match_time:1};
  const result=aggregateOrders([],[trade,trade,{...trade,id:'fill-2',size:3}],[{id:'one',market:'btc-five',status:'CANCELED',status_stale:false,price:.7}]);
  expect(result).toHaveLength(1);expect(result[0]).toMatchObject({id:'one',kind:'canceled',shares:5,amount:3});expect(result[0].fills).toHaveLength(2);
});
it('holds the same server snapshot while paging and supports 10/20/50 rows',async()=>{
  document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);const account=connectAccountData();
  const fetch=vi.fn(async(path:string)=>{const q=new URL(path,'https://example.test').searchParams,limit=Number(q.get('limit')),offset=Number(q.get('offset'));return new Response(JSON.stringify({schemaVersion:1,orders:orders(35).slice(offset,offset+limit),total:35,offset,limit,has_more:offset+limit<35,asOf:1000,snapshotEventId:321}));});vi.stubGlobal('fetch',fetch);
  const ui=connectStrategyOrders();close=()=>{ui.close();account.close();};ui.receive('run-1','btc-five');await vi.waitFor(()=>expect(document.querySelectorAll('#trade-orders tbody tr')).toHaveLength(10));
  expect(document.querySelector('#trade-orders tbody')!.textContent).toContain('撤单确认 125.0 ms');
  document.querySelector<HTMLButtonElement>('[data-strategy-order-next]')!.click();await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));expect(fetch.mock.calls[1][0]).toContain('as_of=1000');expect(fetch.mock.calls[1][0]).toContain('snapshot_event_id=321');expect(fetch.mock.calls[1][0]).toContain('offset=10');expect(new URL(fetch.mock.calls[1][0],'https://example.test').searchParams.get('market')).toBe('btc-five');
  const select=document.querySelector<HTMLSelectElement>('[data-strategy-order-size]')!;expect(Array.from(select.options).map(o=>o.value)).toEqual(['10','20','50']);select.value='20';select.dispatchEvent(new Event('change'));await vi.waitFor(()=>expect(document.querySelectorAll('#trade-orders tbody tr')).toHaveLength(20));expect(fetch.mock.calls.at(-1)![0]).not.toContain('as_of');expect(fetch.mock.calls.at(-1)![0]).toContain('offset=0');
});
it('does not query unknown current market or expose raw HTML from server records',async()=>{
  document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);const account=connectAccountData();const fetch=vi.fn(async()=>new Response(JSON.stringify({schemaVersion:1,orders:[{...orders(1)[0],market:'<img src=x onerror=alert(1)>'}],total:1,limit:10,offset:0,has_more:false,asOf:1000,snapshotEventId:321})));vi.stubGlobal('fetch',fetch);const ui=connectStrategyOrders();close=()=>{ui.close();account.close();};ui.receive('run',null);await ui.refresh();expect(fetch).not.toHaveBeenCalled();ui.receive('run','btc-five');await vi.waitFor(()=>expect(document.querySelector('#trade-orders tbody')!.textContent).toContain('<img'));expect(document.querySelector('#trade-orders tbody img')).toBeNull();
});
