import { get } from './api/client';
import type { Account, Obj } from './api/types';
import { weightedAverageFillPrice } from './order-pricing';
import { date, esc, finite, money, number, price } from './ui';

export interface AccountSection { available: boolean; complete: boolean; items: Obj[]; checked_at: string; source: string; value?: number; error_code?: string; coverage?: string; historical_complete?: boolean }
export interface AccountData { schemaVersion: 1; account_id?: string | null; wallet: string | null; checked_at: string | null; stale: boolean; refreshing?: boolean; error_code?: string; read_only: true; collateral?: AccountSection; open_orders?: AccountSection; order_history?: AccountSection; trades?: AccountSection; positions?: AccountSection; closed_positions?: AccountSection; activity?: AccountSection; fees?: FinanceSection; rewards?: FinanceSection; reconciliation?: FinanceSection; occupancy?: Occupancy }
export function classifyPositions(items:Obj[]) {
  const groups:{active:Obj[];pending:Obj[];settled:Obj[];unknown:Obj[]}={active:[],pending:[],settled:[],unknown:[]};
  for(const item of items){
    const size=numeric(item.size),currentValue=numeric(item.currentValue);
    if(size===null||size<0||currentValue===null||currentValue<0||typeof item.redeemable!=='boolean')groups.unknown.push(item);
    else if(item.redeemable===true){
      if(currentValue>0)groups.pending.push(item);else groups.settled.push(item);
    }else if(size>0)groups.active.push(item);
    else groups.unknown.push(item);
  }
  return groups;
}
interface FinanceSection { available:boolean; complete:boolean; checked_at:string; known_amount?:number|null; items?: Record<string,unknown>[]; reason?:string; wallet_net_profit?:number|null; receipts_checked?:number; receipts_pending?:number }
interface Occupancy { available:boolean; complete:boolean; open_buy_notional:number|null; balance_after_open_buy_notional:number|null; spendable_balance:number|null; source?:string; reason?:string }
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

export interface OrderRow { id:string; time:number|null; market:unknown; side:string; price:number|null; averagePrice:number|null; shares:number|null; amount:number|null; status:string; kind:string; fills:Obj[] }
/** One exchange order per row; repeated reports of the same trade do not add fills twice. */
export function aggregateOrders(orders: Obj[], trades: Obj[], history: Obj[]): OrderRow[] {
  const grouped = new Map<string,OrderRow>();
  for (const order of [...history, ...orders]) {
    if (typeof order.id !== 'string' || !order.id) continue;
    const state = String(order.status || '').toUpperCase();
    const open = orders.some(item => item.id === order.id);
    const canceled = !open && order.status_stale === false && ['CANCELED','CANCELLED'].includes(state);
    grouped.set(order.id, {id:order.id,time:numeric(order.created_at),market:order.market,side:`${order.outcome || ''} ${order.side || ''}`.trim(),price:numeric(order.price),averagePrice:null,shares:null,amount:null,status:open?'未完成':canceled?'已撤单':order.status_stale?'状态待更新':state === 'MATCHED'?'成交待确认':'状态待核对',kind:open?'open':canceled?'canceled':'pending',fills:[]});
  }
  const reports = new Map<string,Obj>();
  for (const trade of trades) for (const fill of ownFills(trade)) {
    if (typeof fill.order_id !== 'string' || !fill.order_id) continue;
    const key = `${fill.order_id}:${fill.id ?? [fill.match_time,fill.transaction_hash,fill.price,fill.size].join(':')}`;
    const prior = reports.get(key);
    const priority = (v:Obj) => ['FAILED','CONFIRMED'].includes(String(v.status).toUpperCase()) ? 2 : 1;
    if (!prior || priority(fill) >= priority(prior)) reports.set(key, fill);
  }
  for (const fill of reports.values()) {
    const id = String(fill.order_id), state = String(fill.status).toUpperCase();
    let row = grouped.get(id);
    if (!row) { row = {id,time:numeric(fill.match_time),market:fill.market,side:`${fill.outcome || ''} ${fill.side || ''}`.trim(),price:numeric(fill.price),averagePrice:null,shares:null,amount:null,status:'成交待确认',kind:'pending',fills:[]}; grouped.set(id,row); }
    row.fills.push(fill);
    if (state === 'CONFIRMED') {
      const q=numeric(fill.size),p=numeric(fill.price);
      if (q !== null && p !== null) { row.shares=(row.shares ?? 0)+q;row.amount=(row.amount ?? 0)+q*p; }
      if (row.kind !== 'open' && row.kind !== 'canceled') { row.kind='fill';row.status='已确认成交'; }
    } else if (state === 'FAILED' && row.kind === 'pending') { row.kind='failed';row.status='成交失败'; }
  }
  for (const row of grouped.values()) row.averagePrice=weightedAverageFillPrice(row.fills);
  return [...grouped.values()].sort((a,b)=>(b.time ?? 0)-(a.time ?? 0)||a.id.localeCompare(b.id));
}

