import { api } from './api/client';
import { connectForms } from './forms';
import { connectAccountData } from './account-data';
import { connectTradingControls } from './trading-controls';
import { pageTelemetry } from './page-telemetry';
import type { Account, Config, Events, Markets, Resource, Status } from './api/types';
import { activeMarkets, date, esc, finite, fresh, money, modeName, number, price, quotePair, serverNow, usableMarket, marketMessage } from './ui';

const set = (selector: string, value: unknown) => { const node = document.querySelector(selector); if (node) node.textContent = String(value ?? '--'); };
function row(section: string, label: string, value: unknown) {
  document.querySelectorAll(`${section} .row`).forEach(r => { if (r.querySelector('span')?.textContent === label) { const b=r.querySelector('b'); if(b){ b.textContent=String(value ?? '--'); b.className=''; } } });
}
function disable(selector: string, reason: string) {
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(selector).forEach(el => { el.disabled=true; el.title=reason; });
}
const resource = <T>(): Resource<T> => ({data:null,error:null,receivedAt:0,loading:false});
const names: Record<string,string> = {quote:'挂单尝试',fill:'成交',cancel:'撤单事件',reset:'切场',stopped:'停止',unresolved:'未结算',resolved:'结算',taker:'吃单尝试',error:'错误'};

export function prepareReadOnly() {
  set('.side-note','服务器数据接入中\n未接入功能保留原位');
  const note=document.querySelector<HTMLElement>('.side-note'); if(note)note.style.whiteSpace='pre-line';
  disable('[data-start],[data-stop],[data-exit]', '交易控制尚未完成验收');
  disable('#view-orders .subnav button,#view-orders .head-actions button,#view-markets .subnav button', '筛选及导出尚未接入，功能保留');
  document.querySelectorAll<HTMLInputElement>('#settings-strategy input,#settings-run input').forEach(el=>{el.value='';el.placeholder='未接入';});
  document.querySelectorAll<HTMLSelectElement>('#settings-strategy select,#settings-run select').forEach(el=>{
    const option=document.createElement('option');option.text='未接入';option.value='';el.prepend(option);el.value='';
  });
  set('#setting-mode option[value="paper"]','纸面模拟');
  set('#settings-strategy .settings-intro','原设计参数完整保留，可在原位置填写。已接入字段可保存到服务器；其余字段仅本页草稿，不会保存或生效。');
  set('.settings-advanced .settings-check-foot','高级选项可填写草稿；对应执行和风控尚未接入，不会保存或生效。');
  document.querySelectorAll('[data-setting-checks]').forEach(el=>{el.textContent='账户额度、真实市场最小委托、费用和高级参数尚未完成联合检查。';});
  document.querySelectorAll('[data-check-state]').forEach(el=>el.textContent='待接入验收');
  document.querySelectorAll('[data-effective-summary]').forEach(el=>el.textContent='服务器配置尚未获取');
  document.querySelectorAll('[data-settings-save]').forEach(el=>el.textContent='保存设置');
  document.querySelectorAll('[data-settings-reset]').forEach(el=>el.textContent='撤销未保存修改');
  document.querySelectorAll('.settings-example label').forEach(el=>el.textContent='市场最小委托与委托价格 · 待接入核验');
  document.querySelectorAll('.settings-checks > .settings-check-foot').forEach(el=>el.textContent='实际账户额度、市场最小份数和费用尚未完成启动核验。');
  set('#view-home > .stats:first-of-type .stat:nth-child(1) small','今日 --　当月 -- · 订单生命周期待接入');
  // Use direct selectors rather than synthetic totals: quote events are not orders.
  set('#homeOrders','--');
  set('#homeOrders + small','今日 --　当月 --');
  set('#view-home .stats .stat:nth-child(3) strong','--');
  set('#view-home .stats .stat:nth-child(3) small','今日 --　当月 -- · 已结算胜率待接入');
  set('#view-home .section-title > .muted','收益账单未获取 · 纸面与实盘按运行区分');
  set('#view-home .panel .section-title .pill','服务器事件');
  set('#view-home .latency-caption','测量接口尚未接入。无样本显示 --；确认接单不代表成交。');
  set('#settings-account .note','账户可填写；检查与保存由服务器校验授权，不会读取或回显已保存密钥。');
  set('#view-home .grid .note','可在设置页填写并提交已接入参数。交易启停尚未验收，继续保持锁定。');
  set('#view-trade .panel .empty','有效订单生命周期尚未接入，不能据此判断是否有挂单。');
  for(const label of ['UP 数量 / 平均价','DOWN 数量 / 平均价','两边数量差'])row('#view-trade',label,'--');
  row('#view-trade','补仓状态','未接入');
  row('#view-home','账户余额','-- · 余额未接入');
  row('#view-home','当前持仓','-- · 持仓未接入');
  set('#view-orders .note','按运行展示服务器事件，费用未知显示 --。完整委托生命周期、筛选和导出尚未接入；挂单尝试不代表平台已接单。');
}

