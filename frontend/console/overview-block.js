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
        <div><strong>POLYMARKET</strong><small>交易控制台</small></div>
      </div>
      <div class="brand-card">
        <span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span>
        <strong>Polymarket</strong>
      </div>
      <p class="sidebar-copy">\u9762\u5411 平台支持加密货币 \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565\u7684\u4EA4\u6613\u63A7\u5236\u53F0\u603B\u89C8\u3002</p>
      <nav aria-label="\u603B\u89C8\u5BFC\u822A">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>服务器数据</span><small>等待后端连接</small></div>
    </aside>

    <main class="preview-main">
      <header class="preview-header">
        <div class="hero-copy">
          <p class="eyebrow">控制台总览</p>
          <div class="hero-title-row"><h1>\u603B\u89C8</h1><span class="language-chip">\u7B80\u4E2D</span></div>
          <p class="subtitle">\u67E5\u770B\u5F53\u524D\u4EA4\u6613\u72B6\u6001\u3001\u8D26\u6237\u6458\u8981\u3001\u670D\u52A1\u5668\u72B6\u6001\u548C\u8FD0\u884C\u4E8B\u4EF6\u3002</p>
          <div class="hero-actions"><button class="hero-button primary-action" type="button" data-overview-action="start">\u4E00\u952E\u542F\u52A8\u81EA\u52A8\u5316\u4EA4\u6613</button><button class="hero-button" type="button" data-overview-action="strategy">\u4FDD\u5B58\u914D\u7F6E</button><button class="hero-button" type="button" data-overview-action="refresh">\u5237\u65B0\u72B6\u6001</button><button class="hero-button exit-action" type="button" data-overview-action="exit">\u9000\u51FA\u7A0B\u5E8F</button></div>
          <p class="control-feedback" data-overview-control-message role="status" aria-live="polite">正在检查启动条件…</p>
        </div>
        <div class="header-tools"><div class="header-status-grid">
          <article class="header-status"><span>\u5F53\u524D\u54C1\u79CD</span><strong>等待市场目录</strong></article>
          <article class="header-status"><span>\u81EA\u52A8\u5316\u72B6\u6001</span><strong data-overview-runtime>\u672A\u542F\u52A8</strong></article>
          <article class="header-status"><span>\u8D26\u6237\u603B\u8D44\u4EA7</span><strong data-account-total>--</strong></article>
          <article class="header-status"><span>\u53EF\u7528\u4F59\u989D</span><strong data-account-available>--</strong></article>
        </div></div>
      </header>

      <section class="metrics-panel" aria-labelledby="metrics-title">
        <div class="panel-heading"><div><p class="eyebrow">运行表现</p><h2 id="metrics-title">\u4EA4\u6613\u7EDF\u8BA1</h2></div><span class="panel-meta">\u5F53\u524D\u8D26\u6237 \xB7 \u53EA\u8BFB\u6458\u8981</span></div>
        <div class="metrics-grid">
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark blue-mark">\u5355</span><div><h3>\u8BA2\u5355\u6570</h3><p>\u5DF2\u8BB0\u5F55\u7684\u8BA2\u5355\u6570\u91CF</p></div></div><strong class="metric-primary" data-metric="orders-current">--</strong><dl class="metric-rows"><div><dt>\u4ECA\u65E5</dt><dd data-metric="orders-today">--</dd></div><div><dt>\u5F53\u6708</dt><dd data-metric="orders-month">--</dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark amber-mark">\u76C8</span><div><h3>\u76C8 / \u4E8F</h3><p>\u80DC\u8D1F\u573A\u6B21\u7EDF\u8BA1</p></div></div><strong class="metric-primary"><span data-metric="wins-current">--</span> <em>/</em> <span data-metric="losses-current">--</span></strong><dl class="metric-rows"><div><dt>\u4ECA\u65E5</dt><dd><span data-metric="wins-today">--</span> / <span data-metric="losses-today">--</span></dd></div><div><dt>\u5F53\u6708</dt><dd><span data-metric="wins-month">--</span> / <span data-metric="losses-month">--</span></dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark green-mark">\u7387</span><div><h3>\u80DC\u7387</h3><p>\u5DF2\u5B8C\u6210\u573A\u6B21\u7684\u6BD4\u4F8B</p></div></div><strong class="metric-primary"><span data-metric="rate-current">--</span><em>%</em></strong><dl class="metric-rows"><div><dt>\u4ECA\u65E5</dt><dd><span data-metric="rate-today">--</span>%</dd></div><div><dt>\u5F53\u6708</dt><dd><span data-metric="rate-month">--</span>%</dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark violet-mark">\u51C0</span><div><h3>\u7D2F\u8BA1\u76C8\u5229</h3><p>\u5DF2\u7ED3\u7B97\u51C0\u7ED3\u679C</p></div></div><strong class="metric-primary"><span data-metric="pnl-current">--</span> <em>USDC</em></strong><dl class="metric-rows"><div><dt>\u4ECA\u65E5</dt><dd><span data-metric="pnl-today">--</span> USDC</dd></div><div><dt>\u5F53\u6708</dt><dd><span data-metric="pnl-month">--</span> USDC</dd></div></dl></article>
        </div>
        <div class="metrics-footnote"><span class="info-dot">i</span><span data-metrics-state>\u4EC5\u7EDF\u8BA1\u5DF2\u53D6\u5F97\u7684\u771F\u5B9E\u8BB0\u5F55\uFF1B\u540E\u7AEF\u63A5\u5165\u540E\u518D\u663E\u793A\u771F\u5B9E\u8D26\u6237\u6570\u636E\u3002</span></div>
      </section>

      <section class="server-panel" aria-labelledby="server-title">
        <div class="panel-heading"><div><h2 id="server-title">\u670D\u52A1\u5668\u72B6\u6001</h2></div><span class="panel-meta server-expired">\u670D\u52A1\u5668\u72B6\u6001\u5F85\u63A5\u5165</span></div>
        <div class="server-metrics"><div><span>CPU</span><strong data-server="cpu">--</strong></div><div><span>\u5185\u5B58</span><strong data-server="memory">--</strong></div><div><span>\u78C1\u76D8</span><strong data-server="disk">--</strong></div><div><span>\u8D1F\u8F7D 1 / 5 / 15 \u5206\u949F</span><strong data-server="load">-- / -- / --</strong></div></div>
        <div class="server-services" data-server-services><div><span>\u63A7\u5236\u53F0</span><strong>\u5F85\u540E\u7AEF\u786E\u8BA4</strong><small>--</small></div><div><span>\u884C\u60C5\u91C7\u96C6</span><strong>\u5F85\u63A5\u5165</strong><small>--</small></div><div><span>\u4EA4\u6613\u8FDB\u7A0B</span><strong>\u5F85\u540E\u7AEF\u786E\u8BA4</strong><small>--</small></div><div><span>\u8D26\u672C\u6295\u5F71</span><strong>\u5F85\u63A5\u5165</strong><small>--</small></div></div>
      </section>

      <section class="log-panel" aria-labelledby="log-title">
        <div class="panel-heading"><div><p class="eyebrow">\u7CFB\u7EDF\u4E8B\u4EF6</p><h2 id="log-title">\u8FD0\u884C\u65E5\u5FD7</h2></div><div class="log-state"><span class="state-dot"></span><span data-events-state>\u4E8B\u4EF6\u5F85\u63A5\u5165</span><small>\u670D\u52A1\u5668\u6570\u636E</small></div></div>
        <ol class="log-list" data-overview-log-list aria-live="polite">
          <li class="log-entry"><time>--</time><span class="log-icon neutral-icon">\u2022</span><div><strong>\u8FD0\u884C\u4E8B\u4EF6\u5F85\u540E\u7AEF\u8FD4\u56DE</strong><p>\u672A\u6536\u5230\u670D\u52A1\u5668\u4E8B\u4EF6\uFF0C\u6CA1\u6709\u5047\u6570\u636E\u5C55\u793A</p></div><span class="log-status muted-text">\u5F85\u63A5\u5165</span></li>
        </ol>
        <div class="log-footer"><span><i class="tiny-dot"></i>\u53EA\u663E\u793A\u5F53\u524D\u8FD0\u884C\u76F8\u5173\u4E8B\u4EF6</span><span>\u5386\u53F2\u4E8B\u4EF6\u653E\u5728\u8BA2\u5355\u4E0E\u8FD0\u884C\u8BB0\u5F55\u4E2D</span></div>
      </section>
    </main>
  </div>
