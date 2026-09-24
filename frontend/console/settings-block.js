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
        <div class="pane-heading"><div><p class="eyebrow">ACCOUNT STATUS</p><h2>账户状态</h2><p>账户配置只通过当前 HTTPS 同源接口提交；页面不保存或回显密钥。</p></div><span class="live-chip warning-chip"><i></i><b>未接入</b></span></div>
        <div class="account-layout"><div class="account-form-panel">
          <div class="panel-heading"><div><p class="eyebrow">SERVER CONFIGURATION</p><h3>账户配置</h3></div><span class="panel-meta">后端受控配置</span></div>
          <div class="account-readonly-note"><span class="security-icon">◈</span><div><strong>只提交到服务器</strong><p>输入只在检查或保存时发送到同源后端；成功后立即清空密码字段，不写入浏览器存储或日志。</p></div></div>
          <div class="account-status-grid"><div><span>钱包</span><b data-account-flag="wallet">未知</b></div><div><span>Owner</span><b data-account-flag="owner">未知</b></div><div><span>Relayer</span><b data-account-flag="relayer">未知</b></div><div><span>Builder</span><b data-account-flag="builder">未知</b></div><div><span>交易凭据</span><b data-account-flag="execution">未知</b></div></div>
          <label class="field"><span>资金钱包地址</span><input type="text" data-account-field="wallet" autocomplete="off" spellcheck="false" placeholder="0x..." required></label>
          <label class="field"><span>Owner 私钥</span><input type="password" data-account-field="owner_key" autocomplete="new-password" spellcheck="false"></label>
          <div class="account-field-row"><label class="field"><span>Relayer key</span><input type="password" data-account-field="relayer_key" autocomplete="new-password" spellcheck="false"></label><label class="field"><span>Relayer address</span><input type="text" data-account-field="relayer_address" autocomplete="off" spellcheck="false" placeholder="0x..."></label></div>
          <div class="account-field-row"><label class="field"><span>Builder API Key</span><input type="password" data-account-field="builder_api_key" autocomplete="new-password" spellcheck="false"></label><label class="field"><span>Builder Secret</span><input type="password" data-account-field="builder_secret" autocomplete="new-password" spellcheck="false"></label></div>
          <label class="field"><span>Builder Passphrase</span><input type="password" data-account-field="builder_passphrase" autocomplete="new-password" spellcheck="false"></label>
          <div class="form-actions"><button type="button" class="action-button" data-account-check>检查账户</button><button type="button" class="action-button primary-action" data-account-save>检查并保存</button></div><p class="form-message" data-account-message>保存到服务器部署配置；未提交的空白密钥不会覆盖现有配置。</p>
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
    const stamp = resource?.data?.asOf ? window.PolyPreview.format.time(resource.data.asOf) : "--:--:--";
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
  const renderAccount = (resource) => {
    const data = resource?.data || {};
    const configured = data.execution_credentials_ready || data.wallet_configured || data.configured;
    const state = resource?.status === "ready" ? (configured ? "已配置" : "只读") : resource?.status === "stale" ? "连接中断" : "未接入";
    text("[data-header-account]", state);
    text("[data-connection-value=\"account\"]", state);
    text("[data-connection-detail=\"account\"]", resource?.status === "ready" ? (configured ? "服务器账户可读取" : "仅账户状态可读取") : resource?.error || "等待服务器账户状态");
    const chip = document.querySelector('[data-settings-pane="account"] .warning-chip b');
    if (chip) chip.textContent = state;
    const flags = { wallet: data.wallet_configured, owner: data.owner_signer_configured, relayer: data.relayer_api_configured, builder: data.builder_api_configured, execution: data.execution_credentials_ready };
    Object.entries(flags).forEach(([name, value]) => text(`[data-account-flag="${name}"]`, typeof value === "boolean" ? (value ? "已配置" : "未配置") : resource?.status === "stale" ? "保留上次状态" : "状态未知"));
  };
  store.subscribe("account", renderAccount);

  document.querySelector("[data-refresh-diagnostics]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.classList.add("is-loading");
    text("[data-diagnostic-state]", "正在检查 · 只读");
    try { await adapter.loadDiagnostics(); await adapter.loadAccountStatus(); await adapter.loadAccount(); }
    catch (error) { text("[data-diagnostic-state]", error.message || "诊断读取失败"); }
    finally { button.disabled = false; button.classList.remove("is-loading"); }
  });

  const accountFields = [...document.querySelectorAll("[data-account-field]")];
  const accountPayload = () => Object.fromEntries(accountFields.map((field) => [field.dataset.accountField, field.value.trim()]).filter(([, value]) => value));
  const clearSecrets = () => accountFields.filter((field) => field.type === "password").forEach((field) => { field.value = ""; });
  const accountRequestAllowed = () => window.location.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const runAccountAction = async (save, event) => {
    if (!accountRequestAllowed()) { text("[data-account-message]", "账户密钥只允许通过 HTTPS 同源页面提交；当前页面未发送任何输入。"); return; }
    const button = event.currentTarget;
    button.disabled = true;
    const payload = accountPayload();
    if (!payload.wallet) { text("[data-account-message]", "请输入资金钱包地址；未发送账户数据。"); button.disabled = false; return; }
    text("[data-account-message]", save ? "正在检查并保存账户…" : "正在检查账户，尚未保存…");
    try {
      const check = save ? await adapter.saveAccount(payload) : await adapter.checkAccount(payload);
      clearSecrets();
      await adapter.loadAccountStatus();
      text("[data-account-message]", save ? `账户已保存 · 已清除密码输入 · ${now()}` : `账户检查完成 · 未保存 · 已清除密码输入 · ${now()}`);
    } catch (error) { text("[data-account-message]", `${error.message || "账户操作失败"}；未确认保存成功，输入已保留。`); }
    finally { button.disabled = false; }
  };
  document.querySelector("[data-account-check]")?.addEventListener("click", (event) => { void runAccountAction(false, event); });
  document.querySelector("[data-account-save]")?.addEventListener("click", (event) => { void runAccountAction(true, event); });
  if (window.PolyPreview.config.mode !== "local-preview") {
    void adapter.loadDiagnostics();
    void adapter.loadAccountStatus();
    void adapter.loadAccount();
  }
})();

