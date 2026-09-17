import { api } from './api/client';
import { connectForms } from './forms';
import { connectAccountData } from './account-data';
import { connectTradingControls } from './trading-controls';
import { connectStrategy } from './pages/strategy';
import { renderReversal } from './pages/reversal-runtime';
import { connectStrategyOrders } from './pages/strategy-orders';
import { pageTelemetry } from './page-telemetry';
import type { Account, Config, Events, Markets, Resource, Status } from './api/types';
import { activeMarkets, date, esc, executionName, fresh, money, modeName, number, platformRuntime, price, quotePair, usableMarket, marketMessage } from './ui';

const set = (selector: string, value: unknown) => { const node = document.querySelector(selector); if (node) node.textContent = String(value ?? '--'); };
function row(section: string, label: string, value: unknown) {
  document.querySelectorAll(`${section} .row`).forEach(r => { if (r.querySelector('span')?.textContent === label) { const b=r.querySelector('b'); if(b){ b.textContent=String(value ?? '--'); b.className=''; } } });
}
function disable(selector: string, reason: string) {
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(selector).forEach(el => { el.disabled=true; el.title=reason; });
}
const resource = <T>(): Resource<T> => ({data:null,error:null,receivedAt:0,loading:false});
const names: Record<string,string> = {quote:'挂单尝试',fill:'成交',cancel:'撤单事件',reset:'切场',stopped:'停止',unresolved:'未结算',resolved:'结算',taker:'吃单尝试',error:'错误',platform_status:'平台快照',platform_order:'平台订单',platform_fill:'平台成交'};

export function prepareReadOnly() {
  set('.side-note','BTC 五分钟反转 · 正在读取服务器');
  disable('[data-start],[data-stop],[data-pause]', '读取运行状态中');
  set('#settings-account .note','账户配置通过服务器保存，已保存的密钥不会回显。');

}

