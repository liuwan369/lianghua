import type { Status, Obj } from '../api/types';
import { esc, finite, money, number, price, platformRuntime } from '../ui';
const level=(v:unknown):Obj|null=>Array.isArray(v)&&v.length>=2?{price:v[0],size:v[1]}:obj(v);
const obj=(v:unknown):Obj|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Obj:null;
const set=(selector:string,value:unknown)=>{const node=document.querySelector(selector);if(node)node.textContent=String(value??'--');};
const numeric=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
const seconds=(v:unknown):number|null=>{const n=numeric(v);return n===null?null:n>1e12?n/1000:n;};
const reasons:Record<string,string>={waiting_next_round:'等待下一场开始',waiting_for_crossing:'等待价格跨过触发线',waiting_for_reversal:'等待相反方向触发',max_stages_reached:'本场阶段已完成',paused:'已暂停新增',market_closed:'本场已截止',stale_book:'盘口已过期，等待恢复',quote_stale:'盘口已过期，等待恢复',round_budget_exceeded:'本场可用预算不足',total_budget_exceeded:'策略可用预算不足',insufficient_cash:'账户可用资金不足',initial_band_entry:'首份盘口进入触发区间',crossing:'价格跨过触发线'};
export const reasonLabel=(v:unknown)=>typeof v==='string'?reasons[v]||v:'等待策略状态';
const statusLabel=(v:unknown)=>({submitted:'已提交',open:'挂单中',filled:'已成交',partial:'部分成交',cancelled:'已撤单',canceled:'已撤单',unknown:'等待确认',rejected:'已拒绝',failed:'失败',running:'运行中',active:'运行中',waiting:'等待触发',pending:'等待确认',closed:'本场结束',expired:'本场结束',paused:'已暂停',stopped:'已停止'}[String(v).toLowerCase()]||String(v||'--'));

export interface ReversalQuote { tokenId:string; bid:number|null; ask:number|null; ageMs:number|null }
export interface ReversalView { marketId:string|null; marketName:string|null; upTokenId:string|null; downTokenId:string|null; quotes:ReversalQuote[]; quoteAgeMs:number|null; quoteStale:boolean }

