import { get } from '../api/client';
import type { Obj } from '../api/types';
import { weightedAverageFillPrice } from '../order-pricing';
import { date,esc,money,number,price } from '../ui';
interface OrderPage {schemaVersion:1;orders:Obj[];total:number;limit:number;offset:number;has_more:boolean;asOf:number;snapshotEventId:number}
const labels:Record<string,string>={SUBMITTING:'提交中',OPEN:'挂单中',PARTIAL:'部分成交',FILLED:'已成交',CANCELLED:'已撤单',CANCELED:'已撤单',REJECTED:'已拒绝',UNKNOWN:'等待确认'};
const cancellationLabels:Record<string,string>={local_http:'本地请求撤单并收到确认',user_ws:'交易所主动终止（User WS）',account_read:'交易所终止（账户读取）'};
const statusLabel=(order:Obj)=>order.status==='CANCELLED'||order.status==='CANCELED'
  ? cancellationLabels[String(order.cancellation_source||'')]||labels[String(order.status)]||String(order.status)
  : labels[String(order.status)]||String(order.status);
export function connectStrategyOrders() {
  const toolbar=document.createElement('div');toolbar.className='subnav';toolbar.dataset.strategyOrders='';
  toolbar.innerHTML='<label>场次 <select data-strategy-order-round><option value="current">当前场次</option><option value="all">本次全部场次</option></select></label><label>每页 <select data-strategy-order-size><option value="10">10 条</option><option value="20">20 条</option><option value="50">50 条</option></select></label><button data-strategy-order-prev>上一页</button><button data-strategy-order-next>下一页</button><span data-strategy-order-page role="status"></span>';
  document.querySelector('#trade-orders .note')!.before(toolbar);
  const source=document.querySelector<HTMLSelectElement>('#orders-source')!,root=document.querySelector<HTMLElement>('#trade-orders')!;
  const filters=Array.from(root.querySelectorAll<HTMLButtonElement>(':scope > .subnav:first-of-type button'));
  let run:string|null=null,market:string|null=null,scope='current',size=10,offset=0,filter=0,snapshot:number|undefined,eventCutoff:number|undefined,data:OrderPage|null=null,error='',loading=false,closed=false,epoch=0,lastRenderSignature='';
  const bindings:Array<()=>void>=[];
  const on=(el:Element,event:string,fn:EventListener)=>{el.addEventListener(event,fn);bindings.push(()=>el.removeEventListener(event,fn));};
  const active=()=>source.value==='strategy';
  function render() {
    toolbar.hidden=!active();if(!active()){if(root.dataset.orderOwner==='strategy')delete root.dataset.orderOwner;return;}
    if(root.dataset.orderOwner && root.dataset.orderOwner!=='strategy')return;
    root.dataset.orderOwner='strategy';
    root.setAttribute('data-source','strategy');
    filters.forEach((button,i)=>{button.disabled=loading;button.classList.toggle('active',filter===i);});
    const rows=data?.orders||[];
    const renderSignature=JSON.stringify({error,loading,run,scope,size,offset,filter,rows});
    if(renderSignature!==lastRenderSignature){
      lastRenderSignature=renderSignature;
      root.querySelector('tbody')!.innerHTML=rows.length?rows.map(order=>{const fills=Array.isArray(order.fills)?order.fills:[];return `<tr><td>${date(order.time)}</td><td>${esc(order.market)}<details><summary>订单详情</summary><small>${esc(order.order_id||'等待平台订单号')}</small><div>HTTP ACK ${number(order.ack_latency_ms,1)} ms · 签名 ${number(order.sign_latency_ms,1)} ms</div>${typeof order.response_headers_latency_ms==='number'||typeof order.response_body_latency_ms==='number'?`<div>HTTP 响应头 ${number(order.response_headers_latency_ms,1)} ms · 响应体 ${number(order.response_body_latency_ms,1)} ms</div>`:''}${typeof order.risk_metadata_latency_ms==='number'?`<div>风险元数据 ${number(order.risk_metadata_latency_ms,1)} ms</div>`:''}${order.failure_phase?`<div>失败阶段 ${esc(String(order.failure_phase))}</div>`:''}${typeof order.venue_status_latency_ms==='number'?`<div>交易所状态总耗时 ${number(order.venue_status_latency_ms,1)} ms · ${esc(String(order.venue_status_source||'未知来源'))}</div>`:''}${typeof order.venue_status_after_ack_latency_ms==='number'?`<div>HTTP ACK 后终态回报 ${number(order.venue_status_after_ack_latency_ms,1)} ms</div>`:''}${typeof order.cancel_ack_latency_ms==='number'?`<div>撤单确认 ${number(order.cancel_ack_latency_ms,1)} ms</div>`:''}${order.cancellation_source?`<div>撤单来源 ${esc(cancellationLabels[String(order.cancellation_source)]||String(order.cancellation_source))}</div>`:''}${fills.map((fill:Obj)=>`<div>成交 ${number(fill.shares,4)} 份 · ${price(fill.price)} · 费用 ${money(fill.fee)}${fill.fee_source!=="reported"?"（待核实）":""}</div>`).join('')}</details></td><td>${esc(order.side)} ${esc(order.direction)}</td><td>${price(order.price)}</td><td>${price(weightedAverageFillPrice(fills))}</td><td>${number(order.filled_shares,4)} / ${number(order.shares,4)}</td><td>${money(order.amount)}</td><td>${money(order.fee)}</td><td>${esc(statusLabel(order))}</td></tr>`}).join(''):`<tr><td colspan="9" class="empty">${esc(error||(!run?'策略尚未启动':scope==='current'&&!market?'等待当前场次':loading?'正在读取订单':'当前筛选没有订单'))}</td></tr>`;
    }
    toolbar.querySelector('[data-strategy-order-page]')!.textContent=error||`第 ${Math.floor(offset/size)+1} 页${data?` · 共 ${data.total} 条`:''}${offset>0?' · 历史快照，返回第 1 页更新':''}`;
    (toolbar.querySelector('[data-strategy-order-prev]') as HTMLButtonElement).disabled=loading||offset===0;
    (toolbar.querySelector('[data-strategy-order-next]') as HTMLButtonElement).disabled=loading||!data?.has_more;
    root.querySelector('.note')!.textContent='委托价是限价；成交均价按已确认成交明细加权计算，未成交或待确认显示 --；历史页保持同一时间快照。';
  }
  async function refresh() {
    if(closed||loading||!active())return;
    if(!run||scope==='current'&&!market){if(!data)render();return;}
    loading=true;const generation=epoch;render();
    const query=new URLSearchParams({run_id:run,limit:String(size),offset:String(offset)});
    if(scope==='current'&&market)query.set('market',market);
    if(filter)query.set('status',['','active','FILLED','CANCELLED','failed'][filter]);
    if(offset>0&&snapshot!==undefined)query.set('as_of',String(snapshot));
    if(offset>0&&eventCutoff!==undefined)query.set('snapshot_event_id',String(eventCutoff));
    try{const page=await get<OrderPage>('orders',`/api/v1/orders?${query}`);if(closed||generation!==epoch)return;data=page;snapshot=page.asOf;eventCutoff=page.snapshotEventId;error='';}
    catch(e){if(closed||generation!==epoch)return;error=e instanceof Error?e.message:'订单读取失败';}
    finally{loading=false;if(!closed){render();if(generation!==epoch)void refresh();}}
  }
  function reset(){epoch++;data=null;error='';offset=0;snapshot=undefined;eventCutoff=undefined;render();void refresh();}
  on(source,'change',()=>{render();if(active())void refresh();});
  on(toolbar.querySelector('[data-strategy-order-size]')!,'change',event=>{size=Number((event.target as HTMLSelectElement).value);reset();});
  on(toolbar.querySelector('[data-strategy-order-round]')!,'change',event=>{scope=(event.target as HTMLSelectElement).value;reset();});
  on(toolbar.querySelector('[data-strategy-order-prev]')!,'click',()=>{offset=Math.max(0,offset-size);epoch++;void refresh();});
  on(toolbar.querySelector('[data-strategy-order-next]')!,'click',()=>{if(data?.has_more){offset+=size;epoch++;void refresh();}});
  filters.forEach((button,i)=>on(button,'click',()=>{if(active()){filter=i;reset();}}));
  render();
  return {refresh,receive(nextRun:string|null,nextMarket:string|null,authoritative=true,running=true){
    if(!authoritative)return;
    if(nextRun===null){
      // A stopped status can omit the active run after shutdown. Keep the
      // last run visible so its final orders remain inspectable until a new
      // run replaces it.
      if(running && run!==null){run=null;market=null;reset();}
      return;
    }
    const runChanged=run!==nextRun;
    if(!runChanged && scope==='current' && nextMarket===null){
      market=null;
      if(!data)render();
      return;
    }
    const marketChanged=scope==='current' && nextMarket!==null && market!==nextMarket;
    if(runChanged||marketChanged){
      run=nextRun;market=nextMarket;reset();
    }else{
      run=nextRun;
      if(nextMarket!==null)market=nextMarket;
    }
  },close(){closed=true;epoch++;bindings.forEach(remove=>remove());}};
}
