import type { SystemMetrics } from './api/types';
import { esc } from './ui';

const value=(v:number|null|undefined,digits=1)=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(digits):'--';
const bytes=(v:number|null|undefined)=>{
  if(typeof v!=='number'||!Number.isFinite(v)||v<0)return '--';
  const units=['B','KB','MB','GB','TB'];let n=v,i=0;
  while(n>=1024&&i<units.length-1){n/=1024;i++;}
  return `${n.toFixed(i<2?0:1)} ${units[i]}`;
};
const serviceNames:Record<string,string>={dashboard:'控制台',collector:'行情采集',trader:'交易进程',projection:'账本投影'};
const stateNames:Record<string,string>={active:'运行中',stopped:'未运行',inactive:'未运行',failed:'失败',activating:'启动中',deactivating:'停止中',unavailable:'不可用',unknown:'未知'};

export function renderSystemMetrics(data:SystemMetrics|null,error:string|null){
  const root=document.querySelector<HTMLElement>('[data-system-metrics]');if(!root)return;
  if(data?.asOf!==null&&data&&Date.now()/1000-data.asOf>5){data=null;error='服务器状态已过期';}
  const set=(name:string,text:string)=>{const node=root.querySelector(`[data-system-${name}]`);if(node)node.textContent=text;};
  set('cpu',data?`${value(data.cpu.percent)}% · ${data.cpu.cores??'--'} 核`:'--');
  set('memory',data?`${value(data.memory.percent)}% · ${bytes(data.memory.used_bytes)} / ${bytes(data.memory.total_bytes)}`:'--');
  set('disk',data?`${value(data.disk.percent)}% · 可用 ${bytes(data.disk.free_bytes)}`:'--');
  set('load',data?`${value(data.load.one,2)} / ${value(data.load.five,2)} / ${value(data.load.fifteen,2)}`:'--');
  const services=root.querySelector('[data-system-services]');
  if(services)services.innerHTML=data?Object.entries(data.services).map(([name,p])=>`<div class="system-service"><span>${esc(serviceNames[name]||name)}</span><strong class="${p.state==='active'?'good':p.state==='stopped'?'':'warn'}">${esc(stateNames[p.state]||p.state)}</strong><small>PID ${p.pid??'--'} · 内存 ${bytes(p.rss_bytes)} · 运行 ${typeof p.uptime_seconds==='number'?`${Math.floor(p.uptime_seconds)} 秒`:'--'}</small></div>`).join(''):'<span class="muted">进程状态未获取</span>';
  set('state',error||(!data?'服务器状态读取中':data.asOf===null?'等待首个系统采样':`更新 ${new Date(data.asOf*1000).toLocaleTimeString('zh-CN',{hour12:false})} · 投影队列 ${data.journal_backlog??'--'}`));
}
