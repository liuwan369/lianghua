"use strict";
(() => {
  const root = document.querySelector("#settings-block-root");
  if (!root) throw new Error("settings block root missing");
  const store = window.PolyPreviewStore;
  const adapter = window.PolyPreviewAdapter;

  const navItems = [
    ["◈", "总览", "overview.html"],
    ["◇", "市场", "market.html"],
    ["↗", "自动交易", "auto-trade.html"],
    ["◐", "策略", "strategy.html"],
    ["⚙", "设置", "settings.html"]
  ];
  const navMarkup = navItems.map(([icon, label, target]) => `<button class="nav-item${label === "设置" ? " active" : ""}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === "设置" ? ' aria-current="page"' : ""}><span>${icon}</span>${label}</button>`).join("");

  root.innerHTML = `
  <div class="settings-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>TRADING CONSOLE</small></div></div>
      <div class="brand-card"><span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span><strong>Polymarket</strong></div>
      <p class="sidebar-copy">面向平台支持加密货币的五分钟反转策略控制平台。</p>
      <nav aria-label="设置设计稿导航">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>原型预览</span><small>数据待接入</small></div>
    </aside>

    <main class="settings-main">
      <header class="preview-header">
        <div class="hero-copy"><p class="eyebrow">SYSTEM SETTINGS</p><div class="hero-title-row"><h1>设置</h1><span class="language-chip">CRYPTO · 5m</span></div><p class="subtitle">连接、版本和服务器账户状态集中查看。</p></div>
        <div class="header-tools"><div class="header-status-grid">
          <article class="header-status"><span>账户状态</span><strong data-header-account>未接入</strong></article>
          <article class="header-status"><span>当前版本</span><strong>REV-001</strong></article>
          <article class="header-status"><span>系统健康</span><strong data-header-health>等待接入</strong></article>
          <article class="header-status"><span>最后检查</span><strong data-header-check>--:--:--</strong></article>
        </div></div>
      </header>

      <div class="settings-tabs" role="tablist" aria-label="设置分区">
        <button type="button" class="settings-tab active" data-settings-tab="diagnostics" role="tab" aria-selected="true"><span class="tab-icon">◌</span><span><b>系统诊断</b><small>连接状态与版本信息</small></span></button>
        <button type="button" class="settings-tab" data-settings-tab="account" role="tab" aria-selected="false"><span class="tab-icon">▣</span><span><b>账户状态</b><small>服务器读取状态</small></span></button>
      </div>

      <section class="settings-pane active" data-settings-pane="diagnostics" role="tabpanel">
        <div class="pane-heading"><div><p class="eyebrow">HEALTH OVERVIEW</p><h2>系统诊断</h2><p>显示当前服务健康和交易链路状态，全部为只读信息。</p></div><div class="pane-actions"><span class="live-chip"><i></i><b data-diagnostic-state>设计稿 · 数据待接入</b></span><button type="button" class="action-button" data-refresh-diagnostics><span>↻</span>刷新诊断</button></div></div>

        <section class="diagnostic-panel connection-panel">
          <div class="panel-heading"><div><p class="eyebrow">CONNECTIONS</p><h3>连接状态</h3></div><span class="panel-meta" data-diagnostic-time>最后检查 --:--:--</span></div>
          <div class="connection-grid">
            <article class="connection-card"><div class="connection-icon blue">⌁</div><div><span>行情节点</span><strong class="status-warning" data-connection-value="market">等待接入</strong><small data-connection-detail="market">行情更新时间 --</small></div><i class="status-dot warning"></i></article>
            <article class="connection-card"><div class="connection-icon green">↗</div><div><span>交易连接</span><strong class="status-warning" data-connection-value="trade">未检查</strong><small data-connection-detail="trade">不会自动下单</small></div><i class="status-dot warning"></i></article>
            <article class="connection-card"><div class="connection-icon amber">▣</div><div><span>账户读取</span><strong class="status-warning" data-connection-value="account">未接入</strong><small data-connection-detail="account">等待钱包配置</small></div><i class="status-dot warning"></i></article>
            <article class="connection-card"><div class="connection-icon violet">◆</div><div><span>当前版本</span><strong data-connection-value="version">REV-001</strong><small data-connection-detail="version">平台控制台 · 原型</small></div><i class="status-dot neutral"></i></article>
          </div>
        </section>

        <div class="diagnostic-note"><span class="note-icon">i</span><span>服务器资源与服务进程在总览查看，交易速度在自动交易查看；这里仅保留连接与版本诊断。</span><span class="note-time" data-note-time>原型预览 · 未连接后端</span></div>
      </section>

      <section class="settings-pane" data-settings-pane="account" role="tabpanel" hidden>
        <div class="pane-heading"><div><p class="eyebrow">ACCOUNT STATUS</p><h2>账户状态</h2><p>账户由后端配置，前端只读取状态，不收集私钥或授权密钥。</p></div><span class="live-chip warning-chip"><i></i><b>未接入</b></span></div>
        <div class="account-layout"><div class="account-form-panel">
          <div class="panel-heading"><div><p class="eyebrow">READ ONLY</p><h3>服务器账户</h3></div><span class="panel-meta">后端管理</span></div>
          <div class="account-readonly-note"><span class="security-icon">◈</span><div><strong>服务器托管账户</strong><p>钱包、签名和交易服务凭据由后端安全存储。此页面不会接收、保存或回显私钥。</p></div></div>
          <div class="form-actions"><button type="button" class="action-button" data-account-check>检查账户</button></div><p class="form-message" data-account-message>检查只读取服务器状态，不会启动交易。</p>
        </div><aside class="account-side"><section class="side-card"><div class="panel-heading"><div><p class="eyebrow">READ ONLY</p><h3>账户管理边界</h3></div><span class="panel-meta">后端管理</span></div><p class="side-copy">账户秘密和交易连接由服务器环境配置。前端只展示 configured、check status 和最近检查时间。</p></section><section class="security-card"><span class="security-icon">◈</span><div><strong>账户安全</strong><p>前端不保存秘密字段；生产环境通过后端安全配置注入。</p></div></section></aside></div>
      </section>

    </main>
  </div>`;

  const text = (selector, value) => {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  };
  const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

  document.querySelectorAll("[data-preview-nav]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.previewTarget;
    if (target) window.location.href = target;
  }));

  const activateTab = (name) => {
    document.querySelectorAll("[data-settings-tab]").forEach((button) => {
      const active = button.dataset.settingsTab === name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-settings-pane]").forEach((pane) => {
      const active = pane.dataset.settingsPane === name;
      pane.classList.toggle("active", active);
      pane.toggleAttribute("hidden", !active);
    });
  };
  document.querySelectorAll("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.settingsTab)));

  const renderDiagnostics = (resource) => {
    const stamp = resource?.data?.asOf ? new Date(resource.data.asOf * 1000).toLocaleTimeString("zh-CN", { hour12: false }) : "--:--:--";
    const ready = resource?.status === "ready";
    text("[data-diagnostic-state]", ready ? "已连接 · 只读" : resource?.status === "stale" ? "连接中断 · 保留上次数据" : "设计稿 · 数据待接入");
    text("[data-diagnostic-time]", `最后检查 ${stamp}`);
    text("[data-header-check]", stamp);
    text("[data-note-time]", ready ? `后端诊断 · ${stamp}` : "原型预览 · 未连接后端");
    text("[data-header-health]", ready ? "正常" : resource?.status === "stale" ? "连接中断" : "待接入");
    text("[data-connection-value=\"market\"]", ready ? "已读取" : resource?.status === "stale" ? "保留上次数据" : "等待接入");
    text("[data-connection-value=\"trade\"]", ready ? "已读取" : resource?.status === "stale" ? "保留上次数据" : "未检查");
  };
  store.subscribe("diagnostics", renderDiagnostics);

  document.querySelector("[data-refresh-diagnostics]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.classList.add("is-loading");
    text("[data-diagnostic-state]", "正在检查 · 只读");
    try { await adapter.loadDiagnostics(); await adapter.loadAccount(); }
    catch (error) { text("[data-diagnostic-state]", error.message || "诊断读取失败"); }
    finally { button.disabled = false; button.classList.remove("is-loading"); }
  });

  document.querySelector("[data-account-check]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    text("[data-account-message]", "正在读取服务器账户状态…");
    try {
      const result = await adapter.loadAccount();
      text("[data-account-message]", result.status === "ready" ? `账户状态已更新 · ${now()}` : "设计稿演示：账户接口尚未连接");
    } catch (error) { text("[data-account-message]", error.message || "账户状态读取失败"); }
    finally { button.disabled = false; }
  });
  if (window.PolyPreview.config.mode !== "local-preview") {
    void adapter.loadDiagnostics();
    void adapter.loadAccount();
  }
})();

