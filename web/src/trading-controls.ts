import { post } from './api/client';
import type { Config, Status } from './api/types';

export function connectTradingControls(refresh:()=>Promise<void>) {
  let config:Config|null=null,status:Status|null=null,busy=false,closed=false;
  let pending:{revision:number;request_id:string}|null=null;
  const notice=document.createElement('p');notice.className='note';notice.setAttribute('role','status');
  document.querySelector('#view-trade > .head')!.after(notice);
  const starts=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-start]'));
  const stops=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-stop],[data-exit]'));
  function render() {
    starts.forEach(b=>{b.disabled=busy||!status||status.running||!config||config.revision<1||config.params.mode!=='paper';b.textContent=pending?'核对上次模拟启动':'启动纸面模拟';b.title='使用已保存的配置版本；未保存草稿不会生效，不创建真实订单';});
    stops.forEach(b=>{b.disabled=busy||!status||!status.running||status.mode!=='paper';b.textContent='停止纸面模拟';b.title='停止当前模拟进程，等待退出确认，不关闭服务器';});
  }
  async function start() {
    if(busy||!config||!status||status.running||config.params.mode!=='paper')return;
    if(!pending)pending={revision:config.revision,request_id:crypto.randomUUID()};
    busy=true;render();notice.textContent=`正在启动已保存版本 ${pending.revision} 的纸面模拟…`;
    try{await post('/api/v1/trading/start',pending);if(closed)return;pending=null;notice.textContent='服务器已接收模拟启动；以运行状态和实际事件为准。';}
    catch(e){const message=e instanceof Error?e.message:'启动未确认';if(/HTTP (400|403|409)/.test(message))pending=null;notice.textContent=`${message}。${pending?'再次核对会复用同一请求编号，避免重复启动。':'请核对并重新保存配置后再试。'}`;}
    finally{busy=false;if(!closed){await refresh();render();}}
  }
  async function stop() {
    if(busy||!status?.running||status.mode!=='paper')return;
    busy=true;render();notice.textContent='正在请求停止模拟，并等待退出核对…';
    try{const response=await post('/api/v1/trading/stop',{},15000);if(closed)return;const s=response.status as Record<string,unknown>;notice.textContent=s?.running?'停止尚未确认，继续查询进程状态。':'模拟已停止；未结算持仓不会被自动记成已结算。';}
    catch(e){notice.textContent=e instanceof Error?e.message:'停止结果未确认，请核对运行状态';}
    finally{busy=false;if(!closed){await refresh();render();}}
  }
  const onStart=()=>void start(),onStop=()=>void stop();starts.forEach(b=>b.addEventListener('click',onStart));stops.forEach(b=>b.addEventListener('click',onStop));
  notice.textContent='支持已保存版本的纸面模拟启停；实盘下单仍锁定。未保存的参数不影响本次启动。';render();
  return {receive(c:Config|null,s:Status|null){config=c;status=s;render();},close(){closed=true;starts.forEach(b=>b.removeEventListener('click',onStart));stops.forEach(b=>b.removeEventListener('click',onStop));}};
}
