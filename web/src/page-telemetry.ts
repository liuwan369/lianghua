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
  return {record(ms:number){if(Number.isFinite(ms)&&ms>=0){samples.push({at:Date.now(),ms});if(samples.length>300)samples.shift();}render();},render};
}
