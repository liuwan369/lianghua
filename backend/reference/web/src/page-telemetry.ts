type Metric={latest_ms:number;p50_ms:number;p95_ms:number;p99_ms?:number;max_ms?:number;samples:number;limit_reached?:boolean};
const valid=(v:unknown):v is Metric=>{
  if(typeof v!=='object'||v===null)return false;
  const m=v as Record<string,unknown>;
  return ['latest_ms','p50_ms','p95_ms','samples'].every(k=>typeof m[k]==='number'&&Number.isFinite(m[k] as number)&&(m[k] as number)>=0)&&(m.samples as number)>0;
};
const format=(v:number)=>v.toFixed(1);

export function pageTelemetry() {
  const samples:Array<{at:number;ms:number}>=[];
  let serverSummary:any=null,serverRun:string|null=null,expectedRun:string|null|undefined,receivedAt=0;
  function render(){
    const now=Date.now();while(samples.length&&samples[0].at<now-300000)samples.shift();
    displayServer();
    const cells=document.querySelectorAll('[data-latency-page] td');if(cells.length<9)return;
    const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b);
    const percentile=(p:number)=>sorted.length?sorted[Math.ceil(sorted.length*p)-1].toFixed(1):'--';
    cells[2].textContent=samples.length?samples[samples.length-1].ms.toFixed(1):'--';cells[3].textContent=percentile(.5);cells[4].textContent=percentile(.95);cells[5].textContent=percentile(.99);cells[6].textContent=samples.length?sorted[sorted.length-1].toFixed(1):'--';cells[7].textContent=String(samples.length);cells[8].textContent=samples.length?'浏览器本页实测 · 最近5分钟':'暂无成功刷新样本';
  }
  function displayServer(){
    const latency=serverSummary?.latency,runId=serverRun;
    const current=!!runId&&latency?.run_id===runId&&(expectedRun===undefined||expectedRun===runId)&&Date.now()-receivedAt<15000;
    const data:Record<string,unknown>=current&&latency?.metrics&&typeof latency.metrics==='object'?latency.metrics:{};
    document.querySelectorAll<HTMLElement>('[data-latency-metric]').forEach(row=>{
      const metric=row.dataset.latencyMetric||'',v=data[metric],cells=row.querySelectorAll('td');if(cells.length<9)return;
      if(!valid(v)){for(let i=2;i<=6;i++)cells[i].textContent='--';cells[7].textContent='0';cells[8].textContent='暂无有效样本';return;}
      cells[2].textContent=format(v.latest_ms);cells[3].textContent=format(v.p50_ms);cells[4].textContent=format(v.p95_ms);cells[5].textContent=typeof v.p99_ms==='number'?format(v.p99_ms):'--';cells[6].textContent=typeof v.max_ms==='number'?format(v.max_ms):'--';cells[7].textContent=String(v.samples);cells[8].textContent=`服务器实测 · 最近5分钟${v.limit_reached?' · 达到样本上限':''}`;
    });
    document.querySelectorAll<HTMLElement>('[data-latency-summary]').forEach(card=>{
      const v=data[card.dataset.latencySummary||''];const strong=card.querySelector('strong');if(strong)strong.innerHTML=valid(v)?`${format(v.p95_ms)} <small>ms</small>`:'-- <small>ms</small>';
    });
    const reaction=data.reaction,reactionNode=document.querySelector('[data-latency-reaction]');
    if(reactionNode)reactionNode.textContent=valid(reaction)?`${format(reaction.p95_ms)} ms · p95 · 样本 ${reaction.samples}`:'-- ms · 样本 0';
    const count=Object.values(data).filter(valid).reduce((total,v)=>total+v.samples,0);
    const label=current?`当前运行 ${runId} · ${count} 个分段样本`:'当前运行暂无延迟样本';
    document.querySelectorAll('[data-latency-state]').forEach(node=>node.textContent=label);
    document.querySelectorAll('[data-latency-detail-state]').forEach(node=>node.textContent=current?`运行 ${runId} · 更新 ${new Date(Number(latency.as_of)*1000).toLocaleTimeString('zh-CN',{hour12:false})}`:'暂无当前运行样本');
  }
  function renderServer(summary:any,runId:string|null){serverSummary=summary;serverRun=runId;receivedAt=Date.now();displayServer();}
  return {record(ms:number){if(Number.isFinite(ms)&&ms>=0){samples.push({at:Date.now(),ms});if(samples.length>300)samples.shift();}render();},render,renderServer,
    selectRun(runId:string|null){expectedRun=runId;displayServer();}};
}
