import { api } from './api/client';
import { connectForms } from './forms';
import { connectAccountData } from './account-data';
import { connectTradingControls } from './trading-controls';
import { connectStrategy } from './pages/strategy';
import { renderReversal } from './pages/reversal-runtime';
import { connectStrategyOrders } from './pages/strategy-orders';
import { pageTelemetry } from './page-telemetry';
import { renderSystemMetrics } from './system-metrics';
import type { Account, Markets, Resource, Status, SystemMetrics } from './api/types';
import { activeMarkets, date, executionName, fresh, money, number, platformRuntime, projectionUsable, price, quotePair, usableMarket, marketMessage, serverNow } from './ui';

const set = (selector: string, value: unknown) => { const node = document.querySelector(selector); if (node) node.textContent = String(value ?? '--'); };
function row(section: string, label: string, value: unknown) {
  document.querySelectorAll(`${section} .row`).forEach(r => { if (r.querySelector('span')?.textContent === label) { const b=r.querySelector('b'); if(b) b.textContent=String(value ?? '--'); } });
}
function disable(selector: string, reason: string) {
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(selector).forEach(el => { el.disabled=true; el.title=reason; });
}
const resource = <T>(): Resource<T> => ({data:null,error:null,receivedAt:0,loading:false});
const names: Record<string,string> = {quote:'挂单尝试',fill:'成交',cancel:'撤单事件',reset:'切场',stopped:'停止',unresolved:'未结算',resolved:'结算',taker:'吃单尝试',error:'错误',order:'订单',platform_status:'平台快照',platform_order:'平台订单',platform_fill:'平台成交'};

