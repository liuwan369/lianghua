"use strict";
(() => {
  const store = window.PolyPreviewStore;
  const adapter = window.PolyPreviewAdapter;
  const toCoin = (market, pool) => ({
    ...market,
    id: market.assetId,
    yes: market.yesBid,
    no: market.noBid,
    enabled: pool.desiredIds.includes(market.assetId),
    running: pool.currentIds.includes(market.assetId)
  });
  let coins = [];
  const syncCoins = () => {
    const state = store.getState();
    coins = state.marketCatalog.items.map((market) => toCoin(market, state.marketPool));
  };
  syncCoins();
  const root = document.querySelector("#market-block-root");
  if (!root) throw new Error("market block root missing");

  const navItems = [
    ["◈", "总览", "overview.html"],
    ["◇", "市场", "market.html"],
    ["↗", "自动交易", "auto-trade.html"],
    ["◐", "策略", "strategy.html"],
    ["⚙", "设置", "settings.html"]
  ];
  const navMarkup = navItems.map(([icon, label, target]) => `<button class="nav-item${label === "市场" ? " active" : ""}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === "市场" ? ' aria-current="page"' : ""}><span>${icon}</span>${label}</button>`).join("");

  root.innerHTML = `
  <div class="overview-preview market-preview crypto-market-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>TRADING CONSOLE</small></div></div>
      <div class="brand-card"><span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span><strong>Polymarket</strong></div>
      <p class="sidebar-copy">选择平台支持的加密货币五分钟市场，并决定哪些币种加入自动交易。</p>
      <nav aria-label="加密货币市场导航">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>原型预览</span><small>数据待接入</small></div>
    </aside>

    <main class="preview-main market-main crypto-market-main">
      <header class="preview-header market-header crypto-market-header">
        <div class="hero-copy"><p class="eyebrow">CRYPTO MARKET POOL</p><div class="hero-title-row"><h1>加密货币市场</h1><span class="language-chip">5 分钟 · YES / NO</span></div><p class="subtitle">只展示平台支持的加密货币五分钟市场。启用币种后，自动交易可在运行中加入下一个可用场次。</p><div class="market-header-actions"><span class="market-note"><i></i>公开行情 · 仅展示演示数据</span><button class="hero-button" type="button" data-refresh-markets>刷新币种</button></div></div>
        <div class="market-header-side"><div class="header-status-grid"><article class="header-status"><span>支持币种</span><strong data-market-count>6 个</strong></article><article class="header-status"><span>已启用</span><strong class="status-good" data-enabled-count>2 个</strong></article><article class="header-status"><span>当前运行</span><strong data-running-count>1 个</strong></article><article class="header-status"><span>市场周期</span><strong class="status-good">固定 5 分钟</strong></article></div></div>
      </header>

      <section class="pool-toolbar"><div><p class="eyebrow">SUPPORTED ASSETS</p><h2>平台支持的币种</h2><p>选择币种查看当前场次；启用后会同步到自动交易的运行池。</p></div><div class="pool-toolbar-actions"><label class="search-box"><span>⌕</span><input type="search" placeholder="搜索 BTC、以太坊…" data-coin-search></label><span class="pool-sort"><i></i>按交易量排序</span></div></section>

      <section class="market-layout crypto-market-layout">
        <div class="coin-pool-panel">
          <div class="list-heading"><div><p class="eyebrow">5M CRYPTO POOL</p><h2>可用币种</h2></div><span class="list-caption" data-pool-caption>6 个支持币种</span></div>
          <div class="coin-list" data-coin-list aria-live="polite"></div>
          <div class="pool-footnote"><span class="info-dot">i</span><span>启用只改变自动交易运行池，不会立刻下单；当前场次继续使用已启动的币种，新增币种从下一个可用场次开始。</span></div>
        </div>

        <aside class="coin-detail-panel" aria-labelledby="coin-detail-title">
          <div class="detail-heading"><div><p class="eyebrow">SELECTED ASSET</p><h2 id="coin-detail-title" data-detail-title>比特币 · BTC</h2></div><span class="detail-state enabled" data-detail-state>已启用 · 运行中</span></div>
          <div class="coin-detail-identity"><span class="detail-coin-icon btc" data-detail-icon>₿</span><div><strong data-detail-name>比特币</strong><small data-detail-english>Bitcoin · BTC</small></div><span class="detail-cycle">5M</span></div>
          <div class="detail-quote-grid"><div class="detail-quote yes-quote"><div><span class="outcome-dot"></span><span>YES</span></div><strong data-detail-yes>0.486</strong><small>买入价 · 48.6%</small></div><div class="detail-quote no-quote"><div><span class="outcome-dot"></span><span>NO</span></div><strong data-detail-no>0.514</strong><small>买入价 · 51.4%</small></div></div>
          <div class="detail-stats"><div><span>本场结束</span><strong data-detail-close>14:10:00</strong></div><div><span>剩余时间</span><strong data-detail-remaining>02:18</strong></div><div><span>交易量</span><strong data-detail-volume>$284.6K</strong></div><div><span>流动性</span><strong data-detail-liquidity>$68.4K</strong></div></div>

          <section class="market-readiness"><div class="readiness-heading"><span>运行条件</span><small>平台已支持</small></div><ul><li class="passed"><i>✓</i><span>加密货币市场</span><b>通过</b></li><li class="passed"><i>✓</i><span>五分钟 YES / NO 场次</span><b>通过</b></li><li class="passed"><i>✓</i><span>行情和流动性可用</span><b>通过</b></li></ul></section>

          <section class="trade-link-card"><div class="trade-link-heading"><span class="link-icon">↗</span><div><p class="eyebrow">AUTO TRADE LINK</p><h3>自动交易关联</h3></div><span class="link-state" data-link-state>运行中</span></div><p data-link-copy>该币种已在自动交易运行池中，当前场次正在执行。</p><button class="enable-coin-button" type="button" data-detail-enable>停用并移出运行池</button><small data-link-note>停用只影响后续场次，不撤销当前场次订单。</small></section>
        </aside>
      </section>
      <div class="market-selection-note"><span class="note-icon">i</span><span data-selection-note>当前选择 BTC；自动交易会读取已启用币种并在下一场加入新币种。</span><span class="note-time" data-market-refresh-note>最后刷新 · 演示数据</span></div>
    </main>
  </div>`;

  let selectedId = store.getState().marketCatalog.selectedId || "btc";
  let search = "";
  const text = (selector, value) => { const node = document.querySelector(selector); if (node) node.textContent = value; };
  const money = (value) => Number.isFinite(value) ? value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : `$${value.toFixed(0)}` : "--";
  const selectedCoin = () => coins.find((coin) => coin.id === selectedId) || coins[0] || null;
  const escape = (value) => window.PolyPreview.format.escape(value);

  document.querySelectorAll("[data-preview-nav]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.previewTarget;
    if (target) window.location.href = target;
  }));

  const coinRow = (coin) => `<article class="coin-row${coin.id === selectedId ? " selected" : ""}" data-coin-row="${escape(coin.id)}">
    <button class="coin-select" type="button" data-select-coin="${escape(coin.id)}"><span class="coin-logo ${escape(coin.tone)}">${escape(coin.icon)}</span><span class="coin-main"><strong>${escape(coin.symbol)}<small>${escape(coin.name)} · ${escape(coin.english)}</small></strong><span class="coin-market-meta"><b>5 分钟</b><span>结束 ${escape(coin.close)}</span></span></span></button>
    <div class="coin-quotes"><span><small>YES</small><b>${Number.isFinite(coin.yes) ? coin.yes.toFixed(3) : "--"}</b></span><span><small>NO</small><b>${Number.isFinite(coin.no) ? coin.no.toFixed(3) : "--"}</b></span></div>
    <div class="coin-volume"><strong>${money(coin.volume)}</strong><small>交易量</small></div>
    <button class="coin-enable${coin.enabled ? " enabled" : ""}" type="button" data-enable-coin="${escape(coin.id)}" aria-pressed="${coin.enabled}"><i></i><span>${coin.enabled ? "已启用" : "未启用"}</span></button>
  </article>`;

  const renderCounts = () => {
    text("[data-market-count]", `${coins.length} 个`);
    text("[data-enabled-count]", `${coins.filter((coin) => coin.enabled).length} 个`);
    text("[data-running-count]", `${coins.filter((coin) => coin.running).length} 个`);
  };

  const renderList = () => {
    const list = document.querySelector("[data-coin-list]");
    if (!list) return;
    const query = search.trim().toLowerCase();
    const filtered = coins.filter((coin) => !query || `${coin.symbol} ${coin.name} ${coin.english}`.toLowerCase().includes(query));
    list.innerHTML = filtered.length ? filtered.map(coinRow).join("") : '<div class="market-empty"><span>⌕</span><strong>没有匹配的加密货币</strong><small>换一个币种名称或代码再试。</small></div>';
    text("[data-pool-caption]", query ? `匹配 ${filtered.length} 个币种` : `${coins.length} 个支持币种`);
    list.querySelectorAll("[data-select-coin]").forEach((button) => button.addEventListener("click", () => {
      selectedId = button.dataset.selectCoin;
      store.setSelectedMarket(selectedId);
      renderList();
      renderDetail();
    }));
    list.querySelectorAll("[data-enable-coin]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleEnabled(button.dataset.enableCoin);
    }));
  };

  const renderDetail = () => {
    const coin = selectedCoin();
    if (!coin) {
      ["[data-detail-title]", "[data-detail-name]", "[data-detail-english]", "[data-detail-yes]", "[data-detail-no]", "[data-detail-close]", "[data-detail-remaining]", "[data-detail-volume]", "[data-detail-liquidity]"].forEach((selector) => text(selector, "--"));
      text("[data-selection-note]", "暂无可用加密货币市场");
      return;
    }
    text("[data-detail-title]", `${coin.name} · ${coin.symbol}`);
    text("[data-detail-name]", coin.name);
    text("[data-detail-english]", `${coin.english} · ${coin.symbol}`);
    text("[data-detail-yes]", Number.isFinite(coin.yes) ? coin.yes.toFixed(3) : "--");
    text("[data-detail-no]", Number.isFinite(coin.no) ? coin.no.toFixed(3) : "--");
    text("[data-detail-close]", coin.close);
    text("[data-detail-remaining]", coin.remaining);
    text("[data-detail-volume]", money(coin.volume));
    text("[data-detail-liquidity]", money(coin.liquidity));
    const icon = document.querySelector("[data-detail-icon]");
    if (icon) { icon.textContent = coin.icon; icon.className = `detail-coin-icon ${coin.tone}`; }
    const state = document.querySelector("[data-detail-state]");
    if (state) { state.className = `detail-state ${coin.enabled || coin.running ? "enabled" : "disabled"}`; state.textContent = coin.running && !coin.enabled ? "本场继续 · 下场停用" : coin.running ? "已启用 · 运行中" : coin.enabled ? "已启用 · 待运行" : "未启用"; }
    const linkState = document.querySelector("[data-link-state]");
    if (linkState) { linkState.className = `link-state ${coin.enabled || coin.running ? "linked" : "unlinked"}`; linkState.textContent = coin.running && !coin.enabled ? "本场继续" : coin.running ? "运行中" : coin.enabled ? "下一场加入" : "未关联"; }
    text("[data-link-copy]", coin.running && !coin.enabled ? "该币种本场继续执行，停用将在本场结束后生效。" : coin.running ? "该币种已在自动交易运行池中，当前场次正在执行。" : coin.enabled ? "该币种已启用，自动交易将在下一个可用五分钟场次加入。" : "启用后，该币种会加入自动交易的下一场候选运行池。");
    text("[data-link-note]", coin.running ? "停用只影响后续场次，不撤销当前场次订单。" : "启用或停用只影响后续场次，不改变当前已运行订单。");
    const action = document.querySelector("[data-detail-enable]");
    if (action) { action.textContent = coin.enabled ? "停用（下一场生效）" : "启用并关联自动交易"; action.classList.toggle("selected", coin.enabled); }
    text("[data-selection-note]", coin.enabled ? `${coin.symbol} 已加入自动交易运行池；${coin.running ? "当前场次正在运行。" : "下一场可开始运行。"}` : `当前选择 ${coin.symbol}；启用后会加入自动交易下一场运行池。`);
  };

  function toggleEnabled(id) {
    const coin = coins.find((item) => item.id === id);
    if (!coin) return;
    coin.enabled = !coin.enabled;
    // running describes the already accepted current round. Disabling only
    // changes the desired pool for the next round; the backend owns rollover.
    store.setMarketPool({ desiredIds: coins.filter((item) => item.enabled).map((item) => item.id), currentIds: coins.filter((item) => item.running).map((item) => item.id), source: "local-preview" });
    syncCoins();
    renderCounts();
    renderList();
    renderDetail();
  }

  document.querySelector("[data-detail-enable]")?.addEventListener("click", () => toggleEnabled(selectedId));
  document.querySelector("[data-coin-search]")?.addEventListener("input", (event) => { search = event.target.value; renderList(); });
  document.querySelector("[data-refresh-markets]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await adapter.loadMarkets();
      syncCoins();
      renderCounts();
      renderList();
      renderDetail();
      text("[data-market-refresh-note]", `最后刷新 · ${window.PolyPreview.format.clock()}`);
    } catch (error) { text("[data-market-refresh-note]", error.message || "市场目录读取失败"); }
    finally { button.disabled = false; }
  });
  store.subscribe("marketCatalog", () => { syncCoins(); renderCounts(); renderList(); renderDetail(); });
  store.subscribe("marketPool", () => { syncCoins(); renderCounts(); renderList(); renderDetail(); });
  renderCounts();
  renderList();
  renderDetail();
  if (window.PolyPreview.config.mode !== "local-preview") void adapter.loadMarkets();
})();
