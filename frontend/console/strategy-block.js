"use strict";
(() => {
  // src/strategy-block.ts
  var root = document.querySelector("#strategy-block-root");
  if (!root) throw new Error("strategy block root missing");
  var store = window.PolyPreviewStore;
  var adapter = window.PolyPreviewAdapter;
  var vm = window.PolyPreviewViewModel;
  // Sidebar markup and bindings come from PolyPreview (single definition).
  var navMarkup = window.PolyPreview.navMarkup("strategy");
  // binance-lead's own fields (backend/engine/src/strategies/binance-lead.ts,
  // ranges as normalizeBinanceLeadConfig). limitPremium is edited in cents.
  var LEAD_FIELDS = [
    { key: "shares", label: "每场份额", unit: "股", step: "any", note: "信号出现时 FAK 吃单买入的股数，一场最多一笔。", check: (v) => v > 0 && v <= 10000, error: "每场份额须大于 0 且不超过 10000。" },
    { key: "thresholdBp", label: "触发阈值", unit: "bp", step: "any", note: "币安成交价比窗口内最低价高（涨）或比最高价低（跌）至少这么多 bp。", check: (v) => v > 0 && v <= 1000, error: "触发阈值须在 0 到 1000 bp 之间（不含 0）。" },
    { key: "windowMs", label: "观察窗口", unit: "ms", step: "any", note: "和此前这么多毫秒内的币安成交比较（按成交时间）。", check: (v) => v > 0 && v <= 60000, error: "观察窗口须在 0 到 60000 ms 之间（不含 0）。" },
    { key: "limitPremium", label: "限价加价", unit: "¢", step: "any", cents: true, note: "限价 = 信号时这一边的卖价 + 加价，向下取到 tick，最高 0.99。", check: (v) => v >= 0 && v < 100, error: "限价加价须在 0 到 100 美分之间（不含 100）。" },
    { key: "fromSec", label: "开盘后起始秒", unit: "秒", step: "1", note: "开盘后这么多秒起才认信号。", check: (v) => v >= 0 && v < 300, error: "起始秒须在 0 到 299 之间。" },
    { key: "toSec", label: "开盘后截止秒", unit: "秒", step: "1", note: "到这一秒（不含）为止；必须大于起始秒、不超过 300。", check: (v) => v > 0 && v <= 300, error: "截止秒须大于 0 且不超过 300。" }
  ];
  root.innerHTML = `
  <div class="overview-preview strategy-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>交易控制台</small></div></div>
      <div class="brand-card"><span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span><strong>Polymarket</strong></div>
      <p class="sidebar-copy" data-asset-copy>面向 BTC 五分钟币安领先策略的交易控制台。</p>
      <nav aria-label="策略导航">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>服务器数据</span><small>等待后端连接</small></div>
    </aside>

    <main class="preview-main strategy-main">
      <header class="preview-header strategy-header">
        <div class="hero-copy"><p class="eyebrow">策略配置</p><div class="hero-title-row"><h1>策略</h1><span class="language-chip" data-asset-chip>BTC · 5 分钟</span></div><p class="subtitle" data-asset-subtitle>调整币安领先策略的信号、限价和运行边界。</p></div>
        <div class="strategy-header-side"><span class="strategy-state-chip"><i></i>后端未连接</span><div class="header-status-grid"><article class="header-status"><span>策略标识</span><strong>binance-lead</strong></article><article class="header-status"><span>当前版本</span><strong data-strategy-revision>--</strong></article><article class="header-status"><span>运行模式</span><strong>实盘策略</strong></article><article class="header-status"><span>生效时机</span><strong>未来未创建场次</strong></article></div></div>
      </header>

      <section class="strategy-identity-panel">
        <div class="strategy-identity-icon">↯</div><div class="strategy-identity-copy"><p class="eyebrow">当前策略</p><h2 data-asset-title>BTC 币安领先</h2><p>币安成交价在短窗口内急涨或急跌时，买 Polymarket 同方向那一边，持有到结算；一场最多一笔。</p></div><div class="identity-tags"><span class="identity-tag active-tag"><i></i>唯一运行策略</span><span class="identity-tag">已发布版本待读取</span></div>
      </section>

      <section class="strategy-layout">
        <div class="strategy-form-panel">
          <div class="panel-heading"><div><p class="eyebrow">配置内容</p><h2>策略参数</h2></div><span class="panel-meta">保存草稿后需另行激活</span></div>
          <div class="strategy-tabs" role="tablist"><button type="button" class="strategy-tab active" data-strategy-tab="parameters" role="tab" aria-selected="true">策略参数</button><button type="button" class="strategy-tab" data-strategy-tab="runtime" role="tab" aria-selected="false">运行设置</button></div>

          <div class="strategy-pane" data-strategy-pane="parameters">
            <div class="config-section"><div class="config-section-heading"><div><span class="section-number">01</span><div><h3>信号与下单</h3><p>什么算信号、本场什么时段认信号、FAK 限价怎么定。</p></div></div><span class="section-state">每场一次 · 持有到结算</span></div><div class="field-grid three-fields">
              ${LEAD_FIELDS.map((item) => `<label class="strategy-field"><span>${item.label}</span><div><input type="number" step="${item.step}" placeholder="--" data-lead="${item.key}"><b>${item.unit}</b></div><small>${item.note}</small></label>`).join("")}
            </div></div>
            <div class="budget-hint" data-budget-hint><span class="info-dot">i</span><span>按 0.99 最高限价计算，每场最多花 <strong>--</strong>。交易费用另计。</span></div>
          </div>

          <div class="strategy-pane" data-strategy-pane="runtime" hidden>
            <div class="config-section"><div class="config-section-heading"><div><span class="section-number">02</span><div><h3>资金与运行场次</h3><p>限制单场投入、策略总占用和自动停止条件。</p></div></div><span class="section-state">可选边界</span></div><div class="field-grid runtime-fields">
              <label class="strategy-field"><span>单场资金上限</span><div><input type="number" placeholder="未设置" data-runtime-field="roundBudget"><b>USDC</b></div><small>包括本场持仓、未完成买单和费用预留。</small></label>
              <label class="strategy-field"><span>策略总资金上限</span><div><input type="number" placeholder="未设置" data-runtime-field="totalBudget"><b>USDC</b></div><small>限制本策略同时占用的资金。</small></label>
              <label class="strategy-field"><span>每日亏损停止线</span><div><input type="number" placeholder="未设置" data-runtime-field="lossLimit"><b>USDC</b></div><small>达到后暂停新增订单，已有持仓照常结算。</small><small class="loss-basis" data-loss-basis>判断基础读取中…</small></label>
              <label class="strategy-field"><span>运行场次</span><div><input type="number" value="0" min="0" step="1" data-runtime-field="rounds"><b>场</b></div><small>每场 5 分钟；跑满后在场次边界停止，不会停在半场。0 表示持续运行。</small></label>
            </div></div><div class="runtime-note"><span class="info-dot">i</span><span>暂停新增只是不再下新单；停止会撤销余量（FAK 不会留单），已成交持仓保留到结算。运行场次在下次启动时生效。</span></div>
          </div>

          <div class="strategy-savebar"><span class="save-state" data-save-state>当前没有未保存修改</span><div><button type="button" class="secondary-button" data-switch-asset hidden>切换策略币种</button><button type="button" class="secondary-button" data-reset>撤销修改</button><button type="button" class="secondary-button" data-reload>重新读取</button><button type="button" class="save-button" data-save>保存策略草稿</button><button type="button" class="save-button" data-activate disabled>激活已保存草稿</button></div></div>
          <p class="save-state" data-draft-state role="status">尚无可激活草稿</p>
        </div>

        <aside class="strategy-aside">
          <section class="activation-card"><div class="activation-heading"><span class="activation-icon">◷</span><div><h3>生效规则</h3><p>不会立即改变当前运行</p></div></div><div class="activation-line"><i class="done"></i><div><strong>保存策略草稿</strong><small>仅保存，不发布、不启动</small></div></div><div class="activation-line"><i></i><div><strong>另行激活草稿</strong><small>开盘前 10 秒起本场配置冻结</small></div></div><div class="activation-line"><i></i><div><strong>自动交易读取</strong><small>激活后影响之后尚未冻结的场次</small></div></div></section>
          <section class="guardrail-card"><div class="guardrail-heading"><span>策略约束</span><b>4 项</b></div><ul><li><i>✓</i><span data-asset-constraint>只做 BTC 五分钟盘</span></li><li><i>✓</i>一场最多一笔 FAK，成不成交都不再下</li><li><i>✓</i>只做开盘前发现的场；中途启动等下一场</li><li><i>✓</i>保存不会自动启动交易</li></ul></section>
        </aside>
      </section>
    </main>
  </div>
`;
  var text = (selector, value) => {
    const node = document.querySelector(selector);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
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
  const leadInput = (key) => root.querySelector(`[data-lead="${key}"]`);
  const runtimeInput = (key) => root.querySelector(`[data-runtime-field="${key}"]`);
  const core = window.PolyPreview;
  let resource = store.getState().strategy;
  let dirty = false;
  let busy = false;
  let baselineRevision = null;
  let formConfig = null;
  let formKey = null;
  const published = () => resource?.data?.config || null;
  // The published coin is the default. A coin from the URL (the market page's
  // "go switch the strategy coin") is only used after the operator presses
  // 切换策略币种: the URL alone used to retarget any save, so a budget edit
  // after browsing another coin silently switched the traded coin (BUGS F1).
  let assetSwitchConfirmed = false;
  const urlAsset = () => String(core.config.selectedAssetId || new URLSearchParams(window.location.search).get("assetId") || "").toLowerCase();
  const publishedAssetId = () => String(vm.strategyAssetId(resource?.data || {}) || "").toLowerCase();
  const switchOffered = () => Boolean(urlAsset() && publishedAssetId() && urlAsset() !== publishedAssetId());
  const selectedAsset = () => (assetSwitchConfirmed && urlAsset()) || publishedAssetId() || urlAsset() || "btc";
  const assetLabel = () => vm.assetSymbol(selectedAsset(), "BTC");
  // The server answers binance-lead's config even before the first publish
  // (defaults at revision 0), so the form is editable whenever it has one:
  // that is how the first binance-lead revision gets published.
  const hasConfig = () => typeof published()?.shares === "number";
  const firstPublish = () => hasConfig() && resource.revision === 0;
  const switchingAsset = () => hasConfig() && publishedAssetId() !== selectedAsset();
  const draft = () => resource?.draft || null;
  const validDraft = () => {
    const value = draft();
    return value && typeof value.draftId === "string" && value.config
      && vm.strategyTargets(value.config, selectedAsset())
      && Number.isInteger(value.expectedRevision) && value.expectedRevision === resource.revision;
  };
  const setMessage = (message) => text("[data-save-state]", message);
  const controls = () => {
    const available = hasConfig();
    root.querySelectorAll("[data-lead], [data-runtime-field]").forEach((input) => { input.disabled = busy || !available; });
    root.querySelector("[data-save]").disabled = busy || !available;
    root.querySelector("[data-reset]").disabled = busy || !available;
    root.querySelector("[data-reload]").disabled = busy;
    const switchButton = root.querySelector("[data-switch-asset]");
    switchButton.hidden = !switchOffered() || assetSwitchConfirmed;
    switchButton.disabled = busy || !available;
    switchButton.textContent = `切换为 ${vm.assetSymbol(urlAsset(), "--")}`;
    root.querySelector("[data-activate]").disabled = busy || dirty || !validDraft() || resource.status !== "ready";
  };
  const updateBudget = () => {
    const shares = Number(leadInput("shares").value);
    text("[data-budget-hint] strong", leadInput("shares").value.trim() !== "" && Number.isFinite(shares) && shares > 0 ? `$${(shares * 0.99).toFixed(2)}` : "--");
  };
  const markDirty = () => {
    dirty = true;
    updateBudget();
    setMessage("有未保存修改；先保存草稿，再激活。");
    controls();
  };
  const show = (value) => value == null ? "" : String(value);
  const hydrate = (config, key) => {
    formConfig = { ...config };
    formKey = key;
    baselineRevision = resource.revision;
    for (const item of LEAD_FIELDS) {
      const value = config[item.key];
      leadInput(item.key).value = value == null ? "" : item.cents ? String(Number((value * 100).toPrecision(12))) : String(value);
    }
    for (const [key, name] of Object.entries({ roundBudget: "roundBudgetUsd", totalBudget: "totalBudgetUsd", lossLimit: "dailyLossUsd", rounds: "maxRounds" })) {
      runtimeInput(key).value = show(config[name]);
    }
    dirty = false;
    updateBudget();
    controls();
  };
  let connectionLost = false;
  const receive = (next) => {
    resource = next;
    text("[data-strategy-revision]", resource.revision == null ? "--" : resource.revision === 0 ? "未发布" : `版本 ${resource.revision}`);
    text(".identity-tags .identity-tag:last-child", resource.revision == null ? "已发布版本待读取" : resource.revision === 0 ? "尚未发布" : `已发布版本 ${resource.revision}`);
    text(".strategy-state-chip", resource.status === "ready" ? firstPublish() ? "尚未发布 · 显示默认参数" : hasConfig() ? (switchingAsset() ? `已发布 ${vm.assetSymbol(publishedAssetId(), "--")} · 将切换为 ${assetLabel()}` : `${assetLabel()} 服务器配置已读取`) : "配置待接入" : resource.status === "stale" ? "连接中断 · 保留配置和编辑" : "配置待接入");
    // Static template copy said "BTC" regardless of the selected asset.
    text("[data-asset-chip]", `${assetLabel()} · 5 分钟`);
    text("[data-asset-title]", `${assetLabel()} 币安领先`);
    text("[data-asset-copy]", `面向 ${assetLabel()} 五分钟币安领先策略的交易控制台。`);
    text("[data-asset-subtitle]", `调整 ${assetLabel()} 币安领先策略的信号、限价和运行边界。`);
    text("[data-asset-constraint]", `只做 ${assetLabel()} 五分钟盘`);
    const savedDraft = draft();
    text("[data-draft-state]", validDraft()
      ? `草稿 ${savedDraft.draftId} · ${String(savedDraft.config.assetId || "--").toUpperCase()} · 基于版本 ${savedDraft.expectedRevision} · 未激活`
      : savedDraft && !vm.strategyTargets(savedDraft.config, selectedAsset()) ? `服务器草稿目标不是 ${assetLabel()}，已禁止激活；请先在服务器更正草稿。`
      : savedDraft ? "原草稿基线已过期或已发布，请重新保存后激活。" : "尚无可激活草稿；保存不会自动发布或启动。");
    if (!dirty && !busy && resource.status === "ready" && hasConfig()) {
      const config = validDraft() ? savedDraft.config : published();
      const key = validDraft() ? `draft:${savedDraft.draftId}` : `revision:${resource.revision}`;
      if (config && key !== formKey) {
        hydrate(config, key);
        setMessage(validDraft() ? "已读取服务器草稿，尚未激活。" : firstPublish() ? "" : "已读取服务器已发布配置。");
      }
    }
    if (!busy && resource.status === "stale") { setMessage("策略接口断开，保留上次配置和未保存输入。"); connectionLost = true; }
    // Recovered with the same revision: hydrate() is skipped, so clear the
    // disconnect notice here or it stays forever (BUGS P3-16).
    else if (!busy && connectionLost && resource.status === "ready") {
      connectionLost = false;
      setMessage(dirty ? "策略接口已恢复，未保存的输入仍保留。" : "策略接口已恢复，已读取服务器配置。");
    }
    if (!busy && resource.status === "unavailable") setMessage("策略配置不可用，等待接口恢复。");
    if (!busy && !dirty && resource.status === "ready" && firstPublish() && !validDraft()) setMessage("服务器还没有发布过币安领先参数（旧策略的配置不再使用）。核对下面的默认值，保存草稿并激活后才能启动交易。");
    else if (!busy && !dirty && !assetSwitchConfirmed && switchOffered()) setMessage(`当前策略币种是 ${vm.assetSymbol(publishedAssetId(), "--")}；保存只改参数。要改为 ${vm.assetSymbol(urlAsset(), "--")}，先点「切换为 ${vm.assetSymbol(urlAsset(), "--")}」。`);
    else if (!busy && !dirty && switchingAsset()) setMessage(`当前已发布策略的币种是 ${vm.assetSymbol(publishedAssetId(), "--")}。保存并激活后，策略币种将改为 ${assetLabel()}；交易运行中不能切换。`);
    else if (!busy && savedDraft && !vm.strategyTargets(savedDraft.config, selectedAsset())) setMessage(`服务器草稿目标不是 ${assetLabel()}，激活已停用；请先在服务器更正草稿。`);
    controls();
  };
  root.querySelectorAll("[data-lead], [data-runtime-field]").forEach((input) => {
    input.addEventListener("input", markDirty);
  });
  root.querySelector("[data-switch-asset]").addEventListener("click", () => {
    if (busy || !switchOffered()) return;
    assetSwitchConfirmed = true;
    dirty = true;
    receive(resource);
    controls();
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
    const values = {};
    for (const item of LEAD_FIELDS) {
      const raw = leadInput(item.key).value.trim();
      const value = raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(value) || !item.check(value)) throw new Error(item.error);
      values[item.key] = item.cents ? Number((value / 100).toPrecision(12)) : value;
    }
    if (!(values.fromSec < values.toSec)) throw new Error("开盘后截止秒必须大于起始秒。");
    const optional = (key) => {
      const value = runtimeInput(key).value.trim();
      return value === "" ? null : Number(value);
    };
    const budgets = [optional("roundBudget"), optional("totalBudget"), optional("lossLimit")];
    if (budgets.some((value) => value !== null && (!Number.isFinite(value) || value <= 0))) throw new Error("资金上限和亏损线必须为空或正数。");
    const rounds = optional("rounds") ?? 0;
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > 10000) throw new Error("运行场次须为 0 到 10000 之间的整数；持续运行请填 0。");
    return { strategyId: core.config.strategyId, assetId: selectedAsset(), expectedRevision: baselineRevision, ...values,
      roundBudgetUsd: budgets[0], totalBudgetUsd: budgets[1], dailyLossUsd: budgets[2],
      // Rounds are the operator's unit; keep durationMinutes at 0 so the wall
      // clock cannot cut a round short behind the round limit's back.
      maxRounds: rounds, durationMinutes: 0, mode: "live",
      maxQuoteAgeSeconds: formConfig?.maxQuoteAgeSeconds ?? 2, maxQuoteSkewSeconds: formConfig?.maxQuoteSkewSeconds ?? 1.5 };
  };
  root.querySelector("[data-save]").addEventListener("click", async () => {
    if (busy) return;
    let payload;
    try { payload = readForm(); } catch (error) { setMessage(error.message); return; }
    busy = true; controls(); setMessage("正在保存草稿，尚未发布…");
    try {
      const result = await adapter.saveStrategy(payload);
      if (!vm.strategyTargets(result?.config, selectedAsset())) throw new Error(`服务器保存回执没有确认 ${assetLabel()} 目标；输入已保留，不能激活。`);
      if (result?.accepted === false || typeof result?.draftId !== "string" || !Number.isInteger(result.expectedRevision) || !result.config) throw new Error(result?.message || "接口没有确认草稿已保存；输入已保留。");
      resource = store.getState().strategy;
      dirty = false;
      formConfig = { ...result.config };
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
      setMessage(resource.status === "ready" ? "策略已发布；只影响之后尚未冻结的场次，当前场保持原配置。" : "服务器已确认发布，但配置重读失败；保留草稿和最后配置，恢复连接后核对版本。");
    } catch (error) { setMessage(core.format.readableError(error.message, "激活失败，草稿已保留。")); }
    finally { busy = false; controls(); }
  });
  updateBudget();
  store.subscribe("strategy", receive);
  // This page reads no catalog data and always submits an explicit config.assetId.
  void adapter.loadStrategy();
  // The daily loss limit trips on verified PnL when external cash flows are fully
  // reconciled and on an estimate otherwise; the operator has to be able to see
  // which, or they will read the stop line as a precise guarantee.
  void (async () => {
    const note = root.querySelector("[data-loss-basis]");
    if (!note) return;
    try {
      const raw = await core.api.runtimeStatus();
      const data = raw?.data && typeof raw.data === "object" ? raw.data : raw;
      const risk = data?.risk || {};
      const status = risk.dailyLossStatus ?? risk.daily_loss_status;
      const pnl = typeof risk.dailyPnlUsd === "number" ? risk.dailyPnlUsd : null;
      const today = pnl == null ? "" : ` · 当前当日盈亏 ${pnl > 0 ? "+" : ""}${pnl.toFixed(4)} USDC`;
      if (status === "disabled") {
        note.textContent = "未设置停止线，不会自动停止开仓。";
      } else if (status === "active") {
        note.textContent = `判断基础：已核对资金流水，止损按可证明盈亏触发${today}`;
      } else if (status === "estimated") {
        note.textContent = `判断基础：资金流水未对齐，止损按估算盈亏触发，可能早停或晚停${today}`;
      } else {
        note.textContent = "判断基础未提供，请以服务器运行状态为准。";
      }
      note.dataset.basis = status || "unknown";
    } catch {
      note.textContent = "判断基础读取失败，请以服务器运行状态为准。";
    }
  })();
})();
