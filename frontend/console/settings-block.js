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
      <nav aria-label="设置导航">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>服务器数据</span><small>等待连接</small></div>
    </aside>

    <main class="settings-main">
      <header class="preview-header">
        <div class="hero-copy"><p class="eyebrow">SYSTEM SETTINGS</p><div class="hero-title-row"><h1>设置</h1><span class="language-chip">CRYPTO · 5m</span></div><p class="subtitle">连接、版本和服务器账户状态集中查看。</p></div>
        <div class="header-tools"><div class="header-status-grid">
          <article class="header-status"><span>账户状态</span><strong data-header-account>未接入</strong></article>
          <article class="header-status"><span>当前版本</span><strong data-header-version>未提供</strong></article>
          <article class="header-status"><span>系统健康</span><strong data-header-health>等待接入</strong></article>
          <article class="header-status"><span>最后检查</span><strong data-header-check>--:--:--</strong></article>
        </div></div>
      </header>

      <div class="settings-tabs" role="tablist" aria-label="设置分区">
        <button type="button" class="settings-tab active" data-settings-tab="diagnostics" role="tab" aria-selected="true"><span class="tab-icon">◌</span><span><b>系统诊断</b><small>连接状态与版本信息</small></span></button>
        <button type="button" class="settings-tab" data-settings-tab="account" role="tab" aria-selected="false"><span class="tab-icon">▣</span><span><b>账户状态</b><small>服务器读取状态</small></span></button>
      </div>

      <section class="settings-pane active" data-settings-pane="diagnostics" role="tabpanel">
        <div class="pane-heading"><div><p class="eyebrow">HEALTH OVERVIEW</p><h2>系统诊断</h2><p>显示当前服务健康和交易链路状态，全部为只读信息。</p></div><div class="pane-actions"><span class="live-chip"><i></i><b data-diagnostic-state>等待服务器</b></span><button type="button" class="action-button" data-refresh-diagnostics><span>↻</span>刷新诊断</button></div></div>

        <section class="diagnostic-panel connection-panel">
          <div class="panel-heading"><div><p class="eyebrow">CONNECTIONS</p><h3>连接状态</h3></div><span class="panel-meta" data-diagnostic-time>最后检查 --:--:--</span></div>
          <div class="connection-grid">
            <article class="connection-card"><div class="connection-icon blue">⌁</div><div><span>行情节点</span><strong class="status-warning" data-connection-value="market">等待接入</strong><small data-connection-detail="market">行情更新时间 --</small></div><i class="status-dot warning"></i></article>
            <article class="connection-card"><div class="connection-icon green">↗</div><div><span>交易连接</span><strong class="status-warning" data-connection-value="trade">未检查</strong><small data-connection-detail="trade">不会自动下单</small></div><i class="status-dot warning"></i></article>
            <article class="connection-card"><div class="connection-icon amber">▣</div><div><span>账户读取</span><strong class="status-warning" data-connection-value="account">未接入</strong><small data-connection-detail="account">等待钱包配置</small></div><i class="status-dot warning"></i></article>
            <article class="connection-card"><div class="connection-icon violet">◆</div><div><span>当前版本</span><strong data-connection-value="version">未提供</strong><small data-connection-detail="version">等待服务器版本信息</small></div><i class="status-dot neutral"></i></article>
          </div>
        </section>

        <div class="diagnostic-note"><span class="note-icon">i</span><span>服务器资源与服务进程在总览查看，交易速度在自动交易查看；这里仅保留连接与版本诊断。</span><span class="note-time" data-note-time>等待服务器连接</span></div>
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
          <div class="form-actions"><button type="button" class="action-button" data-account-check-saved>检查已保存账户</button><button type="button" class="action-button" data-account-check>检查输入账户</button><button type="button" class="action-button primary-action" data-account-save>检查并保存</button></div><p class="form-message" data-account-message role="status" aria-live="polite">检查已保存账户不会提交输入框草稿。检查不会保存，保存不会启动交易。钱包不变时空白密钥保留服务器配置；更换钱包不会继承旧密钥。</p>
        </div><aside class="account-side"><section class="side-card"><div class="panel-heading"><div><p class="eyebrow">READ ONLY</p><h3>账户管理边界</h3></div><span class="panel-meta">后端管理</span></div><p class="side-copy">保存位置：服务器受控账户配置（由服务器 PM_ACCOUNT_PROFILE 指定）。未保存账户时，服务器可读取部署环境配置。此处只显示配置状态。</p><p class="side-copy" data-account-last-check>最近账户检查：未提供</p><p class="side-copy" data-account-report>账户检查结果尚未提供。</p></section><section class="side-card control-session-card"><div class="panel-heading"><div><p class="eyebrow">CONTROL SESSION</p><h3>连接控制会话</h3></div><span class="panel-meta">受保护访问</span></div><label class="field"><span>交易控制密码</span><input type="password" data-control-token autocomplete="new-password" spellcheck="false" maxlength="1024"><small>由服务器验证并保存控制密码，浏览器只使用服务器设置的 HttpOnly 会话 Cookie。</small></label><button type="button" class="action-button" data-control-connect>连接控制会话</button><p class="form-message" data-control-message role="status" aria-live="polite">连接成功后清空密码输入；不会启动交易或改变服务器实盘解锁配置。</p></section><section class="security-card"><span class="security-icon">◈</span><div><strong>账户安全</strong><p>密码只留在当前输入框，检查或保存成功后清除；失败保留草稿供重试。离开页面时清空密码字段。</p></div></section></aside></div>
      </section>

    </main>
  </div>`;

  const text = (selector, value) => {
    const node = document.querySelector(selector);
    if (node && node.textContent !== String(value)) node.textContent = value;
  };
  const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

  document.querySelectorAll("[data-preview-nav]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.previewTarget;
    if (target) window.PolyPreview.navigate(target);
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

  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const accountFields = [...document.querySelectorAll("[data-account-field]")];
  const fieldByName = Object.fromEntries(accountFields.map((field) => [field.dataset.accountField, field]));
  const fieldVersions = new Map(accountFields.map((field) => [field, 0]));
  const accountButtons = [...document.querySelectorAll("[data-account-check], [data-account-save], [data-account-check-saved]")];
  const controlInput = document.querySelector("[data-control-token]");
  const controlButton = document.querySelector("[data-control-connect]");
  let controlVersion = 0;
  let controlBusy = false;
  let accountBusy = false;
  let pendingAccountAction = "";
  let diagnosticsBusy = false;
  let closed = false;
  let savedWallet = "";
  const safeMessage = (value, payload = {}) => {
    let message = typeof value === "string" ? value : "接口暂时不可用";
    const secrets = [...Object.values(payload), controlInput.value.trim(), ...accountFields.filter((field) => field.type === "password").map((field) => field.value.trim())];
    for (const secret of secrets) if (typeof secret === "string" && secret) message = message.split(secret).join("[已隐藏]");
    return message.replace(/(?:0x)?[a-fA-F0-9]{64}/g, "[已隐藏]").slice(0, 240);
  };
  const connection = (name, label, detail, tone = "warning") => {
    const node = document.querySelector(`[data-connection-value="${name}"]`);
    text(`[data-connection-value="${name}"]`, label);
    text(`[data-connection-detail="${name}"]`, detail);
    if (node) {
      node.className = `status-${tone}`;
      const dot = node.closest(".connection-card")?.querySelector(".status-dot");
      if (dot) dot.className = `status-dot ${tone}`;
    }
  };
  const renderDiagnostics = (resource) => {
    const data = isObject(resource?.data) ? resource.data : {};
    const services = isObject(data.services) ? data.services : {};
    const stamp = window.PolyPreview.format.time(data.asOf);
    const degraded = data.status === "degraded";
    const stale = resource?.stale === true || resource?.status === "stale" || data.stale === true;
    const unavailable = resource?.status === "unavailable" || resource?.status === "error";
    const healthy = resource?.status === "ready" && data.status === "ok" && data.stale === false && !resource.error && stamp !== "--:--:--";
    const label = degraded ? "服务异常" : stale ? "快照过期" : unavailable ? "待接入" : healthy ? "正常" : "健康状态未知";
    const failure = resource?.error || data.error;
    text("[data-diagnostic-state]", `${label} · 只读${stale ? " · 保留最近快照" : ""}`);
    text("[data-diagnostic-time]", `快照时间 ${stamp}`);
    text("[data-header-check]", stamp);
    text("[data-header-health]", label);
    text("[data-note-time]", failure ? safeMessage(failure) : healthy ? `后端诊断 · ${stamp}` : "未收到完整健康状态");
    const transportStale = unavailable || (stale && !degraded && data.stale !== true) || !!(resource?.error && resource.error !== data.error);
    const collector = isObject(services.collector) ? services.collector : null;
    const collectorStale = transportStale || collector?.stale === true;
    connection("market", collector ? (collectorStale ? "行情快照过期" : collector.stale === false ? "行情可用" : "状态未知") : "等待行情状态",
      collector ? `行情时间 ${window.PolyPreview.format.time(collector.asOf)}${collectorStale ? " · 保留最近快照" : ""}` : "诊断未提供行情服务状态",
      collector && collector.stale === false && !collectorStale ? "good" : "warning");
    const trading = isObject(services.trading) ? services.trading : null;
    const tradingLabels = { running: "运行中", paused: "已暂停", stopped: "已停止", starting: "启动中", stopping: "停止中", failed: "运行失败", unavailable: "运行状态不可用", idle: "空闲" };
    const tradingStale = transportStale || trading?.stale === true;
    const tradingLabel = trading ? tradingLabels[trading.status] || "状态未知" : "未检查";
    connection("trade", `${tradingLabel}${tradingStale && trading ? " · 过期" : ""}`,
      trading ? `运行时间 ${window.PolyPreview.format.time(trading.asOf)}${tradingStale ? " · 保留最近快照" : ""}` : "诊断未提供交易运行状态",
      trading && !tradingStale && trading.status === "running" ? "good" : trading && !tradingStale && ["stopped", "idle"].includes(trading.status) ? "neutral" : "warning");
    const version = typeof data.version === "string" && data.version ? data.version : "未提供";
    text("[data-header-version]", version);
    connection("version", version, version === "未提供" ? "服务器未返回版本信息" : "服务器报告的版本", "neutral");
  };
  const boolText = (value) => value === true ? "是" : value === false ? "否" : "未知";
  const renderAccount = (resource) => {
    const data = isObject(resource?.data) ? resource.data : {};
    const stale = resource?.stale === true || resource?.status === "stale";
    const ready = resource?.status === "ready" && !stale && !resource.error && !data.config_error;
    const state = data.config_error ? "配置读取失败" : stale ? "状态过期" : !ready ? "未接入" : data.execution_credentials_ready === true ? "交易凭据已配置" : data.wallet_configured === true ? "钱包已配置" : data.wallet_configured === false ? "未配置钱包" : "配置状态未知";
    text("[data-header-account]", state);
    connection("account", state, resource?.error || data.config_error ? safeMessage(resource?.error || data.config_error) : stale ? "保留上次状态，尚未确认最新配置" : ready ? "配置状态不代表账户检查或交易授权通过" : "等待服务器账户状态", ready ? "neutral" : "warning");
    text('[data-settings-pane="account"] .warning-chip b', state);
    const flags = { wallet: data.wallet_configured, owner: data.owner_signer_configured, relayer: data.relayer_api_configured, builder: data.builder_api_configured, execution: data.execution_credentials_ready };
    Object.entries(flags).forEach(([name, value]) => text(`[data-account-flag="${name}"]`, `${typeof value === "boolean" ? (value ? "已配置" : "未配置") : "状态未知"}${stale && typeof value === "boolean" ? "（上次）" : ""}`));
    const report = isObject(data.last_check) ? data.last_check : {};
    text("[data-account-last-check]", `最近账户检查：${window.PolyPreview.format.time(report.checked_at, "未提供")}${stale ? "（上次状态）" : ""}`);
    text("[data-account-report]", `账户就绪：${boolText(report.account_ready)}；签名匹配：${boolText(report.signer_matches)}；授权就绪：${boolText(report.approvals_ready)}。`);
    const walletField = fieldByName.wallet;
    if (ready && !accountBusy && fieldVersions.get(walletField) === 0 && typeof data.wallet === "string"
      && (!savedWallet || savedWallet.toLowerCase() === data.wallet.toLowerCase())) walletField.value = data.wallet;
  };
  store.subscribe("diagnostics", renderDiagnostics);
  store.subscribe("accountStatus", renderAccount);

  const refreshDiagnostics = async () => {
    if (diagnosticsBusy || closed) return;
    diagnosticsBusy = true;
    const button = document.querySelector("[data-refresh-diagnostics]");
    button.disabled = true;
    button.classList.add("is-loading");
    text("[data-diagnostic-state]", "正在检查 · 只读");
    try {
      const results = await Promise.allSettled([adapter.loadDiagnostics(), adapter.loadAccountStatus()]);
      if (closed) return;
      const failed = results.find((result) => result.status === "rejected");
      if (failed) text("[data-diagnostic-state]", `读取失败 · ${safeMessage(failed.reason?.message)}`);
      else renderDiagnostics(store.getState().diagnostics);
    } finally {
      diagnosticsBusy = false;
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  };
  document.querySelector("[data-refresh-diagnostics]")?.addEventListener("click", () => { void refreshDiagnostics(); });

  const syncAccountButtons = () => {
    accountButtons.forEach((button) => { button.disabled = accountBusy || controlBusy || closed; });
    controlButton.disabled = accountBusy || controlBusy || closed || !controlInput.value.trim();
    text("[data-control-connect]", controlBusy ? "正在连接…" : "连接控制会话");
    text("[data-account-check]", pendingAccountAction === "check" ? "正在检查…" : "检查输入账户");
    text("[data-account-check-saved]", pendingAccountAction === "saved" ? "正在检查…" : "检查已保存账户");
    text("[data-account-save]", pendingAccountAction === "save" ? "正在检查并保存…" : "检查并保存");
    document.querySelector(".account-form-panel")?.setAttribute("aria-busy", String(accountBusy));
  };
  accountFields.forEach((field) => {
    const name = field.dataset.accountField;
    field.name = name;
    field.maxLength = name === "owner_key" ? 66 : name === "relayer_key" ? 256 : ["wallet", "relayer_address"].includes(name) ? 42 : 512;
    field.addEventListener("input", () => {
      fieldVersions.set(field, fieldVersions.get(field) + 1);
      field.setCustomValidity("");
      text("[data-account-message]", accountBusy ? "请求正在处理；新修改尚未提交，将保留在输入框。" : "账户修改尚未保存；检查或保存成功后清空已提交密码字段。");
    });
  });
  const validateAccount = (payload) => {
    const invalid = (name, message) => { fieldByName[name].setCustomValidity(message); fieldByName[name].reportValidity(); text("[data-account-message]", `${message}；未发送账户数据。`); return false; };
    accountFields.forEach((field) => field.setCustomValidity(""));
    if (!/^0x[0-9a-fA-F]{40}$/.test(payload.wallet || "")) return invalid("wallet", "请填写完整的资金钱包地址（0x 开头，共 42 位）");
    if (payload.owner_key && !/^(?:0x)?[0-9a-fA-F]{64}$/.test(payload.owner_key)) return invalid("owner_key", "Owner 私钥格式错误，应为 64 位十六进制字符，可带 0x 前缀");
    if (payload.relayer_key && !/^[A-Za-z0-9._~+/=-]{16,256}$/.test(payload.relayer_key)) return invalid("relayer_key", "Relayer key 格式错误，请去掉说明文字");
    if (payload.relayer_address && !/^0x[0-9a-fA-F]{40}$/.test(payload.relayer_address)) return invalid("relayer_address", "Relayer address 格式错误，应为 0x 开头的完整地址");
    for (const name of ["builder_api_key", "builder_secret", "builder_passphrase"]) {
      if (payload[name] && (/\s/.test(payload[name]) || payload[name].length > 512)) return invalid(name, "Builder 凭据不能包含空白字符，且每项最多 512 个字符");
    }
    // The server merges blank fields with the same wallet's saved profile before
    // checking Relayer/Builder completeness; a partial rotation can be valid.
    return true;
  };
  const accountRequestAllowed = () => {
    try { return window.location.protocol === "https:" && new URL(window.PolyPreview.config.apiBase || window.location.origin, window.location.href).origin === window.location.origin; }
    catch { return false; }
  };
  const runAccountAction = async (save, useSaved = false) => {
    if (accountBusy || controlBusy || closed) return;
    if (window.PolyPreview.config.mode === "local-preview") { text("[data-account-message]", "服务器未连接，无法检查或保存账户。"); return; }
    if (!accountRequestAllowed()) { text("[data-account-message]", "账户密钥只允许通过受保护的 HTTPS 同源页面提交；当前页面未发送任何输入。"); return; }
    const payload = useSaved ? {} : Object.fromEntries(accountFields.map((field) => [field.dataset.accountField, field.value.trim()]).filter(([, value]) => value));
    if (!useSaved && !validateAccount(payload)) return;
    const submitted = useSaved ? [] : accountFields.map((field) => ({ field, value: field.value, version: fieldVersions.get(field) }));
    accountBusy = true;
    pendingAccountAction = useSaved ? "saved" : save ? "save" : "check";
    syncAccountButtons();
    text("[data-account-message]", useSaved ? "正在检查服务器已保存账户；未提交输入框草稿…" : save ? "正在检查并保存账户…" : "正在检查账户，尚未保存…");
    try {
      const response = save ? await adapter.saveAccount(payload) : await adapter.checkAccount(payload);
      if (closed) return;
      if (!isObject(response) || response.ok !== true || response.status === "preview" || !isObject(response.report)) throw new Error("账户接口未确认检查或保存成功");
      if (save) savedWallet = payload.wallet;
      let changed = false;
      submitted.forEach(({ field, value, version }) => {
        if (fieldVersions.get(field) !== version || field.value !== value) { changed = true; return; }
        if (field.type === "password") field.value = "";
      });
      const report = response.report;
      text("[data-account-message]", `${useSaved ? "服务器已保存账户检查完成；输入框草稿未提交，仍保留" : `${save ? "本次提交的账户已保存" : "检查完成，尚未保存账户"}；已提交密码已清除${changed ? "，请求期间的新修改仍保留且未保存" : ""}`}。账户就绪：${boolText(report.account_ready)}；签名匹配：${boolText(report.signer_matches)}；授权就绪：${boolText(report.approvals_ready)}。未启动交易 · ${now()}`);
      // A follow-up read failure must not turn a confirmed save into a failure.
      void Promise.resolve().then(() => adapter.loadAccountStatus()).catch(() => {});
    } catch (error) {
      if (!closed) text("[data-account-message]", `${safeMessage(error?.message || "账户操作失败", payload)}；未确认保存成功，输入已保留。`);
    } finally {
      submitted.forEach((item) => { item.value = ""; });
      Object.keys(payload).forEach((key) => { delete payload[key]; });
      accountBusy = false;
      pendingAccountAction = "";
      syncAccountButtons();
    }
  };
  document.querySelector("[data-account-check]")?.addEventListener("click", () => { void runAccountAction(false); });
  document.querySelector("[data-account-check-saved]")?.addEventListener("click", () => { void runAccountAction(false, true); });
  document.querySelector("[data-account-save]")?.addEventListener("click", () => { void runAccountAction(true); });
  controlInput.addEventListener("input", () => {
    controlVersion += 1;
    text("[data-control-message]", controlBusy ? "正在连接；新输入尚未提交，将保留供下一次连接。" : "控制密码尚未提交，点击连接后由服务器验证。");
    syncAccountButtons();
  });
  controlButton.addEventListener("click", async () => {
    if (accountBusy || controlBusy || closed || !controlInput.value.trim()) return;
    if (window.PolyPreview.config.mode === "local-preview") { text("[data-control-message]", "服务器未连接，无法建立控制会话。"); return; }
    if (!accountRequestAllowed()) { text("[data-control-message]", "控制密码只允许通过受保护的 HTTPS 同源页面提交；当前未发送输入。"); return; }
    let token = controlInput.value.trim();
    if (token.length > 1024) { text("[data-control-message]", "控制密码长度超出限制；未发送输入。"); return; }
    const submittedVersion = controlVersion;
    controlBusy = true;
    syncAccountButtons();
    text("[data-control-message]", "正在验证并连接控制会话…");
    try {
      const response = await adapter.openControlSession(token);
      if (closed) return;
      if (!isObject(response) || response.ok !== true || response.status === "preview") throw new Error("服务器未确认控制会话连接成功");
      const changed = submittedVersion !== controlVersion || controlInput.value.trim() !== token;
      if (!changed) controlInput.value = "";
      const duration = Number.isFinite(response.expires_in) && response.expires_in > 0 ? `，约 ${Math.max(1, Math.round(response.expires_in / 60))} 分钟有效` : "";
      text("[data-control-message]", `服务器已建立控制会话${duration}；${changed ? "请求期间的新输入尚未提交，仍保留" : "已清空密码输入"}。未启动交易，也未改变服务器实盘解锁配置。`);
    } catch (error) {
      if (!closed) text("[data-control-message]", `${safeMessage(error?.message || "控制会话连接失败", { token })}；未确认连接成功，输入已保留。`);
    } finally {
      token = "";
      controlBusy = false;
      syncAccountButtons();
    }
  });
  window.addEventListener("pagehide", () => {
    closed = true;
    accountFields.filter((field) => field.type === "password").forEach((field) => { field.value = ""; });
    controlInput.value = "";
    syncAccountButtons();
  });
  window.addEventListener("pageshow", () => { closed = false; syncAccountButtons(); });
  syncAccountButtons();
  if (window.PolyPreview.config.mode !== "local-preview") void refreshDiagnostics();
})();

