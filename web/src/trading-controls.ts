import { post } from './api/client';
import type { Config, Status } from './api/types';
import { executionName } from './ui';

export function connectTradingControls(refresh:()=>Promise<void>) {
  let config:Config|null=null,status:Status|null=null,busy=false,closed=false;
  let pending:{revision:number;request_id:string}|null=null;
  const notice=document.createElement('p');notice.className='note';notice.setAttribute('role','status');
  document.querySelector('#view-trade > .head')!.after(notice);
  const starts=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-start]'));
  const stops=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-stop],[data-exit]'));
  const platformTarget = () => config?.capabilities.executionTarget === 'platform' || status?.execution_target === 'platform';
  const targetName = () => platformTarget() ? '平台观察' : '旧引擎纸面';
  const runningName = () => status ? executionName(status) : targetName();
  function render() {
    starts.forEach(b=>{b.disabled=busy||!status||status.running||!config||config.revision<1||config.params.mode!=='paper';b.textContent=pending?'核对上次启动':`启动${targetName()}`;b.title=platformTarget()?'使用已保存的模式和运行时长；未加载策略，不下单':'使用旧引擎已保存配置；不创建真实订单';});
    stops.forEach(b=>{b.disabled=busy||!status||!status.running||status.mode!=='paper';b.textContent=`停止${status?.running ? runningName() : targetName()}`;b.title='停止当前进程，等待退出确认，不关闭服务器';});
  }
  async function start() {
    if(busy||!config||!status||status.running||config.params.mode!=='paper')return;
    if(!pending)pending={revision:config.revision,request_id:crypto.randomUUID()};
    busy=true;render();notice.textContent=`正在启动已保存版本 ${pending.revision} 的${targetName()}…`;
    try{await post('/api/v1/trading/start',pending);if(closed)return;pending=null;notice.textContent=`服务器已接收${targetName()}启动；等待当前运行快照。`;}
    catch(e){const message=e instanceof Error?e.message:'启动未确认';if(/HTTP (400|403|409)/.test(message))pending=null;notice.textContent=`${message}。${pending?'再次核对会复用同一请求编号，避免重复启动。':'请核对并重新保存配置后再试。'}`;}
    finally{busy=false;if(!closed){await refresh();render();}}
  }
  async function stop() {
    if(busy||!status?.running||status.mode!=='paper')return;
    busy=true;render();notice.textContent=`正在停止${runningName()}，等待退出确认…`;
    try{const response=await post('/api/v1/trading/stop',{},15000);if(closed)return;const s=response.status as Record<string,unknown>;notice.textContent=s?.running?'停止尚未确认，继续查询进程状态。':'运行已停止；最后快照保留为历史记录。';}
    catch(e){notice.textContent=e instanceof Error?e.message:'停止结果未确认，请核对运行状态';}
    finally{busy=false;if(!closed){await refresh();render();}}
  }
  const onStart=()=>void start(),onStop=()=>void stop();starts.forEach(b=>b.addEventListener('click',onStart));stops.forEach(b=>b.addEventListener('click',onStop));
  notice.textContent='运行配置读取中。';render();
  return {receive(c:Config|null,s:Status|null){const changed=config?.capabilities.executionTarget!==c?.capabilities.executionTarget;config=c;status=s;if(changed&&!busy&&!pending)notice.textContent=platformTarget()?'平台观察 · 未加载策略 · 不下单。现金与风险使用平台模拟配置，真实账户单独显示。':'旧引擎纸面运行；以实际运行记录为准。';render();},close(){closed=true;starts.forEach(b=>b.removeEventListener('click',onStart));stops.forEach(b=>b.removeEventListener('click',onStop));}};
}