export function renderReversal(status:Status|null,now=Date.now()/1000) {
  const platform=obj(status?.stats.runtime), raw=obj(status?.stats.strategy_runtime)||obj(platform?.strategy_runtime)||obj(status?.projection?.strategy_runtime);
  const round=obj(raw?.currentRound), startsAt=seconds(round?.startsAt), endsAt=seconds(round?.endsAt);
  const fresh=platformRuntime(status,now).current;
  const live=fresh?raw:null, current=fresh?round:null;
  const time=(v:number)=>new Date(v*1000).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'});
  set('[data-reversal-round]',current&&startsAt!==null&&endsAt!==null?`BTC ${time(startsAt)}–${time(endsAt)}`:'--');
  set('[data-reversal-countdown]',current&&endsAt!==null?endsAt>now?`剩余 ${Math.floor((endsAt-now)/60)}:${String(Math.floor((endsAt-now)%60)).padStart(2,'0')}`:'本场已截止':'等待当前场次');
  const stages=Array.isArray(current?.stages)?current.stages.map(obj).filter((v):v is Obj=>!!v):[];
  set('[data-reversal-stage]',current?`${stages.length} / ${obj(current.config)?.maxStages??'--'}`:'--');
  set('[data-reversal-confirmations]',`确认反转 ${live?number(current?.confirmationCount,0):'--'} 次`);
  set('[data-reversal-next]',live?`${current?.nextDirection||'等待方向'} · ${number(current?.nextShares,2)} 份`:'--');
  set('[data-reversal-revision]',`参数版本 ${current?.configRevision??'--'}`);
  set('[data-reversal-status]',!status?'状态未知':!status.running?'已停止':!fresh?'等待最新状态':live?.paused?'已暂停新增':statusLabel(current?.status||live?.status));
  set('[data-reversal-age]',platform&&finite(platform.source_at)?`更新于 ${new Date(Number(platform.source_at)*1000).toLocaleTimeString('zh-CN',{hour12:false})}${fresh?'':' · 非当前状态'}`:'等待服务器状态');
  set('[data-reversal-reason]',live?reasonLabel(current?.reason||live.reason):status?.running?'等待当前策略状态':'策略未运行');
  const positions=obj(current?.positions), ledger=fresh&&Array.isArray(platform?.positions)?platform.positions.map(obj).filter((v):v is Obj=>!!v):null;
  const up=ledger?.find(p=>p.tokenId===current?.upTokenId),down=ledger?.find(p=>p.tokenId===current?.downTokenId);
  set('[data-reversal-up]',number(positions?.UP??(current&&ledger?up?.shares??0:null),4));set('[data-reversal-down]',number(positions?.DOWN??(current&&ledger?down?.shares??0:null),4));
  const knownCost=current&&ledger&&(!up||numeric(up.costUsd)!==null)&&(!down||numeric(down.costUsd)!==null)?(numeric(up?.costUsd)??0)+(numeric(down?.costUsd)??0):null;
  set('[data-reversal-capital]',`${money(current?.costUsd??knownCost)} / ${money(current?.reservedUsd)}`);
  set('[data-reversal-outcomes]',`${money(current?.netIfUpUsd)} / ${money(current?.netIfDownUsd)}`);
  set('[data-reversal-result-reason]',current?.resultReason||'预计结果使用已成交份额与实际成本；最终以官方结果和到账为准。');
  const timeline=document.querySelector('[data-reversal-timeline]');
  const timelineSignature=JSON.stringify(stages.map(stage=>[stage.stage,stage.direction,stage.shares,stage.price,stage.status,stage.filledShares,stage.trigger]));
  const timelineNode=timeline as HTMLElement|null;
  if(timelineNode && timelineNode.dataset.signature!==timelineSignature){
    timelineNode.dataset.signature=timelineSignature;
    timelineNode.innerHTML=stages.length?stages.map(stage=>`<article class="stage-step"><strong>第 ${esc(stage.stage)} 阶段 · ${esc(stage.direction)}</strong><span>${number(stage.shares,2)} 份 · 限价 ${price(stage.price)}</span><span>${esc(statusLabel(stage.status))} · 已成交 ${number(stage.filledShares,4)}</span><small>${esc(reasonLabel(stage.trigger))}</small></article>`).join(''):'等待本场首次触发';
  }
  const books=Array.isArray(platform?.books)?platform.books.map(obj).filter((v):v is Obj=>!!v):[];
  const count=Number(document.querySelector<HTMLSelectElement>('[data-depth-count]')?.value||5);
  const relevant=books.filter(book=>current&&book.stale===false&&book.market_expired!==true&&(book.marketId===current.marketId||[current.upTokenId,current.downTokenId].includes(book.tokenId)));
  const pair=[current?.upTokenId,current?.downTokenId].map(token=>relevant.find(book=>book.tokenId===token));
  const ages=pair.map(book=>{const at=seconds(book?.exchangeTs)??seconds(book?.ts);return at!==null?(now-at)*1000:null;});
  const quoteAgeMs=ages.every(age=>age!==null)?Math.max(...ages as number[]):null;
  const depth=document.querySelector('[data-reversal-depth]');
  const depthSignature=JSON.stringify({count,books:relevant.map(book=>[book.tokenId,book.bid,book.ask,book.bids,book.asks])});
  const depthNode=depth as HTMLElement|null;
  if(depthNode && depthNode.dataset.signature!==depthSignature){
    depthNode.dataset.signature=depthSignature;
    depthNode.innerHTML=relevant.length?relevant.map(book=>{const label=book.tokenId===current?.upTokenId?'UP':book.tokenId===current?.downTokenId?'DOWN':book.outcome||'盘口';return `<div class="table-wrap"><h3>${esc(label)}</h3><table class="table"><thead><tr><th>买价</th><th>份数</th><th>卖价</th><th>份数</th></tr></thead><tbody>${Array.from({length:Math.min(count,Math.max(Array.isArray(book.bids)?book.bids.length:0,Array.isArray(book.asks)?book.asks.length:0))},(_,i)=>{const bid=level((book.bids as unknown[])?.[i]),ask=level((book.asks as unknown[])?.[i]);return `<tr><td>${price(bid?.price)}</td><td>${number(bid?.size??bid?.shares,2)}</td><td>${price(ask?.price)}</td><td>${number(ask?.size??ask?.shares,2)}</td></tr>`;}).join('')}</tbody></table></div>`;}).join(''):'<p>等待当前场次真实深度</p>';
  }
  const quotes=pair.filter((book):book is Obj=>!!book).map(book=>({tokenId:String(book.tokenId),bid:numeric(book.bid),ask:numeric(book.ask),ageMs:(seconds(book.exchangeTs)??seconds(book.ts))===null?null:(now-(seconds(book.exchangeTs)??seconds(book.ts))!)*1000}));
  return typeof current?.marketId==='string'?{marketId:current.marketId,marketName:typeof current.name==='string'?current.name:null,
    upTokenId:typeof current.upTokenId==='string'?current.upTokenId:null,downTokenId:typeof current.downTokenId==='string'?current.downTokenId:null,
    quotes,quoteAgeMs,quoteStale:!fresh}:null;
}