export function connect() {
  prepareReadOnly();
  const accountData=connectAccountData();
  const telemetry=pageTelemetry();
  const trading=connectTradingControls(refresh);
  const strategyConfig=connectStrategy(value=>trading.receiveStrategy(value));
  const strategyOrders=connectStrategyOrders();
  const status=resource<Status>(), markets=resource<Markets>(), config=resource<Config>(), account=resource<Account>();
  const runtimeRows=document.createElement('div');runtimeRows.dataset.platformRuntime='';runtimeRows.hidden=true;
  runtimeRows.innerHTML='<div class="row"><span>平台模拟现金</span><b data-runtime-cash>--</b></div><div class="row"><span>平台持仓 / 活跃委托</span><b data-runtime-counts>--</b></div><div class="row"><span>平台风险</span><b data-runtime-risk>--</b></div><div class="row"><span>日内结果 / 停止线</span><b data-runtime-daily-loss>--</b></div><p class="muted" data-runtime-flow-coverage></p><p class="muted" data-runtime-source role="status"></p>';
  document.getElementById('homeStrategy')!.closest('.panel')!.append(runtimeRows);
  document.querySelector('[data-depth-count]')?.addEventListener('change',renderStatus);
  let closed=false, refreshing=false, runLoading=false, runsLoading=false, historyGeneration=0;
  let configGeneration=0, accountGeneration=0;
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
  let telemetrySummary:any=null;
  let events: Events|null=null, selectedRun:string|null=null, eventError:string|null=null;
  const note=document.querySelector('#trade-orders .note')!;
  const controls=document.createElement('div'); controls.className='subnav';
  controls.innerHTML='<label>查看运行 <select id="history-run" aria-label="查看运行"><option value="">暂无运行</option></select></label><button id="older-events" disabled>更早事件</button><button id="older-runs" disabled>更早运行</button><span id="history-state" role="status"></span>';
  note.before(controls);
  const runSelect=document.getElementById('history-run') as HTMLSelectElement;
  let runCursor:number|null=null;

  function renderMarkets() {
    const data=fresh(markets), list=activeMarkets(markets), market=list[0], usable=market ? usableMarket(market,markets):false;
    set('#view-trade .quote:nth-child(1) b',market?quotePair(market,'up',usable):'-- / --');
    set('#view-trade .quote:nth-child(2) b',market?quotePair(market,'down',usable):'-- / --');
    set('[data-book-age]',usable&&market.quote_at?`${number(Math.max(0,Date.now()-Date.parse(market.quote_at)),0)} ms`:'--');
    row('#view-trade','策略判断',fresh(status)?.engine==='platform'&&fresh(status)?.strategy_id===null?'平台观察 · 未加载策略':usable?'盘口已获取 · 策略判断待接入':'行情不可用或已过期');
    row('#view-home','数据连接',data?.collector_online && usable ? `行情已更新 · ${data.node_label}`:marketMessage(markets));
    row('#settings-system','数据节点',data?.node_label || '--');
    row('#settings-system','行情更新时间',data?.latest_event_at || '--');
  }
  function renderStatus() {
    const s=fresh(status);
    const mode=s?executionName(s):'模式未知';
    const clock=s ? s.asOf+(Date.now()-status.receivedAt)/1000 : Date.now()/1000;
    const runtime=platformRuntime(s,clock);
    const platform=s?.engine==='platform';
    const strategy=platform ? s.strategy_id===null?'未加载策略':s.strategy_id ? `策略 ${s.strategy_id}`:'策略状态未知' : '';
    set('#status',!s ? status.error||'状态读取中' : s.running ? `${mode} · 运行中`:`${mode} · 未运行`);
    const strategyText=!s?'-- · 状态未知':`${mode} · ${s.running?'运行中':'已停止'}${strategy ? ` · ${strategy}` : ''}`;
    set('#homeStrategy',strategyText);
    set('#homeStrategyMetric',strategyText);
    set('#view-trade .chip',s ? `${mode} · ${s.running?'运行中':'未运行'}${strategy ? ` · ${strategy}` : ''}`:'-- · 状态未知');
    row('#settings-system','实盘开关',!s?'未知':s.live_unlocked?'已开启 · 验收状态需核对':'关闭');
    row('#settings-system','当前版本','BTC 五分钟反转');
    const stats=s?.stats;
    const valid=stats?.available===true && s?.projection?.stale===false && s.projection.state==='ready' && (s.run_id===null || s.projection.run_id===s.run_id);
    set('#homeVolume',valid&&(!platform||runtime.current)?`${number(platform?runtime.runtime?.fills_count:stats?.fills)} / ${money(stats?.fill_notional)}`:'-- / --');
    set('#homeVolume + small',s ? `成交笔数 / 成交额 · ${mode} · ${platform&&!runtime.current?'历史或过期快照':'本次运行'}`:'成交笔数 / 成交额 · 状态未获取');
    row('#view-home','本次投入上限',strategyConfig.current?.config.totalBudgetUsd==null?'未设置':money(strategyConfig.current.config.totalBudgetUsd));
    runtimeRows.hidden=!platform;
    const snapshot=runtime.runtime;
    set('[data-runtime-cash]',runtime.current&&snapshot?.mode==='paper'?`${money(snapshot.cash_usd)} · 模拟资金`:'-- · 无当前模拟资金快照');
    set('[data-runtime-counts]',runtime.current?`${number(snapshot?.positions_count)} / ${number(snapshot?.active_orders)}`:'-- / --');
    set('[data-runtime-risk]',runtime.current&&typeof snapshot?.risk?.halted==='boolean'?snapshot.risk.halted?`已暂停 · ${String(snapshot.risk.reason||'原因未提供')}`:'未触发暂停':'-- · 无当前风险快照');
    const risk=runtime.current?snapshot?.risk:null;
    const lossStatus=risk?.dailyLossStatus==='disabled'?'未设置停止线':risk?.dailyLossStatus==='active'?'停止线已启用':risk?.dailyLossStatus==='estimated'?'停止线按暂估值判断':'停止线状态未知';
    set('[data-runtime-daily-loss]',risk?`${money(risk.dailyPnlUsd)}${risk.pnlVerified===true?'':'（暂估）'} · ${lossStatus}`:'--');
    set('[data-runtime-flow-coverage]',risk?`资金变化${risk.cashFlowComplete===true?'已核对':'核对中'}${typeof risk.cashFlowCoverageUntil==='number'?`，覆盖至 ${date(risk.cashFlowCoverageUntil)}`:''}。${risk.pnlVerified===true?'已剔除确认的充值提现。':'较新资金变化仍待确认，暂估结果可能修正。'}`:'');
    set('[data-runtime-source]',`${s?.control_source?.label||'来源未标注'} · 平台运行 ${s?.run_id||'--'} · ${snapshot?`采集 ${date(snapshot.source_at)} · ${number(Math.max(0,clock-snapshot.source_at),1)} 秒前 · ${!s?.running?'历史最终快照':runtime.current?'当前快照':'已过期或等待当前快照'}`:'等待平台快照'}`);
    if(platform){
      row('#view-trade','策略判断',strategy);
      row('#view-trade','补仓状态',s?.strategy_id===null?'未加载策略':'按平台策略运行');
      set('#view-home .grid .note',s?.strategy_id==='btc-reversal'?'BTC 五分钟反转 · 订单和持仓由服务器持续管理。':'当前未加载 BTC 反转策略。');
    }
    const rows=valid&&Array.isArray(stats?.events)? stats.events.slice(-6):[];
    const logs=rows.map(e=>`${date(e.time)} · ${names[e.event]||'其他事件'} · ${e.market||'--'}${e.event==='fill'?` · ${number(e.shares,2)} 份 × ${price(e.price)}`:''}`).join('\n');
    set('#homeLog',status.error||logs||'尚无可用运行事件。'); set('#tradeLog',status.error||logs||'尚无可用运行事件。');
    for(const id of ['homeLog','tradeLog'])document.getElementById(id)!.style.whiteSpace='pre-wrap';
    const currentMarket=renderReversal(s,clock);
    accountData.receiveMarket(currentMarket?.marketId||null);
    strategyOrders.receive(s?.run_id||null,currentMarket?.marketName||null);
    const a=fresh(account);
    trading.receive(fresh(config),s);
    row('#view-home','当前账户',account.error?'-- · 读取失败':a?.wallet_configured ? `${a.wallet} · ${a.control_source?.label || '来源未标注'}` : a ? `未配置 · ${a.control_source?.label || '来源未标注'}` : '读取中');
    if(s?.control_source?.scope === 'local_preview') {
      set('.side-note',`${s.control_source.market_node}公开行情\n账户、运行、账本：本机预览`);
      const previewStrategyText=`${mode} · ${s.running ? '运行中' : '未运行'}${strategy ? ` · ${strategy}` : ''} · 本机预览`;
      set('#homeStrategy', previewStrategyText);
      set('#homeStrategyMetric', previewStrategyText);
    }
  }
  function renderConfig() {
    const c=config.data;
    document.querySelectorAll('[data-effective-summary]').forEach(el=>el.textContent=config.error || (!c?'配置未获取':`${c.control_source?.label || '来源未标注'} · 已保存版本 ${c.revision} · 本次运行版本 ${status.data?.config_revision??'--'}`));

  }
  function renderEvents() {
    if(document.getElementById('trade-orders')?.dataset.source!=='run')return;
    const body=document.querySelector('#trade-orders tbody');
    if (!body) return;
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
    try{await Promise.allSettled([load(status,api.status),load(markets,api.markets),load(config,api.config),load(account,api.account),strategyConfig.refresh()]);
      await Promise.allSettled([accountData.refresh(),strategyOrders.refresh()]);
      await loadRuns(undefined,true);
      if(selectedRun&&!runLoading)await loadEvents(selectedRun,historyCursor);
      if(selectedRun){ try { telemetrySummary=(await api.summary(selectedRun)).summary; telemetry.renderServer(telemetrySummary); } catch { telemetrySummary=null; } }
    }finally{refreshing=false;renderEvents();if(fresh(status))telemetry.record(performance.now()-started);}
  }
  // refresh() owns the run/event refresh sequence. Triggering the paginated
  // loaders here as well races the same requests and can replace a fresh
  // snapshot with an older response (especially when the user clicks twice).
  document.querySelectorAll('[data-refresh]:not(#view-tasks [data-refresh])').forEach(b=>b.addEventListener('click',()=>{void refresh();}));
  renderMarkets();renderStatus();renderConfig();renderEvents();void refresh();
  const poll=window.setInterval(()=>void refresh(),5000);
  const tick=window.setInterval(()=>{renderMarkets();renderStatus();renderEvents();accountData.render();telemetry.render();},1000);
  return ()=>{closed=true;strategyConfig.close();strategyOrders.close();forms.close();accountData.close();trading.close();historyGeneration++;window.clearInterval(poll);window.clearInterval(tick);};
}
