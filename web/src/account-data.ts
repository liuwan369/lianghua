import { get } from './api/client';
import type { Account, Obj } from './api/types';
import { date, esc, finite, money, number, price } from './ui';

export interface AccountSection { available: boolean; complete: boolean; items: Obj[]; checked_at: string; source: string; value?: number; error_code?: string; coverage?: string; historical_complete?: boolean }
export interface AccountData { schemaVersion: 1; account_id?: string | null; wallet: string | null; checked_at: string | null; stale: boolean; refreshing?: boolean; read_only: true; collateral?: AccountSection; open_orders?: AccountSection; order_history?: AccountSection; trades?: AccountSection; positions?: AccountSection; closed_positions?: AccountSection; activity?: AccountSection }
const numeric = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
const text = (selector: string, value: string) => { const el = document.querySelector(selector); if (el) el.textContent = value; };
const row = (section: string, label: string, value: string) => document.querySelectorAll(`${section} .row`).forEach(el => { if (el.querySelector('span')?.textContent === label) { const b=el.querySelector('b'); if(b)b.textContent=value; } });
export function usableSection(data: AccountData | null, name: keyof AccountData, wallet: string, now=Date.now()): AccountSection | null {
  if (!data || data.stale || !wallet || String(data.account_id || data.wallet).toLowerCase() !== wallet.toLowerCase()) return null;
  const s=data[name] as AccountSection | undefined;
  const age=now-Date.parse(s?.checked_at || '');
  return s?.available && Number.isFinite(age) && age>=-5000 && age<=90000 ? s : null;
}
export function csvCell(value: unknown) {
  let s=String(value ?? '');
  if (/^[\s]*[=+@-]/.test(s)) s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}

/** Trade IDs describe matches, not completed orders; maker matches use this wallet's own fills. */
export function ownFills(trade: Obj): Obj[] {
  if (String(trade.trader_side).toUpperCase()==='MAKER') {
    if (!Array.isArray(trade.maker_orders)) return [];
    return trade.maker_orders.map((m: Obj) => ({...trade,...m,side:m.side??null,outcome:m.outcome??null,asset_id:m.asset_id??null,size:m.matched_amount,order_id:m.order_id}));
  }
  if (String(trade.trader_side).toUpperCase()!=='TAKER') return [];
  return [{...trade,order_id:trade.taker_order_id}];
}