export function connect() {
  prepareReadOnly();
  const accountData=connectAccountData();
  const telemetry=pageTelemetry();
  const trading=connectTradingControls(refresh);
  const status=resource<Status>(), markets=resource<Markets>(), config=resource<Config>(), account=resource<Account>();
  let closed=false, refreshing=false, runLoading=false, runsLoading=false, historyGeneration=0;
  let configGeneration=0, accountGeneration=0;
  let marketFilter=0;
  const marketFilters=Array.from(document.querySelectorAll<HTMLButtonElement>('#view-markets .subnav button'));
  marketFilters.forEach((button,index)=>{
    button.disabled=index===3;
    button.title=index===3?'需要完整实时深度与实际委托份数，当前不使用双边报价冒充盘口容量':'只筛选行情，不代表通过账户和策略风控';
    button.addEventListener('click',()=>{marketFilter=index;marketFilters.forEach((b,i)=>b.classList.toggle('active',i===index));renderMarkets();});
  });
  const forms = connectForms({
    config: value => {
      configGeneration++;
      config.data={...value,control_source:value.control_source || config.data?.control_source};
      config.error=null;config.receivedAt=Date.now();renderConfig();
    },
    account: () => {
      accountGeneration++;account.data=null;account.receivedAt=0;
      void load(account,api.account);
    },
  });
  let eventsReceivedAt=0, historyCursor:number|undefined;
  let events: Events|null=null, selectedRun:string|null=null, eventError:string|null=null;
  const note=document.querySelector('#view-orders .note')!;
  const controls=document.createElement('div'); controls.className='subnav';
  controls.innerHTML='<label>查看运行 <select id="history-run" aria-label="查看运行"><option value="">暂无运行</option></select></label><button id="older-events" disabled>更早事件</button><button id="older-runs" disabled>更早运行</button><span id="history-state" role="status"></span>';
  note.before(controls);
  const runSelect=document.getElementById('history-run') as HTMLSelectElement;
  let runCursor:number|null=null;

  function renderMarkets() {
    const data=fresh(markets), list=activeMarkets(markets), market=list[0], usable=market ? usableMarket(market,markets):false;
    const clock=serverNow(markets);
    set('#view-trade .quote:nth-child(1) b',market?quotePair(market,'up',usable):'-- / --');
    set('#view-trade .quote:nth-child(2) b',market?quotePair(market,'down',usable):'-- / --');
    row('#view-trade','两边立即买入成本',usable?price(market.ask_sum):'--');
    row('#view-trade','策略判断',usable?'盘口已获取 · 策略判断待接入':'行情不可用或已过期');
    row('#view-home','数据连接',data?.collector_online && usable ? `行情已更新 · ${data.node_label}`:marketMessage(markets));
    row('#settings-system','数据节点',data?.node_label || '--');
    row('#settings-system','行情更新时间',data?.latest_event_at || '--');
    const threshold=fresh(config)?.params.pair_cost_max;
    marketFilters[2].textContent=`成本低于 ${money(threshold)}（已保存配置）`;
    const filtered=list.filter(m=>marketFilter===0||marketFilter===1&&usableMarket(m,markets)||marketFilter===2&&usableMarket(m,markets)&&finite(threshold)&&finite(m.ask_sum)&&m.ask_sum<threshold);
    const tbody=document.querySelector('#view-markets tbody')!;
    tbody.innerHTML=filtered.length ? filtered.map(m=>{const ok=usableMarket(m,markets);return `<tr><td>${esc(m.slug)}</td><td>${number(Math.max(0,Math.floor(m.end-clock)))} 秒</td><td>${quotePair(m,'up',ok)}</td><td>${quotePair(m,'down',ok)}</td><td>${ok?price(m.ask_sum):'--'}</td><td>${ok?'已获取快照':'已过期/缺失'}</td><td><span class="pill warn">${ok?'行情可用 · 执行另需风控':'行情不可用'}</span></td></tr>`;}).join('') : `<tr><td colspan="7" class="empty">${esc(list.length?'没有符合当前筛选的市场':marketMessage(markets))}</td></tr>`;
  }
  function renderStatus() {
    const s=fresh(status);
    const mode=s?modeName(s.mode):'模式未知';
    set('#status',!s ? status.error||'状态读取中' : s.running ? `${mode} · 运行中`:`${mode} · 未运行`);
    set('#homeStrategy',!s?'-- · 状态未知':s.running?'运行中':'未运行');
    set('#view-trade .chip',s ? `${mode} · ${s.running?'运行中':'未运行'}`:'-- · 状态未知');
    row('#settings-system','实盘开关',!s?'未知':s.live_unlocked?'已开启 · 验收状态需核对':'关闭');
    row('#settings-system','当前版本','六页原设计 · 表单接入');
    const stats=s?.stats;
    const valid=stats?.available===true && s?.projection?.stale===false && s.projection.state==='ready' && (s.run_id===null || s.projection.run_id===s.run_id);
    set('#homeVolume',valid?`${number(stats?.fills)} / ${money(stats?.fill_notional)}`:'-- / --');
    set('#homeVolume + small',s ? `成交笔数 / 成交额 · ${mode} · 最近运行`:'成交笔数 / 成交额 · 状态未获取');
    row('#view-home','本次投入上限',s?.running?money(s.params.max_total_usd):'-- · 未运行');
    const rows=valid&&Array.isArray(stats?.events)? stats.events.slice(-6):[];
    const logs=rows.map(e=>`${date(e.time)} · ${names[e.event]||'其他事件'} · ${e.market||'--'}${e.event==='fill'?` · ${number(e.shares,2)} 份 × ${price(e.price)}`:''}`).join('\n');
    set('#homeLog',status.error||logs||'尚无可用运行事件。'); set('#tradeLog',status.error||logs||'尚无可用运行事件。');
    for(const id of ['homeLog','tradeLog'])document.getElementById(id)!.style.whiteSpace='pre-wrap';
    const a=fresh(account);
    trading.receive(fresh(config),s);
    row('#view-home','当前账户',account.error?'-- · 读取失败':a?.wallet_configured ? `${a.wallet} · ${a.control_source?.label || '来源未标注'}` : a ? `未配置 · ${a.control_source?.label || '来源未标注'}` : '读取中');
    if(s?.control_source?.scope === 'local_preview') {
      set('.side-note',`${s.control_source.market_node}公开行情\n账户、运行、账本：本机预览`);
      set('#homeStrategy', `${s.running ? '运行中' : '未运行'} · 本机预览`);
    }
  }
  function renderConfig() {
    const c=config.data;
    document.querySelectorAll('[data-effective-summary]').forEach(el=>el.textContent=config.error || (!c?'配置未获取':`${c.control_source?.label || '来源未标注'} · 已保存版本 ${c.revision} · 本次运行版本 ${status.data?.config_revision??'--'}`));
    row('#view-trade','目标成本上限','-- · 目标与硬上限尚未分别接入');
  }
  function renderEvents() {
    if(document.getElementById('view-orders')?.dataset.source==='account')return;
    const body=document.querySelector('#view-orders tbody')!;
    const expired=events!==null && Date.now()-eventsReceivedAt>=15000;
    const rows=events?.run_id===selectedRun && Date.now()-eventsReceivedAt<15000 ? events.events:[];
    body.innerHTML=rows.length ? rows.map(e=>{const fill=e.event==='fill';return `<tr><td>${date(e.time)}</td><td>${esc(e.market)}</td><td>${esc(e.side)}</td><td>${price(e.price)}</td><td>${fill?number(e.shares,2):'--'}</td><td>${fill?money(e.amount):'--'}</td><td>${fill?money(e.fee):'--'}</td><td>${esc(names[e.event]||'其他事件')}</td></tr>`;}).join('') : `<tr><td colspan="8" class="empty">${esc(eventError||'该运行暂无事件')}</td></tr>`;
    set('#history-state',eventError|| (expired?'事件快照已过期，正在刷新':selectedRun?`运行：${selectedRun} · ${events?.control_source?.label||'来源未标注'}`:'暂无运行'));
    (document.getElementById('older-events') as HTMLButtonElement).disabled=runLoading||!events?.next_before_id;
    (document.getElementById('older-runs') as HTMLButtonElement).disabled=refreshing||runsLoading||runCursor===null;
  }
  async function loadEvents(run:string, before?:number) {
    const generation=++historyGeneration;runLoading=true;eventError=null;
    if(before===undefined && events?.run_id!==run)events=null;
    historyCursor=before;
    renderEvents();
    try {const data=await api.events(run,before);if(closed||generation!==historyGeneration)return;
      if(data.run_id!==run)throw new Error('运行事件不匹配，已清空');events=data;eventsReceivedAt=Date.now();
    }catch(e){if(generation!==historyGeneration)return;events=null;eventError=e instanceof Error?e.message:'事件读取失败';}
    finally{if(generation===historyGeneration){runLoading=false;renderEvents();}}
  }
  runSelect.addEventListener('change',()=>{selectedRun=runSelect.value||null;if(selectedRun)void loadEvents(selectedRun);});
  document.getElementById('older-events')!.addEventListener('click',()=>{if(selectedRun&&events?.next_before_id)void loadEvents(selectedRun,events.next_before_id);});
  async function loadRuns(before?:number, refreshLatest=false) {
    if(runsLoading || closed)return;runsLoading=true;
    renderEvents();
    try {const page=await api.runs(before);if(closed)return;
      Array.from(runSelect.options).filter(option=>!option.value).forEach(option=>option.remove());
      const hadOptions=runSelect.options.length>0;
      if(before===undefined && !refreshLatest)runSelect.replaceChildren();
      const latestOptions: HTMLOptionElement[]=[];
      for(const r of page.runs){let opt=Array.from(runSelect.options).find(o=>o.value===r.run_id);if(!opt){opt=document.createElement('option');opt.value=r.run_id;}opt.text=`${modeName(r.mode)} · ${r.account_id||'未绑定账户'} · ${r.run_id}`;if(refreshLatest)latestOptions.push(opt);else runSelect.append(opt);}
      // Poll the head without discarding a historical selection or its cursor.
      // Moving existing options also refreshes metadata without duplicating runs.
      if(refreshLatest)runSelect.prepend(...latestOptions);
      if(selectedRun&&!Array.from(runSelect.options).some(o=>o.value===selectedRun)){selectedRun=null;events=null;}
      if(!refreshLatest || !hadOptions)runCursor=page.next_before_id;
      if(!selectedRun){selectedRun=runSelect.options[0]?.value||null;if(selectedRun)void loadEvents(selectedRun);}
      runSelect.value=selectedRun||'';
    }catch(e){eventError=e instanceof Error?e.message:'运行读取失败';events=null;runCursor=null;historyGeneration++;runLoading=false;selectedRun=null;runSelect.replaceChildren();}
    runsLoading=false;renderEvents();
  }
  document.getElementById('older-runs')!.addEventListener('click',()=>{if(runCursor!==null)void loadRuns(runCursor);});
  async function load<T>(r:Resource<T>, request:()=>Promise<T>) {
    const configEpoch=configGeneration, accountEpoch=accountGeneration;
    const obsolete=()=>closed || (r===config && configEpoch!==configGeneration) || (r===account && accountEpoch!==accountGeneration);
    try{const data=await request();if(obsolete())return;
      if(r===config && config.data && (data as Config).revision<config.data.revision)return;
      r.data=data;r.error=null;r.receivedAt=Date.now();}
    catch(e){if(obsolete())return;r.data=null;r.error=e instanceof Error?e.message:'读取失败';r.receivedAt=0;}
    if(!closed){
      if(r===config)forms.receiveConfig(config.data,config.error);
      if(r===account){forms.receiveAccount(account.data);accountData.receiveAccount(account.data);}
      renderMarkets();renderStatus();renderConfig();accountData.render();
    }
  }
  async function refresh() {
    if(refreshing||closed)return;refreshing=true;
    const started=performance.now();
    try{await Promise.allSettled([load(status,api.status),load(markets,api.markets),load(config,api.config),load(account,api.account)]);
      await accountData.refresh();
      await loadRuns(undefined,true);
      if(selectedRun&&!runLoading)await loadEvents(selectedRun,historyCursor);
    }finally{refreshing=false;renderEvents();if(fresh(status))telemetry.record(performance.now()-started);}
  }
  // refresh() owns the run/event refresh sequence. Triggering the paginated
  // loaders here as well races the same requests and can replace a fresh
  // snapshot with an older response (especially when the user clicks twice).
  document.querySelectorAll('[data-refresh]').forEach(b=>b.addEventListener('click',()=>{void refresh();}));
  renderMarkets();renderStatus();renderConfig();renderEvents();void refresh();
  const poll=window.setInterval(()=>void refresh(),5000);
  const tick=window.setInterval(()=>{renderMarkets();renderStatus();renderEvents();accountData.render();telemetry.render();},1000);
  return ()=>{closed=true;forms.close();accountData.close();trading.close();historyGeneration++;window.clearInterval(poll);window.clearInterval(tick);};
}
