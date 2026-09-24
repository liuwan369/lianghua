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
  var selectedAssetId = store.getState().marketCatalog.selectedId || window.PolyPreview.config.selectedAssetId || null;
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
        <div><strong>POLYMARKET</strong><small>TRADING CONSOLE</small></div>
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
          <p class="eyebrow">LIVE CONTROL \xB7 通用 REVERSAL</p>
          <div class="hero-title-row"><h1>\u81EA\u52A8\u4EA4\u6613</h1><span class="language-chip">5 \u5206\u949F</span></div>
          <p class="subtitle">\u76D8\u53E3\u3001\u7B56\u7565\u5224\u65AD\u3001\u5F53\u524D\u6301\u4ED3\u548C\u8BA2\u5355\u72B6\u6001\u96C6\u4E2D\u67E5\u770B\uFF0C\u5B9E\u65F6\u6570\u636E\u5404\u81EA\u72EC\u7ACB\u66F4\u65B0\u3002</p>
          <div class="hero-actions">
            <button class="hero-button primary-action" type="button" data-action="start">\u542F\u52A8\u81EA\u52A8\u4EA4\u6613</button>
            <button class="hero-button" type="button" data-action="pause">\u6682\u505C\u65B0\u589E</button>
            <button class="hero-button exit-action" type="button" data-action="stop">\u505C\u6B62\u5E76\u64A4\u4F59\u91CF</button>
          </div>
        </div>
        <div class="trade-header-side">
           <span class="live-chip"><i></i><b data-live-status>后端未连接</b><small data-live-clock>--:--:--</small></span>
          <div class="header-status-grid">
            <article class="header-status"><span>\u5F53\u524D\u5E02\u573A</span><strong data-active-market>当前选中市场 / 5m YES-NO</strong></article>
             <article class="header-status"><span>\u6570\u636E\u8FDE\u63A5</span><strong class="status-warning" data-connection-status>后端未连接 · 等待快照</strong></article>
            <article class="header-status"><span>\u4EA4\u6613\u6A21\u5F0F</span><strong>\u5B9E\u76D8 \xB7 \u5355\u7B56\u7565</strong></article>
            <article class="header-status"><span>\u8D26\u6237\u4F59\u989D</span><strong>-- USDC</strong></article>
          </div>
        </div>
      </header>

      <section class="latency-panel" aria-labelledby="latency-title">
        <div class="panel-heading compact-heading">
          <div><p class="eyebrow">EXECUTION TELEMETRY</p><h2 id="latency-title">\u4EA4\u6613\u901F\u5EA6</h2></div>
          <div class="latency-heading-meta"><span class="sample-dot"></span><span>\u5F53\u524D\u8FD0\u884C p95</span><button type="button" class="quiet-button">\u67E5\u770B\u5168\u90E8\u5EF6\u8FDF</button></div>
        </div>
        <div class="latency-grid">
          <article class="latency-card"><span>\u884C\u60C5\u5230\u51B3\u7B56</span><strong><b data-latency="decision">--</b><em>ms</em></strong><small>WebSocket \u6536\u5230\u884C\u60C5\u5230\u7B56\u7565\u5B8C\u6210</small></article>
          <article class="latency-card"><span>\u4E0B\u5355\u786E\u8BA4</span><strong><b data-latency="order">--</b><em>ms</em></strong><small>HTTP \u53D1\u51FA\u8BA2\u5355\u5230\u5E73\u53F0\u786E\u8BA4</small></article>
          <article class="latency-card"><span>\u64A4\u5355\u786E\u8BA4</span><strong><b data-latency="cancel">--</b><em>ms</em></strong><small>\u53D1\u51FA\u64A4\u5355\u5230\u5E73\u53F0\u660E\u786E\u53D6\u6D88</small></article>
          <article class="latency-card latency-accent"><span>\u6574\u8F6E\u53CD\u5E94</span><strong><b data-latency="round">--</b><em>ms</em></strong><small>\u89E6\u53D1\u884C\u60C5\u6536\u5230\u5230\u8BA2\u5355\u786E\u8BA4</small></article>
        </div>
        <p class="latency-caption">\u5EF6\u8FDF\u53EA\u53CD\u6620\u4EE3\u7801\u94FE\u8DEF\uFF0C\u4E0D\u5305\u542B\u7B49\u5F85\u5BF9\u624B\u6210\u4EA4\u548C\u94FE\u4E0A\u786E\u8BA4\u3002\u65E0\u6837\u672C\u65F6\u663E\u793A --\u3002</p>
      </section>

      <section class="trade-panel market-pool-panel" aria-labelledby="market-pool-title">
        <div class="panel-heading">
          <div><p class="eyebrow">ENABLED MARKET POOL</p><h2 id="market-pool-title">\u5F53\u524D\u8FD0\u884C\u6C60</h2></div>
          <a class="pool-link" href="market.html" data-manage-markets>\u7BA1\u7406\u5E02\u573A <span>↗</span></a>
        </div>
        <label class="market-selector"><span>详情市场</span><select data-market-selector><option value="">等待市场目录</option></select></label>
        <div class="market-pool-row" data-market-pool-row></div>
        <p class="market-pool-note" data-market-pool-note>\u5F53\u524D\u573A\u6B21\u7EE7\u7EED\u8FD0\u884C\uFF0C\u5E02\u573A\u9875\u65B0\u542F\u7528\u7684\u5E01\u79CD\u4ECE\u4E0B\u4E00\u573A\u52A0\u5165\u3002</p>
      </section>

      <section class="trade-summary-grid" aria-label="\u5F53\u524D\u7B56\u7565\u6458\u8981">
        <article class="summary-card"><div class="summary-icon blue-icon">\u25F7</div><div><span>\u5F53\u524D\u573A\u6B21</span><strong data-round>待接入 · 当前场次</strong><small data-countdown>\u5F85\u63A5\u5165</small></div></article>
        <article class="summary-card"><div class="summary-icon violet-icon">\u21AF</div><div><span>\u5F53\u524D\u9636\u6BB5</span><strong data-stage>\u5F85\u63A5\u5165</strong><small>\u786E\u8BA4\u53CD\u8F6C <b data-confirmations>--</b> / -- \u6B21</small></div></article>
        <article class="summary-card"><div class="summary-icon amber-icon">\u2192</div><div><span>\u4E0B\u4E00\u7B14</span><strong data-next>\u7B49\u5F85\u4FE1\u53F7</strong><small>\u53C2\u6570\u7248\u672C REV-001</small></div></article>
           <article class="summary-card"><div class="summary-icon green-icon">\u2713</div><div><span>\u7B56\u7565\u72B6\u6001</span><strong data-strategy-status>策略配置待接入</strong><small>\u66F4\u65B0\u65F6\u95F4 <b data-status-age>--</b></small></div></article>
      </section>

      <section class="trade-main-grid">
        <article class="trade-panel orderbook-panel" aria-labelledby="orderbook-title">
          <div class="panel-heading">
            <div><p class="eyebrow">LIVE ORDER BOOK</p><h2 id="orderbook-title">\u5F53\u524D\u76D8\u53E3</h2></div>
            <div class="book-live"><i></i><span data-book-live-state>\u5F85\u63A5\u5165</span><small data-book-age>--</small></div>
          </div>
          <div class="quote-strip">
            <div class="quote-box up-quote"><span><i></i>YES \u4E70\u4E00 / \u5356\u4E00</span><strong><b data-quote="yes-bid">--</b><em>/</em><b data-quote="yes-ask">--</b></strong></div>
            <div class="quote-box down-quote"><span><i></i>NO \u4E70\u4E00 / \u5356\u4E00</span><strong><b data-quote="no-bid">--</b><em>/</em><b data-quote="no-ask">--</b></strong></div>
          </div>
          <div class="depth-toolbar"><div><strong>\u4E94\u6863\u6DF1\u5EA6</strong><span>\u4E70\u5356\u4E24\u4FA7\u5B9E\u65F6\u663E\u793A</span></div><span class="depth-source" data-book-source>\u7B49\u5F85\u5B9E\u65F6\u5FEB\u7167</span></div>
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
            <div><p class="eyebrow">ROUND POSITION</p><h2 id="position-title">\u672C\u573A\u6301\u4ED3\u4E0E\u7ED3\u679C</h2></div>
            <span class="panel-meta" data-round-identity>\u5F53\u524D\u573A\u6B21 \xB7 \u7B49\u5F85\u8F6E\u6B21\u6807\u8BC6</span>
          </div>
          <div class="position-hero"><div><span>\u672C\u573A\u51C0\u6295\u5165</span><strong data-invested>-- <em>USDC</em></strong></div><span class="position-badge" data-position-state>\u5F85\u63A5\u5165</span></div>
          <div class="holding-grid">
            <div class="holding-item up-holding"><span>YES \u4EFD\u989D</span><strong data-holding="up">--</strong><small>\u5747\u4EF7 <b data-average="up">--</b></small></div>
            <div class="holding-item down-holding"><span>NO \u4EFD\u989D</span><strong data-holding="down">--</strong><small>\u5747\u4EF7 <b data-average="down">--</b></small></div>
          </div>
          <div class="result-grid"><div><span>\u5DF2\u4E70\u5165 / \u8BA2\u5355\u5360\u7528</span><strong><b data-bought>--</b> / <b data-occupied>--</b> USDC</strong></div><div><span>YES \u80DC / NO \u80DC\u9884\u8BA1\u7ED3\u679C</span><strong class="result-values"><b data-outcome="up">--</b><em>/</em><b data-outcome="down">--</b> USDC</strong></div></div>
          <div class="stage-section">
            <div class="stage-heading"><div><span>\u9636\u6BB5\u8FDB\u5EA6</span><small>\u9636\u6BB5\u72B6\u6001\u5F52\u5165\u672C\u573A\u7ED3\u679C</small></div><b data-stage-progress>--</b></div>
            <div class="stage-track"><i data-progress-fill></i></div>
            <ol class="stage-timeline" data-stage-timeline><li class="current"><span>·</span><div><strong>\u573A\u6B21\u548C\u7B56\u7565\u9636\u6BB5\u5F85\u63A5\u5165</strong><small>\u540E\u7AEF\u8FD4\u56DE marketId + roundId \u540E\u663E\u793A\u5B9E\u65F6\u8FDB\u5EA6</small></div><time>--</time></li></ol>
          </div>
          <p class="result-note"><span class="info-dot">i</span>\u9884\u8BA1\u7ED3\u679C\u6309\u5DF2\u6210\u4EA4\u4EFD\u989D\u548C\u5B9E\u9645\u6210\u672C\u8BA1\u7B97\uFF0C\u6700\u7EC8\u4EE5\u5B98\u65B9\u7ED3\u679C\u548C\u5230\u8D26\u4E3A\u51C6\u3002</p>
        </article>
      </section>

      <section class="orders-panel trade-panel" aria-labelledby="orders-title">
        <div class="panel-heading">
          <div><p class="eyebrow">ORDER LIFECYCLE</p><h2 id="orders-title">\u5F53\u524D\u8FD0\u884C\u8BA2\u5355</h2></div>
          <div class="orders-meta"><span class="panel-meta" data-orders-state>等待当前场次数据</span><span class="orders-count"><b data-order-count>--</b> \u4E2A\u8BA2\u5355</span><button type="button" class="quiet-button">\u67E5\u770B\u5168\u90E8</button></div>
        </div>
        <div class="orders-table-wrap"><table class="orders-table"><thead><tr><th>\u65F6\u95F4</th><th>\u65B9\u5411</th><th>\u4EF7\u683C</th><th>\u6570\u91CF</th><th>已成交份额</th><th>\u72B6\u6001</th></tr></thead><tbody><tr><td colspan="6">\u5F53\u524D\u573A\u6B21\u8BA2\u5355\u7B49\u5F85\u540E\u7AEF\u8FD4\u56DE</td></tr></tbody></table></div>
      </section>

      <section class="activity-panel trade-panel" aria-labelledby="activity-title">
        <div class="panel-heading"><div><p class="eyebrow">RUN ACTIVITY</p><h2 id="activity-title">\u6700\u8FD1\u52A8\u4F5C</h2></div><span class="panel-meta">\u5F53\u524D\u8FD0\u884C\u4E8B\u4EF6</span></div>
        <ol class="activity-list" aria-live="polite"><li><time>--</time><span class="activity-icon info-icon">i</span><div><strong>\u7B49\u5F85\u540E\u7AEF\u8FD4\u56DE\u8FD0\u884C\u4E8B\u4EF6</strong><small>\u5B9E\u65F6\u4E8B\u4EF6\u5C06\u6309 marketId + roundId \u8FFD\u52A0</small></div><b class="activity-tag info-tag">\u5F85\u63A5\u5165</b></li></ol>
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
  var renderMarketSelector = function() {
    var selector = document.querySelector("[data-market-selector]");
    if (!selector) return;
    html(selector, '<option value="">请选择市场</option>' + marketAssets.map(function(asset) { return `<option value="${window.PolyPreview.format.escape(asset.id)}">${window.PolyPreview.format.escape(asset.symbol)} · ${window.PolyPreview.format.escape(asset.name)}</option>`; }).join(""));
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
    var activeMarket = selected ? `${selected.symbol} / ${selected.cycle || "5m"} YES-NO` : "请选择详情市场";
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
  var commandPending = false;
  var currentMarketContextKey = null;
  var activeStreamContextKey = null;
  var activeStreamConfigKey = null;
  var lastSnapshotValid = false;
  var timestampMs = function(value) {
    if (value == null || value === "") return null;
    var numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    var parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
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
    var hasDepth = ["yes", "no"].every(function(side) {
      var sideBook = bookSide(side);
      return Array.isArray(sideBook.bids || sideBook.bid) && Array.isArray(sideBook.asks || sideBook.ask);
    });
    var watermarkKey = identityKey(context);
    var previousSequence = snapshotWatermarks.get(watermarkKey);
    var valid = Boolean(marketId && roundId) && hasDepth && !model.depthUnavailable && Number.isFinite(sequence) && sequence >= 0 && sourceAt != null && expiresAt != null
      && sourceAt <= now + 5000 && expiresAt > now && source.stale !== true && raw.stale !== true
      && (previousSequence == null || sequence >= previousSequence);
    if (!valid) {
      markSnapshotStale(model.depthUnavailable ? "盘口深度待接入 · 保留最近快照" : raw.stale === true ? "行情源标记 stale · 保留最近快照" : "行情已过期、缺少深度或序列落后 · 保留最近快照");
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
    text("[data-book-source]", `${fromStream ? "实时流" : "REST 快照"} · ${window.PolyPreview.format.time(sourceAt)}`);
    text("[data-book-live-state]", fromStream ? "实时流 · 已连接" : "REST 快照 · 已更新");
    text("[data-book-age]", window.PolyPreview.format.time(sourceAt));
    return true;
  };
  var streams = [];
  var currentContext = function() {
    var asset = assetById(selectedAssetId);
    return asset ? { assetId: asset.id, marketId: asset.marketId, roundId: asset.roundId } : { assetId: null, marketId: null, roundId: null };
  };
  var payloadOf = function(frame) { return frame?.data && typeof frame.data === "object" ? frame.data : frame?.payload && typeof frame.payload === "object" ? frame.payload : frame || {}; };
  var frameMatches = function(frame, requireRound) {
    var context = currentContext();
    var payload = payloadOf(frame);
    var marketId = payload.marketId || payload.market_id || frame?.marketId || frame?.market_id;
    var roundId = payload.roundId || payload.round_id || frame?.roundId || frame?.round_id;
    var assetId = payload.assetId || payload.asset_id || frame?.assetId || frame?.asset_id;
    if (!requireRound && !marketId && !roundId && !assetId) return true;
    if (!context.assetId || !context.marketId || !context.roundId || !marketId || !roundId || !assetId) return false;
    return String(assetId) === String(context.assetId) && marketId === context.marketId && roundId === context.roundId;
  };
  var streamUrl = function(name) {
    var configured = window.PolyPreview.config.streams?.[name];
    return typeof configured === "string" ? configured : configured?.url || null;
  };
  var streamConfigKey = function() { return ["markets", "runtime", "orders"].map(function(name) { return `${name}:${streamUrl(name) || ""}`; }).join("|"); };
  var markStreamPending = function() {
    if (!lastSnapshotValid) text("[data-book-live-state]", "等待 REST 快照");
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
    text("[data-orders-state]", "读取中");
    text("[data-live-status]", "所选市场状态待接入");
    text("[data-invested]", "--");
    text('[data-holding="up"]', "--");
    text('[data-holding="down"]', "--");
    text('[data-average="up"]', "--");
    text('[data-average="down"]', "--");
    text("[data-stage]", "待接入");
    text("[data-confirmations]", "--");
    text("[data-stage-progress]", "--");
    text("[data-order-count]", "--");
    ["[data-bought]", "[data-occupied]", '[data-outcome="up"]', '[data-outcome="down"]'].forEach(function(selector) { text(selector, "--"); });
    var body = document.querySelector(".orders-table tbody");
    if (body) body.innerHTML = '<tr><td colspan="6">正在读取新场次持仓和订单</td></tr>';
    var timeline = document.querySelector("[data-stage-timeline]");
    if (timeline) timeline.innerHTML = '<li class="current"><span>·</span><div><strong>新场次数据读取中</strong><small>等待后端返回当前 roundId 的持仓和策略阶段</small></div><time>--</time></li>';
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
    text("[data-round-identity]", context.assetId && context.marketId && context.roundId ? `${context.assetId} · marketId ${context.marketId} · roundId ${context.roundId}` : "所选资产的 marketId + roundId 待后端提供");
    text("[data-round]", context.roundId || "场次身份待接入");
    return contextKey;
  };
  var renderPosition = function(raw) {
    raw = raw?.data && typeof raw.data === "object" ? raw.data : raw;
    var position = raw?.position || raw;
    if (!position || !vm.matchesIdentity(position, currentContext()) || raw.stale || raw.error || raw.available === false || position.stale || position.available === false || position.error) {
      text("[data-position-state]", "持仓 unavailable/stale · 保留本场最近成功数据");
      return false;
    }
    var number = function(...keys) { for (var key of keys) { var value = numeric(position[key]); if (value != null) return value; } return null; };
    var occupied = number("occupiedUsd", "occupied_usd");
    text("[data-invested]", occupied != null ? `${occupied.toFixed(2)} USDC` : "-- USDC");
    text("[data-stage]", position.stage != null ? `阶段 ${position.stage}` : "--");
    text("[data-confirmations]", position.confirmations == null ? "--" : String(position.confirmations));
    var yesShares = number("yesShares", "yes_shares"); var noShares = number("noShares", "no_shares");
    text('[data-holding="up"]', yesShares == null ? "--" : yesShares.toFixed(2));
    text('[data-holding="down"]', noShares == null ? "--" : noShares.toFixed(2));
    var average = position.averagePrice && typeof position.averagePrice === "object" ? position.averagePrice : {};
    var yesAverage = numeric(average.yes ?? average.up ?? position.yesAveragePrice ?? position.yes_average_price);
    var noAverage = numeric(average.no ?? average.down ?? position.noAveragePrice ?? position.no_average_price);
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
    if (!orders || !asset || raw.stale || raw.error || raw.available === false || orders.some(function(order) { return !itemMatchesContext(order, asset); })) {
      text("[data-orders-state]", "订单 unavailable/stale · 保留本场最近成功数据");
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
      var price = numeric(order.price); var size = numeric(order.size ?? order.quantity ?? order.shares); var filled = numeric(order.filledShares ?? order.filled_shares ?? order.filled ?? order.filledSize ?? order.filled_size);
      return `<tr><td>${window.PolyPreview.format.time(order.updatedAt || order.createdAt || order.time)}</td><td>${window.PolyPreview.format.escape(String(side).toUpperCase())}</td><td>${Number.isFinite(price) ? price.toFixed(3) : "--"}</td><td>${Number.isFinite(size) ? size.toFixed(2) : "--"}</td><td>${Number.isFinite(filled) ? filled.toFixed(2) : "--"}</td><td>${window.PolyPreview.format.escape(order.status || "--")}</td></tr>`;
    }).join("") : '<tr><td colspan="6">当前场次暂无订单</td></tr>');
    text("[data-orders-state]", `已更新 · ${window.PolyPreview.format.time(raw.asOf)}`);
    return true;
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
      var stream = window.PolyPreviewStreams.createStream(name, { url, acceptFrame: function(frame) { return frameMatches(frame, requireRound); }, onState, onMessage, onError: function(error) { if (currentLifecycle()) markSnapshotStale(error.message || "实时流不可用 · 保留最近快照"); } });
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
        text("[data-book-source]", `实时流${state === "error" ? "错误" : "断开"} · 保留最近快照`);
        text("[data-book-live-state]", "连接中断 · 保留快照");
      }
    });
     make("orders", true, function(frame) { if (!currentLifecycle()) return; scheduleRoundRefresh(0); }, function() {});
     make("runtime", false, function(frame) {
       if (!currentLifecycle()) return;
       var payload = payloadOf(frame);
       var hasIdentity = Boolean(payload.assetId || payload.asset_id || frame?.assetId || frame?.asset_id);
       if (hasIdentity) renderRuntime(vm.runtime(payload));
       else text("[data-connection-status]", "运行流已连接 · 等待所选市场状态");
       scheduleRuntimeRefresh(0);
     }, function(state) {
      if (!currentLifecycle()) return;
      if (state === "connected") return;
      text("[data-connection-status]", "运行流中断 · REST 独立刷新");
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
      text("[data-position-state]", "unavailable · 等待完整市场身份");
      text("[data-orders-state]", "unavailable · 等待完整市场身份");
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
      }, function() { if (version === contextVersion) text("[data-orders-state]", "读取失败 · 保留本场最近成功数据"); })
    ]).finally(function() {
      roundRefreshInFlight = null;
      scheduleRoundRefresh(version === contextVersion ? 3000 : 0);
    });
    return roundRefreshInFlight;
  };
  var updateControls = function() {
    var context = currentContext();
    var asset = assetById(context.assetId);
    var running = selectedRuntime && !selectedRuntime.stale && ["running", "starting", "paused"].includes(selectedRuntime.state || selectedRuntime.status);
    document.querySelectorAll("[data-action]").forEach(function(button) {
      var action = button.dataset.action;
      var strategy = store.getState().strategy;
      var reason = commandPending ? "控制指令处理中" : !context.marketId || !context.roundId ? "所选市场身份待后端提供" : "";
      if (!reason && action === "start" && (strategy.status !== "ready" || !(strategy.revision > 0))) reason = "请先在策略页面保存并激活有效版本";
      if (!reason && action === "start" && (!asset?.canEnable || asset?.strategyEligible !== true || asset?.stale === true || marketPool.stale || !marketPool.desiredIds.includes(context.assetId))) reason = asset?.strategyEligible !== true ? "服务器尚未确认该市场符合策略条件" : asset?.stale === true ? "行情已过期，暂不允许启动" : "请先在市场页启用所选币种并等待服务器确认";
      if (!reason && action === "start" && running) reason = "所选市场正在运行";
      if (!reason && action !== "start" && !running) reason = "所选市场运行状态尚未确认";
      if (action === "pause") button.textContent = selectedRuntime?.state === "paused" || selectedRuntime?.status === "paused" ? "恢复新增" : "暂停新增";
      button.disabled = Boolean(reason);
      button.title = reason;
    });
  };
  var renderRuntime = function(runtime) {
    var matching = vm.matchesIdentity(runtime, currentContext());
    var available = matching && runtime.status !== "unavailable" && !runtime.stale && !runtime.error;
    if (available) selectedRuntime = runtime;
    else if (selectedRuntime) selectedRuntime = { ...selectedRuntime, stale: true };
    var state = available ? runtime.state || runtime.status : selectedRuntime ? `${selectedRuntime.state || selectedRuntime.status} · stale` : "所选市场状态 unavailable";
    text("[data-strategy-status]", state);
    text("[data-live-status]", state);
    text("[data-status-age]", window.PolyPreview.format.time((available ? runtime : selectedRuntime)?.asOf));
    text("[data-connection-status]", available ? "REST 独立刷新" : "运行状态待接入 · 行情独立刷新");
    text("[data-sidebar-state]", available ? "所选市场已连接" : "所选市场状态待接入");
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
    } else {
      scheduleSnapshotRefresh(0);
      scheduleMarketContextRefresh(0);
      scheduleRoundRefresh(0);
      scheduleRuntimeRefresh(0);
    }
  });
  var streamLifecycleReady = false;
  renderMarketPool();
  store.subscribe("marketPool", function(value) {
    marketPool = value;
    renderMarketPool();
    updateControls();
  });
  store.subscribe("marketCatalog", function(value) {
    marketAssets = value.items.map(function(item) { return { ...item, id: item.assetId }; });
    selectedAssetId = value.selectedId || null;
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
      const action = button.dataset.action === "pause" && (selectedRuntime?.state === "paused" || selectedRuntime?.status === "paused") ? "resume" : button.dataset.action;
      if (commandPending || button.disabled) return;
      var context = currentContext();
      var version = contextVersion;
      commandPending = true;
      updateControls();
      try {
        const command = { action, assetId: context.assetId, marketIds: [context.marketId], strategyId: window.PolyPreview.config.strategyId, requestId: `console-${Date.now()}` };
        const result = await adapter.commandRuntime(command);
        if (version !== contextVersion) return;
        const accepted = result?.accepted === true && result.commandStatus !== "failed";
        text("[data-live-status]", result.message || (accepted ? "指令已接收，等待运行状态确认" : "指令未接受，运行状态未改变"));
        text("[data-strategy-status]", accepted ? "等待状态确认" : "指令未接受，未改变运行状态");
      } catch (error) {
        if (version === contextVersion) {
          text("[data-live-status]", error.message || "控制请求失败，运行状态未改变");
          text("[data-strategy-status]", "控制失败，未改变运行状态");
        }
      }
      finally { commandPending = false; updateControls(); scheduleRuntimeRefresh(500); }
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
  Promise.allSettled([adapter.loadMarkets(), adapter.loadMarketPool(), adapter.loadStrategy()]).then(function() {
    streamLifecycleReady = true;
    scheduleMarketContextRefresh(); scheduleSnapshotRefresh(0); scheduleRoundRefresh(0); scheduleRuntimeRefresh(0); startStreams();
  }).catch(function(error) { text("[data-live-status]", error.message || "运行数据不可用"); });
})();