export function connectAccountData() {
  let data:AccountData|null=null, wallet='', sourceLabel='服务器', error:string|null=null, closed=false, loading=false, generation=0;
  let source='account', filter=0, page=0;
  let lastOrders:unknown[]=[],lastPositions:AccountSection|null|undefined;
  let lastFinancial:unknown[]=[],financialBoundary=0;
  const changed=(before:unknown[],after:unknown[])=>before.length!==after.length||after.some((v,i)=>v!==before[i]);
  const note=document.querySelector('#view-orders .note')!;
  const toolbar=document.createElement('div');toolbar.className='subnav';
  toolbar.innerHTML='<label>数据来源 <select id="orders-source"><option value="account">真实账户订单与成交</option><option value="run">运行事件（按运行模式）</option></select></label><button id="account-previous">上一页</button><button id="account-next">下一页</button><span id="account-data-state" role="status"></span>';
  note.before(toolbar);
  const selector=toolbar.querySelector<HTMLSelectElement>('select')!;
  const orderButtons=Array.from(document.querySelector('#view-orders > .subnav')!.querySelectorAll<HTMLButtonElement>('button'));
  const exportButton=document.querySelector<HTMLButtonElement>('#view-orders .head-actions button')!;
  const positions=document.createElement('div');positions.className='table-wrap';positions.id='account-positions';
  positions.innerHTML='<table class="table"><caption>真实账户持仓 · 与模拟运行库存分开</caption><thead><tr><th>市场</th><th>方向</th><th>份数</th><th>平均价</th><th>当前估值</th><th>平台报告盈亏</th></tr></thead><tbody></tbody></table>';
  document.querySelector('#view-home .grid')!.after(positions);
  const bindings:Array<()=>void>=[];
  const on=(el:Element,event:string,fn:EventListener)=>{el.addEventListener(event,fn);bindings.push(()=>el.removeEventListener(event,fn));};
  function section(name:keyof AccountData){return usableSection(data,name,wallet);}
  function rows() {
    const orders=section('open_orders'),trades=section('trades'),history=section('order_history');
    const a=(orders?.items||[]).map(o=>({time:numeric(o.created_at),market:o.market,side:`${o.outcome||''} ${o.side||''}`,price:numeric(o.price),shares:numeric(o.size_matched),amount:null,fee:null,status:`未完成 · ${o.status||'平台挂单'}`,kind:'open',id:o.id}));
    const b=(trades?.items||[]).flatMap(ownFills).map(t=>{const p=numeric(t.price),confirmed=String(t.status).toUpperCase()==='CONFIRMED',failed=String(t.status).toUpperCase()==='FAILED',q=confirmed?numeric(t.size):null;return {time:numeric(t.match_time),market:t.market,side:`${t.outcome||''} ${t.side||''}`,price:p,shares:q,amount:p!==null&&q!==null?p*q:null,fee:null,status:`${confirmed?'已确认成交':failed?'成交失败':'成交待确认'} · ${t.status||'未知'}`,kind:confirmed?'fill':failed?'failed':'pending',id:t.order_id};});
    const c=(history?.items||[]).filter(o=>o.status_stale===false&&['CANCELED','CANCELLED'].includes(String(o.status).toUpperCase())).map(o=>({time:numeric(o.created_at),market:o.market,side:`${o.outcome||''} ${o.side||''}`,price:numeric(o.price),shares:null,amount:null,fee:null,status:`已撤单 · ${o.status}`,kind:'canceled',id:o.id}));
    return [...a,...b,...c].filter(r=>filter===0||filter===1&&r.kind==='open'||filter===2&&r.kind==='fill'||filter===3&&r.kind==='canceled'||filter===4&&r.kind==='failed').sort((a,b)=>(b.time||0)-(a.time||0));
  }
  function renderOrders() {
    const signature=[source,filter,page,wallet,error,section('open_orders'),section('trades'),section('order_history')];
    if(!changed(lastOrders,signature))return;
    lastOrders=signature;
    document.getElementById('view-orders')!.dataset.source=source;
    const runHistory=document.getElementById('history-run')?.closest<HTMLElement>('.subnav');if(runHistory)runHistory.hidden=source==='account';
    for(const id of ['account-previous','account-next','account-data-state'])document.getElementById(id)!.hidden=source!=='account';
    orderButtons.forEach((b,i)=>{b.disabled=source!=='account';b.classList.toggle('active',i===filter);});
    exportButton.disabled=source!=='account'||!rows().length;
    if(source!=='account')return;
    const all=rows();page=Math.min(page,Math.max(0,Math.ceil(all.length/50)-1));const slice=all.slice(page*50,(page+1)*50);
    const complete=section('open_orders')?.complete&&section('trades')?.complete;
    const history=section('order_history');
    const scope=filter===3?history?`已观察订单范围 · ${history.complete?'状态查询完成':history.error_code==='order_details_unavailable'?'官方未返回部分订单详情，撤单状态无法核对':'状态尚未全部查明'} · 非账户全部历史`:'已撤订单状态尚无来源':complete?'当前挂单与成交查询已完整返回':'来源未就绪或分页不完整';
    text('#account-data-state',error||`${wallet||'未配置账户'} · 第 ${page+1} 页 · ${scope}`);
    text('#view-orders .note','仅 CONFIRMED 回报列入已成交；待确认与失败回报不计成交份数和金额。撤单状态取自官方订单查询，仅覆盖已观察的订单，不推断消失挂单已撤。费率不是实际扣费。导出覆盖当前筛选下已获取记录。');
    document.querySelector('#view-orders tbody')!.innerHTML=slice.length?slice.map(r=>`<tr><td>${date(r.time)}</td><td>${esc(r.market)}<small> ${esc(r.id)}</small></td><td>${esc(r.side)}</td><td>${price(r.price)}</td><td>${number(r.shares,4)}</td><td>${money(r.amount)}</td><td>--</td><td>${esc(r.status)}</td></tr>`).join(''):`<tr><td colspan="8" class="empty">${esc(error|| (filter===3?history?'已观察订单中暂无确认撤单记录；不代表账户历史没有撤单':'平台已撤订单历史尚无来源，不能推断为空':complete?'当前筛选无记录':'等待真实账户数据，不能判断为空'))}</td></tr>`;
    (document.getElementById('account-previous') as HTMLButtonElement).disabled=page===0;
    (document.getElementById('account-next') as HTMLButtonElement).disabled=(page+1)*50>=all.length;
  }
  function render() {
    if(closed)return;
    const cash=section('collateral'),pos=section('positions'),orders=section('open_orders');
    row('#view-home','账户余额',cash&&finite(cash.value)?`${money(cash.value)} · CLOB 抵押资产余额（未扣挂单占用）`:`-- · ${error||'账户余额等待同步'}`);
    row('#view-home','当前持仓',pos?`${pos.items.length} 项 · 真实账户${pos.complete?'':' · 未完整'}`:'-- · 持仓未获取或已过期');
    if(pos!==lastPositions){
      lastPositions=pos;
      positions.querySelector('tbody')!.innerHTML=pos?.items.length?pos.items.map(p=>`<tr><td>${esc(p.title||p.slug||p.conditionId)}</td><td>${esc(p.outcome)}</td><td>${number(numeric(p.size),4)}</td><td>${price(numeric(p.avgPrice))}</td><td>${money(numeric(p.currentValue))}</td><td>${money(numeric(p.cashPnl))}</td></tr>`).join(''):`<tr><td colspan="6">${pos?.complete?'当前账户无持仓':'持仓尚未完整获取'}</td></tr>`;
    }
    if(orders?.complete){text('#homeOrders',number(orders.items.length));text('#homeOrders + small','当前真实未完成委托 · 不是今日/月累计');}
    else {text('#homeOrders','--');text('#homeOrders + small','真实未完成委托尚未完整获取');}
    // The trade panel follows a run; do not place account-wide inventory inside a paper run.
    const holder=document.querySelector('#view-trade .panel .empty');
    if(holder){holder.textContent=orders?`真实账户未完成委托 ${orders.items.length} 条${orders.complete?'':'（未完整）'}；详见订单页。此数值不代表模拟委托。`:'真实账户委托等待同步；模拟委托需按运行核对。';}
    const timing=data?.checked_at?new Date(data.checked_at).toLocaleString('zh-CN',{hour12:false}):'--';
    text('.side-note',`${sourceLabel}\n账户数据：${error|| (data?.stale?'已过期':timing)}\n账户记录与运行事件分开`);
    renderOrders();renderFinancial();
  }
  function renderFinancial() {
    const closedPositions=section('closed_positions'),activity=section('activity'),period=document.querySelector<HTMLSelectElement>('#reward-period')?.selectedIndex||0;
    const signature=[closedPositions,activity,period];
    if(!changed(lastFinancial,signature)&&Date.now()<financialBoundary)return;
    lastFinancial=signature;
    const now=new Date();let since=0;
    if(period===0)since=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())/1000;
    if(period===1)since=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)/1000;
    if(period===2)since=Date.now()/1000-30*86400;
    financialBoundary=period===0?Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1):period===1?Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1):Infinity;
    if(period===2){
      const times=[...(closedPositions?.items||[]),...(activity?.items||[])].map(p=>numeric(p.timestamp)).filter((t):t is number=>t!==null&&t>=since);
      if(times.length)financialBoundary=times.reduce((a,b)=>Math.min(a,b),Infinity)*1000+30*86400000+1;
    }
    const items=(closedPositions?.items||[]).filter(p=>{const t=numeric(p.timestamp);return t!==null&&t>=since;});
    const values=items.map(p=>numeric(p.realizedPnl));
    const valid=closedPositions?.complete&&closedPositions.items.every(p=>numeric(p.timestamp)!==null)&&values.every(v=>v!==null);
    const pnl=valid?values.reduce<number>((sum,v)=>sum+(v||0),0):null;
    for(const root of ['#income-summary','#reward-ledger-section .stats']){
      text(`${root} .stat:nth-child(1) label`,'已关闭持仓报告盈亏');
      text(`${root} .stat:nth-child(1) strong`,money(pnl));
      text(`${root} .stat:nth-child(1) small`,'Data API 已关闭持仓 reported realizedPnl · 非钱包净收益');
    }
    text('#reward-period-note',`${['今日 UTC','本月 UTC','近 30 天','全部已获取历史'][period]} · ${closedPositions?.complete?'已关闭持仓查询完整':'已关闭持仓未完整'}；费用和到账核对尚未完成`);
    const body=document.querySelector('#reward-payments tbody');
    const rewards=(activity?.items||[]).filter(a=>{const t=numeric(a.timestamp);return ['REWARD','MAKER_REBATE'].includes(String(a.type))&&t!==null&&t>=since;});
    if(body)body.innerHTML=rewards.length?rewards.map(a=>`<tr><td>${esc(a.type)}</td><td>${date(numeric(a.timestamp))}</td><td>接口记账单位 USDC</td><td>${money(numeric(a.usdcSize))}</td><td>官方活动记录 · 链上归属待核对</td><td>${/^0x[0-9a-fA-F]{64}$/.test(String(a.transactionHash))?`<a target="_blank" rel="noopener noreferrer" href="https://polygonscan.com/tx/${esc(a.transactionHash)}">查看交易</a>`:'无交易凭证'}</td></tr>`).join(''):'<tr><td colspan="6">已接入账户活动查询；未取得可核对的奖励付款记录，不能据此认定没有奖励。</td></tr>';
    text('#reward-payments .reward-status',activity?`账户活动 · ${['今日 UTC','本月 UTC','近 30 天','全部已获取历史'][period]} · ${activity.complete?'查询完整':'部分记录'}${activity.items.some(a=>['REWARD','MAKER_REBATE'].includes(String(a.type))&&numeric(a.timestamp)===null)?' · 存在日期不明记录，未计入所选期间':''}`:'账户活动等待同步');
    // Neither fee rate nor an activity label proves the wallet's final net profit.
  }
  on(selector,'change',()=>{source=selector.value;page=0;renderOrders();});
  orderButtons.forEach((b,i)=>on(b,'click',()=>{filter=i;page=0;renderOrders();}));
  on(document.getElementById('account-previous')!,'click',()=>{page--;renderOrders();});
  on(document.getElementById('account-next')!,'click',()=>{page++;renderOrders();});
  on(document.getElementById('reward-period')!,'change',renderFinancial);
  on(exportButton,'click',()=>{
    if(source!=='account')return;
    const content=[['账户','数据范围','时间','市场','订单ID','方向','价格','成交份数','名义金额','费用','状态'],...rows().map(r=>[wallet,'当前筛选已获取记录',date(r.time),r.market,r.id,r.side,r.price,r.shares,r.amount,'未知',r.status])].map(r=>r.map(csvCell).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\uFEFF'+content],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='account-records.csv';a.click();URL.revokeObjectURL(url);
  });
  async function refresh(){
    if(loading||closed)return;loading=true;const epoch=generation;
    try{const value=await get<AccountData>('account-data','/api/v1/account-data');if(!closed&&epoch===generation){data=value;error=null;}}
    catch(e){if(epoch===generation){data=null;error=e instanceof SyntaxError?'账户数据格式错误，已清空旧值':e instanceof Error?e.message:'账户数据读取失败';}}
    finally{loading=false;render();}
  }
  return { refresh, render, receiveAccount(a:Account|null){sourceLabel=a?.control_source?.label||'来源未标注';const next=a?.wallet||'';if(next.toLowerCase()!==wallet.toLowerCase()){wallet=next;data=null;generation++;page=0;}render();}, close(){closed=true;bindings.forEach(f=>f());} };
}
