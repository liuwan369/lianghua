export function pageTelemetry() {
  const samples:Array<{at:number;ms:number}>=[];
  function render(){
    const now=Date.now();while(samples.length&&samples[0].at<now-300000)samples.shift();
    const cells=document.querySelectorAll('.latency-table tbody tr:nth-child(8) td');if(cells.length<7)return;
    const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b);
    const percentile=(p:number)=>sorted.length?sorted[Math.ceil(sorted.length*p)-1].toFixed(1):'--';
    cells[2].textContent=samples.length?samples[samples.length-1].ms.toFixed(1):'--';cells[3].textContent=percentile(.5);cells[4].textContent=percentile(.95);cells[5].textContent=String(samples.length);cells[6].textContent=samples.length?'浏览器本页实测 · 最近5分钟':'暂无成功刷新样本';
    const state=document.querySelector('#settings-system .latency-state');if(state)state.textContent=`页面刷新样本 ${samples.length} · 其余环节按各自来源显示`;
  }
  function renderServer(summary:any){
    const data=summary?.latency?.metrics || {};
    const rows=['market_age','book_processing','strategy_decision','order_sign','order_ack','cancel_ack','fill_report','reaction'];
    const body=document.querySelectorAll('.latency-table tbody tr');
    rows.forEach((metric,i)=>{const row=body[i] as HTMLElement; const v=data[metric]; if(!row)return;
      const cells=row.querySelectorAll('td'); if(!v){cells[2].textContent='--';cells[3].textContent='--';cells[4].textContent='--';cells[5].textContent='0';cells[6].textContent='暂无有效样本';return;}
      cells[2].textContent=Number(v.latest_ms).toFixed(1); cells[3].textContent=Number(v.p50_ms).toFixed(1); cells[4].textContent=Number(v.p95_ms).toFixed(1); cells[5].textContent=String(v.samples); cells[6].textContent=`服务器实测 · 最近5分钟${v.limit_reached?' · 达到样本上限':''}`;
    });
  }
  return {record(ms:number){if(Number.isFinite(ms)&&ms>=0){samples.push({at:Date.now(),ms});if(samples.length>300)samples.shift();}render();},render,renderServer};
}
