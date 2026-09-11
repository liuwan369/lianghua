(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const set = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  const esc = value => String(value ?? '--').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const money = value => value == null ? '--' : (Number(value) >= 0 ? '+$' : '-$') + Math.abs(Number(value)).toFixed(2);
  const price = value => value != null && Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '--';
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
  let tradingLoading = false;
  let actionBusy = false;
  let actionError = null;
  let lastStatus = null;
  const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(55000) });

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
    // Ask sum describes immediate buying, not maker eligibility or inventory cost.
    set('strategyGate', '补仓成本上限 $' + cap.toFixed(3) + ' · 挂单由库存和盘口共同决定');
  }

  async function loadLive() {
    if (liveLoading) return;
    liveLoading = true;
    try {
      const response = await request('api/live', { cache: 'no-store' });
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
      renderBook(null);
      ['clob', 'binance', 'dataAge'].forEach(id => set(id, '不可用'));
      set('liveNote', '实时数据已断开，页面已清空旧价格。');
    } finally { liveLoading = false; }
  }

  function renderEvents(events) {
    const labels = { quote: '挂单尝试', fill: '成交', taker: '吃单', cancel: '撤单', stopped: '已停止', resolved: '结算', resolved_empty: '结算（无成交）' };
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
    lastStatus = status;
    const stats = status.stats || {};
    const account = status.account || {};
    const running = status.running === true;
    runningParams = running && status.params ? status.params : {};
    const fills = Number(stats.fills || 0), quotes = Number(stats.quotes || 0), cancels = Number(stats.cancels || 0);
    const spent = Number(stats.fill_notional || 0), pnl = stats.pnl == null ? null : Number(stats.pnl);
    const settled = Number(stats.settled_markets || 0), observed = Number(stats.markets || 0), traded = Number(stats.traded_markets || 0);
    set('systemBadge', running ? (status.mode === 'live' ? '实盘运行中' : '模拟运行中') : '安全模式');
    let accountLabel = '未配置资金账户';
    if (account.execution_credentials_ready) accountLabel = '签名已填写，请在“账户”完成检查';
    else if (account.session_signer_configured) accountLabel = 'Session Key 已配置（交易接入未放行）';
    else if (account.wallet_configured) accountLabel = '资金地址已核对（当前只能只读）';
    if (account.config_error) accountLabel = account.config_error;
    if (account.last_check?.compromised) accountLabel = '需更换安全账户（模拟可用）';
    else if (account.last_check?.account_ready) accountLabel = '账户检查通过 · 真钱成交待验收';
    set('overviewAccount', accountLabel);
    set('overviewParams', running ? '$' + Number(runningParams.pair_cost_max || 0.99).toFixed(3) + ' 配对上限 · $' + Number(runningParams.order_usd || 0).toFixed(2) + ' 每笔 · $' + Number(runningParams.max_total_usd || 0).toFixed(2) + ' 总上限' : '尚未启动，可在“配置”中修改');
    updateStartButton();
    if ($('overviewStop')) $('overviewStop').disabled = !running || actionBusy;
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
      else if (running) reason = '已启动，正在等待策略允许的挂单机会。';
      else if (fills) reason = settled ? '本次已成交，已结算部分见收益。' : '本次已成交但未结算，尚不能确认收益。';
      else if (quotes) reason = '本次有 ' + quotes + ' 次挂单尝试，但没有成交。';
      else reason = '尚无成交记录。启动后会显示挂单和成交；没有记录不能推断具体原因。';
    }
    if (stats.error) reason = '运行异常，请检查：' + stats.error;
    if (!actionBusy) set('actionResult', actionError || reason);
  }

  function updateStartButton() {
    const live = $('mode')?.value === 'live';
    set('overviewStart', live ? '开始真实交易' : '开始模拟');
    if ($('overviewStart')) $('overviewStart').disabled = actionBusy || !lastStatus || lastStatus.running || (live && !lastStatus.live_unlocked);
  }

  async function loadTrading() {
    if (tradingLoading) return;
    tradingLoading = true;
    try {
      const response = await request('api/trading/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      renderTrading(await response.json());
    } catch (_) {
      lastStatus = null;
      updateStartButton();
      set('systemBadge', '状态不可用');
      if (!actionBusy && !actionError) set('actionResult', '无法确认后台是否运行，请恢复连接后检查，勿重复启动。');
    } finally { tradingLoading = false; }
  }

  async function tradingAction(path) {
    if (actionBusy) return;
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
    if (!isStop && body.mode === 'live') {
      if (!lastStatus?.live_unlocked) { set('actionResult', '真实交易尚未解锁，请先完成账户检查和小额验收。'); return; }
      if (!window.confirm('将使用真钱交易：每笔最多 $' + body.order_usd + '，累计提交上限 $' + body.max_total_usd + '。确认启动？')) return;
      body.confirm_live = true;
    }
    actionBusy = true;
    actionError = null;
    updateStartButton();
    if ($('overviewStop')) $('overviewStop').disabled = true;
    set('actionResult', isStop ? '正在停止并核对撤单…' : '正在启动，请稍候…');
    try {
      const headers = { 'Content-Type': 'application/json' };
      const controlToken = $('controlToken')?.value.trim();
      if (controlToken) headers['X-PM-Control-Token'] = controlToken;
      const response = await request(path, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || String(response.status));
      actionBusy = false;
      renderTrading(data.status);
    } catch (error) {
      actionError = '操作未确认：' + error.message + '。请先查看后台状态，勿重复点击。';
      set('actionResult', actionError);
    } finally { actionBusy = false; updateStartButton(); await loadTrading(); }
  }

  function showAccountReport(report) {
    const rows = report?.checks || [];
    $('accountChecks').innerHTML = rows.map(item => '<div class="row"><span>' + esc(item.name) + '</span><b class="' + (item.ok ? 'good' : 'warn') + '">' + esc(item.detail) + '</b></div>').join('');
    if (report?.checked_at) set('accountResult', '检查时间：' + new Date(report.checked_at).toLocaleString('zh-CN') + '。' + (report.account_ready ? '账户条件通过；仍需实盘验收。' : '请处理下方未通过项。'));
  }

  async function loadAccount() {
    try {
      const response = await request('api/account/status', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!$('accountWallet').value) $('accountWallet').value = data.wallet || '';
      if (data.last_check) showAccountReport(data.last_check);
      else set('accountResult', data.config_error || '已读取账户配置，请点击“检查已保存账户”获取最新结果。');
    } catch (_) { set('accountResult', '账户状态不可用，请恢复连接后重试。'); }
  }

  async function accountAction(save) {
    if ($('accountSave').disabled) return;
    if (save && !window.isSecureContext) { set('accountResult', '请使用带登录保护的 HTTPS 页面。'); return; }
    if (save && !$('accountForm').reportValidity()) return;
    const body = save ? { wallet: $('accountWallet').value.trim(), owner_key: $('accountOwner').value.trim(), relayer_key: $('accountRelayer').value.trim(), relayer_address: $('accountRelayerAddress').value.trim(), builder_api_key: $('accountBuilderApiKey').value.trim(), builder_secret: $('accountBuilderSecret').value.trim(), builder_passphrase: $('accountBuilderPassphrase').value.trim() } : {};
    // Secrets are never placed in storage, URLs, or error messages.
    $('accountOwner').value = '';
    $('accountRelayer').value = '';
    $('accountBuilderApiKey').value = '';
    $('accountBuilderSecret').value = '';
    $('accountBuilderPassphrase').value = '';
    $('accountSave').disabled = $('accountCheck').disabled = true;
    set('accountResult', '正在核对账户、余额和授权，请稍候…');
    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = $('controlToken')?.value.trim();
      if (token) headers['X-PM-Control-Token'] = token;
      const response = await request('api/account/' + (save ? 'save' : 'check'), { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '检查失败');
      showAccountReport(data.report);
      if (save) set('accountResult', $('accountResult').textContent + ' 账户已保存；没有下单或广播授权。');
      await loadTrading();
    } catch (error) { set('accountResult', error.message + '；密码字段已清空。'); }
    finally { body.owner_key = body.relayer_key = body.builder_api_key = body.builder_secret = body.builder_passphrase = ''; $('accountSave').disabled = $('accountCheck').disabled = false; }
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
  $('mode')?.addEventListener('change', () => { updateStartButton(); set('actionResult', $('mode').value === 'live' ? '真实交易需账户检查通过并完成小额验收；未解锁时不能启动。' : '尚未启动。'); });
  $('accountForm')?.addEventListener('submit', event => { event.preventDefault(); accountAction(true); });
  $('accountCheck')?.addEventListener('click', () => accountAction(false));
  loadConfig();
  loadLive();
  loadTrading();
  loadAccount();
  setInterval(loadLive, 5000);
  setInterval(loadTrading, 3000);
})();
