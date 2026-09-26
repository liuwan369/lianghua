"use strict";
(() => {
  // src/auto-trade-block.ts
  var root = document.querySelector("#auto-trade-block-root");
  if (!root) throw new Error("auto trade block root missing");
  var store = window.PolyPreviewStore;
  var adapter = window.PolyPreviewAdapter;
  var vm = window.PolyPreviewViewModel;
  var marketAssets = store.getState().marketCatalog.items.map(function(item) {
    return { ...item, id: item.assetId };
  });
  var marketPool = store.getState().marketPool;
  var accountStatus = store.getState().accountStatus;
  var initialState = store.getState();
  var poolAssetId = initialState.marketPool.currentIds[0] || initialState.marketPool.desiredIds[0] || null;
  var selectedAssetId = [initialState.marketCatalog.selectedId, window.PolyPreview.config.selectedAssetId, poolAssetId]
    .find(function(id) { return id && initialState.marketCatalog.items.some(function(item) { return item.assetId === id; }); }) || null;
  var assetById = function(id) { return marketAssets.find(function(asset) { return asset.id === id; }); };
  var navItems = [
    ["\u25C8", "\u603B\u89C8", "overview.html"],
    ["\u25C7", "\u5E02\u573A", "market.html"],
    ["\u2197", "\u81EA\u52A8\u4EA4\u6613", "auto-trade.html"],
    ["\u25D2", "\u7B56\u7565", "strategy.html"],
    ["\u2699", "\u8BBE\u7F6E", "settings.html"]
  ];
  var navMarkup = navItems.map(([icon, label, target]) => `<button class="nav-item${label === "\u81EA\u52A8\u4EA4\u6613" ? " active" : ""}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === "\u81EA\u52A8\u4EA4\u6613" ? ' aria-current="page"' : ""}><span>${icon}</span>${label}</button>`).join("");
  root.innerHTML = `
  <div class="overview-preview auto-trade-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand">
        <span class="brand-mark">P</span>
        <div><strong>POLYMARKET</strong><small>交易控制台</small></div>
      </div>
      <div class="brand-card">
        <span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span>
        <strong>Polymarket</strong>
      </div>
      <p class="sidebar-copy">\u9762\u5411 平台支持加密货币 \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565\u7684\u5B9E\u65F6\u4EA4\u6613\u63A7\u5236\u53F0\u3002</p>
      <nav aria-label="\u81EA\u52A8\u4EA4\u6613\u9884\u89C8\u5BFC\u822A">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span data-sidebar-state>服务器数据</span><small data-sidebar-detail>等待后端连接</small></div>
    </aside>

    <main class="preview-main auto-trade-main">
      <header class="preview-header trade-header">
        <div class="hero-copy">
          <p class="eyebrow">BTC 五分钟反转 · 实盘控制</p>
          <div class="hero-title-row"><h1>\u81EA\u52A8\u4EA4\u6613</h1><span class="language-chip">5 \u5206\u949F</span></div>
          <p class="subtitle">\u76D8\u53E3\u3001\u7B56\u7565\u5224\u65AD\u3001\u5F53\u524D\u6301\u4ED3\u548C\u8BA2\u5355\u72B6\u6001\u96C6\u4E2D\u67E5\u770B\uFF0C\u5B9E\u65F6\u6570\u636E\u5404\u81EA\u72EC\u7ACB\u66F4\u65B0\u3002</p>
          <div class="hero-actions">
            <button class="hero-button primary-action" type="button" data-action="start">\u542F\u52A8\u81EA\u52A8\u4EA4\u6613</button>
            <button class="hero-button" type="button" data-action="pause">\u6682\u505C\u65B0\u589E</button>
            <button class="hero-button exit-action" type="button" data-action="stop" title="提交停止请求；远端挂单撤销状态以服务器确认为准">\u8BF7\u6C42\u505C\u6B62</button>
          </div>
          <p class="control-feedback" data-control-feedback role="status" aria-live="polite">正在检查启动条件…</p>
        </div>
        <div class="trade-header-side">
           <span class="live-chip"><i></i><b data-live-status>后端未连接</b><small data-live-clock>--:--:--</small></span>
          <div class="header-status-grid">
            <article class="header-status"><span>\u5F53\u524D\u5E02\u573A</span><strong data-active-market>当前选中市场 / 五分钟 YES-NO</strong></article>
             <article class="header-status"><span>\u6570\u636E\u8FDE\u63A5</span><strong class="status-warning" data-connection-status>后端未连接 · 等待快照</strong></article>
            <article class="header-status"><span>\u4EA4\u6613\u6A21\u5F0F</span><strong>\u5B9E\u76D8 \xB7 \u5355\u7B56\u7565</strong></article>
             <article class="header-status"><span>\u8D26\u6237\u4F59\u989D</span><strong data-auto-account-available>-- USDC</strong></article>
          </div>
        </div>
      </header>

      <section class="latency-panel" aria-labelledby="latency-title">
        <div class="panel-heading compact-heading">
          <div><p class="eyebrow">\u6267\u884C\u5EF6\u8FDF</p><h2 id="latency-title">\u4EA4\u6613\u901F\u5EA6</h2></div>
          <div class="latency-heading-meta"><span class="sample-dot"></span><span>\u5F53\u524D\u8FD0\u884C p95</span><button type="button" class="quiet-button">\u67E5\u770B\u5168\u90E8\u5EF6\u8FDF</button></div>
        </div>
        <div class="latency-grid">
          <article class="latency-card"><span>\u884C\u60C5\u5230\u51B3\u7B56</span><strong><b data-latency="decision">--</b><em>ms</em></strong><small>\u5B9E\u65F6\u884C\u60C5\u5230\u7B56\u7565\u5224\u65AD\u5B8C\u6210</small></article>
          <article class="latency-card"><span>\u4E0B\u5355\u786E\u8BA4</span><strong><b data-latency="order">--</b><em>ms</em></strong><small>\u53D1\u51FA\u8BA2\u5355\u5230\u5E73\u53F0\u786E\u8BA4</small></article>
          <article class="latency-card"><span>\u64A4\u5355\u786E\u8BA4</span><strong><b data-latency="cancel">--</b><em>ms</em></strong><small>\u53D1\u51FA\u64A4\u5355\u5230\u5E73\u53F0\u786E\u8BA4\u64A4\u9500</small></article>
          <article class="latency-card latency-accent"><span>\u6574\u8F6E\u53CD\u5E94</span><strong><b data-latency="round">--</b><em>ms</em></strong><small>\u89E6\u53D1\u884C\u60C5\u6536\u5230\u5230\u8BA2\u5355\u786E\u8BA4</small></article>
        </div>
        <p class="latency-caption">\u5EF6\u8FDF\u53EA\u53CD\u6620\u4EE3\u7801\u94FE\u8DEF\uFF0C\u4E0D\u5305\u542B\u7B49\u5F85\u5BF9\u624B\u6210\u4EA4\u548C\u94FE\u4E0A\u786E\u8BA4\u3002\u65E0\u6837\u672C\u65F6\u663E\u793A --\u3002</p>
      </section>

      <section class="trade-panel market-pool-panel" aria-labelledby="market-pool-title">
        <div class="panel-heading">
          <div><p class="eyebrow">\u8FD0\u884C\u5E02\u573A</p><h2 id="market-pool-title">\u5F53\u524D\u8FD0\u884C\u6C60</h2></div>
          <div class="pool-actions">
            <label class="market-selector" data-market-selector-wrap><span>查看市场</span><select data-market-selector><option value="">等待市场目录</option></select></label>
            <a class="pool-link" href="market.html" data-manage-markets>\u7BA1\u7406\u5E02\u573A <span>↗</span></a>
          </div>
        </div>
        <div class="market-pool-row" data-market-pool-row></div>
        <p class="market-pool-note" data-market-pool-note>\u5F53\u524D\u573A\u6B21\u7EE7\u7EED\u8FD0\u884C\uFF0C\u5E02\u573A\u9875\u65B0\u542F\u7528\u7684\u5E01\u79CD\u4ECE\u4E0B\u4E00\u573A\u52A0\u5165\u3002</p>
      </section>

      <section class="trade-summary-grid" aria-label="\u5F53\u524D\u7B56\u7565\u6458\u8981">
        <article class="summary-card"><div class="summary-icon blue-icon">\u25F7</div><div><span>\u5F53\u524D\u573A\u6B21</span><strong data-round>待接入 · 当前场次</strong><small data-countdown>\u5F85\u63A5\u5165</small></div></article>
        <article class="summary-card"><div class="summary-icon violet-icon">\u21AF</div><div><span>\u5F53\u524D\u9636\u6BB5</span><strong data-stage>\u5F85\u63A5\u5165</strong><small>\u786E\u8BA4\u53CD\u8F6C <b data-confirmations>--</b> / -- \u6B21</small></div></article>
        <article class="summary-card"><div class="summary-icon amber-icon">\u2192</div><div><span>\u4E0B\u4E00\u7B14</span><strong data-next>\u7B49\u5F85\u4FE1\u53F7</strong><small data-strategy-revision>\u53C2\u6570\u7248\u672C\u5F85\u63A5\u5165</small></div></article>
           <article class="summary-card"><div class="summary-icon green-icon">\u2713</div><div><span>\u7B56\u7565\u72B6\u6001</span><strong data-strategy-status>策略配置待接入</strong><small>\u66F4\u65B0\u65F6\u95F4 <b data-status-age>--</b></small></div></article>
      </section>

      <section class="trade-main-grid">
        <article class="trade-panel orderbook-panel" aria-labelledby="orderbook-title">
          <div class="panel-heading">
            <div><p class="eyebrow">\u5B9E\u65F6\u76D8\u53E3</p><h2 id="orderbook-title">\u5F53\u524D\u76D8\u53E3</h2></div>
            <div class="book-live"><i></i><span data-book-live-state>\u5F85\u63A5\u5165</span><small data-book-age>--</small></div>
          </div>
          <div class="quote-strip">
            <div class="quote-box up-quote"><span><i></i>YES \u4E70\u4E00 / \u5356\u4E00</span><strong><b data-quote="yes-bid">--</b><em>/</em><b data-quote="yes-ask">--</b></strong></div>
            <div class="quote-box down-quote"><span><i></i>NO \u4E70\u4E00 / \u5356\u4E00</span><strong><b data-quote="no-bid">--</b><em>/</em><b data-quote="no-ask">--</b></strong></div>
          </div>
          <div class="depth-toolbar"><div><strong>\u4E94\u6863\u6DF1\u5EA6</strong><span data-depth-availability>\u7B49\u5F85\u6DF1\u5EA6\u6570\u636E</span></div><span class="depth-source" data-book-source>\u7B49\u5F85\u5B9E\u65F6\u5FEB\u7167</span></div>
          <div class="depth-columns">
            <section class="depth-book up-depth" aria-label="YES \u4E94\u6863\u6DF1\u5EA6">
              <div class="depth-book-title"><span class="direction-dot up-dot"></span><strong>YES</strong><small>\u4E70\u5165\u65B9\u5411</small></div>
              <table class="depth-table"><thead><tr><th>\u6863\u4F4D</th><th>\u4EF7\u683C</th><th>\u6570\u91CF</th><th>\u6DF1\u5EA6</th></tr></thead><tbody data-depth="up"></tbody></table>
              <div class="depth-divider"><span>\u5356\u51FA</span><span>---</span></div>
              <table class="depth-table asks"><tbody data-depth-asks="up"></tbody></table>
            </section>
            <section class="depth-book down-depth" aria-label="NO \u4E94\u6863\u6DF1\u5EA6">
              <div class="depth-book-title"><span class="direction-dot down-dot"></span><strong>NO</strong><small>\u5356\u51FA\u65B9\u5411</small></div>
              <table class="depth-table"><thead><tr><th>\u6863\u4F4D</th><th>\u4EF7\u683C</th><th>\u6570\u91CF</th><th>\u6DF1\u5EA6</th></tr></thead><tbody data-depth="down"></tbody></table>
              <div class="depth-divider"><span>\u5356\u51FA</span><span>---</span></div>
              <table class="depth-table asks"><tbody data-depth-asks="down"></tbody></table>
            </section>
          </div>
          <div class="book-decision"><span class="decision-mark">\u21AF</span><div><span>\u4EA4\u6613\u5224\u65AD</span><strong data-decision>\u7B49\u5F85\u786E\u8BA4\uFF0C\u4E0D\u4E0B\u5355</strong><small data-decision-reason>\u53CD\u8F6C\u4FE1\u53F7\u9700\u8981\u8FDE\u7EED\u786E\u8BA4\uFF0C\u5F53\u524D\u76D8\u53E3\u4EC5\u7528\u4E8E\u89C2\u5BDF\u3002</small></div><b class="decision-state" data-decision-state>\u89C2\u5BDF\u4E2D</b></div>
        </article>

        <article class="trade-panel position-panel" aria-labelledby="position-title">
          <div class="panel-heading">
            <div><p class="eyebrow">\u672C\u573A\u7ED3\u679C</p><h2 id="position-title">\u672C\u573A\u6301\u4ED3\u4E0E\u7ED3\u679C</h2></div>
            <span class="panel-meta" data-round-identity>\u5F53\u524D\u573A\u6B21 \xB7 \u7B49\u5F85\u8F6E\u6B21\u6807\u8BC6</span>
          </div>
          <div class="position-hero"><div><span>\u672C\u573A\u51C0\u6295\u5165</span><strong data-invested>-- <em>USDC</em></strong></div><span class="position-badge" data-position-state>\u5F85\u63A5\u5165</span></div>
          <div class="holding-grid">
            <div class="holding-item up-holding"><span>YES \u4EFD\u989D</span><strong data-holding="up">--</strong><small>\u5747\u4EF7 <b data-average="up">--</b></small></div>
            <div class="holding-item down-holding"><span>NO \u4EFD\u989D</span><strong data-holding="down">--</strong><small>\u5747\u4EF7 <b data-average="down">--</b></small></div>
          </div>
          <div class="result-grid"><div><span>\u5DF2\u4E70\u5165 / \u8BA2\u5355\u5360\u7528</span><strong><b data-bought>--</b> / <b data-occupied>--</b> USDC</strong></div><div><span>YES \u80DC / NO \u80DC\u9884\u8BA1\u7ED3\u679C</span><strong class="result-values"><b data-outcome="up">--</b><em>/</em><b data-outcome="down">--</b> USDC</strong></div><div><span>\u5168\u90E8\u6301\u4ED3\u5747\u4EF7</span><strong><b data-average-total>--</b></strong></div></div>
          <div class="stage-section">
            <div class="stage-heading"><div><span>\u9636\u6BB5\u8FDB\u5EA6</span><small>\u9636\u6BB5\u72B6\u6001\u5F52\u5165\u672C\u573A\u7ED3\u679C</small></div><b data-stage-progress>--</b></div>
            <div class="stage-track"><i data-progress-fill></i></div>
            <ol class="stage-timeline" data-stage-timeline><li class="current"><span>·</span><div><strong>\u573A\u6B21\u548C\u7B56\u7565\u9636\u6BB5\u5F85\u63A5\u5165</strong><small>\u540E\u7AEF\u8FD4\u56DE\u5E02\u573A\u548C\u8F6E\u6B21\u8EAB\u4EFD\u540E\u663E\u793A\u5B9E\u65F6\u8FDB\u5EA6</small></div><time>--</time></li></ol>
          </div>
          <p class="result-note"><span class="info-dot">i</span>\u9884\u8BA1\u7ED3\u679C\u6309\u5DF2\u6210\u4EA4\u4EFD\u989D\u548C\u5B9E\u9645\u6210\u672C\u8BA1\u7B97\uFF0C\u6700\u7EC8\u4EE5\u5B98\u65B9\u7ED3\u679C\u548C\u5230\u8D26\u4E3A\u51C6\u3002</p>
          <p class="result-note settlement-note"><span class="info-dot">!</span><span>结算状态：<b data-settlement-state>等待本场结算记录</b><small data-settlement-detail>成交、结算和到账状态由服务器账本确认。</small></span></p>
        </article>
      </section>

      <section class="orders-panel trade-panel" aria-labelledby="orders-title">
        <div class="panel-heading">
          <div><p class="eyebrow">\u8BA2\u5355\u72B6\u6001</p><h2 id="orders-title">\u5F53\u524D\u8FD0\u884C\u8BA2\u5355</h2></div>
          <div class="orders-meta"><span class="panel-meta" data-orders-state>等待当前场次数据</span><span class="orders-count"><b data-order-count>--</b> \u4E2A\u8BA2\u5355</span><span class="panel-meta" data-fill-summary>成交回报 --</span><button type="button" class="quiet-button">\u67E5\u770B\u5168\u90E8</button></div>
        </div>
        <div class="orders-table-wrap"><table class="orders-table"><thead><tr><th>\u65F6\u95F4</th><th>\u65B9\u5411</th><th>\u4EF7\u683C</th><th>\u6570\u91CF</th><th>已成交份额</th><th>\u72B6\u6001</th></tr></thead><tbody><tr><td colspan="6">\u5F53\u524D\u573A\u6B21\u8BA2\u5355\u7B49\u5F85\u540E\u7AEF\u8FD4\u56DE</td></tr></tbody></table></div>
      </section>

      <section class="activity-panel trade-panel" aria-labelledby="activity-title">
        <div class="panel-heading"><div><p class="eyebrow">\u6700\u8FD1\u4E8B\u4EF6</p><h2 id="activity-title">\u8FD0\u884C\u65E5\u5FD7</h2></div><span class="panel-meta" data-activity-state>\u5F53\u524D\u8FD0\u884C\u4E8B\u4EF6</span></div>
        <ol class="activity-list" data-activity-list aria-live="polite"><li><time>--</time><span class="activity-icon info-icon">i</span><div><strong>\u7B49\u5F85\u540E\u7AEF\u8FD4\u56DE\u8FD0\u884C\u4E8B\u4EF6</strong><small>\u5B9E\u65F6\u4E8B\u4EF6\u5C06\u6309\u5F53\u524D\u5E02\u573A\u548C\u8F6E\u6B21\u8FFD\u52A0</small></div><b class="activity-tag info-tag">\u5F85\u63A5\u5165</b></li></ol>
      </section>
    </main>
  </div>
`;
  var text = (selector, value) => {
    const node = document.querySelector(selector);
    if (node && node.textContent !== String(value)) node.textContent = value;
  };
  var html = function(node, value) { if (node && node.innerHTML !== value) node.innerHTML = value; };
  var identityKey = function(context) { return JSON.stringify([context.assetId, context.marketId, context.roundId]); };
  var numeric = function(value) { return value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null; };
  var shortIdentity = function(value) {
    var raw = String(value ?? "");
    return /^0x[\da-f]{32,}$/i.test(raw) ? `${raw.slice(0, 10)}…${raw.slice(-4)}` : raw.length > 22 ? `${raw.slice(0, 10)}…${raw.slice(-5)}` : raw;
  };
  var displayRound = function(value) {
    var raw = String(value ?? "");
    var stamp = /^\d{10,13}$/.test(raw) ? Number(raw) * (raw.length === 10 ? 1000 : 1) : NaN;
    if (!Number.isFinite(stamp)) return shortIdentity(raw);
    var date = new Date(stamp);
    if (!Number.isFinite(date.getTime())) return shortIdentity(raw);
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date).replaceAll("/", "-");
  };
  var fullIdentity = function(context) {
    return `${context.assetId || "未知币种"} · marketId ${context.marketId || "待提供"} · roundId ${context.roundId || "待提供"}`;
  };
  var displayIdentity = function(context) {
    var asset = String(context.assetId || "未知币种").toUpperCase();
    var market = context.marketId ? shortIdentity(context.marketId) : "待确认";
    var round = context.roundId ? displayRound(context.roundId) : "待确认";
    return `${asset} · 市场 ${market} · 场次 ${round}`;
  };
  var eventLabels = {
    stopped: "交易进程已停止", platform_stopped: "交易进程已停止", started: "交易进程已启动", platform_started: "交易进程已启动",
    market_feed_unhealthy: "行情数据异常", transport_disconnected: "行情连接中断，正在等待恢复", stale_book: "行情盘口已过期",
    incomplete_book: "行情深度不完整", connected_waiting_book: "行情已连接，等待盘口数据", complete_book: "盘口数据完整",
    fill: "订单成交", order: "订单状态更新", settlement: "本场结算状态更新", platform_error: "交易运行异常",
    error: "运行异常", unresolved: "结果待确认", order_acknowledged: "订单已确认", order_rejected: "订单未被接受",
    settlement_reconciliation_pending: "结算对账待处理", settlement_failed: "结算未完成", settlement_confirmed: "结算已确认",
    running: "运行中", paused: "已暂停", stopping: "正在停止", ready: "已就绪", degraded: "服务异常",
    unavailable: "暂不可用", stale: "数据已过期", unknown: "状态未知"
  };
  var orderLabels = {
    open: "等待成交", live: "等待成交", pending: "处理中", acknowledged: "平台已确认", partially_filled: "部分成交",
    filled: "已成交", matched: "已成交", cancelled: "已撤销", canceled: "已撤销", rejected: "未接受", failed: "失败",
    expired: "已过期", unknown: "状态未知", buy: "买入", sell: "卖出", yes: "YES", no: "NO", up: "YES", down: "NO"
  };
  var eventWords = {
    market: "市场", feed: "行情源", unhealthy: "异常", transport: "连接", disconnected: "中断", stale: "过期", book: "盘口",
    incomplete: "不完整", complete: "完整", connected: "已连接", waiting: "等待", order: "订单", fill: "成交", settlement: "结算",
    reconciliation: "对账", pending: "待处理", failed: "失败", error: "异常", stopped: "已停止", started: "已启动", running: "运行中",
    paused: "已暂停", stopping: "正在停止", rejected: "未接受", acknowledged: "已确认", confirmed: "已确认", unresolved: "待确认",
    retrying: "重试中", submit: "提交", result: "结果", platform: "交易进程", credentials: "账户凭据", missing: "缺失", mismatch: "不匹配",
    timeout: "超时", rpc: "区块链节点", unavailable: "暂不可用", unknown: "未知", strategy: "策略", decision: "判断", skipped: "已跳过", accepted: "已接受"
  };
  var eventText = function(value, fallback) {
    var raw = String(value ?? "").trim();
    if (!raw) return fallback;
    if (/market_feed_unhealthy/i.test(raw) && /transport_disconnected/i.test(raw)) return "行情连接中断，正在等待恢复";
    if (/market_feed_unhealthy/i.test(raw) && /stale_book/i.test(raw)) return "行情盘口已过期，暂不用于交易";
    if (/market_feed_unhealthy/i.test(raw) && /incomplete_book/i.test(raw)) return "行情深度不完整，暂不可交易";
    raw = raw.replace(/(?:0x[\da-f]{32,}|\b\d{30,}\b)/ig, "关联当前市场");
    var normalized = raw.toLowerCase();
    if (eventLabels[normalized]) return eventLabels[normalized];
    if (/^[a-z][a-z0-9_:\s-]*$/i.test(raw)) {
      var words = normalized.split(/[_:\s-]+/).filter(Boolean).map(function(word) { return eventWords[word]; });
      return words.length && words.every(Boolean) ? words.join(" · ") : fallback;
    }
    return /[\u3400-\u9fff]/.test(raw) ? raw : fallback;
  };
  var renderMarketSelector = function() {
    var selector = document.querySelector("[data-market-selector]");
    if (!selector) return;
    var selectorWrap = document.querySelector("[data-market-selector-wrap]");
    if (selectorWrap) selectorWrap.hidden = marketAssets.length < 2;
    html(selector, '<option value="">请选择市场</option>' + marketAssets.map(function(asset) { return `<option value="${window.PolyPreview.format.escape(asset.id)}" title="${window.PolyPreview.format.escape(asset.name)}">${window.PolyPreview.format.escape(asset.symbol)} · ${window.PolyPreview.format.escape(asset.cycle || "5分钟")}</option>`; }).join(""));
    selector.value = assetById(selectedAssetId) ? selectedAssetId : "";
    selector.disabled = marketAssets.length === 0;
  };
  var renderMarketPool = function() {
    renderMarketSelector();
    var enabledAssets = marketPool.desiredIds.map(assetById).filter(Boolean);
    var runningAssets = marketPool.currentIds.map(assetById).filter(Boolean);
    var visibleAssets = [...new Map([...runningAssets, ...enabledAssets].map((asset) => [asset.id, asset])).values()];
    var row = document.querySelector("[data-market-pool-row]");
    if (row) {
      html(row, visibleAssets.length ? visibleAssets.map(function(asset) {
        var running = marketPool.currentIds.includes(asset.id);
        var queued = marketPool.desiredIds.includes(asset.id);
        return `<div class="market-pool-chip ${running ? "running" : "queued"}"><span class="pool-coin-icon ${window.PolyPreview.format.escape(asset.tone)}">${window.PolyPreview.format.escape(asset.icon)}</span><div><strong>${window.PolyPreview.format.escape(asset.symbol)}</strong><small>${running && !queued ? "本场继续 · 下场停用" : running ? "运行中" : "已启用 · 待运行"}</small></div><b>5M</b></div>`;
      }).join("") : '<div class="market-pool-empty"><span>＋</span><strong>暂无启用币种</strong><small>前往市场启用五分钟加密货币。</small></div>');
    }
    var selected = assetById(selectedAssetId);
    var activeMarket = selected ? `${selected.symbol} / ${selected.cycle || "5分钟"} YES-NO` : "请选择市场";
    text("[data-active-market]", activeMarket);
    text("[data-market-pool-note]", marketPool.stale ? "运行池连接中断 · 保留服务器最近确认配置" : marketPool.pendingDesiredIds ? "变更已提交 · 等待服务器确认运行池" : visibleAssets.length ? "单实例运行一个资产；详情选择只切换查看内容，运行状态以服务器确认结果为准。" : "尚未启用币种；前往市场选择要加入自动交易的五分钟市场。");
  };
  var marketSelector = document.querySelector("[data-market-selector]");
  marketSelector?.addEventListener("change", function(event) {
    if (event.target.value && event.target.value !== selectedAssetId) store.setSelectedMarket(event.target.value);
  });
  var snapshotWatermarks = new Map();
  var snapshotExpiryTimer = null;
  var snapshotRefreshTimer = null;
  var snapshotRefreshInFlight = null;
  var marketContextRefreshTimer = null;
  var marketContextRefreshInFlight = null;
  var roundRefreshTimer = null;
  var roundRefreshInFlight = null;
  var runtimeRefreshTimer = null;
  var runtimeRefreshInFlight = null;
  var contextVersion = 0;
  var selectedRuntime = null;
  var globalProcessRunning = null;
  var commandPending = false;
  var commandCooldownUntil = 0;
  var commandCooldownAction = null;
  var commandCooldownContextKey = null;
  var currentMarketContextKey = null;
  var activeStreamContextKey = null;
  var activeStreamConfigKey = null;
  var lastSnapshotValid = false;
  var timestampMs = window.PolyPreview.format.timestampMs;
  var markSnapshotStale = function(message) {
    lastSnapshotValid = false;
    text("[data-book-source]", message || "行情已过期 · 保留最近快照");
    text("[data-book-live-state]", "已过期 · 保留快照");
  };
  var renderSnapshot = function(raw, fromStream, expectedContextKey) {
    raw = raw?.data && typeof raw.data === "object" ? raw.data : raw;
    if (!raw) return;
    var source = raw.market && typeof raw.market === "object" ? { ...raw, ...raw.market } : raw;
    var sequence = Number(source.sequence);
    var sourceAt = timestampMs(source.sourceAt ?? source.source_at);
    var expiresAt = timestampMs(source.expiresAt ?? source.expires_at);
    var now = Date.now();
    var model = vm.market(source);
    var marketId = model.marketId;
    var roundId = model.roundId;
    var context = currentContext();
    if (expectedContextKey != null && identityKey(context) !== expectedContextKey) return false;
    if (!vm.matchesIdentity(source, context)) { markSnapshotStale("盘口身份与所选资产不匹配 · 保留最近快照"); return false; }
    var book = source.book || source.orderBook || source.orderbook || model.orderBook || {};
    var bookSide = function(side) { return book[side] || book[side.toUpperCase()] || {}; };
    var hasFiveLevels = function(levels) {
      return Array.isArray(levels) && levels.length >= 5 && levels.slice(0, 5).every(function(level) {
        var price = Array.isArray(level) ? Number(level[0]) : Number(level?.price);
        var size = Array.isArray(level) ? Number(level[1]) : Number(level?.size ?? level?.quantity ?? level?.shares);
        return Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(size) && size > 0;
      });
    };
    var hasDepth = ["yes", "no"].every(function(side) {
      var sideBook = bookSide(side);
      var bids = sideBook.bids || sideBook.bid;
      var asks = sideBook.asks || sideBook.ask;
      return hasFiveLevels(bids) && hasFiveLevels(asks);
    });
    var depthPresent = !model.depthUnavailable && hasDepth;
    var watermarkKey = identityKey(context);
    var previousSequence = snapshotWatermarks.get(watermarkKey);
    var valid = Boolean(marketId && roundId) && vm.hasFreshBbo(source, now) && source.stale !== true && raw.stale !== true
      && (previousSequence == null || sequence >= previousSequence);
    if (!valid) {
      markSnapshotStale(raw.stale === true || source.stale === true ? "行情源报告数据过期 · 保留最近快照" : !vm.hasFreshBbo(source, now) ? "买卖报价已过期或未接入 · 保留最近快照" : "行情序列落后 · 保留最近快照");
      return false;
    }
    if (sequence === previousSequence && lastSnapshotValid) return true;
    lastSnapshotValid = true;
    snapshotWatermarks.set(watermarkKey, sequence);
    if (snapshotExpiryTimer) window.clearTimeout(snapshotExpiryTimer);
    snapshotExpiryTimer = window.setTimeout(function() {
      markSnapshotStale("行情快照已过期 · 保留最近快照");
    }, Math.max(0, expiresAt - Date.now()));
    var quote = function(key, value) { text(`[data-quote="${key}"]`, Number.isFinite(value) ? value.toFixed(3) : "--"); };
    quote("yes-bid", model.yesBid); quote("yes-ask", model.yesAsk); quote("no-bid", model.noBid); quote("no-ask", model.noAsk);
    var levels = function(side, kind) {
      var source = bookSide(side);
      var list = Array.isArray(source) ? source : source[kind] || source[`${kind}s`] || [];
      return Array.isArray(list) ? list.map(function(level) { return Array.isArray(level) ? { price: Number(level[0]), size: Number(level[1]) } : { price: Number(level.price), size: Number(level.size ?? level.quantity ?? level.shares) }; }).filter(function(level) { return Number.isFinite(level.price) && Number.isFinite(level.size); }) : [];
    };
    ["yes", "no"].forEach(function(side) {
      var bids = levels(side, "bid"); var asks = levels(side, "ask");
      var render = function(node, list, tone) {
        if (!node) return;
        if (!depthPresent || list.length < 5) {
          node.innerHTML = '<tr><td colspan="4" class="depth-unavailable">深度暂不可用</td></tr>';
          return;
        }
        if (node.rows.length !== 5) node.innerHTML = Array.from({ length: 5 }, function(_, index) { return `<tr><td>${index + 1}</td><td class="depth-price ${tone}">--</td><td>--</td><td><span class="depth-bar ${tone}" style="--depth:0%"></span></td></tr>`; }).join("");
        var maximum = Math.max(1, ...list.slice(0, 5).map(function(level) { return level.size; }));
        Array.from(node.rows).forEach(function(row, index) {
          var level = list[index];
          var price = level ? level.price.toFixed(3) : "--";
          var size = level ? level.size.toFixed(1) : "--";
          if (row.cells[1].textContent !== price) row.cells[1].textContent = price;
          if (row.cells[2].textContent !== size) row.cells[2].textContent = size;
          var bar = row.cells[3].firstElementChild;
          var depth = `${level ? Math.min(100, Math.max(0, level.size / maximum * 100)) : 0}%`;
          if (bar.style.getPropertyValue("--depth") !== depth) bar.style.setProperty("--depth", depth);
        });
      };
      var domSide = side === "yes" ? "up" : "down";
      var bidNode = document.querySelector(`[data-depth="${domSide}"]`); var askNode = document.querySelector(`[data-depth-asks="${domSide}"]`);
      render(bidNode, bids, "bid");
      render(askNode, asks, "ask");
    });
    text("[data-book-source]", `${fromStream ? "实时行情" : "后端快照"} · ${window.PolyPreview.format.time(sourceAt)}`);
    text("[data-book-live-state]", fromStream ? "实时行情 · 已连接" : "后端快照 · 已更新");
    text("[data-depth-availability]", depthPresent ? "五档深度 · 已接入" : "BBO 已更新 · 深度暂不可用");
    text("[data-book-age]", window.PolyPreview.format.time(sourceAt));
    return true;
  };
  var streams = [];
  var currentContext = function() {
    var asset = assetById(selectedAssetId);
    return asset ? { assetId: asset.id, marketId: asset.marketId, roundId: asset.roundId } : { assetId: null, marketId: null, roundId: null };
  };
  var eventContext = function() {
    var context = currentContext();
    var runtime = selectedRuntime || window.PolyPreviewStore.getState().runtime || {};
    var runId = runtime.runId ?? runtime.run_id;
    return runId ? { assetId: context.assetId, runId: String(runId) } : context;
  };
  var ledgerContext = function() {
    var context = currentContext();
    var runtime = selectedRuntime || window.PolyPreviewStore.getState().runtime || {};
    var runId = runtime.runId ?? runtime.run_id;
    return runId ? { ...context, runId: String(runId) } : context;
  };
  var payloadOf = function(frame) { return frame?.data && typeof frame.data === "object" ? frame.data : frame?.payload && typeof frame.payload === "object" ? frame.payload : frame || {}; };
  var frameMatches = function(frame, requireRound) {
    var context = currentContext();
    var payload = payloadOf(frame);
    var snapshot = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot : {};
    var marketId = snapshot.marketId ?? snapshot.market_id ?? payload.marketId ?? payload.market_id ?? frame?.marketId ?? frame?.market_id;
    var roundId = snapshot.roundId ?? snapshot.round_id ?? payload.roundId ?? payload.round_id ?? frame?.roundId ?? frame?.round_id;
    var assetId = snapshot.assetId ?? snapshot.asset_id ?? payload.assetId ?? payload.asset_id ?? frame?.assetId ?? frame?.asset_id;
    if (!requireRound && !marketId && !roundId && !assetId) return true;
    if (!context.assetId || !context.marketId || !context.roundId || !marketId || !roundId || !assetId) return false;
    return String(assetId) === String(context.assetId) && String(marketId) === String(context.marketId) && String(roundId) === String(context.roundId);
  };
  var streamUrl = function(name) {
    var configured = window.PolyPreview.config.streams?.[name];
    return typeof configured === "string" ? configured : configured?.url || null;
  };
  var streamConfigKey = function() { return ["markets", "runtime", "orders"].map(function(name) { return `${name}:${streamUrl(name) || ""}`; }).join("|"); };
  var markStreamPending = function() {
    if (!lastSnapshotValid) text("[data-book-live-state]", "等待后端行情快照");
  };
  var resetRoundPanels = function() {
    if (snapshotExpiryTimer) window.clearTimeout(snapshotExpiryTimer);
    snapshotExpiryTimer = null;
    snapshotWatermarks.clear();
    markSnapshotStale("所选市场已切换 · 等待对应场次快照");
    ["yes-bid", "yes-ask", "no-bid", "no-ask"].forEach(function(key) { text(`[data-quote="${key}"]`, "--"); });
    document.querySelectorAll("[data-depth], [data-depth-asks]").forEach(function(node) { node.innerHTML = ""; });
    text("[data-book-age]", "--");
    text("[data-strategy-status]", "所选市场状态待接入");
    text("[data-status-age]", "--");
    text("[data-position-state]", "读取中");
    text("[data-settlement-state]", "等待本场结算记录");
    text("[data-settlement-detail]", "成交、结算和到账状态由服务器账本确认。");
    text("[data-orders-state]", "读取中");
    text("[data-fill-summary]", "成交回报 --");
    text("[data-activity-state]", "正在读取新场次事件");
    text("[data-live-status]", "所选市场状态待接入");
    text("[data-invested]", "--");
    text('[data-holding="up"]', "--");
    text('[data-holding="down"]', "--");
    text('[data-average="up"]', "--");
    text('[data-average="down"]', "--");
    text("[data-average-total]", "--");
    text("[data-stage]", "待接入");
    text("[data-confirmations]", "--");
    text("[data-stage-progress]", "--");
    text("[data-order-count]", "--");
    ["[data-bought]", "[data-occupied]", '[data-outcome="up"]', '[data-outcome="down"]'].forEach(function(selector) { text(selector, "--"); });
    var body = document.querySelector(".orders-table tbody");
    if (body) body.innerHTML = '<tr><td colspan="6">正在读取新场次持仓和订单</td></tr>';
    var timeline = document.querySelector("[data-stage-timeline]");
    if (timeline) timeline.innerHTML = '<li class="current"><span>·</span><div><strong>新场次数据读取中</strong><small>等待后端返回本场持仓和策略阶段</small></div><time>--</time></li>';
    var activityList = document.querySelector("[data-activity-list]");
    if (activityList) activityList.innerHTML = '<li><time>--</time><span class="activity-icon info-icon">i</span><div><strong>新场次事件读取中</strong><small>等待后端返回本场运行事件</small></div><b class="activity-tag info-tag">读取中</b></li>';
  };
  var itemMatchesContext = function(item, asset) {
    return vm.matchesIdentity(item, { assetId: asset?.id, marketId: asset?.marketId, roundId: asset?.roundId });
  };
  var syncMarketContext = function() {
    var context = currentContext();
    var contextKey = identityKey(context);
    if (contextKey === currentMarketContextKey) return contextKey;
    currentMarketContextKey = contextKey;
    contextVersion += 1;
    selectedRuntime = null;
    resetRoundPanels();
    var identityNode = document.querySelector("[data-round-identity]");
    if (identityNode) {
      identityNode.textContent = context.assetId && context.roundId ? displayIdentity(context) : "等待场次信息";
      identityNode.title = fullIdentity(context);
    }
    text("[data-round]", context.roundId ? displayRound(context.roundId) : "等待场次信息");
    return contextKey;
  };
  var renderPosition = function(raw) {
    raw = raw?.data && typeof raw.data === "object" ? raw.data : raw;
    var position = raw?.position || raw;
    if (!position || !vm.matchesIdentity(position, currentContext()) || raw?.stale || raw?.error || raw?.available === false || position.stale || position.available === false || position.error) {
      var positionReason = window.PolyPreview.format.readableError(raw?.error || position?.error, "持仓数据尚未确认");
      text("[data-position-state]", `${positionReason} · 保留本场最近成功数据`);
      return false;
    }
    var number = function(...keys) { for (var key of keys) { var value = numeric(position[key]); if (value != null) return value; } return null; };
    var occupied = number("occupiedUsd", "occupied_usd");
    var bought = number("boughtUsd", "bought_usd", "filledUsd", "filled_usd", "purchasedUsd", "purchased_usd");
    var outcome = position.outcomePnl && typeof position.outcomePnl === "object" ? position.outcomePnl : position.outcome_pnl && typeof position.outcome_pnl === "object" ? position.outcome_pnl : {};
    var yesOutcome = numeric(outcome.yes ?? outcome.up ?? position.yesOutcomePnl ?? position.yes_outcome_pnl);
    var noOutcome = numeric(outcome.no ?? outcome.down ?? position.noOutcomePnl ?? position.no_outcome_pnl);
    text("[data-bought]", bought == null ? "--" : bought.toFixed(2));
    text("[data-occupied]", occupied == null ? "--" : occupied.toFixed(2));
    text('[data-outcome="up"]', yesOutcome == null ? "--" : yesOutcome.toFixed(2));
    text('[data-outcome="down"]', noOutcome == null ? "--" : noOutcome.toFixed(2));
    text("[data-invested]", occupied != null ? `${occupied.toFixed(2)} USDC` : "-- USDC");
    text("[data-stage]", position.stage != null ? `阶段 ${position.stage}` : "--");
    text("[data-confirmations]", position.confirmations == null ? "--" : String(position.confirmations));
    var yesShares = number("yesShares", "yes_shares"); var noShares = number("noShares", "no_shares");
    text('[data-holding="up"]', yesShares == null ? "--" : yesShares.toFixed(2));
    text('[data-holding="down"]', noShares == null ? "--" : noShares.toFixed(2));
    var averageValue = position.averagePrice;
    var average = averageValue && typeof averageValue === "object" ? averageValue : {};
    var totalAverage = numeric(averageValue);
    var yesAverage = numeric(average.yes ?? average.up ?? position.yesAveragePrice ?? position.yes_average_price);
    var noAverage = numeric(average.no ?? average.down ?? position.noAveragePrice ?? position.no_average_price);
    // The ledger currently returns a weighted total average as a scalar. Only
    // assign it to one side when the other side is explicitly empty.
    if (totalAverage != null) {
      if (yesAverage == null && noAverage == null && yesShares != null && noShares != null) {
        if (yesShares > 0 && noShares === 0) yesAverage = totalAverage;
        if (noShares > 0 && yesShares === 0) noAverage = totalAverage;
      }
      text("[data-average-total]", totalAverage.toFixed(3));
    } else {
      text("[data-average-total]", "--");
    }
    text('[data-average="up"]', yesAverage == null ? "--" : yesAverage.toFixed(3));
    text('[data-average="down"]', noAverage == null ? "--" : noAverage.toFixed(3));
    var progress = numeric(position.stageProgress ?? position.stage_progress);
    text("[data-stage-progress]", progress == null ? "--" : `${progress}%`);
    text("[data-position-state]", `已更新 · ${window.PolyPreview.format.time(position.updatedAt ?? raw.asOf)}`);
    return true;
  };
  var renderOrders = function(raw, asset) {
    raw = raw?.data && typeof raw.data === "object" ? raw.data : raw;
    var orders = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.orders) ? raw.orders : Array.isArray(raw) ? raw : null;
    var mismatched = orders && asset && orders.some(function(order) {
      var hasIdentity = ["assetId", "asset_id", "marketId", "market_id", "roundId", "round_id"].some(function(key) { return order[key] != null && String(order[key]) !== ""; });
      return hasIdentity && !itemMatchesContext(order, asset);
    });
    if (!orders || !asset || raw?.stale || raw?.error || raw?.available === false || mismatched) {
      var orderReason = window.PolyPreview.format.readableError(raw?.error, "订单数据尚未确认");
      text("[data-orders-state]", `${orderReason} · 保留本场最近成功数据`);
      return false;
    }
    // Empty pages are valid for this scoped REST request; non-empty rows must all identify this asset and round.
    if (!Array.isArray(raw) && ["assetId", "marketId", "roundId"].some(function(key) { return raw[key] != null && String(raw[key]) !== String(currentContext()[key]); })) {
      text("[data-orders-state]", "订单身份不匹配 · 保留本场最近成功数据");
      return false;
    }
    var body = document.querySelector(".orders-table tbody");
    if (!body) return;
    text("[data-order-count]", String(numeric(raw.total) ?? orders.length));
    html(body, orders.length ? orders.slice(0, 20).map(function(order) {
      var side = order.side || order.outcome || order.token || "--";
      var sideText = orderLabels[String(side).toLowerCase()] || (/^0x[\da-f]{24,}$/i.test(String(side)) ? "YES / NO" : "--");
      var status = orderLabels[String(order.status || "unknown").toLowerCase()] || "状态待确认";
      var price = numeric(order.price); var size = numeric(order.size ?? order.quantity ?? order.shares); var filled = numeric(order.filledShares ?? order.filled_shares ?? order.filled ?? order.filledSize ?? order.filled_size);
      return `<tr><td>${window.PolyPreview.format.time(order.updatedAt || order.createdAt || order.time)}</td><td>${window.PolyPreview.format.escape(sideText)}</td><td>${Number.isFinite(price) ? price.toFixed(3) : "--"}</td><td>${Number.isFinite(size) ? size.toFixed(2) : "--"}</td><td>${Number.isFinite(filled) ? filled.toFixed(2) : "--"}</td><td>${window.PolyPreview.format.escape(status)}</td></tr>`;
    }).join("") : '<tr><td colspan="6">当前场次暂无订单</td></tr>');
    text("[data-orders-state]", `已更新 · ${window.PolyPreview.format.time(raw.asOf)}`);
    return true;
  };
  var renderFills = function(raw, asset) {
    var resource = raw || {};
    var payload = resource?.data && typeof resource.data === "object" ? resource.data : resource;
    var fills = Array.isArray(resource?.items) ? resource.items : Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.fills) ? payload.fills : Array.isArray(payload) ? payload : null;
    if (!fills || resource?.stale || resource?.status !== "ready" || payload?.stale || payload?.error || payload?.available === false) {
      text("[data-fill-summary]", "成交回报待确认");
      return false;
    }
    var scoped = fills.filter(function(fill) {
      return !asset || !["assetId", "asset_id", "marketId", "market_id", "roundId", "round_id"].some(function(key) { return fill[key] != null && String(fill[key]) !== ""; }) || itemMatchesContext(fill, asset);
    });
    var confirmed = scoped.filter(function(fill) { return String(fill.tradeStatus || fill.trade_status || fill.status || "").toUpperCase() !== "FAILED"; });
    text("[data-fill-summary]", `成交回报 ${confirmed.length} 条`);
    return true;
  };
  var renderSettlements = function(raw) {
    var resource = raw || {};
    var payload = resource?.data && typeof resource.data === "object" ? resource.data : resource;
    var items = Array.isArray(resource?.items) ? resource.items : Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.settlements) ? payload.settlements : Array.isArray(payload) ? payload : null;
    var context = currentContext();
    var stateNode = document.querySelector("[data-settlement-state]");
    var detailNode = document.querySelector("[data-settlement-detail]");
    var set = function(state, detail) { if (stateNode) stateNode.textContent = state; if (detailNode) detailNode.textContent = detail; };
    if (!items || resource?.stale || resource?.status !== "ready" || payload?.stale || payload?.error || payload?.available === false) {
      set("结算记录待确认", window.PolyPreview.format.readableError(resource?.error || payload?.error, "账本连接中断，保留最近结算状态"));
      return false;
    }
    var scoped = items.filter(function(item) { return vm.matchesIdentity(item, context); });
    if (!scoped.length) { set("本场暂无结算记录", "场次尚未结束，或账本尚未收到本场结算回执。"); return true; }
    var item = scoped[0];
    var state = String(item.state || item.status || "unknown").toLowerCase();
    var payoutVerified = item.payoutVerified ?? item.payout_verified;
    var noTrade = item.noTrade ?? item.no_trade;
    var accounting = String(item.accountingState || item.accounting_state || "").toLowerCase();
    var settlementRequired = item.settlementRequired ?? item.settlement_required;
    var redemptionRequired = item.redemptionRequired ?? item.redemption_required;
    noTrade = noTrade === true || settlementRequired === false || redemptionRequired === false || accounting === "no_trade";
    var pnlError = item.pnlError || item.pnl_error;
    var label = noTrade === true
      ? (state === "confirmed" ? "无成交 · 无需赎回" : "无成交 · 等待结算确认")
      : state === "confirmed" && payoutVerified === true ? "结算已确认 · 到账已核实"
        : state === "confirmed" ? "结算已确认 · 到账待核实" : state === "failed" ? "结算失败" : "结算处理中";
    var details = [];
    var accountingLabels = { no_trade: "无成交，无需赎回", cost_basis_unverified: "成交成本尚未核实", payout_unverified: "到账尚未核实", verified: "账本已核实", pending: "账本待处理" };
    if (accounting && !noTrade) details.push(accountingLabels[accounting] || `账本：${accounting}`);
    if (pnlError) details.push(window.PolyPreview.format.readableError(pnlError, "盈亏暂不可核对"));
    var pnl = numeric(item.pnl);
    if (pnl != null) details.push(`净盈亏 ${pnl.toFixed(2)} USDC`);
    set(label, details.join(" · ") || "服务器已返回本场结算状态。");
    return true;
  };
  var renderEvents = function(raw) {
    var resource = raw || {};
    var payload = resource?.data && typeof resource.data === "object" ? resource.data : resource;
    var context = currentContext();
    var runId = payload?.runId ?? payload?.run_id ?? resource?.runId ?? resource?.run_id;
    var events = Array.isArray(resource?.items) ? resource.items : Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.events) ? payload.events : [];
    var scoped = events.filter(function(event) {
      var marketId = event.marketId ?? event.market_id;
      var roundId = event.roundId ?? event.round_id;
      var assetId = event.assetId ?? event.asset_id;
      if (runId != null) return assetId == null || String(assetId) === String(context.assetId);
      return context.marketId != null && context.roundId != null
        && marketId != null && roundId != null
        && String(marketId) === String(context.marketId)
        && String(roundId) === String(context.roundId)
        && (assetId == null || String(assetId) === String(context.assetId));
    });
    var list = document.querySelector("[data-activity-list]");
    var stale = resource.stale === true || ["stale", "unavailable", "error", "degraded"].includes(resource.status) || payload?.stale === true || payload?.available === false;
    if (!list) return;
    if (stale || resource.error || payload?.error) {
      text("[data-activity-state]", resource.status === "unavailable" ? "暂无可用运行事件" : "事件连接中断 · 以下为最近成功事件");
      list.classList.add("is-stale");
      return;
    }
    list.classList.remove("is-stale");
    text("[data-activity-state]", "事件已更新");
    if (!scoped.length) {
      list.innerHTML = '<li><time>--</time><span class="activity-icon info-icon">i</span><div><strong>当前场次暂无运行事件</strong><small>运行事件接口已连接，等待本场数据</small></div><b class="activity-tag info-tag">暂无</b></li>';
      return;
    }
    list.innerHTML = scoped.slice(0, 20).map(function(event) {
      var kind = String(event.kind || event.event || "unknown").toLowerCase();
      var state = String(event.status || event.state || "").toLowerCase();
      var severity = String(event.severity || event.level || "").toLowerCase();
      if (!severity) severity = ["rejected", "failed", "error", "cancel_failed"].includes(state) || ["error", "platform_error", "order_rejected", "settlement_failed"].includes(kind) ? "error" : "info";
      var tag = severity === "error" || severity === "critical" ? "异常" : severity === "warning" || severity === "warn" ? "警告" : "信息";
      var icon = severity === "error" || severity === "critical" ? "!" : severity === "warning" || severity === "warn" ? "!" : "i";
      var kindLabel = eventLabels[kind] || eventText(kind, "服务器事件：未分类状态");
      var message = eventText(event.message || event.reason || event.detail || kind, kindLabel);
      var rawDetail = event.detail && event.detail !== event.message ? event.detail : event.reason && event.reason !== event.message ? event.reason : null;
      var detail = eventText(rawDetail, kindLabel);
      var tagClass = severity === "error" || severity === "critical" ? "error-tag" : severity === "warning" || severity === "warn" ? "warning-tag" : "info-tag";
      return `<li><time>${window.PolyPreview.format.time(event.time || event.createdAt || event.created_at)}</time><span class="activity-icon ${severity === "error" || severity === "critical" ? "error-icon" : severity === "warning" || severity === "warn" ? "warn-icon" : "info-icon"}">${icon}</span><div><strong title="${window.PolyPreview.format.escape(message)}">${window.PolyPreview.format.escape(message)}</strong><small title="${window.PolyPreview.format.escape(detail)}">${window.PolyPreview.format.escape(detail)}</small></div><b class="activity-tag ${tagClass}">${tag}</b></li>`;
    }).join("");
  };
  var eventsRefreshTimer = null;
  var eventsRefreshInFlight = null;
  var scheduleEventsRefresh = function(delay = 5000) {
    if (document.hidden) return;
    if (eventsRefreshTimer) window.clearTimeout(eventsRefreshTimer);
    eventsRefreshTimer = window.setTimeout(function() { eventsRefreshTimer = null; void refreshEvents(); }, Math.max(0, delay));
  };
  var refreshEvents = function() {
    if (eventsRefreshInFlight) return eventsRefreshInFlight;
    var version = contextVersion;
    eventsRefreshInFlight = Promise.resolve().then(function() { return adapter.loadEvents(null, eventContext()); }).then(function(value) {
      if (version === contextVersion) renderEvents(value);
    }).finally(function() { eventsRefreshInFlight = null; scheduleEventsRefresh(version === contextVersion ? 5000 : 0); });
    return eventsRefreshInFlight;
  };
  var stopStreams = function() { streams.splice(0).forEach(function(stream) { stream.close(); }); };
  var startStreams = function() {
    if (!window.PolyPreviewStreams?.createStream) return;
    syncMarketContext();
    var context = currentContext();
    var contextKey = identityKey(context);
    var configKey = streamConfigKey();
    if (activeStreamContextKey === contextKey && activeStreamConfigKey === configKey) {
      if (!streamUrl("markets")) markStreamPending();
      return;
    }
    activeStreamContextKey = contextKey;
    activeStreamConfigKey = configKey;
    stopStreams();
    var lifecycleKey = `${contextKey}|${configKey}`;
    var lifecycleVersion = contextVersion;
    var currentLifecycle = function() { return lifecycleVersion === contextVersion && `${activeStreamContextKey}|${activeStreamConfigKey}` === lifecycleKey; };
    if (!context.assetId || !context.marketId || !context.roundId) return;
    var hasMarketStream = Boolean(streamUrl("markets"));
    if (!hasMarketStream) markStreamPending();
    var make = function(name, requireRound, onMessage, onState) {
      var url = streamUrl(name); if (!url) return;
      var stream = window.PolyPreviewStreams.createStream(name, { url, requireSequence: requireRound, acceptFrame: function(frame) { return frameMatches(frame, requireRound); }, onState, onMessage, onError: function(error) { if (currentLifecycle()) markSnapshotStale(error.message || "实时流不可用 · 保留最近快照"); } });
      stream.connect();
      stream.subscribe({ assetId: context.assetId, marketIds: [context.marketId], marketId: context.marketId, roundId: context.roundId });
      streams.push(stream);
    };
    make("markets", true, function(frame) {
      if (!currentLifecycle()) return;
      var payload = payloadOf(frame); var sourceSnapshot = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot : payload;
      var snapshot = {
        ...sourceSnapshot,
        sequence: sourceSnapshot.sequence ?? payload.sequence ?? frame.sequence,
        sourceAt: sourceSnapshot.sourceAt ?? sourceSnapshot.source_at ?? payload.sourceAt ?? payload.source_at ?? frame.sourceAt ?? frame.source_at,
        expiresAt: sourceSnapshot.expiresAt ?? sourceSnapshot.expires_at ?? payload.expiresAt ?? payload.expires_at ?? frame.expiresAt ?? frame.expires_at,
        stale: sourceSnapshot.stale ?? payload.stale ?? frame.stale,
        assetId: sourceSnapshot.assetId ?? sourceSnapshot.asset_id ?? payload.assetId ?? payload.asset_id ?? frame.assetId ?? frame.asset_id,
        marketId: sourceSnapshot.marketId ?? sourceSnapshot.market_id ?? payload.marketId ?? payload.market_id ?? frame.marketId ?? frame.market_id,
        roundId: sourceSnapshot.roundId ?? sourceSnapshot.round_id ?? payload.roundId ?? payload.round_id ?? frame.roundId ?? frame.round_id
      };
      var hasQuote = ["yesBid", "yesAsk", "noBid", "noAsk", "yes_bid", "yes_ask", "no_bid", "no_ask"].some(function(key) { return snapshot[key] != null; });
      if (snapshot.book || snapshot.orderBook || snapshot.orderbook || hasQuote) renderSnapshot(snapshot, true, contextKey);
    }, function(state) {
      if (!currentLifecycle()) return;
      if (state !== "connected") {
       text("[data-book-source]", `实时行情${state === "error" ? "异常" : "中断"} · 保留最近快照`);
        text("[data-book-live-state]", "连接中断 · 保留快照");
      }
    });
     make("orders", true, function(frame) { if (!currentLifecycle()) return; scheduleRoundRefresh(0); }, function() {});
     make("runtime", false, function(frame) {
       if (!currentLifecycle()) return;
       var payload = payloadOf(frame);
       var hasIdentity = Boolean(payload.assetId || payload.asset_id || frame?.assetId || frame?.asset_id);
       var runtimeFrame = vm.runtime(payload);
       if (hasIdentity) renderRuntime(runtimeFrame);
       else if (runtimeFrame.processRunning !== null) renderRuntime(runtimeFrame, true);
       else text("[data-connection-status]", "实时状态流已连接 · 等待所选市场状态");
       scheduleRuntimeRefresh(0);
     }, function(state) {
      if (!currentLifecycle()) return;
      if (state === "connected") return;
      text("[data-connection-status]", "实时状态流中断 · 后端接口独立刷新");
    });
  };
  var loadCurrentMarket = async function() {
    syncMarketContext();
    var context = currentContext();
    if (!context.assetId || !context.marketId || !context.roundId) { markSnapshotStale("所选市场身份待接入"); return null; }
    var contextKey = identityKey(context);
    var version = contextVersion;
    try {
      var raw = await adapter.loadMarketSnapshot(context.marketId, context);
      if (version !== contextVersion || currentMarketContextKey !== contextKey) return contextKey;
      renderSnapshot(raw, false, contextKey);
    } catch (error) { if (version === contextVersion) markSnapshotStale(error.message || "快照读取失败 · 保留本场最近快照"); }
    return contextKey;
  };
  var scheduleSnapshotRefresh = function(delay = 1000) {
    if (document.hidden) return;
    if (snapshotRefreshTimer) window.clearTimeout(snapshotRefreshTimer);
    snapshotRefreshTimer = window.setTimeout(function() {
      snapshotRefreshTimer = null;
      void refreshCurrentMarket();
    }, Math.max(0, delay));
  };
  var refreshCurrentMarket = function() {
    if (snapshotRefreshInFlight) return snapshotRefreshInFlight;
    var version = contextVersion;
    snapshotRefreshInFlight = Promise.resolve(loadCurrentMarket()).finally(function() {
      snapshotRefreshInFlight = null;
      scheduleSnapshotRefresh(version === contextVersion ? 1000 : 0);
    });
    return snapshotRefreshInFlight;
  };
  var scheduleRoundRefresh = function(delay = 3000) {
    if (document.hidden) return;
    if (roundRefreshTimer) window.clearTimeout(roundRefreshTimer);
    roundRefreshTimer = window.setTimeout(function() { roundRefreshTimer = null; void refreshRoundData(); }, delay);
  };
  var refreshRoundData = function() {
    if (roundRefreshInFlight) return roundRefreshInFlight;
    var context = currentContext();
    if (!context.assetId || !context.marketId || !context.roundId) {
      text("[data-position-state]", "等待完整市场身份");
      text("[data-orders-state]", "等待完整市场身份");
      scheduleRoundRefresh();
      return Promise.resolve();
    }
    var version = contextVersion;
    var asset = assetById(context.assetId);
    roundRefreshInFlight = Promise.allSettled([
      Promise.resolve().then(function() { return adapter.loadPosition(context.roundId, context); }).then(function(value) {
        if (version === contextVersion) renderPosition(value);
      }, function() { if (version === contextVersion) text("[data-position-state]", "读取失败 · 保留本场最近成功数据"); }),
      Promise.resolve().then(function() { return adapter.loadOrders(context.roundId, context); }).then(function(value) {
        if (version === contextVersion) renderOrders(value, asset);
      }, function() { if (version === contextVersion) text("[data-orders-state]", "读取失败 · 保留本场最近成功数据"); }),
      Promise.resolve().then(function() { return adapter.loadFills(null, ledgerContext()); }).then(function(value) {
        if (version === contextVersion) renderFills(value, asset);
      }, function() { if (version === contextVersion) text("[data-fill-summary]", "成交回报读取失败"); }),
      Promise.resolve().then(function() { return adapter.loadSettlements(null, ledgerContext()); }).then(function(value) {
        if (version === contextVersion) renderSettlements(value);
      }, function() { if (version === contextVersion) { text("[data-settlement-state]", "结算读取失败"); text("[data-settlement-detail]", "未确认结算状态，不显示成功结果。"); } })
    ]).finally(function() {
      roundRefreshInFlight = null;
      scheduleRoundRefresh(version === contextVersion ? 3000 : 0);
    });
    return roundRefreshInFlight;
  };
  var updateControls = function() {
    var context = currentContext();
    var asset = assetById(context.assetId);
    var runtimeState = selectedRuntime?.state || selectedRuntime?.status;
    var processRunning = selectedRuntime?.processRunning;
    var runtimeIdentityMatches = Boolean(selectedRuntime && vm.matchesIdentity(selectedRuntime, context));
    var runtimeActive = processRunning === true;
    var running = processRunning === true;
    var startReason = "";
    var freshPaused = runtimeIdentityMatches && !selectedRuntime.stale && processRunning === true && (runtimeState === "paused");
    var catalog = store.getState().marketCatalog;
    document.querySelectorAll("[data-action]").forEach(function(button) {
      var action = button.dataset.action;
      var strategy = store.getState().strategy;
      var cooldownActive = commandCooldownUntil > Date.now();
      var sameActionCooldown = cooldownActive && commandCooldownAction === action;
      var stopAfterAcceptedStart = cooldownActive && commandCooldownAction === "start" && action === "stop" && commandCooldownContextKey === identityKey(context);
      var reason = commandPending || sameActionCooldown ? "控制指令已接收，等待服务器最终状态" : action !== "stop" && (!context.marketId || !context.roundId) ? "所选市场身份待后端提供" : "";
      if (!reason && action === "stop" && (!runtimeIdentityMatches || !running) && !stopAfterAcceptedStart) reason = !runtimeIdentityMatches ? "当前市场没有匹配的服务器运行身份" : "没有服务器确认的可停止运行";
      if (!reason && action === "pause" && (processRunning !== true || selectedRuntime?.stale || !runtimeIdentityMatches)) reason = selectedRuntime?.stale ? "运行状态已过期，暂不允许暂停或恢复" : !runtimeIdentityMatches ? "当前市场没有匹配的服务器运行身份" : "服务器未确认进程正在运行";
      if (!reason && action === "start" && processRunning === true) reason = "服务器已确认进程正在运行";
      if (!reason && action === "start" && processRunning !== false) reason = "服务器进程状态未知，暂不允许启动";
      if (!reason && action === "start" && selectedRuntime?.stale) reason = "运行状态已过期，暂不允许启动";
      if (!reason && action === "start" && (strategy.status !== "ready" || strategy.stale === true || strategy.error || !(strategy.revision > 0))) reason = "请先在策略页面保存并激活有效版本";
      if (!reason && action === "start") reason = vm.strategyAssetStartReason(strategy, context.assetId);
      if (!reason && action === "start" && !lastSnapshotValid) reason = "当前盘口快照未新鲜确认，暂不允许启动";
      if (!reason && action === "start") {
        var account = accountStatus?.data || {};
        var liveReady = typeof account.live_start_ready === "boolean" ? account.live_start_ready
          : typeof account.liveStartReady === "boolean" ? account.liveStartReady
            : account.execution_credentials_ready === true && account.account_check_ready === true;
        var accountErrors = { account_rpc_failed: "区块链节点查询失败，请检查网络连接", account_check_failed: "账户检查未通过，请查看账户配置和授权", account_checker_unavailable: "服务器账户检查程序暂不可用", invalid_account_config: "账户配置格式不正确", wallet_address_mismatch: "钱包地址与签名私钥不匹配", approvals_missing: "交易授权未完成", settlement_credentials_unavailable: "结算凭据不可用" };
        var accountError = String(account.last_check_error || "").toLowerCase().split(/[:：]/, 1)[0];
        if (accountStatus.status !== "ready" || accountStatus.stale === true || accountStatus.error) reason = "账户状态暂不可用，请刷新服务器账户状态";
        if (!reason && account.account_check_ready !== true) reason = accountErrors[accountError] || "账户尚未检查通过，请到设置页检查已保存账户";
        if (!reason && account.settlement_credentials_ready !== true) reason = "结算凭据尚未确认，请到设置页重新检查账户";
        if (!reason && account.server_live_enabled === false) reason = "服务器尚未开启实盘交易配置";
        if (!reason && liveReady !== true) reason = "服务器尚未确认账户可启动交易";
      }
      var initialPool = store.canInitializeMarketPool(marketPool);
      var poolSelected = marketPool.desiredIds.includes(context.assetId);
      var initialPoolAsset = initialPool && asset?.canEnable === true && asset?.stale !== true && catalog.stale !== true
        && asset?.cycle === "5m" && Boolean(asset?.marketId && asset?.roundId);
      if (!reason && action === "start" && (!asset?.canEnable || asset?.stale === true || catalog.stale || (!poolSelected && !initialPoolAsset))) reason = catalog.stale || asset?.stale === true ? "行情目录或行情已过期，暂不允许启动" : !asset?.canEnable ? "服务器尚未确认该市场可加入运行池" : "请先在市场页启用所选币种并等待服务器确认";
      if (!reason && action === "start" && runtimeActive) reason = runtimeState === "stopping" ? "所选市场正在停止，等待服务器确认" : "所选市场正在运行";
      if (action === "start") startReason = reason;
      if (action === "pause") button.textContent = freshPaused ? "恢复新增" : "暂停新增";
      if (action === "start") button.textContent = commandPending ? "启动请求中…" : reason ? "启动条件未满足" : "启动自动交易";
      if (action === "stop" && commandPending) button.textContent = "停止请求中…";
      button.dataset.controlState = commandPending ? "pending" : reason ? "blocked" : "ready";
      button.classList.toggle("is-pending", commandPending || sameActionCooldown);
      button.disabled = Boolean(reason);
      button.title = reason || (commandPending ? "控制请求已提交，等待服务器确认" : "");
      button.setAttribute("aria-label", button.textContent);
    });
    var feedback = document.querySelector("[data-control-feedback]");
    if (feedback) {
      feedback.classList.toggle("is-blocked", Boolean(startReason));
      feedback.textContent = commandPending ? "正在提交控制请求，等待服务器确认…" : startReason ? `暂不能启动：${startReason}` : "启动条件已满足，可以启动交易。";
    }
  };
  var renderStrategyRevision = function(resource) {
    var revision = Number(resource?.revision);
    text("[data-strategy-revision]", Number.isInteger(revision) && revision > 0 ? `参数版本 ${revision}` : "参数版本待接入");
  };
  var renderAccount = function(resource) {
    var data = resource?.data || {};
    var collateral = data.collateral?.value;
    var fallback = data.collateral?.available === true
      ? (collateral && typeof collateral === "object" ? numeric(collateral.availableUsd ?? collateral.available_usd ?? collateral.value ?? collateral.amount) : numeric(collateral))
      : null;
    var value = numeric(data.availableUsd ?? data.available_usd ?? data.balance_occupancy?.spendable_balance) ?? fallback;
    text("[data-auto-account-available]", value == null ? "-- USDC" : `${value.toFixed(2)} USDC`);
  };
  var renderRuntime = function(runtime, globalProcess = false) {
    if (globalProcess) {
      globalProcessRunning = runtime?.processRunning ?? null;
      var globalProcessState = globalProcessRunning === true ? "进程运行中" : globalProcessRunning === false ? "进程已停止" : "进程状态未知";
      if (!selectedRuntime) {
        text("[data-strategy-status]", "所选市场状态待接入");
        text("[data-live-status]", "所选市场状态待接入");
        text("[data-connection-status]", `运行流已连接 · 全局${globalProcessState}`);
        updateControls();
      }
      return;
    }
    var matching = vm.matchesIdentity(runtime, currentContext());
    var available = matching && runtime.status !== "unavailable" && !runtime.stale && !runtime.error;
    if (available) selectedRuntime = runtime;
    else if (matching && (runtime.processRunning === true || runtime.processRunning === false)) selectedRuntime = { ...runtime, stale: true };
    else if (selectedRuntime) selectedRuntime = { ...selectedRuntime, stale: true, processRunning: runtime?.processRunning ?? null };
    var stateValue = available ? runtime.state || runtime.status : selectedRuntime ? selectedRuntime.state || selectedRuntime.status : "unavailable";
    var state = eventText(stateValue, "所选市场状态暂不可用");
    if (!available && selectedRuntime) state += " · 数据已过期";
    var processState = (available ? runtime : selectedRuntime)?.processRunning === true ? "进程运行中" : (available ? runtime : selectedRuntime)?.processRunning === false ? "进程已停止" : "进程状态未知";
    text("[data-strategy-status]", state);
    text("[data-live-status]", state);
    text("[data-status-age]", window.PolyPreview.format.time((available ? runtime : selectedRuntime)?.asOf));
    text("[data-connection-status]", available ? `接口独立刷新 · ${processState}` : `运行状态已过期 · ${processState} · 行情独立刷新`);
    text("[data-sidebar-state]", available ? `所选市场已连接 · ${processState}` : `所选市场状态待接入 · ${processState}`);
    text("[data-sidebar-detail]", available ? "五分钟反转策略" : "保留本场最近成功数据");
    updateControls();
  };
  var scheduleRuntimeRefresh = function(delay = 2000) {
    if (document.hidden) return;
    if (runtimeRefreshTimer) window.clearTimeout(runtimeRefreshTimer);
    runtimeRefreshTimer = window.setTimeout(function() { runtimeRefreshTimer = null; void refreshRuntime(); }, delay);
  };
  var refreshRuntime = function() {
    if (runtimeRefreshInFlight) return runtimeRefreshInFlight;
    var context = currentContext();
    if (!context.assetId || !context.marketId || !context.roundId) { scheduleRuntimeRefresh(); return Promise.resolve(); }
    var version = contextVersion;
    runtimeRefreshInFlight = Promise.resolve().then(function() { return adapter.loadRuntime(context); }).then(function(runtime) {
      if (version === contextVersion) renderRuntime(runtime);
    }, function() { if (version === contextVersion) renderRuntime({ status: "unavailable", stale: true }); }).finally(function() {
      runtimeRefreshInFlight = null;
      scheduleRuntimeRefresh(version === contextVersion ? 2000 : 0);
    });
    return runtimeRefreshInFlight;
  };
  var scheduleMarketContextRefresh = function(delay = 10000) {
    if (document.hidden) return;
    if (marketContextRefreshTimer) window.clearTimeout(marketContextRefreshTimer);
    marketContextRefreshTimer = window.setTimeout(function() {
      marketContextRefreshTimer = null;
      void refreshMarketContext();
    }, Math.max(0, delay));
  };
  var refreshMarketContext = function() {
    if (marketContextRefreshInFlight) return marketContextRefreshInFlight;
    marketContextRefreshInFlight = Promise.resolve()
      .then(function() { return adapter.loadMarkets(); })
      .then(function() { return adapter.loadMarketPool(); })
      .finally(function() {
        marketContextRefreshInFlight = null;
        scheduleMarketContextRefresh();
      });
    return marketContextRefreshInFlight;
  };
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) {
      if (snapshotRefreshTimer) window.clearTimeout(snapshotRefreshTimer);
      snapshotRefreshTimer = null;
      if (marketContextRefreshTimer) window.clearTimeout(marketContextRefreshTimer);
      marketContextRefreshTimer = null;
      if (roundRefreshTimer) window.clearTimeout(roundRefreshTimer);
      roundRefreshTimer = null;
      if (runtimeRefreshTimer) window.clearTimeout(runtimeRefreshTimer);
      runtimeRefreshTimer = null;
      if (eventsRefreshTimer) window.clearTimeout(eventsRefreshTimer);
      eventsRefreshTimer = null;
    } else {
      scheduleSnapshotRefresh(0);
      scheduleMarketContextRefresh(0);
      scheduleRoundRefresh(0);
      scheduleRuntimeRefresh(0);
      scheduleEventsRefresh(0);
    }
  });
  var streamLifecycleReady = false;
  renderMarketPool();
  renderStrategyRevision(store.getState().strategy);
  store.subscribe("strategy", renderStrategyRevision);
  store.subscribe("accountStatus", function(value) { accountStatus = value; updateControls(); });
  store.subscribe("account", renderAccount);
  store.subscribe("marketPool", function(value) {
    marketPool = value;
    renderMarketPool();
    updateControls();
  });
  store.subscribe("marketCatalog", function(value) {
    marketAssets = value.items.map(function(item) { return { ...item, id: item.assetId }; });
    var poolAssetId = marketPool.currentIds[0] || marketPool.desiredIds[0] || null;
    selectedAssetId = [value.selectedId, window.PolyPreview.config.selectedAssetId, poolAssetId]
      .find(function(id) { return id && marketAssets.some(function(item) { return item.id === id; }); }) || null;
    renderMarketPool();
    var previousContext = currentMarketContextKey;
    syncMarketContext();
    updateControls();
    if (streamLifecycleReady && previousContext !== currentMarketContextKey) {
      scheduleSnapshotRefresh(0); scheduleRoundRefresh(0); scheduleRuntimeRefresh(0); startStreams();
    }
  });
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const contextForAction = currentContext();
      const runtimeStateForAction = selectedRuntime?.state || selectedRuntime?.status;
      const canResume = button.dataset.action === "pause"
        && !selectedRuntime?.stale
        && selectedRuntime?.processRunning === true
        && vm.matchesIdentity(selectedRuntime, contextForAction)
        && runtimeStateForAction === "paused";
      const action = canResume ? "resume" : button.dataset.action;
      if (commandPending || button.disabled) return;
      var context = currentContext();
      var version = contextVersion;
      var acceptedResult = false;
      commandPending = true;
      var feedback = document.querySelector("[data-control-feedback]");
      if (feedback) { feedback.classList.remove("is-blocked"); feedback.textContent = action === "start" ? "正在提交启动请求，等待服务器确认…" : "正在提交控制请求，等待服务器确认…"; }
      updateControls();
      try {
        const command = { action, ...(context.assetId ? { assetId: context.assetId } : {}), ...(context.marketId ? { marketIds: [context.marketId] } : {}), strategyId: window.PolyPreview.config.strategyId, requestId: `console-${Date.now()}` };
        const result = await adapter.commandRuntime(command);
        const accepted = result?.accepted === true && result.commandStatus !== "failed";
        acceptedResult = accepted;
        if (version !== contextVersion) return;
        const remoteOrdersState = result?.remoteOrdersState ?? result?.remote_orders_state;
        if (action === "stop") {
          const remoteText = remoteOrdersState === "confirmed" || remoteOrdersState === "cancelled" ? "远端挂单撤销已确认" : remoteOrdersState === "unconfirmed" ? "远端挂单撤销尚未确认" : "远端挂单状态待确认";
          text("[data-live-status]", `${result.message || (accepted ? "停止请求已接收" : "停止请求未接受")} · ${remoteText}`);
          text("[data-strategy-status]", accepted ? `等待停止状态确认 · ${remoteText}` : "停止指令未接受，运行状态未改变");
        } else {
          text("[data-live-status]", result.message || (accepted ? "指令已接收，等待运行状态确认" : "指令未接受，运行状态未改变"));
          text("[data-strategy-status]", accepted ? "等待状态确认" : "指令未接受，未改变运行状态");
        }
        if (feedback) { feedback.classList.toggle("is-blocked", !accepted); feedback.textContent = accepted ? "服务器已接收请求，等待运行状态确认。" : "服务器未接收请求，运行状态没有改变。"; }
      } catch (error) {
        if (version === contextVersion) {
          text("[data-live-status]", error.message || "控制请求失败，运行状态未改变");
          text("[data-strategy-status]", "控制失败，未改变运行状态");
          if (feedback) { feedback.classList.add("is-blocked"); feedback.textContent = `${error.message || "控制请求失败"}，运行状态没有改变。`; }
        }
      }
      finally {
        commandPending = false;
        if (acceptedResult) {
          commandCooldownUntil = Date.now() + 5000;
          commandCooldownAction = action;
          commandCooldownContextKey = identityKey(context);
        }
        updateControls();
        scheduleRuntimeRefresh(500);
        if (commandCooldownUntil > Date.now()) window.setTimeout(function() {
          if (commandCooldownUntil <= Date.now()) {
            commandCooldownUntil = 0;
            commandCooldownAction = null;
            commandCooldownContextKey = null;
          }
          updateControls();
        }, commandCooldownUntil - Date.now() + 10);
      }
    });
  });
  document.querySelectorAll("[data-preview-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.previewTarget;
      if (target) window.PolyPreview.navigate(target);
    });
  });
  // The preview intentionally does not synthesize quotes, latency, countdowns
  // or order events. A real adapter will push independent snapshots here;
  // keeping this page static avoids flicker and prevents fake "live" states.
  document.querySelector("[data-manage-markets]")?.addEventListener("click", function(event) { event.preventDefault(); window.PolyPreview.navigate("market.html"); });
  document.querySelectorAll(".quiet-button").forEach(function(button) {
    button.disabled = true;
    button.title = "此详情功能尚未接入";
    button.textContent += " · 未提供";
  });
  Promise.allSettled([adapter.loadMarkets(), adapter.loadMarketPool(), adapter.loadStrategy(), adapter.loadAccountStatus(), adapter.loadAccount(), adapter.loadEvents(null, eventContext())]).then(function(results) {
    var eventsResult = results[5];
    if (eventsResult.status === "fulfilled") renderEvents(eventsResult.value);
    streamLifecycleReady = true;
    scheduleMarketContextRefresh(); scheduleSnapshotRefresh(0); scheduleRoundRefresh(0); scheduleRuntimeRefresh(0); scheduleEventsRefresh(5000); startStreams();
  }).catch(function(error) { text("[data-live-status]", error.message || "运行数据不可用"); });
})();

