"use strict";
(() => {
  // src/strategy-block.ts
  var root = document.querySelector("#strategy-block-root");
  if (!root) throw new Error("strategy block root missing");
  var store = window.PolyPreviewStore;
  var adapter = window.PolyPreviewAdapter;
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
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>TRADING CONSOLE</small></div></div>
      <div class="brand-card"><span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span><strong>Polymarket</strong></div>
      <p class="sidebar-copy">\u9762\u5411 平台支持加密货币 \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565\u7684\u4EA4\u6613\u63A7\u5236\u53F0\u3002</p>
      <nav aria-label="\u7B56\u7565\u8BBE\u8BA1\u7A3F\u5BFC\u822A">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>\u539F\u578B\u9884\u89C8</span><small>\u6570\u636E\u5F85\u63A5\u5165</small></div>
    </aside>

    <main class="preview-main strategy-main">
      <header class="preview-header strategy-header">
        <div class="hero-copy"><p class="eyebrow">STRATEGY CONFIGURATION</p><div class="hero-title-row"><h1>\u7B56\u7565</h1><span class="language-chip">CRYPTO \xB7 5m</span></div><p class="subtitle">\u8C03\u6574\u5355\u4E00 平台支持加密货币 \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565\u7684\u89E6\u53D1\u3001\u5206\u9636\u6BB5\u4E70\u5165\u548C\u8FD0\u884C\u8FB9\u754C\u3002</p></div>
        <div class="strategy-header-side"><span class="strategy-state-chip"><i></i>\u8BBE\u8BA1\u7A3F \xB7 \u672A\u8FDE\u63A5</span><div class="header-status-grid"><article class="header-status"><span>\u7B56\u7565\u6807\u8BC6</span><strong>reversal-5m</strong></article><article class="header-status"><span>\u5F53\u524D\u7248\u672C</span><strong data-strategy-revision>--</strong></article><article class="header-status"><span>\u8FD0\u884C\u6A21\u5F0F</span><strong>\u5B9E\u76D8\u7B56\u7565</strong></article><article class="header-status"><span>\u751F\u6548\u65F6\u673A</span><strong>\u4E0B\u4E00\u573A\u6B21</strong></article></div></div>
      </header>

      <section class="strategy-identity-panel">
        <div class="strategy-identity-icon">\u21AF</div><div class="strategy-identity-copy"><p class="eyebrow">ACTIVE STRATEGY</p><h2>平台支持加密货币 \u4E94\u5206\u949F\u53CD\u8F6C</h2><p>\u8DDF\u968F\u65B9\u5411\u53CD\u8F6C\uFF0C\u6309\u786E\u8BA4\u6B21\u6570\u5206\u9636\u6BB5\u4E70\u5165\uFF1B\u540C\u4E00\u65B9\u5411\u4E0D\u4F1A\u91CD\u590D\u52A0\u4ED3\u3002</p></div><div class="identity-tags"><span class="identity-tag active-tag"><i></i>\u552F\u4E00\u8FD0\u884C\u7B56\u7565</span><span class="identity-tag">\u7248\u672C REV-001</span></div>
      </section>

      <section class="strategy-layout">
        <div class="strategy-form-panel">
          <div class="panel-heading"><div><p class="eyebrow">CONFIGURATION</p><h2>\u7B56\u7565\u53C2\u6570</h2></div><span class="panel-meta">\u4FEE\u6539\u53EA\u5F71\u54CD\u4E0B\u4E00\u573A\u6B21</span></div>
          <div class="strategy-tabs" role="tablist"><button type="button" class="strategy-tab active" data-strategy-tab="parameters" role="tab" aria-selected="true">\u7B56\u7565\u53C2\u6570</button><button type="button" class="strategy-tab" data-strategy-tab="runtime" role="tab" aria-selected="false">\u8FD0\u884C\u8BBE\u7F6E</button></div>

          <div class="strategy-pane" data-strategy-pane="parameters">
            <div class="preset-row"><div><strong>\u5FEB\u901F\u53C2\u8003</strong><small>\u586B\u5165\u540E\u4ECD\u53EF\u7EE7\u7EED\u4FEE\u6539\uFF0C\u4FDD\u5B58\u624D\u4F1A\u751F\u6548\u3002</small></div><div class="preset-actions" data-preset-list><div class="preset-item" data-preset-item><button type="button" class="preset-choice" data-preset data-preset-trigger="67" data-preset-confirm="70" data-preset-max="70" data-preset-stages="5,18,54,130">70 \u7F8E\u5206\u53C2\u8003</button><button type="button" class="preset-remove" data-remove-preset aria-label="\u5220\u9664 70 \u7F8E\u5206\u53C2\u8003">\xD7</button></div><div class="preset-item" data-preset-item><button type="button" class="preset-choice" data-preset data-preset-trigger="70" data-preset-confirm="75" data-preset-max="75" data-preset-stages="5,22,75,236">75 \u7F8E\u5206\u53C2\u8003</button><button type="button" class="preset-remove" data-remove-preset aria-label="\u5220\u9664 75 \u7F8E\u5206\u53C2\u8003">\xD7</button></div><button type="button" class="add-preset" data-add-preset>\uFF0B \u6DFB\u52A0\u53C2\u8003</button></div></div>
            <div class="preset-editor" data-preset-editor hidden><div><strong>\u6DFB\u52A0\u53C2\u8003\u53C2\u6570</strong><small>\u4FDD\u5B58\u5230\u672C\u5730\u8BBE\u8BA1\u7A3F\u5217\u8868\uFF0C\u540E\u7EED\u53EF\u7EE7\u7EED\u5220\u9664\u3002</small></div><div class="preset-editor-fields"><label>\u540D\u79F0<input type="text" value="\u65B0\u53C2\u8003" data-preset-new-name></label><label>\u89E6\u53D1\u4EF7<input type="number" value="67" data-preset-new-trigger></label><label>\u786E\u8BA4\u4EF7<input type="number" value="70" data-preset-new-confirm></label><label>\u6700\u9AD8\u4E70\u5165<input type="number" value="70" data-preset-new-max></label></div><div class="preset-editor-actions"><button type="button" class="secondary-button" data-cancel-preset>\u53D6\u6D88</button><button type="button" class="save-button" data-create-preset>\u6DFB\u52A0\u5230\u5217\u8868</button></div></div>
            <div class="config-section"><div class="config-section-heading"><div><span class="section-number">01</span><div><h3>\u89E6\u53D1\u4E0E\u4E70\u5165\u4EF7\u683C</h3><p>\u63A7\u5236\u4EC0\u4E48\u65F6\u5019\u8FDB\u5165\u53CD\u8F6C\u3001\u786E\u8BA4\u65B9\u5411\uFF0C\u4EE5\u53CA\u6700\u9AD8\u9650\u4EF7\u3002</p></div></div><span class="section-state">\u4EF7\u683C\u5355\u4F4D \xB7 \u7F8E\u5206</span></div><div class="field-grid three-fields">
              <label class="strategy-field"><span>\u89E6\u53D1\u4EF7</span><div><input type="number" step="1" value="67" data-field="trigger"><b>\xA2</b></div><small>\u5356\u4E00\u4ECE\u4E0B\u65B9\u8DE8\u8FC7\u6B64\u4EF7\u683C\u65F6\u89E6\u53D1\u3002</small></label>
              <label class="strategy-field"><span>\u53CD\u8F6C\u786E\u8BA4\u4EF7</span><div><input type="number" step="1" value="70" data-field="confirm"><b>\xA2</b></div><small>\u7528\u4E8E\u8BB0\u5F55\u65B9\u5411\u786E\u8BA4\uFF0C\u4E0D\u5EF6\u8FDF\u4E0B\u4E00\u9636\u6BB5\u3002</small></label>
              <label class="strategy-field"><span>\u6700\u9AD8\u4E70\u5165\u4EF7</span><div><input type="number" step="1" value="70" data-field="maxPrice"><b>\xA2</b></div><small>\u9650\u4EF7\u4E0D\u8FFD\u9AD8\uFF0C\u672A\u6210\u4EA4\u4F59\u91CF\u7EE7\u7EED\u6302\u5355\u3002</small></label>
            </div></div>

            <div class="config-section stages-config"><div class="config-section-heading"><div><span class="section-number">02</span><div><h3>\u6BCF\u9636\u6BB5\u65B0\u589E\u4EFD\u989D</h3><p>\u65B0\u65B9\u5411\u53CD\u8F6C\u65F6\u8FDB\u5165\u4E0B\u4E00\u9636\u6BB5\uFF0C\u540C\u65B9\u5411\u4E0D\u91CD\u590D\u52A0\u4ED3\u3002</p></div></div><label class="stage-count"><span>\u9636\u6BB5\u6570</span><input type="number" min="1" max="8" value="4" data-stage-count></label></div><div class="stage-input-grid" data-stage-inputs>
              <label class="stage-input stage-one"><span><i>1</i>\u7B2C\u4E00\u9636\u6BB5</span><div><input type="number" value="5" data-stage="1"><b>\u4EFD</b></div><small>\u9996\u6B21\u8FDB\u5165\u89E6\u53D1\u533A</small></label>
              <label class="stage-input stage-two"><span><i>2</i>\u7B2C\u4E8C\u9636\u6BB5</span><div><input type="number" value="18" data-stage="2"><b>\u4EFD</b></div><small>\u7B2C\u4E00\u6B21\u53CD\u8F6C\u786E\u8BA4</small></label>
              <label class="stage-input stage-three"><span><i>3</i>\u7B2C\u4E09\u9636\u6BB5</span><div><input type="number" value="54" data-stage="3"><b>\u4EFD</b></div><small>\u7B2C\u4E8C\u6B21\u53CD\u8F6C\u786E\u8BA4</small></label>
              <label class="stage-input stage-four"><span><i>4</i>\u7B2C\u56DB\u9636\u6BB5</span><div><input type="number" value="130" data-stage="4"><b>\u4EFD</b></div><small>\u7B2C\u4E09\u6B21\u53CD\u8F6C\u786E\u8BA4</small></label>
            </div></div>
            <div class="budget-hint" data-budget-hint><span class="info-dot">i</span><span>\u6309\u6700\u9AD8\u4E70\u5165\u4EF7\u8BA1\u7B97\u7684\u5168\u90E8\u9636\u6BB5\u540D\u4E49\u6210\u672C <strong>$1.45</strong>\u3002\u4EA4\u6613\u8D39\u7528\u53E6\u8BA1\u3002</span></div>
          </div>

          <div class="strategy-pane" data-strategy-pane="runtime" hidden>
            <div class="config-section"><div class="config-section-heading"><div><span class="section-number">03</span><div><h3>\u8D44\u91D1\u4E0E\u8FD0\u884C\u65F6\u95F4</h3><p>\u9650\u5236\u5355\u573A\u6295\u5165\u3001\u7B56\u7565\u603B\u5360\u7528\u548C\u81EA\u52A8\u505C\u6B62\u6761\u4EF6\u3002</p></div></div><span class="section-state">\u53EF\u9009\u8FB9\u754C</span></div><div class="field-grid runtime-fields">
              <label class="strategy-field"><span>\u5355\u573A\u8D44\u91D1\u4E0A\u9650</span><div><input type="number" placeholder="\u672A\u8BBE\u7F6E" data-runtime-field="roundBudget"><b>USD</b></div><small>\u5305\u62EC\u672C\u573A\u6301\u4ED3\u3001\u672A\u5B8C\u6210\u4E70\u5355\u548C\u8D39\u7528\u9884\u7559\u3002</small></label>
              <label class="strategy-field"><span>\u7B56\u7565\u603B\u8D44\u91D1\u4E0A\u9650</span><div><input type="number" placeholder="\u672A\u8BBE\u7F6E" data-runtime-field="totalBudget"><b>USD</b></div><small>\u9650\u5236\u672C\u7B56\u7565\u540C\u65F6\u5360\u7528\u7684\u8D44\u91D1\u3002</small></label>
              <label class="strategy-field"><span>\u6BCF\u65E5\u4E8F\u635F\u505C\u6B62\u7EBF</span><div><input type="number" placeholder="\u672A\u8BBE\u7F6E" data-runtime-field="lossLimit"><b>USD</b></div><small>\u8FBE\u5230\u540E\u6682\u505C\u65B0\u589E\u8BA2\u5355\uFF0C\u4FDD\u7559\u5DF2\u6709\u8BA2\u5355\u3002</small></label>
              <label class="strategy-field"><span>\u8FD0\u884C\u65F6\u957F</span><div><input type="number" value="0" data-runtime-field="duration"><b>\u5206\u949F</b></div><small>0 \u8868\u793A\u6301\u7EED\u8FD0\u884C\uFF0C\u76F4\u5230\u624B\u52A8\u505C\u6B62\u3002</small></label>
            </div></div><div class="runtime-note"><span class="info-dot">i</span><span>\u6682\u505C\u65B0\u589E\u4F1A\u4FDD\u7559\u73B0\u6709\u8BA2\u5355\uFF1B\u505C\u6B62\u4F1A\u64A4\u9500\u4F59\u91CF\uFF0C\u5DF2\u6210\u4EA4\u6301\u4ED3\u4FDD\u7559\u3002\u8FD0\u884C\u65F6\u957F\u5728\u4E0B\u6B21\u542F\u52A8\u65F6\u751F\u6548\u3002</span></div>
          </div>

          <div class="strategy-savebar"><span class="save-state" data-save-state>\u5F53\u524D\u6CA1\u6709\u672A\u4FDD\u5B58\u4FEE\u6539</span><div><button type="button" class="secondary-button" data-reset>\u64A4\u9500\u4FEE\u6539</button><button type="button" class="save-button" data-save>\u4FDD\u5B58\u7B56\u7565</button></div></div>
        </div>

        <aside class="strategy-aside">
          <section class="preview-card"><div class="panel-heading"><div><p class="eyebrow">LIVE PREVIEW</p><h2>\u53C2\u6570\u9884\u89C8</h2></div><span class="preview-dot"><i></i>\u5F85\u4FDD\u5B58</span></div><div class="preview-price"><span>\u89E6\u53D1\u4EF7</span><strong data-preview-trigger>0.67 <em>USD</em></strong><span class="preview-arrow">\u2192</span><div><span>\u6700\u9AD8\u4E70\u5165</span><strong data-preview-max>0.70 <em>USD</em></strong></div></div><div class="preview-steps"><div class="preview-step-heading"><span>\u5206\u9636\u6BB5\u4E70\u5165\u8BA1\u5212</span><b data-preview-total>207 \u4EFD</b></div><ol><li><i>1</i><span>\u8FDB\u5165\u89E6\u53D1\u533A</span><strong data-preview-stage="1">5 \u4EFD</strong></li><li><i>2</i><span>\u7B2C\u4E00\u6B21\u786E\u8BA4</span><strong data-preview-stage="2">18 \u4EFD</strong></li><li><i>3</i><span>\u7B2C\u4E8C\u6B21\u786E\u8BA4</span><strong data-preview-stage="3">54 \u4EFD</strong></li><li><i>4</i><span>\u7B2C\u4E09\u6B21\u786E\u8BA4</span><strong data-preview-stage="4">130 \u4EFD</strong></li></ol></div></section>
          <section class="activation-card"><div class="activation-heading"><span class="activation-icon">\u25F7</span><div><h3>\u751F\u6548\u89C4\u5219</h3><p>\u4E0D\u4F1A\u7ACB\u5373\u6539\u53D8\u5F53\u524D\u8FD0\u884C</p></div></div><div class="activation-line"><i class="done"></i><div><strong>\u4FDD\u5B58\u914D\u7F6E</strong><small>\u4FDD\u5B58\u540E\u751F\u6210\u65B0\u7248\u672C</small></div></div><div class="activation-line"><i></i><div><strong>\u4E0B\u4E00\u573A\u6B21\u542F\u7528</strong><small>\u5F53\u524D\u573A\u6B21\u7EE7\u7EED\u4F7F\u7528\u65E7\u7248\u672C</small></div></div><div class="activation-line"><i></i><div><strong>\u81EA\u52A8\u4EA4\u6613\u8BFB\u53D6</strong><small>\u542F\u52A8\u65F6\u52A0\u8F7D\u5DF2\u4FDD\u5B58\u53C2\u6570</small></div></div></section>
          <section class="guardrail-card"><div class="guardrail-heading"><span>\u7B56\u7565\u7EA6\u675F</span><b>4 \u9879</b></div><ul><li><i>\u2713</i>\u5355\u4E00 平台支持加密货币 \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565</li><li><i>\u2713</i>\u4EF7\u683C\u4F7F\u7528\u9650\u4EF7\uFF0C\u4E0D\u8FFD\u9AD8</li><li><i>\u2713</i>\u540C\u65B9\u5411\u4E0D\u91CD\u590D\u52A0\u4ED3</li><li><i>\u2713</i>\u4FDD\u5B58\u4E0D\u4F1A\u81EA\u52A8\u542F\u52A8\u4EA4\u6613</li></ul></section>
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
      if (target) window.location.href = target;
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
  var field = (key) => document.querySelector(`[data-field="${key}"]`);
  var updatePreview = () => {
    const trigger = Number(field("trigger")?.value) || 0;
    const max = Number(field("maxPrice")?.value) || 0;
    text("[data-preview-trigger]", `${(trigger / 100).toFixed(2)} USD`);
    text("[data-preview-max]", `${(max / 100).toFixed(2)} USD`);
    let total = 0;
    const stages = Array.from(document.querySelectorAll("[data-stage]"), (input) => ({
      number: input.dataset.stage,
      value: Number(input.value) || 0
    }));
    stages.forEach((stage) => { total += stage.value; });
    const previewList = document.querySelector(".preview-steps ol");
    if (previewList) previewList.innerHTML = stages.map((stage) => `<li><i>${stage.number}</i><span>${stage.number === "1" ? "进入触发区" : `第 ${Number(stage.number) - 1} 次确认`}</span><strong>${stage.value} 份</strong></li>`).join("");
    text("[data-preview-total]", `${total} \u4EFD`);
    text("[data-save-state]", "\u6709\u672A\u4FDD\u5B58\u4FEE\u6539");
  };
  var syncStageCount = () => {
    const countInput = document.querySelector("[data-stage-count]");
    const container = document.querySelector("[data-stage-inputs]");
    if (!countInput || !container) return;
    const count = Math.max(1, Math.min(8, Number(countInput.value) || 1));
    countInput.value = String(count);
    const previous = Array.from(container.querySelectorAll("[data-stage]"), (input) => Number(input.value) || 0);
    container.innerHTML = Array.from({ length: count }, (_, index) => {
      const stage = index + 1;
      const value = previous[index] || 0;
      const description = stage === 1 ? "首次进入触发区" : `第 ${stage - 1} 次反转确认`;
      const className = ["one", "two", "three", "four"][index] || "extra";
      return `<label class="stage-input stage-${className}"><span><i>${stage}</i>第${stage}阶段</span><div><input type="number" min="1" value="${value}" data-stage="${stage}"><b>份</b></div><small>${description}</small></label>`;
    }).join("");
    container.querySelectorAll("[data-stage]").forEach((input) => input.addEventListener("input", updatePreview));
    updatePreview();
  };
  document.querySelector("[data-stage-count]")?.addEventListener("input", syncStageCount);
  document.querySelectorAll("[data-field], [data-stage], [data-runtime-field]").forEach((input) => input.addEventListener("input", updatePreview));
  var applyPreset = (button) => {
    const stages = (button.dataset.presetStages || "").split(",").map(Number).filter(Number.isFinite);
    field("trigger").value = button.dataset.presetTrigger || "67";
    field("confirm").value = button.dataset.presetConfirm || "70";
    field("maxPrice").value = button.dataset.presetMax || "70";
    stages.forEach((value, index) => {
      const input = document.querySelector(`[data-stage="${index + 1}"]`);
      if (input) input.value = String(value);
    });
    updatePreview();
    text("[data-save-state]", `\u5DF2\u586B\u5165\u201C${button.textContent?.trim() || "\u53C2\u8003\u53C2\u6570"}\u201D\uFF0C\u5C1A\u672A\u4FDD\u5B58`);
  };
  var bindPresetItem = (item) => {
    item.querySelector("[data-preset]")?.addEventListener("click", (event) => applyPreset(event.currentTarget));
    item.querySelector("[data-remove-preset]")?.addEventListener("click", () => {
      item.remove();
      text("[data-save-state]", "\u53C2\u8003\u53C2\u6570\u5DF2\u5220\u9664\uFF0C\u5C1A\u672A\u4FDD\u5B58");
    });
  };
  document.querySelectorAll("[data-preset-item]").forEach(bindPresetItem);
  var editor = document.querySelector("[data-preset-editor]");
  document.querySelector("[data-add-preset]")?.addEventListener("click", () => editor?.toggleAttribute("hidden", false));
  document.querySelector("[data-cancel-preset]")?.addEventListener("click", () => editor?.toggleAttribute("hidden", true));
  document.querySelector("[data-create-preset]")?.addEventListener("click", () => {
    const name = document.querySelector("[data-preset-new-name]")?.value.trim() || "\u65B0\u53C2\u8003";
    const trigger = Number(document.querySelector("[data-preset-new-trigger]")?.value);
    const confirm = Number(document.querySelector("[data-preset-new-confirm]")?.value);
    const max = Number(document.querySelector("[data-preset-new-max]")?.value);
    if (![trigger, confirm, max].every((value) => Number.isFinite(value) && value > 0)) {
      text("[data-save-state]", "\u8BF7\u5148\u586B\u5199\u6709\u6548\u7684\u53C2\u8003\u4EF7\u683C");
      return;
    }
    const stages = Array.from(document.querySelectorAll("[data-stage]")).map((input) => Number(input.value) || 0);
    const item = document.createElement("div");
    item.className = "preset-item";
    item.dataset.presetItem = "";
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "preset-choice";
    choice.dataset.preset = "";
    choice.dataset.presetTrigger = String(trigger);
    choice.dataset.presetConfirm = String(confirm);
    choice.dataset.presetMax = String(max);
    choice.dataset.presetStages = stages.join(",");
    choice.textContent = name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "preset-remove";
    remove.dataset.removePreset = "";
    remove.setAttribute("aria-label", `\u5220\u9664 ${name}`);
    remove.textContent = "\xD7";
    item.append(choice, remove);
    const list = document.querySelector("[data-preset-list]");
    const add = document.querySelector("[data-add-preset]");
    if (list && add) list.insertBefore(item, add);
    bindPresetItem(item);
    editor?.toggleAttribute("hidden", true);
    text("[data-save-state]", `\u5DF2\u6DFB\u52A0\u201C${name}\u201D\uFF0C\u5C1A\u672A\u4FDD\u5B58`);
  });
  document.querySelector("[data-reset]")?.addEventListener("click", () => {
    field("trigger").value = "67";
    field("confirm").value = "70";
    field("maxPrice").value = "70";
    ["5", "18", "54", "130"].forEach((value, index) => {
      const input = document.querySelector(`[data-stage="${index + 1}"]`);
      if (input) input.value = value;
    });
    updatePreview();
    text("[data-save-state]", "\u5DF2\u6062\u590D\u8BBE\u8BA1\u7A3F\u9ED8\u8BA4\u53C2\u6570");
  });
  document.querySelector("[data-save]")?.addEventListener("click", async (event) => {
    const trigger = Number(field("trigger")?.value);
    const confirm = Number(field("confirm")?.value);
    const max = Number(field("maxPrice")?.value);
    const stages = Array.from(document.querySelectorAll("[data-stage]"), (input) => Number(input.value));
    if (![trigger, confirm, max].every((value) => Number.isFinite(value) && value > 0 && value <= 100)
      || !(trigger <= confirm && confirm <= max)
      || !stages.length || stages.some((value) => !Number.isFinite(value) || value <= 0)) {
      text("[data-save-state]", "请检查价格顺序、价格范围和阶段份额");
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    const runtimeValue = (key) => {
      const input = document.querySelector(`[data-runtime-field="${key}"]`);
      return input?.value === "" ? null : Number(input?.value);
    };
    try {
      const result = await window.PolyPreviewAdapter.saveStrategy({
        strategyId: window.PolyPreview.config.strategyId,
        triggerPrice: trigger / 100,
        confirmationPrice: confirm / 100,
        maxBuyPrice: max / 100,
        stageShares: stages,
        roundBudgetUsd: runtimeValue("roundBudget"),
        totalBudgetUsd: runtimeValue("totalBudget"),
        dailyLossUsd: runtimeValue("lossLimit"),
        durationMinutes: runtimeValue("duration") || 0,
        mode: "live"
      });
      text("[data-save-state]", result.message || (result.accepted ? "策略草稿已保存，等待下一场生效" : "设计稿演示：校验通过，保存接口尚未连接"));
    } catch (error) { text("[data-save-state]", error.message || "策略保存失败"); }
    finally { button.disabled = false; }
  });
  store.subscribe("strategy", (resource) => {
    const revision = resource?.revision;
    text("[data-strategy-revision]", revision == null ? "--" : `REV-${revision}`);
  });
  void adapter.loadStrategy();
})();