export function connectAccountData() {
  let data:AccountData|null=null, wallet='', sourceLabel='服务器', error:string|null=null, closed=false, loading=false, generation=0;
  let source='strategy', filter=0, page=0, pageSize=10, currentMarket='', roundScope='all';
  let orderedIds:string[]=[]; let lastRows:OrderRow[]=[];
  let lastOrders:unknown[]=[],lastPositions:AccountSection|null|undefined;
  let lastFinancial:unknown[]=[],financialBoundary=0;
  const changed=(before:unknown[],after:unknown[])=>before.length!==after.length||after.some((v,i)=>v!==before[i]);
  const note=document.querySelector('#trade-orders .note')!;
  const toolbar=document.createElement('div');toolbar.className='subnav';
  toolbar.innerHTML='<label>订单来源 <select id="orders-source"><option value="strategy">本次策略订单</option><option value="account">账户历史（已获取范围）</option></select></label><label>场次 <select id="orders-round"><option value="all">全部场次</option><option value="current">当前场次</option></select></label><label>每页 <select id="orders-page-size"><option value="10">10 条</option><option value="20">20 条</option><option value="50">50 条</option></select></label><button id="account-previous">上一页</button><button id="account-next">下一页</button><span id="account-data-state" role="status"></span>';
  note.before(toolbar);
  const selector=toolbar.querySelector<HTMLSelectElement>('select')!;
  const orderButtons=Array.from(document.querySelector('#trade-orders > .subnav')!.querySelectorAll<HTMLButtonElement>('button'));
  const exportButton=document.querySelector<HTMLButtonElement>('#trade-orders .head-actions button')!;
  const positions=document.createElement('section');positions.id='account-positions';
  document.querySelector('#view-home .grid')!.after(positions);
  const bindings:Array<()=>void>=[];
  const on=(el:Element,event:string,fn:EventListener)=>{el.addEventListener(event,fn);bindings.push(()=>el.removeEventListener(event,fn));};
  function section(name:keyof AccountData){return usableSection(data,name,wallet);}
  function rows() {
    return aggregateOrders(section('open_orders')?.items || [], section('trades')?.items || [], section('order_history')?.items || [])
      .filter(r => (roundScope !== 'current' || !!currentMarket && r.market === currentMarket) && (filter===0||filter===1&&r.kind==='open'||filter===2&&r.kind==='fill'||filter===3&&r.kind==='canceled'||filter===4&&r.kind==='failed'));
  }
  function renderOrders() {
    const signature=[source,filter,page,pageSize,currentMarket,roundScope,wallet,error,section('open_orders'),section('trades'),section('order_history')];
    if(!changed(lastOrders,signature))return;
    lastOrders=signature;
    const ordersRoot=document.getElementById('trade-orders')!;
    if(source==='account')ordersRoot.dataset.orderOwner='account';
    else if(ordersRoot.dataset.orderOwner==='account')delete ordersRoot.dataset.orderOwner;
    ordersRoot.dataset.source=source;
    const runHistory=document.getElementById('history-run')?.closest<HTMLElement>('.subnav');if(runHistory)runHistory.hidden=true;
    for(const id of ['account-previous','account-next','account-data-state'])document.getElementById(id)!.hidden=source!=='account';
    orderButtons.forEach((b,i)=>{b.disabled=false;if(source==='account')b.classList.toggle('active',i===filter);});
    exportButton.disabled=source!=='account'||!rows().length;
    toolbar.querySelectorAll<HTMLElement>('label').forEach(label=>{if(!label.contains(selector))label.hidden=source!=='account';});
    if(source!=='account')return;
    const currentRows=rows(), byId=new Map(currentRows.map(r=>[r.id,r]));
    // Preserve historical membership as new orders arrive; page 1 follows latest orders.
    if(page===0) orderedIds=currentRows.map(r=>r.id);
    const all=orderedIds.map(id=>byId.get(id)).filter((r):r is OrderRow=>!!r);
    lastRows=all; const slice=all.slice(page*pageSize,(page+1)*pageSize);
    const complete=section('open_orders')?.complete&&section('trades')?.complete;
    const history=section('order_history');
    const scope=filter===3?history?`已观察订单范围 · ${history.complete?'状态查询完成':history.error_code==='order_details_unavailable'?'官方未返回部分订单详情，撤单状态无法核对':'状态尚未全部查明'} · 非账户全部历史`:'已撤订单状态尚无来源':complete?'当前挂单与成交查询已完整返回':'来源未就绪或分页不完整';
    text('#account-data-state',error||`${wallet||'未配置账户'} · 第 ${page+1} 页 · 每页 ${pageSize} 条 · ${scope}`);
    text('#trade-orders .note','账户历史包含手工和其他程序交易，不代表本次策略下单。每行一个真实订单，成交份数仅计已确认回报；此处仅为已获取范围。');
    const renderSignature=JSON.stringify({error,source,filter,page,pageSize,currentMarket,roundScope,slice});
    if((ordersRoot.dataset.accountRenderSignature||'')!==renderSignature){
      ordersRoot.dataset.accountRenderSignature=renderSignature;
      document.querySelector('#trade-orders tbody')!.innerHTML=slice.length?slice.map(r=>`<tr><td>${date(r.time)}</td><td>${esc(r.market)}<details><summary>订单详情</summary><small>${esc(r.id)}</small>${r.fills.map(f=>`<div>${date(numeric(f.match_time))} · ${price(numeric(f.price))} × ${number(numeric(f.size),4)} · ${esc(f.status)}</div>`).join('')}</details></td><td>${esc(r.side)}</td><td>${price(r.price)}</td><td>${price(r.averagePrice)}</td><td>${number(r.shares,4)}</td><td>${money(r.amount)}</td><td>--</td><td>${esc(r.status)}</td></tr>`).join(''):`<tr><td colspan="9" class="empty">${esc(error|| (filter===3?history?'已观察订单中暂无确认撤单记录；不代表账户历史没有撤单':'平台已撤订单历史尚无来源，不能推断为空':complete?'当前筛选无记录':'等待真实账户数据，不能判断为空'))}</td></tr>`;
    }
    (document.getElementById('account-previous') as HTMLButtonElement).disabled=page===0;
    (document.getElementById('account-next') as HTMLButtonElement).disabled=(page+1)*pageSize>=all.length;
  }
  function render() {
    if(closed)return;
    const cash=section('collateral'),pos=section('positions'),orders=section('open_orders');
    const occupancy=cash&&orders?.complete?data?.occupancy:null;
    const balanceLabel=cash&&finite(cash.value)?`${money(cash.value)} · CLOB 抵押资产余额${occupancy?.available&&finite(occupancy.open_buy_notional)?` · 未结买单占用 ${money(occupancy.open_buy_notional)}`:''}`:`-- · ${error||'账户余额等待同步'}`;
    row('#view-home','账户余额',balanceLabel);
    const grouped=classifyPositions(pos?.items||[]);
    row('#view-home','当前持仓',pos?`${grouped.active.length} 项${grouped.unknown.length?` · ${grouped.unknown.length} 项待核对`:''}${pos.complete?'':' · 未完整'}${grouped.pending.length?` · ${grouped.pending.length} 项待到账`:''}`:'-- · 持仓未获取或已过期');
    if(pos!==lastPositions){
      lastPositions=pos;
      const table=(items:Obj[],caption:string,empty:string)=>`<div class="table-wrap"><table class="table"><caption>${caption}</caption><thead><tr><th>市场</th><th>方向</th><th>份数</th><th>平均价</th><th>当前估值</th><th>平台报告盈亏</th></tr></thead><tbody>${items.length?items.map(p=>`<tr><td>${esc(p.title||p.slug||p.conditionId)}</td><td>${esc(p.outcome)}</td><td>${number(numeric(p.size),4)}</td><td>${price(numeric(p.avgPrice))}</td><td>${money(numeric(p.currentValue))}</td><td>${money(numeric(p.cashPnl))}</td></tr>`).join(''):`<tr><td colspan="6">${empty}</td></tr>`}</tbody></table></div>`;
      positions.innerHTML=table(grouped.active,'当前有效持仓',pos?.complete&&!grouped.unknown.length?'当前账户无有效持仓':'持仓尚待完整核对')
        +(grouped.pending.length?table(grouped.pending,'待到账持仓',''):'')
        +(grouped.unknown.length?`<p class="position-warning">${grouped.unknown.length} 项持仓状态待核对，当前持仓数量未包含这些项目。</p>${table(grouped.unknown,'待核对持仓','')}`:'')
        +(grouped.settled.length?`<details class="position-history"><summary>已结算零价值残留 ${grouped.settled.length} 项</summary>${table(grouped.settled,'已结算历史残留','')}</details>`:'');
    }
    if(orders?.complete){text('#homeOrders',number(orders.items.length));text('#homeOrders + small','当前真实未完成委托 · 不是今日/月累计');}
    else {text('#homeOrders','--');text('#homeOrders + small','真实未完成委托尚未完整获取');}
    const timing=data?.checked_at?new Date(data.checked_at).toLocaleString('zh-CN',{hour12:false}):'--';
    text('.side-note',`${sourceLabel}\n账户数据：${error||data?.error_code|| (data?.stale?'已过期':timing)}\nBTC 五分钟反转`);
    renderOrders();renderFinancial();
  }
  function renderFinancial() {
    const closedPositions=section('closed_positions'),activity=section('activity'),period=document.querySelector<HTMLSelectElement>('#reward-period')?.selectedIndex||0;
    const fees=section('fees') as FinanceSection|null,rewardsData=section('rewards') as FinanceSection|null,reconciliation=section('reconciliation') as FinanceSection|null,trades=section('trades');
    const signature=[closedPositions,activity,fees,rewardsData,reconciliation,trades,period];
    if(!changed(lastFinancial,signature)&&Date.now()<financialBoundary)return;
    lastFinancial=signature;
    const now=new Date();let since=0;
    if(period===0)since=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())/1000;
    if(period===1)since=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)/1000;
    if(period===2)since=Date.now()/1000-30*86400;
    financialBoundary=period===0?Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1):period===1?Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1):Infinity;
    if(period===2){
      const times=[...(closedPositions?.items||[]),...(activity?.items||[]),...(rewardsData?.items||[]),...(trades?.items||[]).map(t=>({timestamp:t.match_time}))].map(p=>numeric(p.timestamp)).filter((t):t is number=>t!==null&&t>=since);
      if(times.length)financialBoundary=times.reduce((a,b)=>Math.min(a,b),Infinity)*1000+30*86400000+1;
    }
    const items=(closedPositions?.items||[]).filter(p=>{const t=numeric(p.timestamp);return t!==null&&t>=since;});
    const values=items.map(p=>numeric(p.realizedPnl));
    const valid=closedPositions?.complete&&closedPositions.items.every(p=>numeric(p.timestamp)!==null)&&values.every(v=>v!==null);
    const pnl=valid?values.reduce<number>((sum,v)=>sum+(v||0),0):null;
    // Fee receipts have no date. Use a unique source timestamp; ambiguous or
    // undated transactions belong only to the all-fetched-history scope.
    const txTimes=new Map<string,Set<number>>();
    for(const r of [...(trades?.items||[]).map(t=>({hash:t.transaction_hash,time:t.match_time})),...(activity?.items||[]).map(a=>({hash:a.transactionHash,time:a.timestamp}))]){
      const t=numeric(r.time),hash=String(r.hash||'').toLowerCase();
      if(hash&&t!==null){const times=txTimes.get(hash)||new Set<number>();times.add(t);txTimes.set(hash,times);}
    }
    const inPeriod=(t:number|null)=>t!==null&&t>=since&&t<=Date.now()/1000;
    const feeItems=(fees?.items||[]).filter(f=>{const times=txTimes.get(String(f.transaction_hash).toLowerCase());return period===3||times?.size===1&&inPeriod([...times][0]);});
    const feeTotal=feeItems.length&&feeItems.every(f=>finite(f.amount))?feeItems.reduce((sum,f)=>sum+Number(f.amount),0):null;
    const payments=(rewardsData?.items||[]).filter(p=>p.verified===true&&finite(p.received_amount)&&(period===3||inPeriod(numeric(p.timestamp))));
    const byToken=new Map<string,number>();
    for(const p of payments){const token=String(p.token);byToken.set(token,(byToken.get(token)||0)+Number(p.received_amount));}
    const rewardTotal=byToken.size===1?[...byToken.values()][0]:null;
    for(const root of ['#income-summary','#reward-ledger-section .stats']){
      text(`${root} .stat:nth-child(1) label`,'已关闭持仓报告盈亏');
      text(`${root} .stat:nth-child(1) strong`,money(pnl));
      text(`${root} .stat:nth-child(1) small`,'Data API 已关闭持仓 reported realizedPnl · 非钱包净收益');
      text(`${root} .stat:nth-child(2) label`,'已核对手续费');
      text(`${root} .stat:nth-child(2) strong`,money(feeTotal));
      text(`${root} .stat:nth-child(2) small`,'所选期间已知费用小计 · 历史不完整；日期不明仅列全部历史');
      text(`${root} .stat:nth-child(3) label`,'已核对奖励到账');
      text(`${root} .stat:nth-child(3) strong`,number(rewardTotal,6));
      text(`${root} .stat:nth-child(3) small`,payments.length?byToken.size>1?'多个币种，请按到账明细分别核对':`资产 ${[...byToken.keys()][0]} · 所选期间已核对小计，非美元换算`:'所选期间未取得可核对到账凭证');
      text(`${root} .stat:nth-child(4) label`,'钱包净收益对账');
      text(`${root} .stat:nth-child(4) strong`,'未完成');
      text(`${root} .stat:nth-child(4) small`,reconciliation?`回执已核对 ${reconciliation.receipts_checked??'--'} / 待核对 ${reconciliation.receipts_pending??'--'} · 缺少完整历史与基线`:'缺少完整历史与基线，不推断净收益');
    }
    text('#reward-period-note',`${['今日 UTC','本月 UTC','近 30 天','全部已获取历史'][period]} · ${closedPositions?.complete?'已关闭持仓查询完整':'已关闭持仓未完整'}；手续费和奖励仅列已核对小计，钱包净收益未完成`);
    const body=document.querySelector('#reward-payments tbody');
    const rewards=(activity?.items||[]).filter(a=>{const t=numeric(a.timestamp);return ['REWARD','MAKER_REBATE','TAKER_REBATE'].includes(String(a.type))&&t!==null&&t>=since;});
    if(body)body.innerHTML=rewards.length?rewards.map(a=>`<tr><td>${esc(a.type)}</td><td>${date(numeric(a.timestamp))}</td><td>接口记账单位 USDC</td><td>${money(numeric(a.usdcSize))}</td><td>官方活动记录 · 链上归属待核对</td><td>${/^0x[0-9a-fA-F]{64}$/.test(String(a.transactionHash))?`<a target="_blank" rel="noopener noreferrer" href="https://polygonscan.com/tx/${esc(a.transactionHash)}">查看交易</a>`:'无交易凭证'}</td></tr>`).join(''):'<tr><td colspan="6">已接入账户活动查询；未取得可核对的奖励付款记录，不能据此认定没有奖励。</td></tr>';
    // Replace matching claims with one receipt per transaction, preventing a
    // multi-claim payment from being presented as several cash receipts.
    if(body&&payments.length){
      body.querySelectorAll('tr').forEach(tr=>{const href=tr.querySelector('a')?.getAttribute('href')||'';if(payments.some(p=>href.toLowerCase().endsWith('/'+String(p.transaction_hash).toLowerCase()))||tr.querySelector('[colspan]'))tr.remove();});
      body.insertAdjacentHTML('afterbegin',payments.map(p=>`<tr><td>${esc(Array.isArray(p.types)?p.types.join(' / '):'奖励')}</td><td>${date(numeric(p.timestamp))}</td><td>${esc(p.token)}</td><td>${number(numeric(p.received_amount),6)}</td><td>链上到账与活动匹配 · 非完整历史</td><td><a target="_blank" rel="noopener noreferrer" href="https://polygonscan.com/tx/${esc(p.transaction_hash)}">查看交易</a></td></tr>`).join(''));
    }
    text('#reward-center .reward-banner','账户费用回执与奖励到账核对已接入；仅展示已获取范围，资格、完整账单及钱包净收益仍待核对。');
    text('#reward-payments .reward-status',activity||payments.length?`已核对到账 ${payments.length} 笔 · ${['今日 UTC','本月 UTC','近 30 天','全部已获取历史'][period]} · ${activity?.complete?'活动查询完整':'部分记录'}${activity?.items.some(a=>['REWARD','MAKER_REBATE','TAKER_REBATE'].includes(String(a.type))&&numeric(a.timestamp)===null)?' · 存在日期不明记录，未计入所选期间':''}`:'账户活动等待同步');
    // Neither fee rate nor an activity label proves the wallet's final net profit.
  }
  on(selector,'change',()=>{source=selector.value;page=0;renderOrders();});
  orderButtons.forEach((b,i)=>on(b,'click',()=>{filter=i;page=0;renderOrders();}));
  on(document.getElementById('account-previous')!,'click',()=>{page=Math.max(0,page-1);renderOrders();});
  on(document.getElementById('orders-page-size')!,'change',event=>{pageSize=Number((event.target as HTMLSelectElement).value);page=0;renderOrders();});
  on(document.getElementById('orders-round')!,'change',event=>{roundScope=(event.target as HTMLSelectElement).value;page=0;renderOrders();});
  on(document.getElementById('account-next')!,'click',()=>{page++;renderOrders();});
  on(document.getElementById('reward-period')!,'change',renderFinancial);
  on(exportButton,'click',()=>{
    if(source!=='account')return;
    const content=[['账户','数据范围','时间','市场','订单ID','方向','委托价','成交均价','成交份数','名义金额','费用','状态'],...rows().map(r=>[wallet,'当前筛选已获取记录',date(r.time),r.market,r.id,r.side,r.price,r.averagePrice,r.shares,r.amount,'未知',r.status])].map(r=>r.map(csvCell).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\uFEFF'+content],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='account-records.csv';a.click();URL.revokeObjectURL(url);
  });
  async function refresh(){
    if(loading||closed)return;loading=true;const epoch=generation;
    try{const value=await get<AccountData>('account-data','/api/v1/account-data');if(!closed&&epoch===generation){data=value;error=null;}}
    catch(e){if(epoch===generation){error=e instanceof SyntaxError?'账户数据格式错误，保留上次账户快照':e instanceof Error?e.message:'账户数据读取失败';}}
    finally{loading=false;render();}
  }
  return { refresh, render, receiveMarket(market:string|null){const next=market||'';if(next!==currentMarket){currentMarket=next;if(roundScope==='current')page=0;}renderOrders();}, receiveAccount(a:Account|null){sourceLabel=a?.control_source?.label||'来源未标注';const next=a?.wallet||'';if(next.toLowerCase()!==wallet.toLowerCase()){wallet=next;data=null;generation++;page=0;}render();}, close(){closed=true;bindings.forEach(f=>f());} };
}
