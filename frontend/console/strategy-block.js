"use strict";
(() => {
  // src/strategy-block.ts
  var root = document.querySelector("#strategy-block-root");
  if (!root) throw new Error("strategy block root missing");
  var store = window.PolyPreviewStore;
  var adapter = window.PolyPreviewAdapter;
  var vm = window.PolyPreviewViewModel;
  var navItems = [
    ["\u25C8", "\u603B\u89C8", "overview.html"],
    ["\u25C7", "\u5E02\u573A", "market.html"],
    ["\u2197", "\u81EA\u52A8\u4EA4\u6613", "auto-trade.html"],
    ["\u25D2", "\u7B56\u7565", "strategy.html"],
    ["\u2699", "\u8BBE\u7F6E", "settings.html"]
  ];
  var navMarkup = navItems.map(([icon, label, target]) => `<button class="nav-item${label === "\u7B56\u7565" ? " active" : ""}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === "\u7B56\u7565" ? ' aria-current="page"' : ""}><span>${icon}</span>${label}</button>`).join("");
  root.innerHTML = `
  <div class="overview-preview strategy-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>交易控制台</small></div></div>
      <div class="brand-card"><span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span><strong>Polymarket</strong></div>
      <p class="sidebar-copy">\u9762\u5411 BTC \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565\u7684\u4EA4\u6613\u63A7\u5236\u53F0\u3002</p>
      <nav aria-label="\u7B56\u7565\u5BFC\u822A">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>服务器数据</span><small>等待后端连接</small></div>
    </aside>

    <main class="preview-main strategy-main">
      <header class="preview-header strategy-header">
        <div class="hero-copy"><p class="eyebrow">策略配置</p><div class="hero-title-row"><h1>\u7B56\u7565</h1><span class="language-chip">BTC \xB7 5 分钟</span></div><p class="subtitle">\u8C03\u6574\u5355\u4E00 BTC \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565\u7684\u89E6\u53D1\u3001\u5206\u9636\u6BB5\u4E70\u5165\u548C\u8FD0\u884C\u8FB9\u754C\u3002</p></div>
        <div class="strategy-header-side"><span class="strategy-state-chip"><i></i>后端未连接</span><div class="header-status-grid"><article class="header-status"><span>\u7B56\u7565\u6807\u8BC6</span><strong>btc-reversal</strong></article><article class="header-status"><span>\u5F53\u524D\u7248\u672C</span><strong data-strategy-revision>--</strong></article><article class="header-status"><span>\u8FD0\u884C\u6A21\u5F0F</span><strong>\u5B9E\u76D8\u7B56\u7565</strong></article><article class="header-status"><span>\u751F\u6548\u65F6\u673A</span><strong>未来未创建场次</strong></article></div></div>
      </header>

      <section class="strategy-identity-panel">
        <div class="strategy-identity-icon">\u21AF</div><div class="strategy-identity-copy"><p class="eyebrow">当前策略</p><h2>BTC \u4E94\u5206\u949F\u53CD\u8F6C</h2><p>\u8DDF\u968F\u65B9\u5411\u53CD\u8F6C\uFF0C\u6309\u786E\u8BA4\u6B21\u6570\u5206\u9636\u6BB5\u4E70\u5165\uFF1B\u540C\u4E00\u65B9\u5411\u4E0D\u4F1A\u91CD\u590D\u52A0\u4ED3\u3002</p></div><div class="identity-tags"><span class="identity-tag active-tag"><i></i>\u552F\u4E00\u8FD0\u884C\u7B56\u7565</span><span class="identity-tag">已发布版本待读取</span></div>
      </section>

      <section class="strategy-layout">
        <div class="strategy-form-panel">
          <div class="panel-heading"><div><p class="eyebrow">配置内容</p><h2>\u7B56\u7565\u53C2\u6570</h2></div><span class="panel-meta">保存草稿后需另行激活</span></div>
          <div class="strategy-tabs" role="tablist"><button type="button" class="strategy-tab active" data-strategy-tab="parameters" role="tab" aria-selected="true">\u7B56\u7565\u53C2\u6570</button><button type="button" class="strategy-tab" data-strategy-tab="runtime" role="tab" aria-selected="false">\u8FD0\u884C\u8BBE\u7F6E</button></div>

          <div class="strategy-pane" data-strategy-pane="parameters">
            <div class="preset-row"><div><strong>\u5FEB\u901F\u53C2\u8003</strong><small>服务器尚未提供参考参数，当前不可用。</small></div><div class="preset-actions" data-preset-list><span class="muted-text">等待后端能力</span></div></div>
            <div class="preset-editor" data-preset-editor hidden><div><strong>\u6DFB\u52A0\u53C2\u8003\u53C2\u6570</strong><small>服务器参考参数接口接入后，可保存并复用参数。</small></div><div class="preset-editor-fields"><label>\u540D\u79F0<input type="text" value="\u65B0\u53C2\u8003" data-preset-new-name></label><label>\u89E6\u53D1\u4EF7<input type="number" value="67" data-preset-new-trigger></label><label>\u786E\u8BA4\u4EF7<input type="number" value="70" data-preset-new-confirm></label><label>\u6700\u9AD8\u4E70\u5165<input type="number" value="70" data-preset-new-max></label></div><div class="preset-editor-actions"><button type="button" class="secondary-button" data-cancel-preset>\u53D6\u6D88</button><button type="button" class="save-button" data-create-preset>\u6DFB\u52A0\u5230\u5217\u8868</button></div></div>
            <div class="config-section"><div class="config-section-heading"><div><span class="section-number">01</span><div><h3>\u89E6\u53D1\u4E0E\u4E70\u5165\u4EF7\u683C</h3><p>\u63A7\u5236\u4EC0\u4E48\u65F6\u5019\u8FDB\u5165\u53CD\u8F6C\u3001\u786E\u8BA4\u65B9\u5411\uFF0C\u4EE5\u53CA\u6700\u9AD8\u9650\u4EF7\u3002</p></div></div><span class="section-state">\u4EF7\u683C\u5355\u4F4D \xB7 \u7F8E\u5206</span></div><div class="field-grid three-fields">
              <label class="strategy-field"><span>\u89E6\u53D1\u4EF7</span><div><input type="number" step="1" placeholder="--" data-field="trigger"><b>\xA2</b></div><small>\u5356\u4E00\u4ECE\u4E0B\u65B9\u8DE8\u8FC7\u6B64\u4EF7\u683C\u65F6\u89E6\u53D1\u3002</small></label>
              <label class="strategy-field"><span>\u53CD\u8F6C\u786E\u8BA4\u4EF7</span><div><input type="number" step="1" placeholder="--" data-field="confirm"><b>\xA2</b></div><small>\u7528\u4E8E\u8BB0\u5F55\u65B9\u5411\u786E\u8BA4\uFF0C\u4E0D\u5EF6\u8FDF\u4E0B\u4E00\u9636\u6BB5\u3002</small></label>
              <label class="strategy-field"><span>\u6700\u9AD8\u4E70\u5165\u4EF7</span><div><input type="number" step="1" placeholder="--" data-field="maxPrice"><b>\xA2</b></div><small>\u9650\u4EF7\u4E0D\u8FFD\u9AD8\uFF0C\u672A\u6210\u4EA4\u4F59\u91CF\u7EE7\u7EED\u6302\u5355\u3002</small></label>
            </div></div>

            <div class="config-section stages-config"><div class="config-section-heading"><div><span class="section-number">02</span><div><h3>\u6BCF\u9636\u6BB5\u65B0\u589E\u4EFD\u989D</h3><p>\u65B0\u65B9\u5411\u53CD\u8F6C\u65F6\u8FDB\u5165\u4E0B\u4E00\u9636\u6BB5\uFF0C\u540C\u65B9\u5411\u4E0D\u91CD\u590D\u52A0\u4ED3\u3002</p></div></div><label class="stage-count"><span>\u9636\u6BB5\u6570</span><input type="number" min="1" max="100" step="1" placeholder="--" data-stage-count></label></div><label class="stage-count"><span>执行阶段上限</span><input type="number" min="1" max="100" step="1" placeholder="--" data-max-stages></label><div class="stage-input-grid" data-stage-inputs>
            </div></div>
            <div class="budget-hint" data-budget-hint><span class="info-dot">i</span><span>按服务器返回的最高买入价计算执行阶段名义成本 <strong>--</strong>。交易费用另计。</span></div>
          </div>

          <div class="strategy-pane" data-strategy-pane="runtime" hidden>
            <div class="config-section"><div class="config-section-heading"><div><span class="section-number">03</span><div><h3>\u8D44\u91D1\u4E0E\u8FD0\u884C\u65F6\u95F4</h3><p>\u9650\u5236\u5355\u573A\u6295\u5165\u3001\u7B56\u7565\u603B\u5360\u7528\u548C\u81EA\u52A8\u505C\u6B62\u6761\u4EF6\u3002</p></div></div><span class="section-state">\u53EF\u9009\u8FB9\u754C</span></div><div class="field-grid runtime-fields">
              <label class="strategy-field"><span>\u5355\u573A\u8D44\u91D1\u4E0A\u9650</span><div><input type="number" placeholder="\u672A\u8BBE\u7F6E" data-runtime-field="roundBudget"><b>USDC</b></div><small>\u5305\u62EC\u672C\u573A\u6301\u4ED3\u3001\u672A\u5B8C\u6210\u4E70\u5355\u548C\u8D39\u7528\u9884\u7559\u3002</small></label>
              <label class="strategy-field"><span>\u7B56\u7565\u603B\u8D44\u91D1\u4E0A\u9650</span><div><input type="number" placeholder="\u672A\u8BBE\u7F6E" data-runtime-field="totalBudget"><b>USDC</b></div><small>\u9650\u5236\u672C\u7B56\u7565\u540C\u65F6\u5360\u7528\u7684\u8D44\u91D1\u3002</small></label>
              <label class="strategy-field"><span>\u6BCF\u65E5\u4E8F\u635F\u505C\u6B62\u7EBF</span><div><input type="number" placeholder="\u672A\u8BBE\u7F6E" data-runtime-field="lossLimit"><b>USDC</b></div><small>\u8FBE\u5230\u540E\u6682\u505C\u65B0\u589E\u8BA2\u5355\uFF0C\u4FDD\u7559\u5DF2\u6709\u8BA2\u5355\u3002</small></label>
              <label class="strategy-field"><span>\u8FD0\u884C\u65F6\u957F</span><div><input type="number" value="0" data-runtime-field="duration"><b>\u5206\u949F</b></div><small>0 \u8868\u793A\u6301\u7EED\u8FD0\u884C\uFF0C\u76F4\u5230\u624B\u52A8\u505C\u6B62\u3002</small></label>
            </div></div><div class="runtime-note"><span class="info-dot">i</span><span>\u6682\u505C\u65B0\u589E\u4F1A\u4FDD\u7559\u73B0\u6709\u8BA2\u5355\uFF1B\u505C\u6B62\u4F1A\u64A4\u9500\u4F59\u91CF\uFF0C\u5DF2\u6210\u4EA4\u6301\u4ED3\u4FDD\u7559\u3002\u8FD0\u884C\u65F6\u957F\u5728\u4E0B\u6B21\u542F\u52A8\u65F6\u751F\u6548\u3002</span></div>
          </div>

          <div class="strategy-savebar"><span class="save-state" data-save-state>\u5F53\u524D\u6CA1\u6709\u672A\u4FDD\u5B58\u4FEE\u6539</span><div><button type="button" class="secondary-button" data-reset>\u64A4\u9500\u4FEE\u6539</button><button type="button" class="secondary-button" data-reload>重新读取</button><button type="button" class="save-button" data-save>\u4FDD\u5B58\u7B56\u7565\u8349\u7A3F</button><button type="button" class="save-button" data-activate disabled>激活已保存草稿</button></div></div>
          <p class="save-state" data-draft-state role="status">尚无可激活草稿</p>
        </div>

        <aside class="strategy-aside">
          <section class="preview-card"><div class="panel-heading"><div><p class="eyebrow">实时预览</p><h2>\u53C2\u6570\u9884\u89C8</h2></div><span class="preview-dot"><i></i>\u5F85\u4FDD\u5B58</span></div><div class="preview-price"><span>\u89E6\u53D1\u4EF7</span><strong data-preview-trigger>--</strong><span class="preview-arrow">\u2192</span><div><span>\u6700\u9AD8\u4E70\u5165</span><strong data-preview-max>--</strong></div></div><div class="preview-steps"><div class="preview-step-heading"><span>\u5206\u9636\u6BB5\u4E70\u5165\u8BA1\u5212</span><b data-preview-total>--</b></div><ol></ol></div></section>
          <section class="activation-card"><div class="activation-heading"><span class="activation-icon">\u25F7</span><div><h3>\u751F\u6548\u89C4\u5219</h3><p>\u4E0D\u4F1A\u7ACB\u5373\u6539\u53D8\u5F53\u524D\u8FD0\u884C</p></div></div><div class="activation-line"><i class="done"></i><div><strong>保存策略草稿</strong><small>仅保存，不发布、不启动</small></div></div><div class="activation-line"><i></i><div><strong>另行激活草稿</strong><small>当前和已预热场次配置保持不变</small></div></div><div class="activation-line"><i></i><div><strong>\u81EA\u52A8\u4EA4\u6613\u8BFB\u53D6</strong><small>激活后仅影响未来未创建场次</small></div></div></section>
          <section class="guardrail-card"><div class="guardrail-heading"><span>\u7B56\u7565\u7EA6\u675F</span><b>4 \u9879</b></div><ul><li><i>\u2713</i>\u5355\u4E00 BTC \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565</li><li><i>\u2713</i>\u4EF7\u683C\u4F7F\u7528\u9650\u4EF7\uFF0C\u4E0D\u8FFD\u9AD8</li><li><i>\u2713</i>\u540C\u65B9\u5411\u4E0D\u91CD\u590D\u52A0\u4ED3</li><li><i>\u2713</i>\u4FDD\u5B58\u4E0D\u4F1A\u81EA\u52A8\u542F\u52A8\u4EA4\u6613</li></ul></section>
        </aside>
      </section>
    </main>
  </div>
`;
  var text = (selector, value) => {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  };
  document.querySelectorAll("[data-preview-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.previewTarget;
      if (target) window.PolyPreview.navigate(target);
    });
  });
  var parameterPane = document.querySelector('[data-strategy-pane="parameters"]');
  var runtimePane = document.querySelector('[data-strategy-pane="runtime"]');
  document.querySelectorAll("[data-strategy-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const runtime = button.dataset.strategyTab === "runtime";
      parameterPane?.toggleAttribute("hidden", runtime);
      runtimePane?.toggleAttribute("hidden", !runtime);
      document.querySelectorAll("[data-strategy-tab]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", String(active));
      });
    });
  });
  const field = (key) => root.querySelector(`[data-field="${key}"]`);
  const stageInputs = () => Array.from(root.querySelectorAll("[data-stage]"));
  const core = window.PolyPreview;
  let resource = store.getState().strategy;
  let dirty = false;
  let busy = false;
  let baselineRevision = null;
  let formConfig = null;
  let formKey = null;
  const legacyMode = core.config.apiFlavor === "legacy";
  const published = () => resource?.data?.config || null;
  const hasBtcPublished = () => vm.isBtcStrategyConfig(published());
  const draft = () => resource?.draft || null;
  const validDraft = () => {
    const value = draft();
    return value && typeof value.draftId === "string" && value.config
      && vm.isBtcStrategyConfig(value.config)
      && Number.isInteger(value.expectedRevision) && value.expectedRevision === resource.revision;
  };
  const selectedAsset = () => "btc";
  const setMessage = (message) => text("[data-save-state]", message);
  const controls = () => {
    const available = hasBtcPublished();
    root.querySelectorAll("[data-field], [data-stage], [data-stage-count], [data-max-stages], [data-runtime-field]")
      .forEach((input) => { input.disabled = busy || !available; });
    root.querySelector("[data-save]").disabled = busy || !available;
    root.querySelector("[data-reset]").disabled = busy || !available;
    root.querySelector("[data-reload]").disabled = busy;
    root.querySelector("[data-activate]").disabled = legacyMode || busy || dirty || !validDraft() || resource.status !== "ready";
  };
  const updatePreview = () => {
    const trigger = field("trigger").value.trim() === "" ? null : Number(field("trigger").value);
    const max = field("maxPrice").value.trim() === "" ? null : Number(field("maxPrice").value);
    const stages = stageInputs().map((input) => input.value.trim() === "" ? null : Number(input.value));
    const limit = Number(root.querySelector("[data-max-stages]").value);
    const total = stages.length && Number.isInteger(limit) && limit > 0 ? stages.slice(0, limit).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) : null;
    text("[data-preview-trigger]", Number.isFinite(trigger) ? `${trigger / 100} USDC` : "--");
    text("[data-preview-max]", Number.isFinite(max) ? `${max / 100} USDC` : "--");
    text("[data-preview-total]", `${Number.isFinite(total) ? total : "--"} 份`);
    const list = root.querySelector(".preview-steps ol");
    list.innerHTML = stages.map((value, index) => `<li><i>${index + 1}</i><span>${index >= limit ? "不执行 · 超出上限" : index ? `第 ${index} 次反转` : "进入触发区"}</span><strong>${Number.isFinite(value) ? value : "--"} 份</strong></li>`).join("");
    text("[data-budget-hint] strong", Number.isFinite(total) && Number.isFinite(max) ? `$${(total * max / 100).toFixed(2)}` : "--");
  };
  const markDirty = () => {
    dirty = true;
    updatePreview();
    setMessage("有未保存修改；先保存草稿，再激活。");
    controls();
  };
  const renderStages = (values) => {
    root.querySelector("[data-stage-count]").value = String(values.length);
    root.querySelector("[data-stage-inputs]").innerHTML = values.map((value, index) => {
      const finiteValue = typeof value === "number" && Number.isFinite(value) ? value : "";
      return `<label class="stage-input stage-${["one", "two", "three", "four"][index] || "extra"}"><span><i>${index + 1}</i>第${index + 1}阶段</span><div><input type="number" min="0" step="any" value="${finiteValue}" data-stage="${index + 1}"><b>份</b></div><small>${index ? `第 ${index} 次反转确认` : "首次进入触发区"}</small></label>`;
    }).join("");
    stageInputs().forEach((input) => input.addEventListener("input", markDirty));
  };
  const hydrate = (config, key) => {
    formConfig = { ...config, stageShares: [...config.stageShares] };
    formKey = key;
    baselineRevision = resource.revision;
    for (const [key, name] of Object.entries({ trigger: "triggerPrice", confirm: "confirmationPrice", maxPrice: "maxBuyPrice" })) {
      const value = config[name];
      field(key).value = value == null ? "" : String(Number((value * 100).toPrecision(14)));
    }
    renderStages(config.stageShares);
    root.querySelector("[data-max-stages]").value = String(config.maxStages ?? config.stageShares.length);
    for (const [key, name] of Object.entries({ roundBudget: "roundBudgetUsd", totalBudget: "totalBudgetUsd", lossLimit: "dailyLossUsd", duration: "durationMinutes" })) {
      root.querySelector(`[data-runtime-field="${key}"]`).value = config[name] == null ? "" : String(config[name]);
    }
    dirty = false;
    updatePreview();
    controls();
  };
  const receive = (next) => {
    resource = next;
    text("[data-strategy-revision]", resource.revision == null ? "--" : `版本 ${resource.revision}`);
    text(".identity-tags .identity-tag:last-child", resource.revision == null ? "已发布版本待读取" : `已发布版本 ${resource.revision}`);
    text(".strategy-state-chip", resource.status === "ready" ? hasBtcPublished() ? "BTC 服务器配置已读取" : "配置目标未确认为 BTC" : resource.status === "stale" ? "连接中断 · 保留配置和编辑" : "配置待接入");
    const savedDraft = draft();
    text("[data-draft-state]", validDraft()
      ? `草稿 ${savedDraft.draftId} · ${String(savedDraft.config.assetId || "--").toUpperCase()} · 基于版本 ${savedDraft.expectedRevision} · 未激活`
      : savedDraft && !vm.isBtcStrategyConfig(savedDraft.config) ? "服务器草稿目标不是 BTC，已禁止激活；请先在服务器更正草稿。"
      : savedDraft ? "原草稿基线已过期或已发布，请重新保存后激活。" : "尚无可激活草稿；保存不会自动发布或启动。");
    if (!dirty && !busy && resource.status === "ready" && hasBtcPublished()) {
      const config = validDraft() ? savedDraft.config : published();
      const key = validDraft() ? `draft:${savedDraft.draftId}` : `revision:${resource.revision}`;
      if (config && Array.isArray(config.stageShares) && key !== formKey) {
        hydrate(config, key);
        setMessage(validDraft() ? "已读取服务器草稿，尚未激活。" : "已读取服务器已发布配置。");
      }
    }
    if (!busy && resource.status === "stale") setMessage("策略接口断开，保留上次配置和未保存输入。");
    if (!busy && resource.status === "unavailable") setMessage("策略配置不可用，等待接口恢复。");
    if (!busy && resource.status === "ready" && !hasBtcPublished()) setMessage("服务器策略没有明确的 BTC 目标，编辑、保存和激活已停用。");
    else if (!busy && savedDraft && !vm.isBtcStrategyConfig(savedDraft.config)) setMessage("服务器草稿目标不是 BTC，激活已停用；请先在服务器更正草稿。");
    if (!dirty && !busy && !hasBtcPublished() && !validDraft()) {
      field("trigger").value = "";
      field("confirm").value = "";
      field("maxPrice").value = "";
      renderStages([]);
      root.querySelector("[data-stage-count]").value = "";
      root.querySelector("[data-max-stages]").value = "";
      root.querySelectorAll("[data-runtime-field]").forEach((input) => { input.value = ""; });
      formConfig = null;
      formKey = "unavailable";
      updatePreview();
    }
    controls();
  };
  root.querySelector("[data-stage-count]").addEventListener("input", (event) => {
    const count = Number(event.target.value);
    if (!Number.isInteger(count) || count < 1 || count > 100) { dirty = true; setMessage("阶段数须为 1 至 100 的整数。"); controls(); return; }
    const previous = stageInputs().map((input) => input.value === "" ? null : Number(input.value));
    const oldLimit = Number(root.querySelector("[data-max-stages]").value);
    renderStages(Array.from({ length: count }, (_, index) => previous[index] ?? null));
    root.querySelector("[data-max-stages]").value = String(oldLimit === previous.length ? count : Math.min(count, oldLimit));
    markDirty();
  });
  root.querySelectorAll("[data-field], [data-stage], [data-runtime-field], [data-max-stages]").forEach((input) => {
    input.step = input.hasAttribute("data-max-stages") ? "1" : "any";
    input.addEventListener("input", markDirty);
  });
  root.querySelectorAll("[data-preset], [data-remove-preset], [data-add-preset], [data-create-preset]").forEach((button) => {
    button.disabled = true;
    button.title = "参考参数接口尚未提供";
  });
  root.querySelector("[data-reset]").addEventListener("click", () => {
    if (busy || !published()) return;
    const savedDraft = validDraft() ? draft() : null;
    hydrate(savedDraft ? savedDraft.config : published(), savedDraft ? `draft:${savedDraft.draftId}` : `revision:${resource.revision}`);
    setMessage(savedDraft ? "已恢复服务器最后保存草稿，尚未激活。" : "已恢复服务器最后发布配置。");
    controls();
  });
  root.querySelector("[data-reload]").addEventListener("click", async () => {
    if (busy) return;
    busy = true; controls();
    try { await adapter.loadStrategy(); }
    catch (error) { setMessage(core.format.readableError(error.message, "策略读取失败，输入已保留。")); }
    finally { busy = false; receive(store.getState().strategy); }
    if (dirty) setMessage("服务器状态已读取；未保存输入保持不变。撤销修改可恢复服务器值。");
  });
  const readForm = () => {
    const prices = [field("trigger"), field("confirm"), field("maxPrice")].map((input) => Number(input.value));
    const [trigger, confirmation, maximum] = prices;
    const stages = stageInputs().map((input) => Number(input.value));
    const count = Number(root.querySelector("[data-stage-count]").value);
    const maxStages = Number(root.querySelector("[data-max-stages]").value);
    if (prices.some((value) => !Number.isFinite(value) || value <= 0 || value >= 100) || trigger > confirmation || trigger > maximum) throw new Error("价格须大于 0 且小于 100 美分；确认价和最高买价均不得低于触发价。");
    if (!Number.isInteger(count) || count < 1 || count > 100 || stages.length !== count || stages.some((value) => !Number.isFinite(value) || value <= 0) || !Number.isInteger(maxStages) || maxStages < 1 || maxStages > count) throw new Error("请填写 1 至 100 个正数阶段份额，执行上限须为不超过阶段数的正整数。");
    const optional = (key) => {
      const value = root.querySelector(`[data-runtime-field="${key}"]`).value.trim();
      return value === "" ? null : Number(value);
    };
    const budgets = [optional("roundBudget"), optional("totalBudget"), optional("lossLimit")];
    if (budgets.some((value) => value !== null && (!Number.isFinite(value) || value <= 0))) throw new Error("资金上限和亏损线必须为空或正数。");
    const duration = optional("duration") ?? 0;
    if (!Number.isFinite(duration) || duration < 0 || duration * 60000 > 2147483647) throw new Error("运行时长须为有效非负分钟数；持续运行请填 0。");
    return { strategyId: core.config.strategyId, assetId: selectedAsset(), expectedRevision: baselineRevision,
      triggerPrice: trigger / 100, confirmationPrice: confirmation / 100, maxBuyPrice: maximum / 100,
      stageShares: stages, maxStages, roundBudgetUsd: budgets[0], totalBudgetUsd: budgets[1], dailyLossUsd: budgets[2],
      durationMinutes: duration, mode: "live", maxQuoteAgeSeconds: formConfig?.maxQuoteAgeSeconds ?? 2,
      maxQuoteSkewSeconds: formConfig?.maxQuoteSkewSeconds ?? 1.5 };
  };
  root.querySelector("[data-save]").addEventListener("click", async () => {
    if (busy) return;
    let payload;
    try { payload = readForm(); } catch (error) { setMessage(error.message); return; }
    busy = true; controls(); setMessage("正在保存草稿，尚未发布…");
    try {
      const result = await adapter.saveStrategy(payload);
      if (!vm.isBtcStrategyConfig(result?.config)) throw new Error("服务器保存回执没有确认 BTC 目标；输入已保留，不能激活。");
      if (result?.published === true) {
        resource = store.getState().strategy;
        dirty = false;
        formConfig = { ...result.config, stageShares: [...result.config.stageShares] };
        baselineRevision = result.revision;
        formKey = `revision:${result.revision}`;
        setMessage("旧版策略接口已保存并发布；启动时使用该服务器版本。现代草稿接口接入后可恢复单独激活。");
        return;
      }
      if (result?.accepted === false || typeof result?.draftId !== "string" || !Number.isInteger(result.expectedRevision) || !result.config) throw new Error(result?.message || "接口没有确认草稿已保存；输入已保留。");
      resource = store.getState().strategy;
      dirty = false;
      formConfig = { ...result.config, stageShares: [...result.config.stageShares] };
      baselineRevision = result.expectedRevision;
      formKey = `draft:${result.draftId}`;
      setMessage("策略草稿已保存，尚未激活；请确认后点击激活已保存草稿。");
    } catch (error) { setMessage(core.format.readableError(error.message, "草稿保存失败，输入已保留。")); }
    finally { busy = false; controls(); }
  });
  root.querySelector("[data-activate]").addEventListener("click", async () => {
    if (busy || dirty || !validDraft()) return;
    const savedDraft = draft();
    busy = true; controls(); setMessage("正在激活服务器草稿…");
    try {
      const result = await adapter.activateStrategy({ strategyId: core.config.strategyId, draftId: savedDraft.draftId, expectedRevision: savedDraft.expectedRevision });
      if (result?.accepted !== true) throw new Error(result?.message || "服务器未确认激活成功，草稿仍保留。");
      busy = false;
      receive(store.getState().strategy);
      setMessage(resource.status === "ready" ? "策略已发布；仅影响未来未创建场次，当前及已预热场次保持原配置。" : "服务器已确认发布，但配置重读失败；保留草稿和最后配置，恢复连接后核对版本。");
    } catch (error) { setMessage(core.format.readableError(error.message, "激活失败，草稿已保留。")); }
    finally { busy = false; controls(); }
  });
  if (legacyMode) root.querySelector("[data-activate]").hidden = true;
  updatePreview();
  store.subscribe("strategy", receive);
  void adapter.loadMarkets().then(() => adapter.loadStrategy());
})();
