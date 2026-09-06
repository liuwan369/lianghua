(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const set = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  const esc = value => String(value ?? '--').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const money = value => value == null ? '--' : (Number(value) >= 0 ? '+$' : '-$') + Math.abs(Number(value)).toFixed(2);
  const price = value => Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '--';
  const age = iso => {
    const time = Date.parse(iso || '');
    if (!Number.isFinite(time)) return '--';
    const seconds = Math.max(0, (Date.now() - time) / 1000);
    return seconds < 1 ? '<1秒' : seconds < 60 ? Math.round(seconds) + '秒前' : Math.round(seconds / 60) + '分钟前';
  };
  const sourceAge = (sources, name) => {
    const value = Number(sources?.[name]);
    if (!Number.isFinite(value)) return '无数据';
    const seconds = Math.max(0, Date.now() / 1000 - value);
    return seconds < 1 ? '<1秒' : seconds < 60 ? Math.round(seconds) + '秒前' : Math.round(seconds / 60) + '分钟前';
  };
  let latestLive = null;
  let runningParams = {};
  let liveLoading = false;

  function currentMarket(data) {
    return (data?.current_markets || []).slice().sort((a, b) => Number(a.end || Infinity) - Number(b.end || Infinity))[0];
  }

  function renderBook(data) {
    const market = currentMarket(data);
    if (!market) {
      set('currentMarket', '暂无可交易市场');
      ['upBook', 'downBook', 'askSum'].forEach(id => set(id, '--'));
      set('strategyGate', '暂无盘口，停止补仓');
      return;
    }
    set('currentMarket', market.slug || '--');
    set('upBook', price(market.up_bid) + ' / ' + price(market.up_ask));
    set('downBook', price(market.down_bid) + ' / ' + price(market.down_ask));
    set('askSum', market.ask_sum == null ? '--' : price(market.ask_sum));
    const cap = Number(runningParams.pair_cost_max ?? $('pairCostMax')?.value ?? 0.99);
    const eligible = market.ask_sum != null && Number(market.ask_sum) <= cap;
    set('strategyGate', eligible ? '符合本次成本上限 $' + cap.toFixed(3) : '超过本次成本上限 $' + cap.toFixed(3));
  }

  async function loadLive() {
    if (liveLoading) return;
    liveLoading = true;
    try {
      const response = await fetch('api/live', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      latestLive = data;
      const nodeLabel = data.node_label || '行情节点';
      set('nodeLabel', nodeLabel);
      set('clob', sourceAge(data.latest_by_source, 'clob'));
      set('binance', sourceAge(data.latest_by_source, 'binance'));
      set('dataAge', age(data.latest_event_at));
      set('liveNote', data.refreshing ? '正在读取' + nodeLabel + '行情…' : data.collector_online === true ? nodeLabel + '行情正常。' : '暂无实时数据。');
      renderBook(data);
    } catch (_) {
      latestLive = null;
      ['clob', 'binance', 'dataAge'].forEach(id => set(id, '不可用'));
      set('liveNote', '实时数据已断开，页面已清空旧价格。');
    } finally { liveLoading = false; }
  }

  function renderEvents(events) {
    const labels = { quote: '挂单尝试', fill: '成交', taker: '吃单', cancel: '撤单', resolved: '结算', resolved_empty: '结算（无成交）' };
    const rows = (events || []).filter(event => event.event !== 'reset').slice(-12).reverse();
    const html = rows.length ? rows.map(event => {
      const time = event.time ? new Date(Number(event.time) * 1000).toLocaleTimeString('zh-CN') : '--';
      const amount = event.amount == null ? '--' : '$' + Number(event.amount).toFixed(2);
      const pnl = event.event === 'resolved_empty' ? '无成交' : event.pnl == null ? '--' : money(event.pnl);
      return '<tr><td>' + esc(time) + '</td><td>' + esc(labels[event.event] || event.event) + '</td><td>' + esc(event.side || '--') + '</td><td class="num">' + price(event.price) + '</td><td class="num">' + (event.shares == null ? '--' : Number(event.shares).toFixed(2)) + '</td><td class="num">' + amount + '</td><td class="num">' + pnl + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">没有成交或订单记录</td></tr>';
    if ($('tradeEvents')) $('tradeEvents').innerHTML = html;
  }

  function renderHistory(items) {
    const rows = (items || []).filter(item => Number(item.fills || 0) > 0).slice(0, 50);
    const html = rows.length ? rows.map(item => '<tr><td title="' + esc(item.market) + '">' + esc(String(item.market || '').slice(0, 38)) + '</td><td class="num">' + Number(item.fills || 0) + '</td><td class="num">$' + Number(item.turnover || 0).toFixed(2) + '</td><td class="num">' + (item.pnl == null ? '未结算' : money(item.pnl)) + '</td><td>' + esc(item.status || '进行中') + '</td></tr>').join('') : '<tr><td colspan="5" class="muted">没有成交市场</td></tr>';
    if ($('historySummaries')) $('historySummaries').innerHTML = html;
  }

  function renderTrading(status) {
    const stats = status.stats || {};
    const running = status.running === true;
    runningParams = running && status.params ? status.params : {};
    const fills = Number(stats.fills || 0), quotes = Number(stats.quotes || 0), cancels = Number(stats.cancels || 0);
    const spent = Number(stats.fill_notional || 0), pnl = stats.pnl == null ? null : Number(stats.pnl);
    const settled = Number(stats.settled_markets || 0), observed = Number(stats.markets || 0), traded = Number(stats.traded_markets || 0);
    set('systemBadge', running ? (status.mode === 'live' ? '实盘运行中' : '模拟运行中') : '安全模式');
    set('overviewAccount', status.account_configured ? '已配置' : '未配置');
    set('overviewParams', running ? '$' + Number(runningParams.pair_cost_max || 0.99).toFixed(3) + ' 配对上限 · $' + Number(runningParams.order_usd || 0).toFixed(2) + ' 每笔 · $' + Number(runningParams.max_total_usd || 0).toFixed(2) + ' 总上限' : '尚未启动，可在“配置”中修改');
    if ($('overviewStart')) $('overviewStart').disabled = running;
    if ($('overviewStop')) $('overviewStop').disabled = !running;
    set('statFills', fills);
    set('statFillNote', fills ? '已有成交 · 观察 ' + observed + ' 场 · 实际成交 ' + traded + ' 场' : '观察 ' + observed + ' 场 · 实际成交 0 场');
    set('statTurnover', '$' + spent.toFixed(2));
    set('statOrders', quotes + ' / ' + cancels);
    set('statPnl', pnl == null ? '未结算' : money(pnl));
    set('statPnlNote', settled ? settled + ' 场已结算 · 手续费 $' + Number(stats.fees || 0).toFixed(4) : '尚未结算，模拟收益不含返佣奖励');
    renderEvents(stats.events);
    renderHistory(stats.market_summaries);
    if (latestLive) renderBook(latestLive);
    const stop = status.stop_result || {};
    let reason = stop.message;
    if (!reason) {
      if (running && fills) reason = '已产生成交，继续观察结算。';
      else if (running && quotes) reason = '已尝试挂单 ' + quotes + ' 次，撤单 ' + cancels + ' 次，暂未成交。';
      else if (running) reason = '模拟已启动，正在等待满足配对成本上限的盘口。';
      else if (fills) reason = '本次已产生成交，结算收益已记录。';
      else if (quotes) reason = '本次有 ' + quotes + ' 次挂单尝试，但没有成交。';
      else reason = '本次没有成交：没有出现满足成本上限的盘口。';
    }
    set('actionResult', reason);
  }

  async function loadTrading() {
    try {
      const response = await fetch('api/trading/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      renderTrading(await response.json());
    } catch (_) {
      set('systemBadge', '状态不可用');
      set('actionResult', '交易状态暂时不可用，请稍后重试。');
    }
  }

  async function tradingAction(path) {
    const isStop = path.endsWith('/stop');
    const body = isStop ? {} : {
      mode: $('mode')?.value || 'paper',
      pair_cost_max: Number($('pairCostMax')?.value || 0.99),
      order_usd: Number($('orderUsd')?.value || 2),
      max_total_usd: Number($('maxTotal')?.value || 10),
      max_orders: Number($('maxOrders')?.value || 50),
      duration_min: Number($('duration')?.value ?? 5),
      maker_life_sec: Number($('makerLife')?.value || 15),
      decision_interval_ms: Number($('decisionInterval')?.value || 0),
      defensive_cancel_bps: Number($('defensiveCancel')?.value || 0),
      confirm_live: false
    };
    set('actionResult', isStop ? '正在停止并撤单…' : '正在启动模拟…');
    try {
      const headers = { 'Content-Type': 'application/json' };
      const controlToken = $('controlToken')?.value.trim();
      if (controlToken) headers.Authorization = 'Bearer ' + controlToken;
      const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || String(response.status));
      set('actionResult', isStop ? '已停止，撤单已确认。' : '模拟交易已启动。');
      await loadTrading();
    } catch (error) { set('actionResult', '操作失败：' + error.message); }
  }

  const configKey = 'pm-dashboard-config-v1';
  const configIds = ['mode', 'pairCostMax', 'orderUsd', 'maxTotal', 'maxOrders', 'duration', 'makerLife', 'decisionInterval', 'defensiveCancel'];
  function loadConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(configKey) || '{}');
      configIds.forEach(id => { if (saved[id] !== undefined && $(id)) $(id).value = String(saved[id]); });
      if (saved.savedAt) set('settingsResult', '已恢复上次保存的配置（' + new Date(saved.savedAt).toLocaleString('zh-CN') + '）。');
    } catch (_) { set('settingsResult', '无法读取已保存配置，使用默认值。'); }
  }
  function saveConfig() {
    const saved = { savedAt: new Date().toISOString() };
    configIds.forEach(id => { if ($(id)) saved[id] = $(id).value; });
    try { localStorage.setItem(configKey, JSON.stringify(saved)); set('settingsResult', '配置已保存，下一次启动将使用这些参数。'); }
    catch (_) { set('settingsResult', '保存失败，请检查浏览器存储权限。'); }
  }

  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === button.dataset.view));
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-' + button.dataset.view));
  }));
  $('overviewStart')?.addEventListener('click', () => tradingAction('api/trading/start'));
  $('overviewStop')?.addEventListener('click', () => tradingAction('api/trading/stop'));
  $('saveSettings')?.addEventListener('click', saveConfig);
  $('mode')?.addEventListener('change', () => set('actionResult', $('mode').value === 'live' ? '真实交易需要服务器解锁和人工授权。' : '尚未启动。'));
  loadConfig();
  loadLive();
  loadTrading();
  setInterval(loadLive, 5000);
  setInterval(loadTrading, 3000);
})();