export function eventLabel(event: {event?:unknown;state?:unknown;payout_verified?:unknown;credited_usd?:unknown;status?:unknown;code?:unknown;phase?:unknown}): string {
  if (event.event === 'order') {
    const status = typeof event.status === 'string' ? event.status : '';
    if (status === 'UNKNOWN') return '订单状态未知';
    return status ? `订单 ${status}` : '订单';
  }
  if (event.event === 'error') {
    const code = typeof event.code === 'string' ? event.code : '';
    const prefix = event.phase === 'shutdown' ? '停止阶段异常' : '平台事件异常';
    return code ? `${prefix} · ${code}` : prefix;
  }
  if (event.event !== 'settlement') return names[String(event.event)] || '其他事件';
  if (event.state === 'confirmed' && event.payout_verified === true
    && typeof event.credited_usd === 'number' && Number.isFinite(event.credited_usd) && event.credited_usd >= 0)
    return `结算到账 ${money(event.credited_usd)}`;
  return event.state === 'confirmed' ? '结算结束 · 未记录到账' : event.state === 'pending' ? '结算等待确认' : '结算待处理';
}

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
  const strategyConfig=connectStrategy(value=>{trading.receiveStrategy(value);renderEffectiveConfig();});
  const strategyOrders=connectStrategyOrders();
  const status=resource<Status>(), markets=resource<Markets>(), account=resource<Account>(), system=resource<SystemMetrics>();
  const runtimeRows=document.createElement('div');runtimeRows.dataset.platformRuntime='';runtimeRows.hidden=true;
  runtimeRows.innerHTML='<div class="row"><span>平台账户现金</span><b data-runtime-cash>--</b></div><div class="row"><span>平台持仓 / 活跃委托</span><b data-runtime-counts>--</b></div><div class="row"><span>平台风险</span><b data-runtime-risk>--</b></div><div class="row"><span>日内结果 / 停止线</span><b data-runtime-daily-loss>--</b></div><p class="muted" data-runtime-flow-coverage></p><p class="muted" data-runtime-source role="status"></p>';
  document.getElementById('homeStrategy')!.closest('.panel')!.append(runtimeRows);
  document.querySelector('[data-depth-count]')?.addEventListener('change',renderStatus);
  let closed=false, refreshing=false, slowRefreshing=false, systemLoading=false;
  let systemMetricsReceivedAt=0;
  const systemMetricsRefreshMs=15_000;
  let accountDataRequestedAt=0;
  const accountDataRefreshMs=15_000;
  let accountGeneration=0;
  const forms = connectForms({
    account: () => {
      accountGeneration++;account.data=null;account.receivedAt=0;
      void load(account,api.account);
    },
  });
  let telemetrySummary:any=null;
  const note=document.querySelector('#trade-orders .note')!;
  let lastQuote:{up:string;down:string;ageMs:number|null;receivedAtMs:number;source:string;stale:boolean;historical:boolean}|null=null;

  function renderMarkets() {
    const data=fresh(markets), list=activeMarkets(markets), market=list[0], usable=market ? usableMarket(market,markets):false;
    row('#view-trade','策略判断',fresh(status)?.engine==='platform'&&fresh(status)?.strategy_id===null?'平台观察 · 未加载策略':usable?'盘口已获取 · 策略判断待接入':'行情不可用或已过期');
    row('#view-home','数据连接',data?.collector_online && usable ? `行情已更新 · ${data.node_label}`:marketMessage(markets));
    row('#settings-system','数据节点',data?.node_label || '--');
    row('#settings-system','行情更新时间',data?.latest_event_at || '--');
  }

  function renderQuoteView(view: ReturnType<typeof renderReversal>) {
    const liveStatus=fresh(status);
    const statusKnown=status.data!==null;
    const running=liveStatus?.running ?? (status.data?.running === true ? true : false);
    const market=activeMarkets(markets)[0];
    const usable=market ? usableMarket(market,markets):false;
    if (running) {
      let updated=false;
      if (view?.quotes?.length===2 && !view.quoteStale) {
        const byToken=new Map(view.quotes.map(quote=>[quote.tokenId,quote]));
        const up=view.upTokenId ? byToken.get(view.upTokenId) : undefined;
        const down=view.downTokenId ? byToken.get(view.downTokenId) : undefined;
        if (up && down) {
          lastQuote={up:`${price(up.bid)} / ${price(up.ask)}`,down:`${price(down.bid)} / ${price(down.ask)}`,
            ageMs:view.quoteAgeMs===null||view.quoteAgeMs<0?null:view.quoteAgeMs,
            source:'当前策略 WS 快照 · 距今时间包含状态汇总与页面刷新等待，不是下单延迟。',
            receivedAtMs:Date.now(),stale:view.quoteStale,historical:false};
          updated=true;
        }
      }
      if (!updated && lastQuote) lastQuote={...lastQuote,stale:true,historical:false};
    } else if ((!statusKnown || liveStatus?.running === false) && market && usable) {
      const age=market.quote_at?serverNow(markets)*1000-Date.parse(market.quote_at):null;
      if (age===null || age>=0) lastQuote={up:quotePair(market,'up',usable),down:quotePair(market,'down',usable),
        ageMs:age,receivedAtMs:Date.now(),source:'公开行情 · 策略未运行。',stale:false,historical:false};
    } else if (!running && lastQuote) {
      lastQuote={...lastQuote,stale:true,historical:true};
    }
    if (lastQuote) {
      set('#view-trade .quote:nth-child(1) b',lastQuote.up);
      set('#view-trade .quote:nth-child(2) b',lastQuote.down);
      const displayAgeMs=lastQuote.ageMs===null?null:lastQuote.ageMs+Math.max(0,Date.now()-lastQuote.receivedAtMs);
      set('[data-book-age]',displayAgeMs===null?'等待来源时间':`约 ${number(displayAgeMs,0)} ms`);
      set('[data-book-source]',lastQuote.stale
        ? `${lastQuote.source} · ${lastQuote.historical?'运行已停止，保留上次成功盘口。':'数据暂时过期，保留上次成功盘口。'}`
        : lastQuote.source);
    }
  }
  function renderStatus() {
    const s=fresh(status);
    if (!s && status.data) {
      set('#status', status.error || '状态暂时不可用，保留上次成功数据');
    }
    telemetry.selectRun(s?.run_id||null);
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
    const valid=stats?.available===true && s?.projection?.stale===false && projectionUsable(s) && (s.run_id===null || s.projection?.run_id===s.run_id);
    set('#homeVolume',valid&&(!platform||runtime.current)?`${number(platform?runtime.runtime?.fills_count:stats?.fills)} / ${money(stats?.fill_notional)}`:'-- / --');
    set('#homeVolume + small',s ? `成交笔数 / 成交额 · ${mode} · ${platform&&!runtime.current?'历史或过期快照':'本次运行'}`:'成交笔数 / 成交额 · 状态未获取');
    row('#view-home','本次投入上限',strategyConfig.current?.config.totalBudgetUsd==null?'未设置':money(strategyConfig.current.config.totalBudgetUsd));
    runtimeRows.hidden=!platform;
    const snapshot=runtime.runtime;
    set('[data-runtime-cash]',runtime.current&&snapshot?.mode==='live'?`${money(snapshot.cash_usd)} · 实盘账户`:'-- · 无当前实盘账户快照');
    set('[data-runtime-counts]',runtime.current?`${number(snapshot?.positions_count)} / ${number(snapshot?.active_orders)}`:'-- / --');
    const risk=runtime.current?snapshot?.risk:null;
    const unresolved=typeof risk?.unresolvedOrderCount==='number'&&Number.isFinite(risk.unresolvedOrderCount)?risk.unresolvedOrderCount:0;
    const reconciliationRequired=risk?.reconciliationRequired===true||unresolved>0;
    set('[data-runtime-risk]',runtime.current&&typeof snapshot?.risk?.halted==='boolean'
      ?snapshot.risk.halted?`已暂停 · ${String(snapshot.risk.reason||'原因未提供')}`
      :reconciliationRequired?`可继续验证 · 保留 ${number(unresolved,0)} 个未确认订单，待交易所核对`:'未触发暂停'
      :'-- · 无当前风险快照');
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
    const logs=rows.map(e=>`${date(e.time)} · ${eventLabel(e)} · ${e.market||'--'}${e.event==='fill'?` · ${number(e.shares,2)} 份 × ${price(e.price)}`:''}`).join('\n');
    const statsError=typeof stats?.error==='string'?stats.error:null;
    const meaningfulStatsError=statsError&&statsError!=='引擎报告异常，请检查运行状态'?statsError:null;
    const runLog=meaningfulStatsError&&logs?`${meaningfulStatsError}\n${logs}`:logs||meaningfulStatsError||statsError||status.error||'尚无可用运行事件。';
    set('#homeLog',runLog); set('#tradeLog',runLog);
    for(const id of ['homeLog','tradeLog'])document.getElementById(id)!.style.whiteSpace='pre-wrap';
    const currentMarket=renderReversal(s,clock);
    renderQuoteView(currentMarket);
    accountData.receiveMarket(currentMarket?.marketId||null);
    strategyOrders.receive(s?.run_id||null,currentMarket?.marketName||null,!!s,s?.running===true);
    const a=fresh(account);
    trading.receive(s);
    row('#view-home','当前账户',account.error?'-- · 读取失败':a?.wallet_configured ? `${a.wallet} · ${a.control_source?.label || '来源未标注'}` : a ? `未配置 · ${a.control_source?.label || '来源未标注'}` : '读取中');
    if(s?.control_source?.scope === 'local_preview') {
      set('.side-note',`${s.control_source.market_node}公开行情\n账户、运行、账本：本机预览`);
      const previewStrategyText=`${mode} · ${s.running ? '运行中' : '未运行'}${strategy ? ` · ${strategy}` : ''} · 本机预览`;
      set('#homeStrategy', previewStrategyText);
      set('#homeStrategyMetric', previewStrategyText);
    }
  }
  function renderEffectiveConfig() {
    const saved = strategyConfig.current;
    const runningRevision = status.data?.config_revision;
    document.querySelectorAll('[data-effective-summary]').forEach(el=>el.textContent=
      saved ? `已保存版本 ${saved.savedRevision} · 本次运行版本 ${runningRevision ?? '--'}` : '策略配置未获取');
  }
  async function load<T>(r:Resource<T>, request:()=>Promise<T>) {
    const accountEpoch=accountGeneration;
    const obsolete=()=>closed || (r===account && accountEpoch!==accountGeneration);
    try{const data=await request();if(obsolete())return;
      r.data=data;r.error=null;r.receivedAt=Date.now();}
    catch(e){if(obsolete())return;r.error=e instanceof Error?e.message:'读取失败';}
    if(!closed){
      if(r===account){forms.receiveAccount(account.data);accountData.receiveAccount(account.data);}
      renderMarkets();renderStatus();renderEffectiveConfig();accountData.render();
      if(r===system)renderSystemMetrics(system.data,system.error);
    }
  }
  async function loadSystemMetrics(){
    if(systemLoading||closed)return;systemLoading=true;
    try{await load(system,api.systemMetrics);if(system.data)systemMetricsReceivedAt=Date.now();}
    finally{systemLoading=false;}
  }
  async function loadRealtime<T>(r:Resource<T>, request:()=>Promise<T>) {
    if(r.loading||closed)return;r.loading=true;
    try{await load(r,request);}finally{r.loading=false;}
  }
  function refreshRealtime() {
    return Promise.allSettled([loadRealtime(status,api.status),loadRealtime(markets,api.markets)]);
  }
  async function refreshSlow() {
    if(slowRefreshing||closed)return;slowRefreshing=true;
    const metricsDue=!system.data || Date.now()-systemMetricsReceivedAt>=systemMetricsRefreshMs;
    const accountDataDue=Date.now()-accountDataRequestedAt>=accountDataRefreshMs;
    if(accountDataDue)accountDataRequestedAt=Date.now();
    try {
      await Promise.allSettled([load(account,api.account),metricsDue?loadSystemMetrics():Promise.resolve(),strategyConfig.refresh(),
        accountDataDue?accountData.refresh():Promise.resolve(),strategyOrders.refresh()]);
      const telemetryRun=fresh(status)?.run_id||null;
      if(telemetryRun){try{telemetrySummary=(await api.summary(telemetryRun)).summary;telemetry.renderServer(telemetrySummary,telemetryRun);}catch{/* keep last successful latency summary */}}
      else {telemetrySummary=null;telemetry.renderServer(null,null);}
    } finally {slowRefreshing=false;}
  }
  async function refresh() {
    if(refreshing||closed)return;refreshing=true;
    const started=performance.now();
    try { await Promise.allSettled([refreshRealtime(),refreshSlow()]); }
    finally {refreshing=false;if(fresh(status))telemetry.record(performance.now()-started);}
  }
  // refresh() owns the run/event refresh sequence. Triggering the paginated
  // loaders here as well races the same requests and can replace a fresh
  // snapshot with an older response (especially when the user clicks twice).
  document.querySelectorAll('[data-refresh]').forEach(b=>b.addEventListener('click',()=>{void refresh();}));
  renderMarkets();renderStatus();renderEffectiveConfig();void refresh();
  const poll=window.setInterval(()=>void refreshRealtime(),1000);
  const slowPoll=window.setInterval(()=>void refreshSlow(),15000);
  // Public quotes and runtime status are independent from slower account/history
  // reads. Each endpoint has one in-flight read, so a slow endpoint cannot queue
  // stale snapshots or stall the other endpoint's next refresh.
  const tick=window.setInterval(()=>{renderMarkets();renderStatus();renderSystemMetrics(system.data,system.error);telemetry.render();},1000);
  return ()=>{closed=true;strategyConfig.close();strategyOrders.close();forms.close();accountData.close();trading.close();window.clearInterval(poll);window.clearInterval(slowPoll);window.clearInterval(tick);};
}
