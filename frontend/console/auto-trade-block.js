"use strict";
(() => {
  // src/auto-trade-block.ts
  var root = document.querySelector("#auto-trade-block-root");
  if (!root) throw new Error("auto trade block root missing");
  var store = window.PolyPreviewStore;
  var adapter = window.PolyPreviewAdapter;
  var vm = window.PolyPreviewViewModel;
  var marketAssets = store.getState().marketCatalog.items.map(function(item) {
    return { id: item.assetId, marketId: item.marketId, roundId: item.roundId, symbol: item.symbol, name: item.name, icon: item.icon, tone: item.tone };
  });
  var marketPool = store.getState().marketPool;
  var assetById = function(id) { return marketAssets.find(function(asset) { return asset.id === id; }); };
  var marketIdsForCommand = function() { return marketPool.desiredIds.map(assetById).filter(Boolean).map(function(asset) { return asset.marketId || asset.id; }); };
  var navItems = [
    ["\u25C8", "\u603B\u89C8", "overview.html"],
    ["\u25C7", "\u5E02\u573A", "market.html"],
    ["\u2197", "\u81EA\u52A8\u4EA4\u6613", "auto-trade.html"],
    ["\u25D2", "\u7B56\u7565", "strategy.html"],
    ["\u2699", "\u8BBE\u7F6E", "settings.html"]
  ];
  var navMarkup = navItems.map(([icon, label, target]) => `<button class="nav-item${label === "\u81EA\u52A8\u4EA4\u6613" ? " active" : ""}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === "\u81EA\u52A8\u4EA4\u6613" ? ' aria-current="page"' : ""}><span>${icon}</span>${label}</button>`).join("");
  var depthRows = (prices = [], sizes = [], tone) => prices.map((price, index) => `<tr><td>${index + 1}</td><td class="depth-price ${tone}">${price.toFixed(3)}</td><td>${sizes[index].toFixed(1)}</td><td><span class="depth-bar ${tone}" style="--depth:${Math.round(sizes[index] / 62 * 100)}%"></span></td></tr>`).join("");
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
      <div class="sidebar-status"><i></i><span data-sidebar-state>\u539F\u578B\u9884\u89C8</span><small data-sidebar-detail>\u6570\u636E\u5F85\u63A5\u5165</small></div>
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
          <span class="live-chip"><i></i><b data-live-status>\u8BBE\u8BA1\u7A3F \xB7 \u5F85\u63A5\u5165</b><small data-live-clock>--:--:--</small></span>
          <div class="header-status-grid">
            <article class="header-status"><span>\u5F53\u524D\u5E02\u573A</span><strong data-active-market>当前选中市场 / 5m YES-NO</strong></article>
            <article class="header-status"><span>\u6570\u636E\u8FDE\u63A5</span><strong class="status-warning" data-connection-status>\u6F14\u793A\u6570\u636E \xB7 \u5F85\u63A5\u5165</strong></article>
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
          <a class="pool-link" href="market.html">\u7BA1\u7406\u5E02\u573A <span>↗</span></a>
        </div>
        <div class="market-pool-row" data-market-pool-row></div>
        <p class="market-pool-note" data-market-pool-note>\u5F53\u524D\u573A\u6B21\u7EE7\u7EED\u8FD0\u884C\uFF0C\u5E02\u573A\u9875\u65B0\u542F\u7528\u7684\u5E01\u79CD\u4ECE\u4E0B\u4E00\u573A\u52A0\u5165\u3002</p>
      </section>

      <section class="trade-summary-grid" aria-label="\u5F53\u524D\u7B56\u7565\u6458\u8981">
        <article class="summary-card"><div class="summary-icon blue-icon">\u25F7</div><div><span>\u5F53\u524D\u573A\u6B21</span><strong data-round>待接入 · 当前场次</strong><small data-countdown>\u5F85\u63A5\u5165</small></div></article>
        <article class="summary-card"><div class="summary-icon violet-icon">\u21AF</div><div><span>\u5F53\u524D\u9636\u6BB5</span><strong data-stage>\u5F85\u63A5\u5165</strong><small>\u786E\u8BA4\u53CD\u8F6C <b data-confirmations>--</b> / -- \u6B21</small></div></article>
        <article class="summary-card"><div class="summary-icon amber-icon">\u2192</div><div><span>\u4E0B\u4E00\u7B14</span><strong data-next>\u7B49\u5F85\u4FE1\u53F7</strong><small>\u53C2\u6570\u7248\u672C REV-001</small></div></article>
        <article class="summary-card"><div class="summary-icon green-icon">\u2713</div><div><span>\u7B56\u7565\u72B6\u6001</span><strong data-strategy-status>\u8BBE\u8BA1\u7A3F \xB7 \u5F85\u63A5\u5165</strong><small>\u66F4\u65B0\u65F6\u95F4 <b data-status-age>--</b></small></div></article>
      </section>

      <section class="trade-main-grid">
        <article class="trade-panel orderbook-panel" aria-labelledby="orderbook-title">
          <div class="panel-heading">
            <div><p class="eyebrow">LIVE ORDER BOOK</p><h2 id="orderbook-title">\u5F53\u524D\u76D8\u53E3</h2></div>
            <div class="book-live"><i></i><span>\u5F85\u63A5\u5165</span><small data-book-age>--</small></div>
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
          <div class="position-hero"><div><span>\u672C\u573A\u51C0\u6295\u5165</span><strong data-invested>-- <em>USDC</em></strong></div><span class="position-badge">\u5F85\u63A5\u5165</span></div>
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
          <div class="orders-meta"><span class="orders-count"><b data-order-count>--</b> \u4E2A\u8BA2\u5355</span><button type="button" class="quiet-button">\u67E5\u770B\u5168\u90E8</button></div>
        </div>
        <div class="orders-table-wrap"><table class="orders-table"><thead><tr><th>\u65F6\u95F4</th><th>\u65B9\u5411</th><th>\u4EF7\u683C</th><th>\u6570\u91CF</th><th>\u6210\u4EA4\u989D</th><th>\u72B6\u6001</th></tr></thead><tbody><tr><td colspan="6">\u5F53\u524D\u573A\u6B21\u8BA2\u5355\u7B49\u5F85\u540E\u7AEF\u8FD4\u56DE</td></tr></tbody></table></div>
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
    if (node) node.textContent = value;
  };
  var renderMarketPool = function() {
    var enabledAssets = marketPool.desiredIds.map(assetById).filter(Boolean);
    var runningAssets = marketPool.currentIds.map(assetById).filter(Boolean);
    var visibleAssets = [...new Map([...runningAssets, ...enabledAssets].map((asset) => [asset.id, asset])).values()];
    var row = document.querySelector("[data-market-pool-row]");
    if (row) {
      row.innerHTML = visibleAssets.length ? visibleAssets.map(function(asset) {
        var running = marketPool.currentIds.includes(asset.id);
        var queued = marketPool.desiredIds.includes(asset.id);
        return `<div class="market-pool-chip ${running ? "running" : "queued"}"><span class="pool-coin-icon ${asset.tone}">${window.PolyPreview.format.escape(asset.icon)}</span><div><strong>${window.PolyPreview.format.escape(asset.symbol)}</strong><small>${running && !queued ? "本场继续 · 下场停用" : running ? "运行中" : "下一场加入"}</small></div><b>5M</b></div>`;
      }).join("") : '<div class="market-pool-empty"><span>＋</span><strong>暂无启用币种</strong><small>前往市场启用五分钟加密货币。</small></div>';
    }
    var activeMarket = runningAssets.length ? `${runningAssets[0].symbol}${runningAssets.length > 1 ? ` + ${runningAssets.length - 1} 个` : ""} / 5m YES-NO` : "等待启用币种";
    text("[data-active-market]", activeMarket);
    text("[data-market-pool-note]", visibleAssets.length ? `已启用 ${enabledAssets.length} 个币种；当前场次继续运行，新增币种从下一场加入。` : "尚未启用币种；前往市场选择要加入自动交易的五分钟市场。");
  };
  var renderSnapshot = function(raw) {
    raw = raw?.data && typeof raw.data === "object" ? raw.data : raw;
    if (!raw) return;
    var model = vm.market(raw.market || raw);
    var quote = function(key, value) { text(`[data-quote="${key}"]`, Number.isFinite(value) ? value.toFixed(3) : "--"); };
    quote("yes-bid", model.yesBid); quote("yes-ask", model.yesAsk); quote("no-bid", model.noBid); quote("no-ask", model.noAsk);
    var book = raw.book || raw.orderBook || raw.orderbook || {};
    var levels = function(side, kind) {
      var source = book[side] || book[side.toUpperCase()] || {};
      var list = Array.isArray(source) ? source : source[kind] || source[`${kind}s`] || [];
      return Array.isArray(list) ? list.map(function(level) { return Array.isArray(level) ? { price: Number(level[0]), size: Number(level[1]) } : { price: Number(level.price), size: Number(level.size ?? level.quantity ?? level.shares) }; }).filter(function(level) { return Number.isFinite(level.price) && Number.isFinite(level.size); }) : [];
    };
    ["yes", "no"].forEach(function(side) {
      var bids = levels(side, "bid"); var asks = levels(side, "ask");
      var render = function(list, tone) { return depthRows(list.slice(0, 5).map(function(level) { return level.price; }), list.slice(0, 5).map(function(level) { return level.size; }), tone); };
      var bidNode = document.querySelector(`[data-depth="${side}"]`); var askNode = document.querySelector(`[data-depth-asks="${side}"]`);
      if (bidNode) bidNode.innerHTML = render(bids, "bid");
      if (askNode) askNode.innerHTML = render(asks, "ask");
    });
    text("[data-book-source]", model.sourceAt || model.quoteAt ? `实时快照 · ${window.PolyPreview.format.time(model.sourceAt || model.quoteAt)}` : "快照时间未知");
    text("[data-book-age]", model.sourceAt || model.quoteAt ? window.PolyPreview.format.time(model.sourceAt || model.quoteAt) : "--");
  };
  var streams = [];
  var currentContext = function() {
    var id = marketPool.currentIds[0] || marketPool.desiredIds[0];
    var asset = assetById(id);
    return asset ? { assetId: asset.id, marketId: asset.marketId, roundId: asset.roundId } : { marketId: null, roundId: null };
  };
  var payloadOf = function(frame) { return frame?.data && typeof frame.data === "object" ? frame.data : frame?.payload && typeof frame.payload === "object" ? frame.payload : frame || {}; };
  var frameMatches = function(frame, requireRound) {
    var context = currentContext();
    var payload = payloadOf(frame);
    var marketId = payload.marketId || payload.market_id || frame?.marketId || frame?.market_id;
    var roundId = payload.roundId || payload.round_id || frame?.roundId || frame?.round_id;
    if (!marketId && !requireRound) return true;
    if (!context.marketId || marketId !== context.marketId) return false;
    if (requireRound && !context.roundId) return false;
    return !context.roundId || roundId === context.roundId;
  };
  var streamUrl = function(name) {
    var configured = window.PolyPreview.config.streams?.[name];
    return typeof configured === "string" ? configured : configured?.url || null;
  };
  var renderPosition = function(raw) {
    raw = raw?.data && typeof raw.data === "object" ? raw.data : raw;
    var position = raw?.position || raw;
    if (!position || typeof position !== "object") return;
    var number = function(...keys) { for (var key of keys) { var value = Number(position[key]); if (Number.isFinite(value)) return value; } return null; };
    var occupied = number("occupiedUsd", "occupied_usd");
    if (occupied != null) text("[data-invested]", `${occupied.toFixed(2)} USDC`);
    if (position.stage != null) text("[data-stage]", `阶段 ${position.stage}`);
    if (position.confirmations != null) text("[data-confirmations]", String(position.confirmations));
    var yesShares = number("yesShares", "yes_shares"); var noShares = number("noShares", "no_shares");
    if (yesShares != null) text('[data-holding="up"]', yesShares.toFixed(2));
    if (noShares != null) text('[data-holding="down"]', noShares.toFixed(2));
  };
  var renderOrders = function(raw) {
    raw = raw?.data && typeof raw.data === "object" ? raw.data : raw;
    var orders = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.orders) ? raw.orders : Array.isArray(raw) ? raw : [];
    var body = document.querySelector(".orders-table tbody");
    if (!body) return;
    text("[data-order-count]", String(orders.length));
    body.innerHTML = orders.length ? orders.slice(0, 20).map(function(order) {
      var side = order.side || order.outcome || order.token || "--";
      var price = Number(order.price); var size = Number(order.size ?? order.quantity ?? order.shares); var filled = Number(order.filled ?? order.filledSize ?? order.filled_size);
      return `<tr><td>${window.PolyPreview.format.time(order.updatedAt || order.createdAt || order.time)}</td><td>${window.PolyPreview.format.escape(String(side).toUpperCase())}</td><td>${Number.isFinite(price) ? price.toFixed(3) : "--"}</td><td>${Number.isFinite(size) ? size.toFixed(2) : "--"}</td><td>${Number.isFinite(filled) ? filled.toFixed(2) : "--"}</td><td>${window.PolyPreview.format.escape(order.status || "--")}</td></tr>`;
    }).join("") : '<tr><td colspan="6">当前场次暂无订单</td></tr>';
  };
  var stopStreams = function() { streams.splice(0).forEach(function(stream) { stream.close(); }); };
  var startStreams = function() {
    stopStreams();
    if (window.PolyPreview.config.mode === "local-preview" || !window.PolyPreviewStreams?.createStream) return;
    var context = currentContext();
    var hasMarketStream = Boolean(streamUrl("markets"));
    if (!hasMarketStream) text("[data-book-source]", "实时流未配置 · 保留最近快照");
    var make = function(name, requireRound, onMessage, onState) {
      var url = streamUrl(name); if (!url) return;
      var stream = window.PolyPreviewStreams.createStream(name, { url, acceptFrame: function(frame) { return frameMatches(frame, requireRound); }, onState, onMessage, onError: function(error) { text("[data-book-source]", error.message || "实时流不可用 · 保留最近快照"); } });
      stream.connect();
      stream.subscribe({ marketIds: context.marketId ? [context.marketId] : [], marketId: context.marketId, roundId: context.roundId || undefined });
      streams.push(stream);
    };
    make("markets", true, function(frame) {
      var payload = payloadOf(frame); var snapshot = payload.snapshot || payload;
      var hasQuote = ["yesBid", "yesAsk", "noBid", "noAsk", "yes_bid", "yes_ask", "no_bid", "no_ask"].some(function(key) { return snapshot[key] != null; });
      if (snapshot.book || snapshot.orderBook || snapshot.orderbook || hasQuote) { renderSnapshot(snapshot); text("[data-book-source]", "实时流 · 已连接"); }
    }, function(state) { if (state !== "connected") text("[data-book-source]", `实时流${state === "error" ? "错误" : "断开"} · 保留最近快照`); });
    make("orders", true, function(frame) { var payload = payloadOf(frame); if (payload.position) renderPosition(payload.position); if (payload.order) renderOrders([payload.order]); else if (payload.orders || payload.items) renderOrders(payload.orders || payload); }, function() {});
    make("runtime", false, function(frame) { var payload = payloadOf(frame); if (payload.status == null && payload.state == null && payload.running == null) return; var runtime = vm.runtime(payload); store.setSlice("runtime", { ...runtime, connectionStatus: "ready", stale: false, error: null }); }, function(state) {
      var current = store.getState().runtime;
      if (state === "connected") return;
      store.setSlice("runtime", { ...current, connectionStatus: state, runtimeState: current.runtimeState || current.status, stale: true, error: "运行状态流已断开，保留上次成功状态" });
    });
  };
  var loadCurrentMarket = async function() {
    if (window.PolyPreview.config.mode === "local-preview") return;
    var id = marketPool.currentIds[0] || marketPool.desiredIds[0];
    var asset = assetById(id);
    if (!asset?.marketId) return;
    text("[data-round-identity]", asset.roundId ? `marketId ${asset.marketId} · roundId ${asset.roundId}` : `marketId ${asset.marketId} · \u5F53\u524D\u8F6E\u6B21\u6807\u8BC6\u5F85\u540E\u7AEF\u63D0\u4F9B`);
    try {
      var raw = await adapter.loadMarketSnapshot(asset.marketId);
      renderSnapshot(raw);
      if (asset.roundId) {
        var results = await Promise.allSettled([adapter.loadPosition(asset.roundId), adapter.loadOrders(asset.roundId)]);
        var position = results[0].status === "fulfilled" ? results[0].value : null;
        var orders = results[1].status === "fulfilled" ? results[1].value : null;
        if (position) renderPosition(position);
        if (orders) renderOrders(orders);
      }
    } catch (error) { text("[data-book-source]", error.message || "实时快照不可用"); }
  };
  var streamLifecycleReady = false;
  renderMarketPool();
  store.subscribe("marketPool", function(value) {
    marketPool = value;
    renderMarketPool();
    if (streamLifecycleReady && window.PolyPreview.config.mode !== "local-preview") { void loadCurrentMarket(); startStreams(); }
  });
  store.subscribe("marketCatalog", function(value) {
    marketAssets = value.items.map(function(item) { return { id: item.assetId, marketId: item.marketId, roundId: item.roundId, symbol: item.symbol, name: item.name, icon: item.icon, tone: item.tone }; });
    renderMarketPool();
  });
  store.subscribe("runtime", function(runtime) {
    const local = window.PolyPreview.config.mode === "local-preview";
    const ready = runtime.status !== "unavailable" && !runtime.stale;
    text("[data-live-status]", local ? "设计稿 · 待接入" : ready ? runtime.status : "连接中断 · 保留状态");
    text("[data-connection-status]", local ? "演示数据 · 待接入" : runtime.status === "unavailable" ? "等待后端" : runtime.stale ? "连接中断 · 保留快照" : "已连接 · 独立流");
    text("[data-sidebar-state]", local ? "原型预览" : runtime.stale ? "连接中断" : runtime.status === "unavailable" ? "等待后端" : "运行状态已连接");
    text("[data-sidebar-detail]", local ? "数据待接入" : runtime.stale ? "保留最近成功状态" : runtime.status === "unavailable" ? "实时数据待接入" : "五分钟反转策略");
  });
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      button.disabled = true;
      try {
        const result = await adapter.commandRuntime({ action, marketIds: marketIdsForCommand(), strategyId: window.PolyPreview.config.strategyId, requestId: `console-${Date.now()}` });
        text("[data-live-status]", result.message || (result.accepted ? "指令已接收，等待运行状态确认" : "设计稿操作 · 后端未接入"));
        text("[data-strategy-status]", result.accepted ? "等待状态确认" : "待接入");
      } catch (error) { text("[data-live-status]", error.message || "控制请求失败"); }
      finally { button.disabled = false; }
    });
  });
  document.querySelectorAll("[data-preview-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.previewTarget;
      if (target) {
        window.location.href = target;
        return;
      }
      document.querySelectorAll("[data-preview-nav]").forEach((item) => {
        item.classList.toggle("active", item === button);
        if (item === button) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
      });
    });
  });
  // The preview intentionally does not synthesize quotes, latency, countdowns
  // or order events. A real adapter will push independent snapshots here;
  // keeping this page static avoids flicker and prevents fake "live" states.
  document.querySelectorAll(".quiet-button").forEach((button) => button.addEventListener("click", () => {
    text("[data-live-status]", "演示操作 · 后端未接入");
  }));
  if (window.PolyPreview.config.mode !== "local-preview") {
    Promise.all([adapter.loadMarkets(), adapter.loadMarketPool(), adapter.loadRuntime()]).then(function() { streamLifecycleReady = true; return loadCurrentMarket(); }).then(startStreams).catch(function(error) { text("[data-live-status]", error.message || "运行数据不可用"); });
  }
})();

