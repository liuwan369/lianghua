"use strict";
(() => {
  // src/overview-block.ts
  var root = document.querySelector("#overview-block-root");
  if (!root) throw new Error("overview block root missing");
  var store = window.PolyPreviewStore;
  var adapter = window.PolyPreviewAdapter;
  var navItems = [
    ["\u25C8", "\u603B\u89C8", "overview.html"],
    ["\u25C7", "\u5E02\u573A", "market.html"],
    ["\u2197", "\u81EA\u52A8\u4EA4\u6613", "auto-trade.html"],
    ["\u25D2", "\u7B56\u7565", "strategy.html"],
    ["\u2699", "\u8BBE\u7F6E", "settings.html"]
  ];
  var navMarkup = navItems.map(([icon, label, target]) => `<button class="nav-item${label === "\u603B\u89C8" ? " active" : ""}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === "\u603B\u89C8" ? ' aria-current="page"' : ""}><span>${icon}</span>${label}</button>`).join("");
  root.innerHTML = `
  <div class="overview-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand">
        <span class="brand-mark">P</span>
        <div><strong>POLYMARKET</strong><small>TRADING CONSOLE</small></div>
      </div>
      <div class="brand-card">
        <span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span>
        <strong>Polymarket</strong>
      </div>
      <p class="sidebar-copy">\u9762\u5411 平台支持加密货币 \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565\u7684\u4EA4\u6613\u63A7\u5236\u53F0\u603B\u89C8\u3002</p>
      <nav aria-label="\u603B\u89C8\u8BBE\u8BA1\u7A3F\u5BFC\u822A">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>\u539F\u578B\u9884\u89C8</span><small>\u6570\u636E\u5F85\u63A5\u5165</small></div>
    </aside>

    <main class="preview-main">
      <header class="preview-header">
        <div class="hero-copy">
          <p class="eyebrow">DASHBOARD CENTER</p>
          <div class="hero-title-row"><h1>\u603B\u89C8</h1><span class="language-chip">\u7B80\u4E2D</span></div>
          <p class="subtitle">\u67E5\u770B\u5F53\u524D\u4EA4\u6613\u72B6\u6001\u3001\u8D26\u6237\u6458\u8981\u3001\u670D\u52A1\u5668\u72B6\u6001\u548C\u8FD0\u884C\u4E8B\u4EF6\u3002</p>
          <div class="hero-actions"><button class="hero-button primary-action" type="button" data-overview-action="start">\u4E00\u952E\u542F\u52A8\u81EA\u52A8\u5316\u4EA4\u6613</button><button class="hero-button" type="button" data-overview-action="strategy">\u4FDD\u5B58\u914D\u7F6E</button><button class="hero-button" type="button" data-overview-action="refresh">\u5237\u65B0\u72B6\u6001</button><button class="hero-button exit-action" type="button" data-overview-action="exit">\u9000\u51FA\u7A0B\u5E8F</button></div>
        </div>
        <div class="header-tools"><div class="header-status-grid">
          <article class="header-status"><span>\u5F53\u524D\u54C1\u79CD</span><strong>\u5F53\u524D\u9009\u4E2D\u5E02\u573A 5 \u5206\u949F YES / NO</strong></article>
          <article class="header-status"><span>\u81EA\u52A8\u5316\u72B6\u6001</span><strong data-overview-runtime>\u672A\u542F\u52A8</strong></article>
          <article class="header-status"><span>\u8D26\u6237\u603B\u8D44\u4EA7</span><strong data-account-total>--</strong></article>
          <article class="header-status"><span>\u53EF\u7528\u4F59\u989D</span><strong data-account-available>--</strong></article>
        </div></div>
      </header>

      <section class="metrics-panel" aria-labelledby="metrics-title">
        <div class="panel-heading"><div><p class="eyebrow">PERFORMANCE SNAPSHOT</p><h2 id="metrics-title">\u4EA4\u6613\u7EDF\u8BA1</h2></div><span class="panel-meta">\u5F53\u524D\u8D26\u6237 \xB7 \u53EA\u8BFB\u6458\u8981</span></div>
        <div class="metrics-grid">
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark blue-mark">\u5355</span><div><h3>\u8BA2\u5355\u6570</h3><p>\u5DF2\u8BB0\u5F55\u7684\u8BA2\u5355\u6570\u91CF</p></div></div><strong class="metric-primary" data-metric="orders-current">--</strong><dl class="metric-rows"><div><dt>\u4ECA\u65E5</dt><dd data-metric="orders-today">--</dd></div><div><dt>\u5F53\u6708</dt><dd data-metric="orders-month">--</dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark amber-mark">\u76C8</span><div><h3>\u76C8 / \u4E8F</h3><p>\u80DC\u8D1F\u573A\u6B21\u7EDF\u8BA1</p></div></div><strong class="metric-primary"><span data-metric="wins-current">--</span> <em>/</em> <span data-metric="losses-current">--</span></strong><dl class="metric-rows"><div><dt>\u4ECA\u65E5</dt><dd><span data-metric="wins-today">--</span> / <span data-metric="losses-today">--</span></dd></div><div><dt>\u5F53\u6708</dt><dd><span data-metric="wins-month">--</span> / <span data-metric="losses-month">--</span></dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark green-mark">\u7387</span><div><h3>\u80DC\u7387</h3><p>\u5DF2\u5B8C\u6210\u573A\u6B21\u7684\u6BD4\u4F8B</p></div></div><strong class="metric-primary"><span data-metric="rate-current">--</span><em>%</em></strong><dl class="metric-rows"><div><dt>\u4ECA\u65E5</dt><dd><span data-metric="rate-today">--</span>%</dd></div><div><dt>\u5F53\u6708</dt><dd><span data-metric="rate-month">--</span>%</dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark violet-mark">\u51C0</span><div><h3>\u7D2F\u8BA1\u76C8\u5229</h3><p>\u5DF2\u7ED3\u7B97\u51C0\u7ED3\u679C</p></div></div><strong class="metric-primary"><span data-metric="pnl-current">--</span> <em>\u03BCUSD</em></strong><dl class="metric-rows"><div><dt>\u4ECA\u65E5</dt><dd><span data-metric="pnl-today">--</span> \u03BCUSD</dd></div><div><dt>\u5F53\u6708</dt><dd><span data-metric="pnl-month">--</span> \u03BCUSD</dd></div></dl></article>
        </div>
        <div class="metrics-footnote"><span class="info-dot">i</span><span data-metrics-state>\u4EC5\u7EDF\u8BA1\u5DF2\u53D6\u5F97\u7684\u771F\u5B9E\u8BB0\u5F55\uFF1B\u540E\u7AEF\u63A5\u5165\u540E\u518D\u663E\u793A\u771F\u5B9E\u8D26\u6237\u6570\u636E\u3002</span></div>
      </section>

      <section class="server-panel" aria-labelledby="server-title">
        <div class="panel-heading"><div><h2 id="server-title">\u670D\u52A1\u5668\u72B6\u6001</h2></div><span class="panel-meta server-expired">\u670D\u52A1\u5668\u72B6\u6001\u5F85\u63A5\u5165</span></div>
        <div class="server-metrics"><div><span>CPU</span><strong data-server="cpu">--</strong></div><div><span>\u5185\u5B58</span><strong data-server="memory">--</strong></div><div><span>\u78C1\u76D8</span><strong data-server="disk">--</strong></div><div><span>\u8D1F\u8F7D 1 / 5 / 15 \u5206\u949F</span><strong data-server="load">-- / -- / --</strong></div></div>
        <div class="server-services" data-server-services><div><span>\u63A7\u5236\u53F0</span><strong class="service-good">\u8BBE\u8BA1\u7A3F\u8FD0\u884C\u4E2D</strong><small>\u6570\u636E\u5F85\u63A5\u5165</small></div><div><span>\u884C\u60C5\u91C7\u96C6</span><strong>\u5F85\u63A5\u5165</strong><small>--</small></div><div><span>\u4EA4\u6613\u8FDB\u7A0B</span><strong>\u672A\u542F\u52A8</strong><small>--</small></div><div><span>\u8D26\u672C\u6295\u5F71</span><strong>\u5F85\u63A5\u5165</strong><small>--</small></div></div>
      </section>

      <section class="log-panel" aria-labelledby="log-title">
        <div class="panel-heading"><div><p class="eyebrow">SERVICE ACTIVITY</p><h2 id="log-title">\u8FD0\u884C\u65E5\u5FD7</h2></div><div class="log-state"><span class="state-dot"></span><span data-events-state>\u8BBE\u8BA1\u7A3F\u9884\u89C8</span><small>\u672C\u5730\u793A\u4F8B</small></div></div>
        <ol class="log-list" data-overview-log-list aria-live="polite">
          <li class="log-entry"><time>--</time><span class="log-icon neutral-icon">\u2022</span><div><strong>\u8FD0\u884C\u4E8B\u4EF6\u7B49\u5F85\u540E\u7AEF</strong><p>\u539F\u578B\u9884\u89C8\u4E0D\u4EE3\u8868\u5B9E\u65F6\u884C\u60C5\u3001\u8D26\u6237\u6216\u4EA4\u6613\u5DF2\u8FDE\u63A5</p></div><span class="log-status muted-text">\u5F85\u63A5\u5165</span></li>
        </ol>
        <div class="log-footer"><span><i class="tiny-dot"></i>\u53EA\u663E\u793A\u5F53\u524D\u8FD0\u884C\u76F8\u5173\u4E8B\u4EF6</span><span>\u5386\u53F2\u4E8B\u4EF6\u653E\u5728\u8BA2\u5355\u4E0E\u8FD0\u884C\u8BB0\u5F55\u4E2D</span></div>
      </section>
    </main>
  </div>
`;
  document.querySelectorAll("[data-preview-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.previewTarget;
      if (target) window.location.href = target;
    });
  });
  document.querySelectorAll("[data-overview-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.overviewAction;
    if (action === "start" || action === "exit") {
      button.disabled = true;
      const marketIds = store.getState().marketPool.desiredIds
        .map((assetId) => store.getState().marketCatalog.items.find((item) => item.assetId === assetId)?.marketId)
        .filter(Boolean);
      adapter.commandRuntime({ action: action === "start" ? "start" : "stop", marketIds, strategyId: window.PolyPreview.config.strategyId, requestId: `overview-${Date.now()}` })
        .then((result) => { text("[data-overview-runtime]", result.message || (result.accepted ? "等待确认" : "设计稿 · 待接入")); if (action === "start" && result.accepted) window.PolyPreview.navigate("auto-trade.html"); })
        .catch((error) => text("[data-overview-runtime]", error.message || "控制请求失败"))
        .finally(() => { button.disabled = false; });
      return;
    }
    if (action === "strategy") return window.PolyPreview?.navigate("strategy.html");
    if (action === "refresh") {
      button.disabled = true;
      Promise.allSettled([adapter.loadMarkets(), adapter.loadRuntime(), adapter.loadDiagnostics(), adapter.loadMetrics(), adapter.loadAccount(), adapter.loadEvents()])
        .then((results) => {
          const disconnected = results.some((result) => result.status === "fulfilled" && ["stale", "unavailable"].includes(result.value?.status));
          text(".server-expired", disconnected ? "连接中断 · 保留上次成功数据" : "状态已刷新 · 数据源已更新");
        })
        .finally(() => { button.disabled = false; });
    }
  }));
  const text = (selector, value) => { const node = document.querySelector(selector); if (node) node.textContent = value; };
  const read = (source, keys, fallback = null) => {
    for (const key of keys) {
      const value = key.split(".").reduce((current, part) => current == null ? undefined : current[part], source);
      if (value !== undefined && value !== null) return value;
    }
    return fallback;
  };
  const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const bytes = (value) => {
    let amount = finite(value);
    if (amount == null || amount < 0) return "--";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
    return `${amount.toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
  };
  const formatMetric = (value, digits = 0) => {
    const number = finite(value);
    return number == null ? "--" : number.toFixed(digits);
  };
  const periodValue = (data, period, fields, rootFields = fields) => {
    const root = data?.summary || data || {};
    const bucket = data?.[period] || data?.periods?.[period] || root?.[period] || {};
    return read(bucket, fields, read(root, rootFields));
  };
  const renderMetrics = (resource) => {
    const data = resource?.data;
    text("[data-metrics-state]", resource?.status === "stale" ? "统计接口断开，保留上次成功数据。" : resource?.status === "unavailable" ? "统计数据待接入。" : "仅统计已取得的真实记录；后端接入后再显示真实账户数据。");
    if (!data) return;
    const setMetric = (name, value) => text(`[data-metric="${name}"]`, value);
    ["current", "today", "month"].forEach((period) => {
      const suffix = period === "current" ? "current" : period;
      setMetric(`orders-${suffix}`, formatMetric(periodValue(data, period, ["orders", "orderCount", "order_count", "ordersCount"], ["orders", "orderCount", "order_count"])));
      setMetric(`wins-${suffix}`, formatMetric(periodValue(data, period, ["wins", "winCount", "win_count"], ["wins", "winCount", "win_count"])));
      setMetric(`losses-${suffix}`, formatMetric(periodValue(data, period, ["losses", "lossCount", "loss_count"], ["losses", "lossCount", "loss_count"])));
      const rate = finite(periodValue(data, period, ["winRate", "win_rate", "rate"], ["winRate", "win_rate", "rate"]));
      setMetric(`rate-${suffix}`, rate == null ? "--" : (rate <= 1 ? rate * 100 : rate).toFixed(2));
      setMetric(`pnl-${suffix}`, formatMetric(periodValue(data, period, ["pnlUsd", "pnl_usd", "profit", "settledPnl", "settled_pnl"], ["pnlUsd", "pnl_usd", "profit", "settledPnl", "settled_pnl"]), 2));
    });
  };
  const renderDiagnostics = (resource) => {
    const data = resource?.data;
    if (!data) return;
    text("[data-server=cpu]", `${formatMetric(data.cpu?.percent, 1)}% · ${data.cpu?.cores ?? "--"} 核`);
    text("[data-server=memory]", `${formatMetric(data.memory?.percent, 1)}% · ${bytes(data.memory?.used_bytes)} / ${bytes(data.memory?.total_bytes)}`);
    text("[data-server=disk]", `${formatMetric(data.disk?.percent, 1)}% · 可用 ${bytes(data.disk?.free_bytes)}`);
    text("[data-server=load]", [data.load?.one, data.load?.five, data.load?.fifteen].map((value) => formatMetric(value, 2)).join(" / "));
    const names = { dashboard: "控制台", collector: "行情采集", trader: "交易进程", projection: "账本投影" };
    const states = { active: "运行中", stopped: "未运行", inactive: "未运行", failed: "失败", activating: "启动中", deactivating: "停止中", unavailable: "不可用", unknown: "未知" };
    const services = document.querySelector("[data-server-services]");
    if (services && data.services) services.innerHTML = Object.entries(data.services).map(([name, service]) => {
      const state = String(service?.state || "unknown");
      const stateClass = state === "active" ? "service-good" : state === "stopped" || state === "inactive" ? "" : "service-warning";
      return `<div><span>${window.PolyPreview.format.escape(names[name] || name)}</span><strong class="${stateClass}">${window.PolyPreview.format.escape(states[state] || state)}</strong><small>PID ${service?.pid ?? "--"} · 内存 ${bytes(service?.rss_bytes)} · 运行 ${service?.uptime_seconds == null ? "--" : `${Math.floor(service.uptime_seconds)} 秒`}</small></div>`;
    }).join("");
    const stamp = data.asOf == null ? "" : window.PolyPreview.format.time(data.asOf);
    text(".server-expired", resource?.status === "stale"
      ? `连接中断 · 保留上次采样${stamp ? ` · ${stamp}` : ""}`
      : stamp ? `更新 ${stamp}` : "等待系统采样");
  };
  const renderAccount = (resource) => {
    const data = resource?.data;
    if (!data) return;
    const total = read(data, ["totalUsd", "total_usd", "equity", "balance"]);
    const available = read(data, ["availableUsd", "available_usd", "available", "cash"]);
    const formatUsd = (value) => { const amount = finite(value); return amount == null ? "--" : `${amount.toFixed(2)} USDC`; };
    text("[data-account-total]", formatUsd(total));
    text("[data-account-available]", formatUsd(available));
  };
  const renderEvents = (resource) => {
    text("[data-events-state]", resource?.status === "stale" ? "连接中断 · 保留上次事件" : resource?.status === "ready" ? "已连接" : "设计稿预览");
    if (resource?.status !== "ready") return;
    const items = Array.isArray(resource.items) ? resource.items : [];
    const list = document.querySelector("[data-overview-log-list]");
    if (!list) return;
    if (!items.length) { list.innerHTML = '<li class="log-entry"><time>--</time><span class="log-icon neutral-icon">•</span><div><strong>暂无运行事件</strong><p>后端返回新的事件后会在这里追加。</p></div><span class="log-status muted-text">空闲</span></li>'; return; }
    const icon = { error: "!", warning: "!", warn: "!", success: "✓", good: "✓" };
    list.innerHTML = items.slice(0, 8).map((item) => {
      const severity = String(item.severity || item.level || "info").toLowerCase();
      const time = item.time || item.createdAt || item.created_at || item.timestamp || "--";
      const message = item.message || item.title || item.event || "运行事件";
      const detail = item.detail || item.description || item.marketId || item.market || "";
      const statusClass = severity === "error" || severity === "warning" || severity === "warn" ? "muted-text" : severity === "success" || severity === "good" ? "good-text" : "info-text";
      return `<li class="log-entry"><time>${window.PolyPreview.format.escape(time)}</time><span class="log-icon ${statusClass.replace("-text", "-icon")}">${icon[severity] || "i"}</span><div><strong>${window.PolyPreview.format.escape(message)}</strong><p>${window.PolyPreview.format.escape(detail)}</p></div><span class="log-status ${statusClass}">${window.PolyPreview.format.escape(severity)}</span></li>`;
    }).join("");
  };
  store.subscribe("metrics", renderMetrics);
  store.subscribe("diagnostics", renderDiagnostics);
  store.subscribe("account", renderAccount);
  store.subscribe("events", renderEvents);
  store.subscribe("runtime", (runtime) => {
    const label = runtime.status === "unavailable" ? "设计稿 · 待接入" : runtime.status === "stale" ? "连接中断 · 保留上次状态" : runtime.status;
    text("[data-overview-runtime]", label);
  });
  if (window.PolyPreview.config.mode !== "local-preview") {
    void adapter.loadMarkets();
    void adapter.loadMarketPool();
    void adapter.loadRuntime();
    void adapter.loadDiagnostics();
    void adapter.loadMetrics();
    void adapter.loadAccount();
    void adapter.loadEvents();
  }
})();

