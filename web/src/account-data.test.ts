import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from './layout';
import { connectAccountData, csvCell, ownFills, usableSection, type AccountData, type AccountSection } from './account-data';
import { validate } from './api/client';
const wallet='0x'+'1'.repeat(40);
const section=(items:Record<string,unknown>[]=[]):AccountSection=>({available:true,complete:true,items,checked_at:new Date().toISOString(),source:'test'});
const data=():AccountData=>({schemaVersion:1,wallet,read_only:true,stale:false,checked_at:new Date().toISOString(),collateral:{...section(),value:108.7},open_orders:section(),trades:section(),positions:section(),closed_positions:section(),activity:section()});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();});
it('rejects cross-account and expired sections even when HTTP response is fresh',()=>{
  const d=data();expect(usableSection(d,'collateral',wallet)?.value).toBe(108.7);
  expect(usableSection(d,'collateral','0x'+'2'.repeat(40))).toBeNull();
  expect(usableSection(d,'collateral',wallet,Date.now()+91000)).toBeNull();
  d.stale=true;expect(usableSection(d,'collateral',wallet)).toBeNull();
});
it('accepts explicit unavailable envelopes but rejects malformed successful data',()=>{
  expect(()=>validate('account-data',{schemaVersion:1,wallet,read_only:true,stale:true,checked_at:null})).not.toThrow();
  expect(()=>validate('account-data',{...data(),positions:{available:true,items:'bad'}})).toThrow();
});
it('counts own maker matches instead of the full taker transaction',()=>{
  expect(ownFills({trader_side:'MAKER',size:'100',maker_orders:[{matched_amount:'3',price:'.4',order_id:'ours'}]})[0].size).toBe('3');
  expect(ownFills({size:'100'})).toEqual([]);
  expect(ownFills({trader_side:'MAKER',side:'SELL',maker_orders:[{matched_amount:'3',price:'.4',order_id:'ours'}]})[0].side).toBeNull();
  expect(ownFills({trader_side:'MAKER',outcome:'DOWN',maker_orders:[{matched_amount:'3',price:'.4',order_id:'ours'}]})[0].outcome).toBeNull();
});
it('escapes spreadsheet formula fields including leading whitespace',()=>{
  expect(csvCell(' =WEBSERVICE("secret")')).toBe('"\' =WEBSERVICE(""secret"")"');
});
it('renders real balances and positions, escapes upstream text, and clears after a read failure',async()=>{
  document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);
  const d=data();d.positions=section([{title:'<img src=x onerror=alert(1)>',outcome:'UP',size:3,avgPrice:.4,currentValue:1.3,cashPnl:.1}]);
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(d)));vi.stubGlobal('fetch',fetch);
  const ui=connectAccountData();ui.receiveAccount({wallet,wallet_configured:true,owner_signer_configured:true,relayer_api_configured:false,last_check:null,config_error:null,control_source:{scope:'local_preview',label:'本机预览服务',market_node:'都柏林节点'}});
  await ui.refresh();expect(document.querySelector('#view-home')!.textContent).toContain('$108.70');
  expect(document.querySelector('.side-note')!.textContent).toContain('本机预览服务');
  expect(document.querySelector('#account-positions')!.textContent).toContain('<img src=x');expect(document.querySelector('#account-positions img')).toBeNull();
  fetch.mockResolvedValue(new Response('',{status:503}));await ui.refresh();expect(document.querySelector('#view-home')!.textContent).not.toContain('$108.70');ui.close();
});
it('activates the original filter toolbar and filters real orders versus fills',async()=>{
  document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);
  const d=data();d.open_orders=section([{id:'order-open',market:'open-market',side:'BUY',price:'.4',size_matched:'0',created_at:1}]);
  d.trades=section([{id:'trade-filled',trader_side:'TAKER',taker_order_id:'order-filled',market:'filled-market',side:'BUY',price:'.5',size:'3',match_time:2,status:'CONFIRMED'}]);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(d))));
  const ui=connectAccountData();ui.receiveAccount({wallet,wallet_configured:true,owner_signer_configured:true,relayer_api_configured:false,last_check:null,config_error:null});await ui.refresh();
  const buttons=document.querySelector('#view-orders > .subnav')!.querySelectorAll<HTMLButtonElement>('button');
  expect(buttons[1].disabled).toBe(false);buttons[1].click();expect(document.querySelector('#view-orders tbody')!.textContent).toContain('open-market');expect(document.querySelector('#view-orders tbody')!.textContent).not.toContain('filled-market');
  buttons[2].click();expect(document.querySelector('#view-orders tbody')!.textContent).toContain('filled-market');expect(document.querySelector('#view-orders tbody')!.textContent).not.toContain('open-market');ui.close();
});