`;
  document.querySelectorAll("[data-preview-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.previewTarget;
      if (target) window.PolyPreview.navigate(target);
    });
  });
  const overviewStartReason = () => {
    const state = store.getState();
    const assetId = state.marketPool.desiredIds[0] || state.marketCatalog.selectedId || window.PolyPreview.config.selectedAssetId;
    const runtime = state.runtime || {};
    if (runtime.processRunning === true) return "服务器已确认进程正在运行，请先停止或等待状态确认";
    if (runtime.processRunning !== false) return "服务器进程状态未知，暂不允许启动";
    if (runtime.stale) return "运行状态已过期，暂不允许启动";
    const runtimeState = runtime.runtimeState || runtime.status;
    if (!runtime.stale && ["running", "starting", "paused", "stopping"].includes(runtimeState)) return "服务器仍有运行状态，请先停止或等待状态确认";
    const item = state.marketCatalog.items.find((market) => market.assetId === assetId);
    if (!assetId || !item?.marketId || !item.roundId) return "请先等待服务器返回完整市场身份";
    if (item.canEnable !== true) return "服务器尚未确认该市场可加入运行池";
    if (item.stale === true || state.marketCatalog.stale) return "行情目录或行情已过期，暂不允许启动";
    const initialPool = store.canInitializeMarketPool(state.marketPool);
    if ((!initialPool && (state.marketPool.status !== "ready" || state.marketPool.stale || !state.marketPool.desiredIds.includes(assetId)))) return "请先在市场页面确认运行池";
    const snapshotFresh = window.PolyPreviewViewModel.hasFreshBbo(item);
    if (!snapshotFresh) return "当前盘口快照未新鲜确认，暂不允许启动";
    const strategy = state.strategy || {};
    if (strategy.status !== "ready" || strategy.stale === true || strategy.error || !(strategy.revision > 0)) return "请先在策略页面保存并激活有效版本";
    const strategyAssetReason = window.PolyPreviewViewModel.strategyAssetStartReason(strategy, assetId);
    if (strategyAssetReason) return strategyAssetReason;
    const account = state.accountStatus?.data || {};
    if (state.accountStatus?.status !== "ready" || state.accountStatus?.stale === true || state.accountStatus?.error) return "账户状态暂不可用，请刷新服务器账户状态";
    const accountErrors = {
      account_rpc_failed: "区块链节点查询失败，请检查网络连接",
      account_check_failed: "账户检查未通过，请查看账户配置和授权",
      account_checker_unavailable: "服务器账户检查程序暂不可用",
      account_check_busy: "已有账户检查正在进行，请稍候",
      invalid_account_config: "账户配置格式不正确",
      wallet_address_mismatch: "钱包地址与签名私钥不匹配",
      approvals_missing: "交易授权未完成",
      settlement_credentials_unavailable: "结算凭据不可用"
    };
    const errorCode = String(account.last_check_error || "").toLowerCase().split(/[:：]/, 1)[0];
    if (account.account_check_ready !== true) return account.last_check_error
      ? `账户检查未通过：${accountErrors[errorCode] || "请查看设置页账户检查结果"}`
      : "账户尚未检查通过，请到设置页检查已保存账户";
    if (account.settlement_credentials_ready !== true) return "结算凭据尚未确认，请到设置页重新检查账户";
    if (account.server_live_enabled === false) return "服务器尚未开启实盘交易配置";
    const liveReady = typeof account.live_start_ready === "boolean" ? account.live_start_ready
      : typeof account.liveStartReady === "boolean" ? account.liveStartReady
        : account.execution_credentials_ready === true && account.account_check_ready === true;
    if (liveReady !== true) return "服务器尚未确认账户可启动交易";
    return "";
  };
  const overviewEventContext = () => {
    const state = store.getState();
    const runId = state.runtime?.runId || state.runtime?.run_id || null;
    // Overview is a run-level activity feed. Scoping it to the currently
    // selected round made a valid round transition look like an empty log and
    // discarded the previous run events on the next poll.
    const context = { runId };
    return Object.fromEntries(Object.entries(context).filter(([, value]) => value != null && value !== ""));
  };
  const overviewRuntimeContext = () => {
    const state = store.getState();
    const assetId = state.marketPool.desiredIds[0] || state.marketCatalog.selectedId || window.PolyPreview.config.selectedAssetId;
    const item = state.marketCatalog.items.find((market) => market.assetId === assetId);
    return Object.fromEntries(Object.entries({ assetId, marketId: item?.marketId, roundId: item?.roundId })
      .filter(([, value]) => value != null && value !== ""));
  };
  const overviewRuntimeControl = (runtime = store.getState().runtime || {}) => {
    const context = overviewRuntimeContext();
    if (window.PolyPreviewViewModel.matchesIdentity(runtime, context)) return { context, runtime, identityMatches: true };
    const nested = Array.isArray(runtime.markets)
      ? runtime.markets.map((item) => ({
        ...item,
        assetId: item.assetId ?? item.asset_id ?? runtime.assetId ?? runtime.asset_id,
        marketId: item.marketId ?? item.market_id ?? runtime.marketId ?? runtime.market_id,
        roundId: item.roundId ?? item.round_id ?? runtime.roundId ?? runtime.round_id
      })).find((item) => window.PolyPreviewViewModel.matchesIdentity(item, context))
      : null;
    if (nested) return { context, runtime: { ...runtime, ...nested, processRunning: runtime.processRunning ?? nested.processRunning }, identityMatches: true };
    return { context, runtime, identityMatches: false };
  };
  const updateOverviewControls = () => {
    const start = document.querySelector('[data-overview-action="start"]');
    const stop = document.querySelector('[data-overview-action="exit"]');
    const feedback = document.querySelector("[data-overview-control-message]");
    const control = overviewRuntimeControl();
    const runtime = control.runtime;
    if (start) {
      const reason = overviewStartReason();
      start.dataset.controlState = reason ? "blocked" : "ready";
      start.textContent = reason ? "启动条件未满足" : "一键启动自动化交易";
      start.disabled = Boolean(reason);
      start.title = reason || "提交启动请求，最终状态以服务器确认为准";
      start.setAttribute("aria-label", start.textContent);
      start.setAttribute("aria-describedby", "overview-control-message");
      if (feedback) {
        feedback.id = "overview-control-message";
        feedback.classList.toggle("is-blocked", Boolean(reason));
        feedback.textContent = reason ? `暂不能启动：${reason}` : "启动条件已满足，可以启动交易。";
      }
    }
    if (stop) {
      const stoppable = control.identityMatches && runtime.processRunning === true;
      stop.disabled = !stoppable;
      stop.title = stoppable ? "提交停止请求；最终状态以服务器确认为准" : !control.identityMatches ? "当前市场没有匹配的服务器运行身份" : runtime.processRunning == null ? "服务器进程状态未知，暂不允许停止" : "没有服务器确认的可停止运行";
    }
  };
  document.querySelectorAll("[data-overview-action]").forEach((button) => button.addEventListener("click", async () => {
    const action = button.dataset.overviewAction;
    if (action === "start" || action === "exit") {
      if (button.disabled) return;
      const state = store.getState();
      const control = overviewRuntimeControl();
      const assetId = control.context.assetId;
      const item = state.marketCatalog.items.find((item) => item.assetId === assetId);
      if (action === "start" && overviewStartReason()) { text("[data-overview-runtime]", overviewStartReason()); return; }
      if (action === "exit" && (!control.identityMatches || control.runtime.processRunning !== true)) return;
      document.querySelectorAll('[data-overview-action="start"], [data-overview-action="exit"]').forEach((node) => { node.disabled = true; });
      const startButton = document.querySelector('[data-overview-action="start"]');
      const exitButton = document.querySelector('[data-overview-action="exit"]');
      if (startButton && action === "start") { startButton.textContent = "启动请求中…"; startButton.setAttribute("aria-busy", "true"); }
      if (exitButton && action === "exit") { exitButton.textContent = "停止请求中…"; exitButton.setAttribute("aria-busy", "true"); }
      const message = document.querySelector("[data-overview-control-message]");
      if (message) {
        message.classList.remove("is-blocked");
        message.textContent = action === "start" ? "正在提交启动请求，等待服务器确认…" : "正在提交停止请求，等待服务器确认…";
      }
      const marketIds = control.context.marketId ? [control.context.marketId] : [];
      if (assetId) window.PolyPreview.setSelectedAssetUrl(assetId);
      const command = async () => {
        if (action !== "start") return adapter.commandRuntime({ action: "stop", assetId, marketIds, strategyId: window.PolyPreview.config.strategyId, requestId: `overview-${Date.now()}` });
        const strategy = await adapter.loadStrategy();
        if (strategy.status !== "ready" || !(strategy.revision > 0)) throw new Error("请先在策略页面保存并激活有效版本");
        const strategyAssetReason = window.PolyPreviewViewModel.strategyAssetStartReason(strategy, assetId);
        if (strategyAssetReason) throw new Error(strategyAssetReason);
        return adapter.commandRuntime({ action: "start", assetId, marketIds, strategyId: window.PolyPreview.config.strategyId, revision: strategy.revision, requestId: `overview-${Date.now()}` });
      };
      command()
      .then((result) => {
        const confirmed = result?.accepted === true && result.commandStatus !== "failed";
        const reply = result?.message || (confirmed ? "服务器已接收请求" : "服务器未接收请求");
        text("[data-overview-runtime]", reply);
        if (message) {
          message.classList.toggle("is-blocked", !confirmed);
          message.textContent = confirmed
            ? `${reply}，等待交易进程状态确认。`
            : `${reply}，运行状态没有改变。`;
        }
        if (action === "start" && confirmed) window.PolyPreview.navigate("auto-trade.html");
      })
        .catch((error) => {
          const reason = error.message || "控制请求失败";
          text("[data-overview-runtime]", reason);
          if (message) { message.classList.add("is-blocked"); message.textContent = `${reason}，运行状态没有改变。`; }
        })
        .finally(() => {
          void refreshFast().catch(() => null).finally(() => {
            if (startButton) { startButton.textContent = "一键启动自动化交易"; startButton.removeAttribute("aria-busy"); }
            if (exitButton) { exitButton.textContent = "退出程序"; exitButton.removeAttribute("aria-busy"); }
            updateOverviewControls();
          });
        });
      return;
    }
    if (action === "strategy") return window.PolyPreview?.navigate("strategy.html");
    if (action === "refresh") {
      button.disabled = true;
      const eventContext = overviewEventContext();
      Promise.allSettled([adapter.loadMarkets(), adapter.loadMarketPool(), adapter.loadRuntime(), adapter.loadStrategy(), adapter.loadDiagnostics(), adapter.loadMetrics(), adapter.loadAccount(), adapter.loadAccountStatus(), adapter.loadEvents(eventContext.runId || null, eventContext)])
        .then((results) => {
          const disconnected = results.some((result) => result.status === "rejected" || ["stale", "unavailable", "error", "degraded"].includes(result.value?.status));
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
  const finite = (value) => value != null && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value)) ? Number(value) : null;
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
    const error = String(resource?.error || "");
    const noRun = /run not found|没有运行记录|当前运行标识尚未提供/i.test(error);
    text("[data-metrics-state]", resource?.status === "stale"
      ? `部分统计未更新，保留上次结果。${error ? ` ${error}` : ""}`
      : resource?.status === "unavailable"
        ? noRun ? "暂无已登记运行记录，统计暂不可用；账户配置和行情连接状态独立显示。"
          : error ? `统计读取失败：${error}` : "统计接口待接入。"
        : "主值为当前运行；今日按 UTC 统计。当前接口不提供月度统计，显示 --。");
    if (!data) {
      return;
    }
    const setMetric = (name, value) => text(`[data-metric="${name}"]`, value);
    ["current", "today", "month"].forEach((period) => {
      const suffix = period === "current" ? "current" : period;
      setMetric(`orders-${suffix}`, formatMetric(periodValue(data, period, ["orders", "orderCount", "order_count", "ordersCount", "fill_count", "fillCount", "count"], ["orders", "orderCount", "order_count", "fill_count", "fillCount", "count"])));
      setMetric(`wins-${suffix}`, formatMetric(periodValue(data, period, ["settled_wins", "wins", "winCount", "win_count"])));
      setMetric(`losses-${suffix}`, formatMetric(periodValue(data, period, ["settled_losses", "losses", "lossCount", "loss_count"])));
      const rate = finite(periodValue(data, period, ["winRate", "win_rate", "rate"], ["winRate", "win_rate", "rate"]));
      setMetric(`rate-${suffix}`, rate == null ? "--" : (rate <= 1 ? rate * 100 : rate).toFixed(2));
      setMetric(`pnl-${suffix}`, formatMetric(periodValue(data, period, ["pnlUsd", "pnl_usd", "profit", "settledPnl", "settled_pnl"], ["pnlUsd", "pnl_usd", "profit", "settledPnl", "settled_pnl"]), 2));
    });
  };
  const renderDiagnostics = (resource) => {
    const health = resource?.data;
    const data = health?.resources || health;
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
      return `<div><span>${window.PolyPreview.format.escape(names[name] || name)}</span><strong class="${stateClass}">${window.PolyPreview.format.escape(states[state] || state)}</strong><small>进程号 ${service?.pid ?? "--"} · 内存 ${bytes(service?.rss_bytes)} · 运行 ${service?.uptime_seconds == null ? "--" : `${Math.floor(service.uptime_seconds)} 秒`}</small></div>`;
    }).join("");
    const stamp = health.asOf == null ? "" : window.PolyPreview.format.time(health.asOf);
    text(".server-expired", resource?.status === "stale"
      ? `服务降级或采样过期${stamp ? ` · ${stamp}` : ""}`
      : stamp ? `更新 ${stamp}` : "等待系统采样");
  };
  const renderAccount = (resource) => {
    const data = resource?.data;
    if (!data) return;
    const total = read(data, ["totalUsd", "total_usd", "equity"], data.collateral?.available === true ? data.collateral.value : null);
    const available = read(data, ["availableUsd", "available_usd", "balance_occupancy.spendable_balance"]);
    const formatUsd = (value) => { const amount = finite(value); return amount == null ? "--" : `${amount.toFixed(2)} USDC`; };
    text("[data-account-total]", formatUsd(total));
    text("[data-account-available]", formatUsd(available));
    document.querySelectorAll("[data-account-total], [data-account-available]").forEach((node) => { node.title = resource.stale ? "数据过期，保留最近账户快照" : "服务器账户快照；缺少可用余额时显示 --"; });
  };
  const renderEvents = (resource) => {
    text("[data-events-state]", resource?.status === "stale" ? "数据过期 · 保留最近事件" : resource?.status === "ready" ? "已读取" : "事件待接入");
    const list = document.querySelector("[data-overview-log-list]");
    if (list) list.classList.toggle("is-stale", resource?.status !== "ready" || resource?.stale === true);
    if (resource?.status !== "ready") return;
    const items = Array.isArray(resource.items) ? resource.items : [];
    if (!list) return;
    if (!items.length) { list.innerHTML = '<li class="log-entry"><time>--</time><span class="log-icon neutral-icon">•</span><div><strong>暂无运行事件</strong><p>后端返回新的事件后会在这里追加。</p></div><span class="log-status muted-text">空闲</span></li>'; return; }
    const icon = { error: "!", warning: "!", warn: "!", success: "✓", good: "✓" };
    const activityNames = {
      platform_status: { running: "交易进程已启动", starting: "交易进程正在启动", paused: "已暂停新增订单", stopping: "正在停止交易", stopped: "交易进程已停止", failed: "交易进程异常退出" },
      order: "订单状态更新",
      order_ack: "平台已确认订单",
      fill: "收到成交回报",
      settlement: "结算状态更新",
      resolved: "市场结果已确认",
      quote: "盘口报价已更新",
      cancel: "撤单状态更新",
      unresolved: "结算仍待确认",
      error: "运行异常"
    };
    const errorNames = {
      market_feed_unhealthy: "行情连接中断，等待数据恢复",
      market_feed_disconnected: "行情连接中断，等待数据恢复",
      stale_book: "盘口数据已过期，暂不触发交易",
      transport_disconnected: "行情传输连接断开",
      market_snapshot_rejected: "行情快照未通过校验",
      feed_processing_failed: "行情处理失败",
      order_recovery_pending: "订单状态仍在核对",
      startup_account_recovery_pending: "启动时账户订单核对未完成",
      cash_flow_refresh_pending: "账户资金数据等待刷新",
      journal_failed: "运行记录写入失败",
      process_failed: "交易进程异常退出",
      ledger_projection_incomplete: "账本投影尚未追上运行记录",
      remote_orders_unconfirmed: "远端挂单状态尚未确认",
      remote_orders_state_unconfirmed: "远端挂单状态尚未确认"
    };
    const stateNames = { running: "运行中", starting: "启动中", paused: "已暂停", stopping: "停止中", stopped: "已停止", failed: "失败", open: "挂单中", matched: "已撮合", filled: "已成交", canceled: "已撤销", cancelled: "已撤销", confirmed: "已确认", pending: "待确认", rejected: "已拒绝", unconfirmed: "尚未确认", stale: "已过期", unavailable: "暂不可用" };
    const statusNames = { stopped: "交易进程已停止", started: "交易进程已启动", running: "交易进程运行中", starting: "交易进程正在启动", stopping: "交易进程正在停止", paused: "已暂停新增订单", failed: "交易进程运行失败", order: "订单状态更新", fill: "订单成交", settlement: "结算状态更新", resolved: "市场结果已确认", cancel: "撤单状态更新" };
    const hashPattern = /0x[a-fA-F0-9]{32,}/g;
    const shorten = (value) => String(value).replace(hashPattern, (hash) => `${hash.slice(0, 10)}…${hash.slice(-7)}`).replace(/\b\d{30,}\b/g, "关联当前市场");
    const readableEvent = (value, fallback) => {
      const raw = String(value ?? "").trim();
      if (!raw) return fallback;
      const safe = shorten(raw);
      if (/[\u3400-\u9fff]/.test(safe)) return safe;
      const translated = window.PolyPreview.format.readableError(safe, "");
      return translated && translated !== safe ? translated : fallback;
    };
    list.innerHTML = items.slice(0, 8).map((item) => {
      const state = String(item.status || item.state || "").toLowerCase();
      const kind = String(item.kind || item.event || "").toLowerCase();
      const suppliedSeverity = String(item.severity || item.level || "").toLowerCase();
      const failure = ["rejected", "failed", "error", "unconfirmed"].includes(state)
        || ["error", "platform_error", "order_rejected", "settlement_failed", "ledger_projection_incomplete", "remote_orders_unconfirmed"].includes(kind);
      const severity = failure ? (state === "unconfirmed" || kind === "ledger_projection_incomplete" ? "warning" : "error") : suppliedSeverity || "info";
      const time = item.time || item.createdAt || item.created_at || item.timestamp || "--";
      const code = String(item.code || "").toLowerCase();
      const fallbackMessage = (kind === "platform_status" && activityNames[kind]?.[state])
        || statusNames[state]
        || errorNames[code]
        || errorNames[kind]
        || activityNames[kind]
        || (severity === "error" || severity === "critical" ? "交易链路发生异常" : "运行状态已更新");
      const message = readableEvent(item.message || item.reason || item.detail, fallbackMessage);
      const asset = String(item.assetId || item.asset_id || "").toUpperCase();
      const marketId = item.marketId || item.market_id;
      const roundId = item.roundId || item.round_id;
      const orderState = stateNames[state] || "";
      const identity = [asset, marketId ? `市场 ${shorten(marketId)}` : "", roundId ? `场次 ${String(roundId).slice(-10)}` : ""].filter(Boolean).join(" · ");
      const detailParts = [];
      const rawDetail = item.detail && item.detail !== item.message ? item.detail : item.reason && item.reason !== item.message ? item.reason : null;
      if (rawDetail) detailParts.push(readableEvent(rawDetail, "服务器已返回附加状态"));
      if (orderState) detailParts.push(`订单：${orderState}`);
      if (Number.isFinite(Number(item.price))) detailParts.push(`价格 ${Number(item.price).toFixed(3)}`);
      if (Number.isFinite(Number(item.shares ?? item.size))) detailParts.push(`${Number(item.shares ?? item.size).toFixed(2)} 份`);
      if (identity) detailParts.push(identity);
      if (errorNames[code] && item.reason && !errorNames[String(item.reason).toLowerCase()]) detailParts.push("请检查服务器连接状态");
      const detail = detailParts.join(" · ") || (severity === "error" || severity === "critical" ? "未完成的操作不会显示为成功。" : "来自服务器的运行状态记录。");
      const statusClass = severity === "error" || severity === "warning" || severity === "warn" ? "muted-text" : severity === "success" || severity === "good" ? "good-text" : "info-text";
      const severityLabel = severity === "error" || severity === "critical" ? "异常" : severity === "warning" || severity === "warn" ? "警告" : severity === "success" || severity === "good" ? "成功" : "信息";
      return `<li class="log-entry"><time>${window.PolyPreview.format.escape(window.PolyPreview.format.time(time, "--:--:--"))}</time><span class="log-icon ${statusClass.replace("-text", "-icon")}">${icon[severity] || "i"}</span><div><strong>${window.PolyPreview.format.escape(message)}</strong><p title="${window.PolyPreview.format.escape(detail)}">${window.PolyPreview.format.escape(detail)}</p></div><span class="log-status ${statusClass}">${severityLabel}</span></li>`;
    }).join("");
  };
  store.subscribe("metrics", renderMetrics);
  store.subscribe("diagnostics", renderDiagnostics);
  store.subscribe("account", renderAccount);
  store.subscribe("events", renderEvents);
  store.subscribe("runtime", (runtime) => {
    const states = { running: "运行中", stopped: "已停止", paused: "已暂停新增", starting: "启动中", stopping: "停止中", failed: "运行失败" };
    const control = overviewRuntimeControl(runtime);
    const processLabel = control.identityMatches && runtime.processRunning === true ? "进程运行中" : control.identityMatches && runtime.processRunning === false ? "进程已停止" : "进程状态未知";
    const label = !control.identityMatches ? `运行状态待接入 · ${processLabel}` : runtime.status === "unavailable" ? `运行状态待接入 · ${processLabel}` : runtime.stale ? `状态过期 · ${processLabel}` : `${states[runtime.runtimeState] || runtime.runtimeState || runtime.status} · ${processLabel}`;
    text("[data-overview-runtime]", label);
    updateOverviewControls();
  });
  store.subscribe("marketCatalog", updateOverviewControls);
  store.subscribe("marketPool", updateOverviewControls);
  store.subscribe("strategy", updateOverviewControls);
  store.subscribe("accountStatus", updateOverviewControls);
  text('[data-overview-action="exit"]', "停止交易");
  text('[data-overview-action="strategy"]', "配置策略");
  text(".sidebar-status span", "服务器数据");
  text(".sidebar-status small", "各模块独立更新");
  text(".log-state small", "当前运行");
  document.querySelector("[data-account-total]").previousElementSibling.textContent = "账户资产 / 抵押余额";
  const controlAssetId = () => {
    const state = store.getState();
    return state.marketPool.desiredIds[0] || state.marketCatalog.selectedId;
  };
  const currentMarket = store.getState().marketCatalog.items.find((item) => item.assetId === controlAssetId());
  text(".header-status strong", currentMarket ? `${currentMarket.symbol} · 5 分钟 YES / NO` : "等待市场目录");
  const renderControlMarket = () => {
    const market = store.getState().marketCatalog.items.find((item) => item.assetId === controlAssetId());
    text(".header-status strong", market ? `${market.symbol} · 5 分钟 YES / NO` : "等待市场目录");
  };
  renderControlMarket();
  store.subscribe("marketCatalog", renderControlMarket);
  store.subscribe("marketPool", renderControlMarket);
  let fastRequest = null;
  let slowRequest = null;
  let accountRequest = null;
  let fastTimer = null;
  let slowTimer = null;
  let accountTimer = null;
  const refreshFast = () => fastRequest || (fastRequest = Promise.allSettled([
    adapter.loadMarkets().then(() => {
      const context = overviewRuntimeControl().context;
      if (context.assetId && context.marketId && context.roundId) {
        return adapter.loadRuntime(context).then((runtime) => store.setSlice("runtime", { ...runtime, runtimeState: runtime.state || runtime.status }));
      }
      return adapter.loadRuntime();
    })
  ]).finally(() => { fastRequest = null; }));
  const refreshSlow = () => slowRequest || (slowRequest = Promise.allSettled([
    adapter.loadMarketPool(), adapter.loadDiagnostics(), adapter.loadMetrics(), (() => { const context = overviewEventContext(); return adapter.loadEvents(context.runId || null, context); })(), adapter.loadStrategy(), adapter.loadAccountStatus()
  ]).finally(() => { slowRequest = null; }));
  const refreshAccount = () => accountRequest || (accountRequest = Promise.allSettled([
    adapter.loadAccount()
  ]).finally(() => { accountRequest = null; }));
  const clearRefreshTimers = () => {
    ["fastTimer", "slowTimer", "accountTimer"].forEach((name) => {
      if (name === "fastTimer" && fastTimer) window.clearTimeout(fastTimer);
      if (name === "slowTimer" && slowTimer) window.clearTimeout(slowTimer);
      if (name === "accountTimer" && accountTimer) window.clearTimeout(accountTimer);
    });
    fastTimer = null;
    slowTimer = null;
    accountTimer = null;
  };
  const scheduleRefresh = (kind, delay) => {
    if (document.hidden) return;
    const timer = kind === "fast" ? fastTimer : kind === "slow" ? slowTimer : accountTimer;
    if (timer) window.clearTimeout(timer);
    const run = async () => {
      if (document.hidden) return;
      if (kind === "fast") {
        fastTimer = null;
        await refreshFast();
        scheduleRefresh("fast", 3000);
      } else if (kind === "slow") {
        slowTimer = null;
        await refreshSlow();
        scheduleRefresh("slow", 15000);
      } else {
        accountTimer = null;
        await refreshAccount();
        scheduleRefresh("account", 30000);
      }
    };
    if (kind === "fast") fastTimer = window.setTimeout(run, delay);
    else if (kind === "slow") slowTimer = window.setTimeout(run, delay);
    else accountTimer = window.setTimeout(run, delay);
  };
  const refreshAllOnVisible = () => {
    clearRefreshTimers();
    if (document.hidden) return;
    void refreshFast();
    void refreshSlow();
    void refreshAccount();
    scheduleRefresh("fast", 3000);
    scheduleRefresh("slow", 15000);
    scheduleRefresh("account", 30000);
  };
  document.addEventListener("visibilitychange", refreshAllOnVisible);
  window.addEventListener("pagehide", clearRefreshTimers);
  refreshAllOnVisible();
  updateOverviewControls();
})();

