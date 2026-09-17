import { post } from './api/client';
import type { Config, Status } from './api/types';
import type { StrategyConfig } from './pages/strategy';

export function connectTradingControls(refresh:()=>Promise<void>) {
  let strategy:StrategyConfig|null=null,status:Status|null=null,busy=false,closed=false;
  let hasControlMessage=false;
  let pending:{revision:number;request_id:string;action:string;strategy_id:string;mode:string}|null=null;
  const notice=document.createElement('p');notice.className='note';notice.setAttribute('role','status');
  document.querySelector('#view-trade > .head')!.after(notice);
  const starts=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-start]'));
  const stops=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-stop],[data-exit]'));
  const pauses=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pause]'));
  const runtime=()=> (status?.stats?.strategy_runtime || (status?.stats?.runtime as Record<string,unknown>|undefined)?.strategy_runtime) as Record<string,unknown> | undefined;
  function render() {
    starts.forEach(b=>{b.disabled=busy||!status||status.running||!strategy||strategy.savedRevision<1;b.textContent=pending?'核对上次启动':'启动 BTC 反转';b.title=!strategy?'正在读取策略配置':strategy.savedRevision<1?'请先到策略页保存参数':'使用已保存的参数启动真实交易';});
    stops.forEach(b=>{b.disabled=busy||!status?.running;b.textContent='停止并撤余量';b.title='停止新增并撤销剩余挂单，已成交持仓保留';});
    pauses.forEach(b=>{b.disabled=busy||!status?.running;b.textContent=runtime()?.paused?'恢复新增':'暂停新增';b.title=status?.running?'调整是否接收新的交易触发，已有订单保留':'策略尚未运行';});
    if(!busy&&!hasControlMessage) notice.textContent=!strategy?'正在读取策略配置。':strategy.savedRevision<1?'请先到策略页保存参数，再启动交易。':!status?'正在读取服务器运行状态。':status.running?'服务器正在运行；关闭此页面不会停止交易。':!status.live_unlocked?'参数已保存；服务器实盘开关尚未开启。':'参数已保存，策略尚未启动。';
  }
  async function control(action:string) {
    if(busy||!status)return;
    if(action==='start'&&(!strategy||status.running))return;
    if(action!=='start'&&!status.running)return;
    const payload=action==='start'?(pending ||= {revision:strategy!.savedRevision,request_id:crypto.randomUUID(),action,strategy_id:'btc-reversal',mode:'live'}):{action,strategy_id:'btc-reversal',request_id:crypto.randomUUID()};
    busy=true;hasControlMessage=true;render();notice.textContent=action==='start'?'正在启动已保存的 BTC 反转策略…':action==='stop'?'正在停止新增并撤销剩余挂单…':'正在更新运行状态…';
    try{const response=await post('/api/trading/control',payload);if(closed)return;if(action==='start')pending=null;notice.textContent=response.control_pending?'指令已发送，等待策略服务器确认。':'操作已接受，正在核对实际运行状态。';}
    catch(e){const message=e instanceof Error?e.message:'操作结果未确认';if(/HTTP (400|403|409)/.test(message))pending=null;notice.textContent=`${message}。${pending?'再次核对将使用同一请求编号。':'请查看服务器状态和原因。'}`;}
    finally{busy=false;if(!closed){await refresh();render();}}
  }
  const onStart=()=>void control('start'),onStop=()=>void control('stop'),onPause=()=>void control(runtime()?.paused?'resume':'pause');
  starts.forEach(b=>b.addEventListener('click',onStart));stops.forEach(b=>b.addEventListener('click',onStop));pauses.forEach(b=>b.addEventListener('click',onPause));
  notice.textContent='运行配置读取中。';render();
  return {receive(_c:Config|null,s:Status|null){status=s;render();},receiveStrategy(c:StrategyConfig){strategy=c;render();},close(){closed=true;starts.forEach(b=>b.removeEventListener('click',onStart));stops.forEach(b=>b.removeEventListener('click',onStop));pauses.forEach(b=>b.removeEventListener('click',onPause));}};
}