async function mounted(d:AccountData){
  document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(d))));
  const ui=connectAccountData();ui.receiveAccount({wallet,wallet_configured:true,owner_signer_configured:true,relayer_api_configured:false,last_check:null,config_error:null});await ui.refresh();return ui;
}
it('keeps failed and provisional trade reports out of settled fills and clears their accounting amounts',async()=>{
  const d=data();d.trades=section(['CONFIRMED','FAILED','MATCHED','MINED','RETRYING','UNKNOWN'].map((status,i)=>({trader_side:'TAKER',taker_order_id:'order-'+status,market:'market-'+status,price:'.5',size:'10',match_time:i,status})));
  const ui=await mounted(d);
  const body=document.querySelector('#view-orders tbody')!;
  for(const tr of Array.from(body.querySelectorAll('tr'))){
    const cells=tr.querySelectorAll('td');
    if(cells[1].textContent?.includes('CONFIRMED')){expect(cells[4].textContent).toBe('10.0000');expect(cells[5].textContent).toBe('$5.00');}
    else {expect(cells[4].textContent).toBe('--');expect(cells[5].textContent).toBe('--');}
  }
  const buttons=document.querySelector('#view-orders > .subnav')!.querySelectorAll<HTMLButtonElement>('button');
  buttons[2].click();expect(body.querySelectorAll('tr')).toHaveLength(1);expect(body.textContent).toContain('market-CONFIRMED');
  buttons[4].click();expect(body.querySelectorAll('tr')).toHaveLength(1);expect(body.textContent).toContain('market-FAILED');ui.close();
});
it('uses official cancellation status without treating missing or unmatched orders as canceled',async()=>{
  const d=data();d.order_history={...section([{id:'canceled',market:'official-cancel',status:'CANCELED'},{id:'missing',market:'unknown-order',status:'UNKNOWN'},{id:'matched',market:'matched-order',status:'MATCHED'},{id:'stale',market:'stale-cancel',status:'CANCELED',status_stale:true}].map(o=>({status_checked_at:new Date().toISOString(),status_stale:false,...o}))),coverage:'observed_order_ids',historical_complete:false};
  const ui=await mounted(d);
  document.querySelector('#view-orders > .subnav')!.querySelectorAll<HTMLButtonElement>('button')[3].click();
  const body=document.querySelector('#view-orders tbody')!;
  expect(body.textContent).toContain('official-cancel');expect(body.textContent).not.toContain('unknown-order');expect(body.textContent).not.toContain('matched-order');expect(body.textContent).not.toContain('stale-cancel');
  expect(document.querySelector('#account-data-state')!.textContent).toContain('非账户全部历史');ui.close();
});
it('filters reward activity by the same UTC period and excludes undated entries explicitly',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
  const d=data();d.activity=section([
    {type:'REWARD',timestamp:Date.parse('2026-09-10T01:00:00Z')/1000,usdcSize:11},
    {type:'MAKER_REBATE',timestamp:Date.parse('2026-09-01T01:00:00Z')/1000,usdcSize:22},
    {type:'REWARD',timestamp:Date.parse('2026-08-20T01:00:00Z')/1000,usdcSize:33},
    {type:'REWARD',timestamp:Date.parse('2026-07-20T01:00:00Z')/1000,usdcSize:44},
    {type:'REWARD',usdcSize:55},
  ]);
  const ui=await mounted(d),body=document.querySelector('#reward-payments tbody')!,period=document.querySelector<HTMLSelectElement>('#reward-period')!;
  expect(body.textContent).toContain('$11.00');expect(body.textContent).not.toContain('$22.00');
  period.selectedIndex=1;period.dispatchEvent(new Event('change'));expect(body.textContent).toContain('$22.00');expect(body.textContent).not.toContain('$33.00');
  period.selectedIndex=2;period.dispatchEvent(new Event('change'));expect(body.textContent).toContain('$33.00');expect(body.textContent).not.toContain('$44.00');
  period.selectedIndex=3;period.dispatchEvent(new Event('change'));expect(body.textContent).toContain('$44.00');expect(body.textContent).not.toContain('$55.00');
  expect(document.querySelector('#reward-payments .reward-status')!.textContent).toContain('日期不明');ui.close();
});
it('preserves unchanged account table nodes on timer renders but clears them when their source expires',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
  const d=data();d.positions=section([{title:'position',size:1}]);d.open_orders=section([{id:'open',market:'order'}]);d.activity=section([{type:'REWARD',timestamp:Date.now()/1000,usdcSize:3}]);
  const ui=await mounted(d),selectors=['#account-positions tbody tr','#view-orders tbody tr','#reward-payments tbody tr'];
  const nodes=selectors.map(s=>document.querySelector(s));
  vi.setSystemTime(new Date('2026-09-10T12:00:01Z'));ui.render();
  selectors.forEach((s,i)=>expect(document.querySelector(s)).toBe(nodes[i]));
  vi.setSystemTime(new Date('2026-09-10T12:01:31Z'));ui.render();
  selectors.forEach((s,i)=>expect(document.querySelector(s)).not.toBe(nodes[i]));
  expect(document.querySelector('#account-positions')!.textContent).not.toContain('position');expect(document.querySelector('#reward-payments tbody')!.textContent).not.toContain('$3.00');ui.close();
});
it('expires a reward from a rolling 30-day period without waiting for a network refresh',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
  const d=data();d.activity=section([{type:'REWARD',timestamp:(Date.now()+1000)/1000-30*86400,usdcSize:9}]);
  const ui=await mounted(d),period=document.querySelector<HTMLSelectElement>('#reward-period')!;
  period.selectedIndex=2;period.dispatchEvent(new Event('change'));expect(document.querySelector('#reward-payments tbody')!.textContent).toContain('$9.00');
  vi.setSystemTime(new Date('2026-09-10T12:00:02Z'));ui.render();expect(document.querySelector('#reward-payments tbody')!.textContent).not.toContain('$9.00');ui.close();
});
