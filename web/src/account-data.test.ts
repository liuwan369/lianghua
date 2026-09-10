import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from './layout';
import { connectAccountData, csvCell, ownFills, usableSection, type AccountData, type AccountSection } from './account-data';
import { validate } from './api/client';
const wallet='0x'+'1'.repeat(40);
const section=(items:Record<string,unknown>[]=[]):AccountSection=>({available:true,complete:true,items,checked_at:new Date().toISOString(),source:'test'});
const data=():AccountData=>({schemaVersion:1,wallet,read_only:true,stale:false,checked_at:new Date().toISOString(),collateral:{...section(),value:108.7},open_orders:section(),trades:section(),positions:section(),closed_positions:section(),activity:section()});
afterEach(()=>{vi.unstubAllGlobals();document.body.replaceChildren();});
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
