"use strict";
// 设置: strategy parameters (draft -> activate), the account (read only) and
// the system (health, run log, clearing the statistics).
(() => {
  const P = window.PolyPreview;
  const { html, fmt, num, VENUES, LINES } = P;
  const ALL_VENUES = ["bybit", "binance", "okx"];
  // [key, label, note, step, kind]; kind: number | optional (empty = 不限) | int
  const FIELDS = [
    ["shares", "每笔股数", "每场那一笔 FAK 买多少股", "1", "number"],
    ["thresholdBp", "信号阈值（bp）", "成交价在窗口内涨跌多少 bp 算信号", "0.1", "number"],
    ["windowMs", "信号窗口（毫秒）", "在多长时间内涨跌到阈值", "10", "number"],
    ["limitPremium", "限价加价", "限价 = 信号时卖价 + 这个数，例如 0.03", "0.01", "number"],
    ["maxAsk", "卖价上限", "信号那边卖价高于这个就不买，例如 0.80", "0.01", "number"],
    ["fromSec", "开盘后起始秒", "开盘后第几秒开始接信号", "1", "number"],
    ["toSec", "开盘后截止秒", "开盘后第几秒以后不再下单（≤ 300）", "1", "number"],
    ["openBandBp", "开盘线范围 ±bp", "价格离开盘线超过这么多 bp 就不买；0 = 不限", "0.5", "number"],
    ["roundBudgetUsd", "单场预算 $", "一场最多花多少；空 = 不限", "1", "optional"],
    ["totalBudgetUsd", "总预算 $", "本次运行最多占用多少；空 = 不限", "1", "optional"],
    ["dailyLossUsd", "每日亏损上限 $", "北京时间当天亏到这个数就停止下新单；空 = 不限", "1", "optional"],
    ["maxRounds", "每次运行场数", "跑满这么多场自动停止；0 = 一直跑", "1", "int"],
    ["restAfterMissSec", "没买到后挂单（秒）", "吃单没买到时，在同一限价挂只挂单的买单，这么多秒后撤；挂单不收手续费；0 = 关", "1", "number"],
  ];
  const ADVANCED = [
    ["maxQuoteAgeSeconds", "盘口最大年龄（秒）", "盘口比这个旧就不下单", "0.1", "number"],
    ["maxQuoteSkewSeconds", "两边盘口时间差（秒）", "UP/DOWN 两边盘口时间相差超过这个就不下单", "0.1", "number"],
  ];
  // The config is exactly these keys (scripts/dashboard/strategy_config.py default_config).
  const CONFIG_KEYS = ["assetId", "shares", "thresholdBp", "windowMs", "limitPremium", "fromSec", "toSec", "maxAsk", "leadVenues",
    "tokyoRelay", "openBandBp", "openLine", "restAfterMissSec", "restShadow", "maxQuoteAgeSeconds", "maxQuoteSkewSeconds", "roundBudgetUsd", "totalBudgetUsd",
    "dailyLossUsd", "durationMinutes", "maxRounds", "mode"];

  // inputs: {<field>: string, openLine, tokyoRelay: bool, leadVenues: string[]} -> {config, errors}
  const buildConfig = (inputs, published = {}) => {
    const errors = {};
    const config = { assetId: "btc", durationMinutes: num(published.durationMinutes) ?? 0, mode: "live" };
    for (const [key, labelText, , , kind] of [...FIELDS, ...ADVANCED]) {
      const raw = String(inputs[key] ?? "").trim();
      if (kind === "optional" && raw === "") { config[key] = null; continue; }
      const value = raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(value)) { errors[key] = `${labelText}要填数字`; continue; }
      config[key] = value;
    }
    const check = (key, ok, message) => { if (!errors[key] && !ok(config[key])) errors[key] = message; };
    check("shares", (v) => v > 0 && v <= 10000, "股数在 0–10000 之间");
    check("thresholdBp", (v) => v > 0 && v <= 1000, "阈值在 0–1000 bp 之间");
    check("windowMs", (v) => v > 0 && v <= 60000, "窗口在 0–60000 毫秒之间");
    check("limitPremium", (v) => v >= 0 && v < 1, "加价在 0–1 之间");
    check("maxAsk", (v) => v > 0 && v < 1, "卖价上限在 0–1 之间");
    check("openBandBp", (v) => v >= 0 && v <= 1000, "范围在 0–1000 bp 之间");
    check("fromSec", (v) => v >= 0 && v < 300, "起始秒在 0–300 之间");
    check("toSec", (v) => v > 0 && v <= 300, "截止秒在 0–300 之间");
    if (!errors.fromSec && !errors.toSec && !(config.fromSec < config.toSec)) errors.toSec = "截止秒要大于起始秒";
    for (const key of ["maxQuoteAgeSeconds", "maxQuoteSkewSeconds"]) check(key, (v) => v > 0, "要大于 0");
    for (const key of ["roundBudgetUsd", "totalBudgetUsd", "dailyLossUsd"]) check(key, (v) => v === null || v > 0, "空或大于 0");
    check("maxRounds", (v) => Number.isInteger(v) && v >= 0 && v <= 10000, "0–10000 的整数");
    check("restAfterMissSec", (v) => v >= 0 && v <= 30, "0–30 秒");
    const venues = ALL_VENUES.filter((venue) => (inputs.leadVenues || []).includes(venue));
    if (!venues.length) errors.leadVenues = "至少选一家交易所";
    config.leadVenues = venues;
    config.tokyoRelay = inputs.tokyoRelay === true;
    config.openLine = inputs.openLine === "mean60" ? "mean60" : "tick";
    config.restShadow = inputs.restShadow !== false;
    const ordered = Object.fromEntries(CONFIG_KEYS.map((key) => [key, config[key]]));
    return { config: ordered, errors };
  };
  const draftPayload = (config, savedRevision) => ({ strategyId: "binance-lead", config, expectedRevision: savedRevision });
  // Save = draft, then publish that draft. Returns the published revision.
  const save = async (config, savedRevision) => {
    const draft = await P.api.strategyDraft(draftPayload(config, savedRevision));
    const published = await P.api.strategyActivate({ strategyId: "binance-lead", expectedRevision: draft.expectedRevision ?? savedRevision, draftId: draft.draftId });
    return published.savedRevision ?? published.revision;
  };
  const inputsFrom = (config) => {
    const inputs = {};
    for (const [key] of [...FIELDS, ...ADVANCED]) inputs[key] = config?.[key] === null || config?.[key] === undefined ? "" : String(config[key]);
    inputs.leadVenues = Array.isArray(config?.leadVenues) ? config.leadVenues : [...ALL_VENUES];
    inputs.tokyoRelay = config?.tokyoRelay !== false;
    inputs.openLine = config?.openLine === "mean60" ? "mean60" : "tick";
    inputs.restShadow = config?.restShadow !== false;
    return inputs;
  };

  const yesNo = (value, yes = "就绪", no = "未就绪") => value === true ? html`<span class="up">${yes}</span>` : value === false ? html`<span class="bad">${no}</span>` : html`<span class="muted">未知</span>`;
  const shortWallet = (wallet) => wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "未配置";
  const renderAccount = (status, snapshot) => {
    const check = status?.last_check || {};
    const positions = snapshot?.positions?.items || [];
    const orders = snapshot?.open_orders?.items || [];
    const STATE = { ready: "检查通过", stale: "检查过期或未通过", unknown: "还没有检查" };
    return html`<dl class="kv">
      <dt>钱包</dt><dd class="mono" title="${status?.wallet || ""}">${shortWallet(status?.wallet)}</dd>
      <dt>账户检查</dt><dd>${STATE[status?.account_check_state] || "--"} · ${status?.last_check_at ? fmt.dateTime(status.last_check_at) : "--"}${status?.last_check_error ? html` · <span class="bad">${P.label(status.last_check_error)}</span>` : ""}</dd>
      <dt>签名就绪</dt><dd>${yesNo(status?.execution_credentials_ready === true && check.signer_matches !== false ? true : status ? false : null)}</dd>
      <dt>交易授权</dt><dd>${yesNo(check.approvals_ready ?? null, "已授权", "未授权")}</dd>
      <dt>结算凭据</dt><dd>${yesNo(status?.settlement_credentials_ready ?? null)}</dd>
      <dt>服务器允许实盘</dt><dd>${yesNo(status?.server_live_enabled ?? null, "允许", "未开启")}</dd>
      <dt>余额</dt><dd>${fmt.usd(snapshot?.collateral?.value ?? null)}${snapshot?.stale ? html` <span class="warn">（数据过期）</span>` : ""} · 读取 ${fmt.time(snapshot?.asOf)}</dd>
    </dl>
    <h3 class="muted" style="margin:14px 0 6px">持仓（${positions.length}）</h3>
    ${positions.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>市场</th><th class="l">方向</th><th>股数</th><th>均价</th><th>现价</th><th>市值</th><th class="l">状态</th></tr></thead><tbody>${positions.map((p) => html`<tr><td class="wrap">${p.title || p.slug || "--"}</td><td class="l">${p.outcome || "--"}</td><td class="num">${fmt.shares(num(Number(p.size)))}</td><td class="num">${fmt.price(num(Number(p.avgPrice)))}</td><td class="num">${fmt.price(num(Number(p.curPrice)))}</td><td class="num">${fmt.usd(num(Number(p.currentValue)))}</td><td class="l">${p.redeemable ? html`<span class="tag warn">可赎回</span>` : "持有中"}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">没有持仓</p>`}
    <h3 class="muted" style="margin:14px 0 6px">挂单（${orders.length}）</h3>
    ${orders.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>方向</th><th class="l">结果</th><th>价格</th><th>数量</th><th>已成交</th><th>时间</th></tr></thead><tbody>${orders.map((o) => html`<tr><td>${o.side || "--"}</td><td class="l">${o.outcome || "--"}</td><td class="num">${fmt.price(num(Number(o.price)))}</td><td class="num">${fmt.shares(num(Number(o.original_size)))}</td><td class="num">${fmt.shares(num(Number(o.size_matched)))}</td><td class="num">${fmt.dateTime(num(Number(o.created_at)))}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">没有挂单</p>`}
    <p class="note">账户密钥只在服务器上配置，网页不输入、不显示。</p>`;
  };
  const gb = (bytes) => num(bytes) === null ? "--" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  const proc = (p) => p ? `${p.state || "--"}${p.pid ? ` · pid ${p.pid}` : ""}${num(p.rss_bytes) !== null ? ` · ${(p.rss_bytes / 1024 ** 2).toFixed(0)} MB` : ""}` : "--";
  const renderHealth = (h) => {
    if (!h) return html`<p class="empty">没有读到</p>`;
    const r = h.resources || {};
    const s = h.services || {};
    const feed = h.leadFeed || {};
    const relay = feed.relayListener;
    const lines = [];
    for (const venue of ALL_VENUES) {
      for (const line of ["direct", "tokyo"]) {
        const c = feed.lines?.[venue]?.[line];
        if (!c) continue;
        const age = num(c.lastTradeAgeSeconds);
        lines.push(html`<dt>${VENUES[venue]} · ${LINES[line]}</dt><dd><span class="dot ${age !== null && age < 10 ? "ok" : "bad"}"></span> ${age === null ? "没有成交" : `${fmt.seconds(age)}前`} · 先到 ${fmt.int(c.delivered)} 笔</dd>`);
      }
    }
    return html`<p class="${h.status === "ok" ? "up" : "warn"}">${h.status === "ok" ? "一切正常" : `有问题：${P.label(h.error)}`}${h.nodeLabel ? ` · 节点 ${h.nodeLabel}` : ""}</p>
    <dl class="kv">
      <dt>CPU</dt><dd>${num(r.cpu?.percent) === null ? "--" : `${r.cpu.percent.toFixed(0)}%`} · ${fmt.int(r.cpu?.cores)} 核</dd>
      <dt>内存</dt><dd>${gb(r.memory?.used_bytes)} / ${gb(r.memory?.total_bytes)}${num(r.memory?.percent) === null ? "" : ` · ${r.memory.percent.toFixed(0)}%`}</dd>
      <dt>硬盘</dt><dd>${gb(r.disk?.used_bytes)} / ${gb(r.disk?.total_bytes)}${num(r.disk?.percent) === null ? "" : ` · ${r.disk.percent.toFixed(0)}%`}</dd>
      <dt>引擎进程</dt><dd>${s.engine?.running ? html`<span class="up">运行中</span>` : "没在运行"} · ${proc(s.engine?.process)}${s.engine?.running && s.engine?.runtimeStale ? html` · <span class="warn">运行快照过期</span>` : ""}</dd>
      <dt>账户读取</dt><dd>${s.accountBridge?.stale ? html`<span class="warn">过期</span>` : html`<span class="up">正常</span>`}${s.accountBridge?.error ? ` · ${P.label(s.accountBridge.error)}` : ""} · ${proc(s.accountBridge?.process)}</dd>
      <dt>统计计算</dt><dd>${s.projection?.state === "ready" && !s.projection?.stale ? html`<span class="up">已追上</span>` : html`<span class="warn">${s.projection?.state || "--"}</span>`} · ${proc(s.projection?.process)}</dd>
      ${lines.length ? lines : html`<dt>信号源</dt><dd class="muted">引擎没在运行</dd>`}
      <dt>转发监听</dt><dd>${!feed.running ? html`<span class="muted">引擎没在运行</span>` : !feed.relayConfigured ? "本次运行没有开启" : !relay ? "没有数据" : relay.error ? html`<span class="bad">${relay.error}</span>` : relay.listening ? html`<span class="up">监听中</span> 端口 ${relay.port} · 接受 ${fmt.int(relay.accepted)} 条` : html`<span class="bad">没有监听</span>`}</dd>
    </dl>`;
  };
  const SEVERITY = (item) => item.severity === "warning" || item.kind === "unresolved" ? "warning" : item.kind === "error" ? "error" : "";
  const renderEvents = (items, kind) => {
    const list = (items || []).filter((item) => !kind || item.kind === kind);
    if (!list.length) return html`<li class="empty">没有事件</li>`;
    return html`${list.map((item) => html`<li><time>${fmt.dateTime(item.time)}</time><span class="${SEVERITY(item)}">${item.kind || "--"}</span><span class="${SEVERITY(item)}">${item.code ? `${item.code} · ` : ""}${item.message || ""}</span></li>`)}`;
  };
  window.PolySettings = Object.freeze({ buildConfig, draftPayload, save, inputsFrom, renderAccount, renderHealth, renderEvents, CONFIG_KEYS });

  const field = ([key, labelText, note, step, kind]) => html`<label class="field"><span>${labelText}</span><input type="number" step="${step}" data-field="${key}"${kind === "optional" ? html` placeholder="不限"` : ""}><small data-note="${key}">${note}</small></label>`;
  const root = P.mount("settings", "设置", "策略参数、账户（只读）和系统状态。", html`
    <section class="panel">
      <div class="panel-head"><h2>策略参数</h2><span class="panel-meta" data-revision></span></div>
      <div class="form">
        ${FIELDS.slice(0, 8).map(field)}
        <label class="field"><span>开盘线</span><select data-field="openLine"><option value="tick">开盘那一笔</option><option value="mean60">开盘前 60 秒均价</option></select><small>开盘线范围从哪条线量</small></label>
        <div class="field"><span>信号交易所</span><div class="checks">${ALL_VENUES.map((venue) => html`<label><input type="checkbox" data-venue="${venue}"> ${VENUES[venue]}</label>`)}</div><small data-note="leadVenues">哪几家的永续合约成交算信号；至少一家</small></div>
        <div class="field"><span>东京转发</span><div class="checks"><label><input type="checkbox" data-field="tokyoRelay"> 开启</label></div><small>同时接东京转发来的成交，谁先到用谁</small></div>
        <div class="field"><span>挂单模拟记录</span><div class="checks"><label><input type="checkbox" data-field="restShadow"> 开启</label></div><small>挂单关着时，记录没买到后 5 秒内挂单会不会成交（不下单），统计页可看</small></div>
        ${FIELDS.slice(8).map(field)}
      </div>
      <details><summary>高级</summary><div class="form" style="margin-top:10px">${ADVANCED.map(field)}</div></details>
      <div class="form-foot"><button class="btn primary" type="button" data-save>保存并发布</button><button class="btn" type="button" data-reset>恢复已发布的值</button><span class="feedback" data-save-feedback role="status"></span></div>
      <p class="note">保存后从下一场生效；信号交易所和东京转发下次启动才生效。</p>
    </section>
    <section class="panel"><div class="panel-head"><h2>账户（只读）</h2></div><div data-account></div></section>
    <section class="panel"><div class="panel-head"><h2>系统</h2></div><div data-health></div></section>
    <section class="panel">
      <div class="panel-head"><h2>运行日志</h2><span class="actions"><select class="plain" data-kind><option value="">全部类型</option></select></span></div>
      <ol class="log" data-events></ol>
    </section>
    <section class="panel"><div class="panel-head"><h2>清空统计数据</h2></div>
      <p class="note">删除运行记录、引擎状态和统计账本，保留结算记录和策略参数。引擎在跑时服务器会拒绝。删了回不来。</p>
      <div class="form-foot"><button class="btn danger" type="button" data-ledger-reset>清空统计数据</button><span class="feedback" data-reset-feedback role="status"></span></div>
    </section>`);
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  const state = { config: null, dirty: false, events: [], status: null, snapshot: null };
  const read = () => {
    const inputs = {};
    for (const [key] of [...FIELDS, ...ADVANCED]) inputs[key] = $(`[data-field="${key}"]`).value;
    inputs.openLine = $('[data-field="openLine"]').value;
    inputs.tokyoRelay = $('[data-field="tokyoRelay"]').checked;
    inputs.restShadow = $('[data-field="restShadow"]').checked;
    inputs.leadVenues = ALL_VENUES.filter((venue) => $(`[data-venue="${venue}"]`).checked);
    return inputs;
  };
  const fill = (config) => {
    const inputs = inputsFrom(config);
    for (const [key] of [...FIELDS, ...ADVANCED]) $(`[data-field="${key}"]`).value = inputs[key];
    $('[data-field="openLine"]').value = inputs.openLine;
    $('[data-field="tokyoRelay"]').checked = inputs.tokyoRelay;
    $('[data-field="restShadow"]').checked = inputs.restShadow;
    for (const venue of ALL_VENUES) $(`[data-venue="${venue}"]`).checked = inputs.leadVenues.includes(venue);
    state.dirty = false;
    showErrors({});
  };
  const NOTES = Object.fromEntries([...FIELDS, ...ADVANCED].map(([key, , note]) => [key, note]));
  NOTES.leadVenues = "哪几家的永续合约成交算信号；至少一家";
  const showErrors = (errors) => {
    for (const [key, note] of Object.entries(NOTES)) {
      const node = $(`[data-note="${key}"]`);
      if (!node) continue;
      node.textContent = errors[key] || note;
      node.classList.toggle("bad", Boolean(errors[key]));
      $(`[data-field="${key}"]`)?.classList.toggle("invalid", Boolean(errors[key]));
    }
  };
  const saveFeedback = (text, bad = false) => { const node = $("[data-save-feedback]"); node.textContent = text; node.classList.toggle("bad", bad); };
  const showRevision = () => {
    const c = state.config;
    $("[data-revision]").textContent = c ? `已发布 r${c.savedRevision || 0}${c.savedAt ? ` · ${fmt.dateTime(c.savedAt)}` : ""}${c.activeRevision ? ` · 当前场用 r${c.activeRevision}` : ""}${c.savedRevision ? "" : " · 还没发布过，启动前要先保存"}` : "";
  };
  root.addEventListener("input", (event) => { if (event.target.closest?.(".form")) { state.dirty = true; showErrors(buildConfig(read(), state.config?.config).errors); } });
  root.addEventListener("change", (event) => { if (event.target.closest?.(".form")) { state.dirty = true; showErrors(buildConfig(read(), state.config?.config).errors); } });
  $("[data-reset]").addEventListener("click", () => { if (state.config) fill(state.config.config); saveFeedback(""); });
  $("[data-save]").addEventListener("click", async () => {
    if (!state.config) { saveFeedback("还没读到已发布的参数", true); return; }
    const { config, errors } = buildConfig(read(), state.config.config);
    showErrors(errors);
    if (Object.keys(errors).length) { saveFeedback("有参数不对，看红字", true); return; }
    $("[data-save]").disabled = true;
    try {
      const revision = await save(config, state.config.savedRevision);
      saveFeedback(`已发布 r${revision}。从下一场生效；信号交易所和东京转发下次启动才生效。`);
      state.config = await P.api.strategyConfig();
      fill(state.config.config);
      showRevision();
    } catch (error) {
      saveFeedback(error.status === 409 ? "参数在别处被改过，已重新读取，请再检查一遍" : `保存失败：${error.message}`, true);
      if (error.status === 409) { state.config = await P.api.strategyConfig().catch(() => state.config); fill(state.config.config); showRevision(); }
    } finally { $("[data-save]").disabled = false; }
  });
  $("[data-kind]").addEventListener("change", () => P.put($("[data-events]"), renderEvents(state.events, $("[data-kind]").value)));
  $("[data-ledger-reset]").addEventListener("click", async () => {
    const node = $("[data-reset-feedback]");
    if (!window.confirm("确认清空统计数据？\n\n会删除运行记录、引擎状态和统计账本（保留结算记录和策略参数），删了回不来。引擎必须已停止。")) return;
    try {
      await P.api.ledgerReset();
      node.textContent = "已清空";
      node.classList.remove("bad");
    } catch (error) { node.textContent = `没有清空：${error.message}`; node.classList.add("bad"); }
  });

  P.every(10000, async () => {
    try {
      const config = await P.api.strategyConfig();
      const changed = config.savedRevision !== state.config?.savedRevision;
      state.config = config;
      if (changed && !state.dirty) fill(config.config);
      if (changed && state.dirty) saveFeedback(`服务器上已发布 r${config.savedRevision}，你改的还没保存`, true);
      showRevision();
    } catch (error) { saveFeedback(`读取参数失败：${error.message}`, true); }
  });
  P.every(10000, async () => {
    const [status, snapshot] = await Promise.all([P.api.accountStatus().catch(() => state.status), P.api.accountSnapshot().catch(() => state.snapshot)]);
    state.status = status;
    state.snapshot = snapshot;
    P.put($("[data-account]"), renderAccount(status, snapshot));
  });
  P.every(5000, async () => {
    try { P.put($("[data-health]"), renderHealth(await P.api.diagnostics())); } catch (error) { P.put($("[data-health]"), html`<p class="error-line">读取失败：${error.message}</p>`); }
  });
  P.every(5000, async () => {
    const data = await P.api.events(200);
    state.events = Array.isArray(data.items) ? data.items : [];
    const select = $("[data-kind]");
    const kinds = [...new Set(state.events.map((item) => item.kind).filter(Boolean))].sort();
    const current = select.value;
    P.put(select, html`<option value="">全部类型</option>${kinds.map((kind) => html`<option value="${kind}">${kind}</option>`)}`);
    select.value = kinds.includes(current) ? current : "";
    P.put($("[data-events]"), data.available === false ? html`<li class="empty">${P.label(data.error) || "没有运行记录"}</li>` : renderEvents(state.events, select.value));
  });
})();
