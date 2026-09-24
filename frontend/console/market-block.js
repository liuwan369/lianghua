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
      <div class="sidebar-status"><i></i><span data-sidebar-state>服务器数据</span><small data-sidebar-detail>等待行情</small></div>
    </aside>

    <main class="preview-main market-main crypto-market-main">
      <header class="preview-header market-header crypto-market-header">
        <div class="hero-copy"><p class="eyebrow">CRYPTO MARKET POOL</p><div class="hero-title-row"><h1>加密货币市场</h1><span class="language-chip">5 分钟 · YES / NO</span></div><p class="subtitle">只展示平台支持的加密货币五分钟市场。启用币种后，自动交易可在运行中加入下一个可用场次。</p><div class="market-header-actions"><span class="market-note" data-market-source><i></i>公开行情 · 等待服务器数据</span><button class="hero-button" type="button" data-refresh-markets>刷新币种</button></div></div>
        <div class="market-header-side"><div class="header-status-grid"><article class="header-status"><span>支持币种</span><strong data-market-count>6 个</strong></article><article class="header-status"><span>已启用</span><strong class="status-good" data-enabled-count>2 个</strong></article><article class="header-status"><span>当前运行</span><strong data-running-count>1 个</strong></article><article class="header-status"><span>市场周期</span><strong class="status-good">固定 5 分钟</strong></article></div></div>
      </header>

      <section class="pool-toolbar"><div><p class="eyebrow">SUPPORTED ASSETS</p><h2>平台支持的币种</h2><p>选择币种查看当前场次；单实例启用一个币种，切换将替换待运行配置。</p></div><div class="pool-toolbar-actions"><label class="search-box"><span>⌕</span><input type="search" placeholder="搜索币种名称或代码…" data-coin-search></label><span class="pool-sort"><i></i>按目录顺序</span></div></section>

      <section class="market-layout crypto-market-layout">
        <div class="coin-pool-panel">
          <div class="list-heading"><div><p class="eyebrow">5M CRYPTO POOL</p><h2>可用币种</h2></div><span class="list-caption" data-pool-caption>6 个支持币种</span></div>
          <div class="coin-list" data-coin-list aria-live="polite"></div>
          <div class="pool-footnote"><span class="info-dot">i</span><span>启用只改变自动交易运行池，不会立刻下单；当前场次继续使用已启动的币种，新增币种从下一个可用场次开始。</span></div>
        </div>

        <aside class="coin-detail-panel" aria-labelledby="coin-detail-title">
          <div class="detail-heading"><div><p class="eyebrow">SELECTED ASSET</p><h2 id="coin-detail-title" data-detail-title>等待选择市场</h2></div><span class="detail-state disabled" data-detail-state>待选择</span></div>
          <div class="coin-detail-identity"><span class="detail-coin-icon" data-detail-icon>?</span><div><strong data-detail-name>等待后端目录</strong><small data-detail-english>assetId · marketId · roundId</small></div><span class="detail-cycle">5M</span></div>
          <div class="detail-quote-grid"><div class="detail-quote yes-quote"><div><span class="outcome-dot"></span><span>YES</span></div><strong data-detail-yes>--</strong><small data-detail-yes-caption>买一 · --</small></div><div class="detail-quote no-quote"><div><span class="outcome-dot"></span><span>NO</span></div><strong data-detail-no>--</strong><small data-detail-no-caption>买一 · --</small></div></div>
          <div class="detail-stats"><div><span>本场结束</span><strong data-detail-close>14:10:00</strong></div><div><span>剩余时间</span><strong data-detail-remaining>02:18</strong></div><div><span>交易量</span><strong data-detail-volume>$284.6K</strong></div><div><span>流动性</span><strong data-detail-liquidity>$68.4K</strong></div></div>

          <section class="market-readiness"><div class="readiness-heading"><span>运行条件</span><small>以服务端确认为准</small></div><ul><li data-readiness="support"><i>·</i><span>运行时支持</span><b>待确认</b></li><li data-readiness="identity"><i>·</i><span>五分钟 YES / NO 场次</span><b>待确认</b></li><li data-readiness="quote"><i>·</i><span>当前报价</span><b>待确认</b></li></ul></section>

          <section class="trade-link-card"><div class="trade-link-heading"><span class="link-icon">↗</span><div><p class="eyebrow">AUTO TRADE LINK</p><h3>自动交易关联</h3></div><span class="link-state" data-link-state>运行中</span></div><p data-link-copy>该币种已在自动交易运行池中，当前场次正在执行。</p><button class="enable-coin-button" type="button" data-detail-enable>停用并移出运行池</button><small data-link-note>停用只影响后续场次，不撤销当前场次订单。</small></section>
        </aside>
      </section>
      <div class="market-selection-note"><span class="note-icon">i</span><span data-selection-note>当前选择 BTC；自动交易会读取已启用币种并在下一场加入新币种。</span><span class="note-time" data-market-refresh-note>最后刷新 · 等待服务器</span></div>
    </main>
  </div>`;

  let selectedId = store.getState().marketCatalog.selectedId || null;
  let search = "";
  let poolSaving = false;
  const text = (selector, value) => { const node = document.querySelector(selector); if (node && node.textContent !== String(value)) node.textContent = value; };
  const money = (value) => Number.isFinite(value) ? value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : `$${value.toFixed(0)}` : "--";
  const selectedCoin = () => coins.find((coin) => coin.id === selectedId) || null;
  const escape = (value) => window.PolyPreview.format.escape(value);

  document.querySelectorAll("[data-preview-nav]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.previewTarget;
    if (target) window.PolyPreview.navigate(target);
  }));

  const coinRow = (coin) => `<article class="coin-row${coin.id === selectedId ? " selected" : ""}" data-coin-row="${escape(coin.id)}">
    <button class="coin-select" type="button" data-select-coin="${escape(coin.id)}"><span class="coin-logo ${escape(coin.tone)}">${escape(coin.icon)}</span><span class="coin-main"><strong>${escape(coin.symbol)}<small>${escape(coin.name)} · ${escape(coin.english)}</small></strong><span class="coin-market-meta"><b>5 分钟</b><span>结束 ${escape(coin.close)}</span></span></span></button>
    <div class="coin-quotes"><span><small>YES</small><b>${Number.isFinite(coin.yes) ? coin.yes.toFixed(3) : "--"}</b></span><span><small>NO</small><b>${Number.isFinite(coin.no) ? coin.no.toFixed(3) : "--"}</b></span></div>
    <div class="coin-volume"><strong>${money(coin.volume)}</strong><small>交易量</small></div>
    <button class="coin-enable${coin.enabled ? " enabled" : ""}" type="button" data-enable-coin="${escape(coin.id)}" aria-pressed="${coin.enabled}"><i></i><span>${coin.enabled ? "已启用" : coin.canEnable ? "未启用" : "暂不可用"}</span></button>
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
    const rows = new Map([...list.querySelectorAll("[data-coin-row]")].map((row) => [row.dataset.coinRow, row]));
    const visible = new Set(filtered.map((coin) => coin.id));
    for (const [id, row] of rows) if (!visible.has(id)) row.remove();
    list.querySelector(".market-empty")?.remove();
    let previous = null;
    filtered.forEach((coin) => {
      let row = rows.get(coin.id);
      const identity = JSON.stringify([coin.symbol, coin.name, coin.english, coin.icon, coin.tone]);
      if (!row || row.dataset.identity !== identity) {
        const template = document.createElement("template");
        template.innerHTML = coinRow(coin);
        const next = template.content.firstElementChild;
        next.dataset.identity = identity;
        if (row) row.replaceWith(next);
        row = next;
      }
      const before = previous ? previous.nextElementSibling : list.firstElementChild;
      if (before !== row) list.insertBefore(row, before);
      previous = row;
      row.classList.toggle("selected", coin.id === selectedId);
      const set = (selector, value) => { const node = row.querySelector(selector); if (node && node.textContent !== value) node.textContent = value; };
      const quotes = row.querySelectorAll(".coin-quotes b");
      [coin.yes, coin.no].forEach((value, index) => { const rendered = Number.isFinite(value) ? value.toFixed(3) : "--"; if (quotes[index].textContent !== rendered) quotes[index].textContent = rendered; });
      set(".coin-volume strong", money(coin.volume));
      set(".coin-market-meta span", `结束 ${coin.close}`);
      const button = row.querySelector("[data-enable-coin]");
      const waiting = poolSaving || Boolean(store.getState().marketPool.pendingDesiredIds);
      button.disabled = waiting || !coin.enabled && !coin.canEnable;
      button.title = waiting ? "等待服务器确认运行池" : !coin.canEnable && !coin.enabled ? "服务器未声明该币种可运行" : "";
      button.classList.toggle("enabled", coin.enabled);
      button.setAttribute("aria-pressed", String(coin.enabled));
      set("[data-enable-coin] span", waiting ? "等待确认" : coin.enabled ? "已启用" : coin.canEnable ? "未启用" : "暂不可用");
    });
    if (!filtered.length) list.innerHTML = '<div class="market-empty"><span>⌕</span><strong>没有匹配的加密货币</strong><small>换一个币种名称或代码再试。</small></div>';
    text("[data-pool-caption]", query ? `匹配 ${filtered.length} 个币种` : `${coins.length} 个支持币种`);
  };
  document.querySelector("[data-coin-list]")?.addEventListener("click", (event) => {
    const selection = event.target.closest("[data-select-coin]");
    if (selection) { store.setSelectedMarket(selection.dataset.selectCoin); return; }
    const enable = event.target.closest("[data-enable-coin]");
    if (enable && !enable.disabled) void toggleEnabled(enable.dataset.enableCoin);
  });

  const renderDetail = () => {
    const coin = selectedCoin();
    const checks = { support: coin?.canEnable === true, identity: Boolean(coin?.marketId && coin?.roundId && coin.cycle === "5m"), quote: Boolean(coin && !coin.stale && !store.getState().marketCatalog.stale && Number.isFinite(coin.yes) && Number.isFinite(coin.no)) };
    Object.entries(checks).forEach(([name, passed]) => {
      const node = document.querySelector(`[data-readiness="${name}"]`);
      if (node) { node.classList.toggle("passed", passed); node.querySelector("i").textContent = passed ? "✓" : "·"; node.querySelector("b").textContent = passed ? "已确认" : "待确认"; }
    });
    if (!coin) {
      ["[data-detail-title]", "[data-detail-name]", "[data-detail-english]", "[data-detail-yes]", "[data-detail-no]", "[data-detail-close]", "[data-detail-remaining]", "[data-detail-volume]", "[data-detail-liquidity]"].forEach((selector) => text(selector, "--"));
      const detailState = document.querySelector("[data-detail-state]");
      if (detailState) { detailState.className = "detail-state disabled"; detailState.textContent = "待接入"; }
      const linkState = document.querySelector("[data-link-state]");
      if (linkState) { linkState.className = "link-state unlinked"; linkState.textContent = "待接入"; }
      const action = document.querySelector("[data-detail-enable]");
      if (action) { action.disabled = true; action.textContent = "等待市场目录"; action.classList.remove("selected"); }
      text("[data-link-copy]", "后端返回有效市场目录后，这里才会显示运行池关联状态。");
      text("[data-link-note]", "没有有效目录时不会修改运行池。");
      text("[data-selection-note]", "暂无可用加密货币市场");
      text("[data-detail-yes-caption]", "买一 · --"); text("[data-detail-no-caption]", "买一 · --");
      return;
    }
    text("[data-detail-title]", `${coin.name} · ${coin.symbol}`);
    text("[data-detail-name]", coin.name);
    text("[data-detail-english]", `${coin.english} · ${coin.symbol}`);
    text("[data-detail-yes]", Number.isFinite(coin.yes) ? coin.yes.toFixed(3) : "--");
    text("[data-detail-no]", Number.isFinite(coin.no) ? coin.no.toFixed(3) : "--");
    text("[data-detail-yes-caption]", Number.isFinite(coin.yes) ? `买一 · ${(coin.yes * 100).toFixed(1)}%` : "买一 · --");
    text("[data-detail-no-caption]", Number.isFinite(coin.no) ? `买一 · ${(coin.no * 100).toFixed(1)}%` : "买一 · --");
    text("[data-detail-close]", coin.close);
    text("[data-detail-remaining]", coin.remaining);
    text("[data-detail-volume]", money(coin.volume));
    text("[data-detail-liquidity]", money(coin.liquidity));
    const icon = document.querySelector("[data-detail-icon]");
    if (icon) { icon.textContent = coin.icon; icon.className = `detail-coin-icon ${coin.tone}`; }
    const state = document.querySelector("[data-detail-state]");
    if (state) { state.className = `detail-state ${coin.enabled || coin.running ? "enabled" : "disabled"}`; state.textContent = !coin.canEnable && !coin.enabled ? "服务器未确认支持" : coin.running && !coin.enabled ? "本场继续 · 下场停用" : coin.running ? "已启用 · 运行中" : coin.enabled ? "已启用 · 待运行" : "未启用"; }
    const linkState = document.querySelector("[data-link-state]");
    if (linkState) { linkState.className = `link-state ${coin.enabled || coin.running ? "linked" : "unlinked"}`; linkState.textContent = coin.running && !coin.enabled ? "本场继续" : coin.running ? "运行中" : coin.enabled ? "下一场加入" : "未关联"; }
    text("[data-link-copy]", coin.running && !coin.enabled ? "该币种本场继续执行，停用将在本场结束后生效。" : coin.running ? "该币种已在自动交易运行池中，当前场次正在执行。" : coin.enabled ? "该币种已启用，自动交易将在下一个可用五分钟场次加入。" : "启用后，该币种会加入自动交易的下一场候选运行池。");
    text("[data-link-note]", coin.running ? "停用只影响后续场次，不撤销当前场次订单。" : "启用或停用只影响后续场次，不改变当前已运行订单。");
    const action = document.querySelector("[data-detail-enable]");
    if (action) { action.disabled = poolSaving || Boolean(store.getState().marketPool.pendingDesiredIds) || !coin.enabled && !coin.canEnable; action.textContent = poolSaving ? "提交中…" : store.getState().marketPool.pendingDesiredIds ? "等待服务器确认" : coin.enabled ? "停用（下一场生效）" : coin.canEnable ? "启用此币种（替换待运行配置）" : "服务器未确认可运行"; action.classList.toggle("selected", coin.enabled); }
    text("[data-selection-note]", !coin.canEnable && !coin.enabled ? `${coin.symbol} 已在市场目录中，但服务器尚未确认可加入运行池。` : coin.enabled ? `${coin.symbol} 已加入自动交易运行池；${coin.running ? "当前场次正在运行。" : "等待服务器确认下一场状态。"}` : `当前选择 ${coin.symbol}；启用后会加入自动交易下一场运行池。`);
  };
  const renderCatalogStatus = (resource) => {
    const local = window.PolyPreview.config.mode === "local-preview";
    const status = resource?.status;
    const incompleteIdentity = !local && resource?.items?.some((item) => !item.marketId || !item.roundId);
    const textValue = local ? "服务器未连接" : status === "error" ? "行情读取失败 · 保留上次快照" : status === "stale" ? "行情连接中断 · 保留上次快照" : status === "unavailable" ? "行情待接入" : incompleteIdentity ? "行情已读取 · 轮次标识待接入" : "公开行情 · 已连接";
    text("[data-market-source]", textValue);
    text("[data-sidebar-state]", local ? "原型预览" : status === "ready" ? (incompleteIdentity ? "轮次标识待接入" : "行情已连接") : status === "error" ? "行情读取失败" : "数据连接");
    text("[data-sidebar-detail]", local ? "服务器未连接" : status === "error" ? "保留最近成功数据" : status === "stale" ? "保留最近成功数据" : status === "unavailable" ? "等待后端" : incompleteIdentity ? "目录/报价可用，持仓订单等待 roundId" : "五分钟市场");
    if (!local && ["error", "stale", "unavailable"].includes(status)) text("[data-market-refresh-note]", status === "error" ? `读取失败 · ${resource.error || "保留上次数据"}` : status === "unavailable" ? "行情待接入 · 保留上次数据" : `连接中断 · ${resource.error || "保留上次数据"}`);
  };

  async function toggleEnabled(id) {
    if (poolSaving || store.getState().marketPool.pendingDesiredIds) return;
    const coin = coins.find((item) => item.id === id);
    if (!coin) return;
    if (!coin.enabled && !coin.canEnable) {
      text("[data-selection-note]", `${coin.symbol} 当前由服务器标记为 unsupported/unavailable，未修改运行池。`);
      return;
    }
    const state = store.getState();
    const desiredIds = coin.enabled ? state.marketPool.desiredIds.filter((value) => value !== id) : [id];
    let resultMessage = null;
    poolSaving = true;
    renderList(); renderDetail();
    text("[data-selection-note]", `${coin.symbol} 运行池更新中…`);
    try {
      // The current round is server-owned. Only desiredIds is changed here;
      // the backend decides when currentIds/nextRoundIds roll over.
      await adapter.saveMarketPool({ desiredIds, effectiveRoundId: state.marketPool.effectiveRoundId });
      const pool = store.getState().marketPool;
      text("[data-market-refresh-note]", pool.pendingDesiredIds ? "已提交 · 等待服务器确认运行池" : `运行池已确认 · ${window.PolyPreview.format.clock()}`);
      if (pool.pendingDesiredIds) resultMessage = "服务器已接收变更请求，生效状态仍以确认后的运行池为准。";
    } catch (error) {
      resultMessage = error.message || "运行池更新失败，保留当前状态";
    } finally {
      poolSaving = false;
      renderList(); renderDetail();
      if (resultMessage) text("[data-selection-note]", resultMessage);
    }
  }

  document.querySelector("[data-detail-enable]")?.addEventListener("click", () => { void toggleEnabled(selectedId); });
  document.querySelector("[data-coin-search]")?.addEventListener("input", (event) => { search = event.target.value; renderList(); });
  let marketRefreshTimer = null;
  let marketRefreshInFlight = null;
  const scheduleMarketRefresh = (delay = 1000) => {
    if (window.PolyPreview.config.mode === "local-preview" || document.hidden) return;
    if (marketRefreshTimer) window.clearTimeout(marketRefreshTimer);
    marketRefreshTimer = window.setTimeout(() => {
      marketRefreshTimer = null;
      void refreshMarkets();
    }, Math.max(0, delay));
  };
  const refreshMarkets = () => {
    if (marketRefreshInFlight) return marketRefreshInFlight;
    marketRefreshInFlight = Promise.resolve(adapter.loadMarkets()).finally(() => {
      marketRefreshInFlight = null;
      scheduleMarketRefresh();
    });
    return marketRefreshInFlight;
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (marketRefreshTimer) window.clearTimeout(marketRefreshTimer);
      marketRefreshTimer = null;
    } else {
      scheduleMarketRefresh(0);
    }
  });
  document.querySelector("[data-refresh-markets]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const resource = await refreshMarkets();
      syncCoins();
      renderCounts();
      renderList();
      renderDetail();
      text("[data-market-refresh-note]", resource?.status === "error" ? `读取失败 · ${resource.error || "保留上次数据"}` : resource?.status === "stale" || resource?.status === "unavailable"
        ? `${resource.status === "unavailable" ? "行情待接入" : "连接中断"} · ${resource.error || "保留上次数据"}`
        : `最后刷新 · ${window.PolyPreview.format.clock()}`);
    } catch (error) { text("[data-market-refresh-note]", error.message || "市场目录读取失败"); }
    finally { button.disabled = false; }
  });
  store.subscribe("marketCatalog", (value) => { selectedId = value.selectedId || null; syncCoins(); renderCounts(); renderList(); renderDetail(); renderCatalogStatus(value); });
  store.subscribe("marketPool", () => { syncCoins(); renderCounts(); renderList(); renderDetail(); });
  renderCounts();
  renderList();
  renderDetail();
  if (window.PolyPreview.config.mode !== "local-preview") {
    void refreshMarkets();
    void adapter.loadMarketPool();
  }
})();
