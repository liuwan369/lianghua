"use strict";
// 总览: every account side by side. A card per account (state, today, balance,
// feed, the engine box's CPU), then the comparison: each account's config with
// the differing values marked, and their results over one range with the
// sample size beside every rate. Each account's data comes from its own
// console instance (/acct/<id>/api/...); this page only reads.
(() => {
  const P = window.PolyPreview;
  const { html, fmt, num } = P;
  const SMALL = 20;   // fewer settled rounds than this: the rates are noise
  const RANGES = [["today", "今天"], ["7d", "7 天"], ["run", "本次运行"]];
  const STATE_TEXT = { running: "运行中", paused: "已暂停", stopped: "已停止", failed: "异常退出", starting: "启动中" };

  // The config rows compared, in the order the settings page groups them.
  const CONFIG_ROWS = [
    ["shares", "每场股数", (v) => fmt.shares(v)],
    ["limitPremium", "限价加价", (v) => fmt.price(v)],
    ["entryOrder", "第一单方式", (v) => (v === "gtc" ? "限价单" : v === "fak" ? "吃单 + 补单" : "--")],
    ["restAfterMissSec", "挂单秒数", (v) => (num(v) === null ? "--" : `${v} 秒`)],
    ["openBandBp", "开盘线范围", (v) => (num(v) === null ? "--" : `±${v} bp`)],
    ["minEdge", "优势下限", (v) => (num(v) === null ? "不限" : `≥ ${String(v).replace("-", "−")}`)],
    ["openLine", "开盘线", (v) => (v === "mean60" ? "开盘前 60 秒均价" : v === "tick" ? "开盘那一笔" : "--")],
    ["regimePause", "行情太乱就暂停", (v) => (v === true ? "开" : v === false ? "关" : "--")],
    ["edgeSizing", "按优势定股数", (v) => (v === true ? "开" : v === false ? "关" : "--")],
    ["exitOnReverse", "反向信号就卖出", (v) => (v === true ? "开" : v === false ? "关" : "--")],
    ["retryReverse", "没买到后反向再试", (v) => (v === true ? "开" : v === false ? "关" : "--")],
    ["directVenues", "爱尔兰直连", (v) => (Array.isArray(v) ? (v.length ? v.map((x) => P.VENUES[x] || x).join("/") : "无") : "--")],
    ["dailyLossUsd", "每日亏损上限", (v) => (num(v) === null ? "不限" : fmt.usd(v))],
    ["ratchetStepUsd", "盈利保护每赚", (v) => (num(v) === null ? "不用" : fmt.usd(v))],
    ["ratchetLiftUsd", "盈利保护抬高", (v) => (num(v) === null ? "不用" : fmt.usd(v))],
  ];
  const compareConfig = (items) => CONFIG_ROWS.map(([key, label, show]) => {
    const raw = items.map((item) => item.config?.config?.[key]);
    const values = raw.map(show);
    return { key, label, values, differs: new Set(raw.map((v) => JSON.stringify(v ?? null))).size > 1 };
  });
  const head = (accounts) => html`<thead><tr><th class="l">参数</th>${accounts.map((a) => html`<th><i class="dot" style="background:${a.color}"></i> ${a.label}</th>`)}</tr></thead>`;
  const renderConfig = (rows, accounts) => html`<div class="table-wrap"><table class="t compare">${head(accounts)}<tbody>${rows.map((row) =>
    html`<tr${row.differs ? html` class="differs"` : ""}><td class="l">${row.label}</td>${row.values.map((v) => html`<td>${v}</td>`)}</tr>`)}</tbody></table></div>
    <p class="note">黄色的行是两个账户设得不一样的地方。</p>`;

  const pct = (part, whole) => (whole > 0 ? `${(100 * part / whole).toFixed(1)}%` : "--");
  const renderResults = (items, accounts) => {
    const funnel = (item) => item.stats?.funnel || {};
    const row = (label, cell) => html`<tr><td class="l">${label}</td>${items.map((item) => html`<td>${cell(funnel(item), item)}</td>`)}</tr>`;
    const small = (f) => (num(f.settled) ?? 0) < SMALL;
    return html`<div class="table-wrap"><table class="t compare">${head(accounts)}<tbody>
      ${row("下单", (f) => fmt.int(f.orders))}
      ${row("买到率", (f) => html`${pct(f.filled, f.orders)} <small class="muted">${fmt.int(f.filled)}/${fmt.int(f.orders)}</small>`)}
      ${row("胜率", (f) => html`<span class="${small(f) ? "small-sample" : ""}">${pct(f.won, f.settled)}</span> <small class="muted">${fmt.int(f.won)}/${fmt.int(f.settled)}</small>`)}
      ${row("每股盈亏", (f) => html`<span class="${fmt.tone(f.pnl_per_share)}">${num(f.pnl_per_share) === null ? "--" : `${f.pnl_per_share >= 0 ? "+" : ""}${f.pnl_per_share.toFixed(3)}`}</span> <small class="muted">${fmt.int(f.settled_shares)} 股</small>`)}
      ${row("盈亏", (f) => html`<span class="${fmt.tone(f.pnl_usd)}">${fmt.money(f.pnl_usd)}</span>`)}
    </tbody></table></div>
    <p class="note">每股盈亏 = 盈亏 ÷ 已结算股数，股数不同的账户按它比。结算不到 ${SMALL} 场的标黄，样本太少别当真。两个账户用同一个信号、在同一个盘口下单，会互相抢单，买到率和价格会互相影响。</p>`;
  };

  const card = (item) => {
    const s = item.status || {};
    const base = s.processRunning === null ? "unreachable" : s.processRunning ? (s.status || "starting") : (s.status === "failed" ? "failed" : "stopped");
    const halt = base === "running" ? P.haltOf(s) : null;
    const state = halt ? halt.key : base;
    const tone = state === "running" ? "ok" : state === "paused" || state === "starting" || state === "held" ? "warn"
      : state === "unreachable" || state === "failed" || state === "day_stop" ? "bad" : "";
    const today = item.today?.funnel || {};
    const cpu = item.health?.resources?.cpu || {};
    const balance = num(item.account?.collateral?.value);
    return html`<div class="card account-card" style="border-top:3px solid ${item.account_meta.color}">
      <span><i class="dot ${tone}"></i> ${item.account_meta.label} · ${item.account_meta.box || "--"}</span>
      <strong>${state === "unreachable" ? "连不上引擎机" : halt ? halt.text : STATE_TEXT[state] || state}</strong>${halt ? html`<small class="${tone}">${halt.note}</small><br>` : ""}
      <small>今日 <b class="${fmt.tone(today.pnl_usd)}">${fmt.money(today.pnl_usd)}</b> · 下单 ${fmt.int(today.orders)} · 买到 ${fmt.int(today.filled)}</small><br>
      <small>余额 ${balance === null ? "--" : fmt.usd(balance)} · 行情 ${s.leadFeedHealthy === true ? "正常" : s.leadFeedHealthy === false ? "断了" : "--"} · 参数 r${fmt.int(s.configRevision)}</small><br>
      <small>引擎机 CPU ${num(cpu.percent) === null ? "--" : `${cpu.percent.toFixed(0)}%`}${num(cpu.steal_percent) === null ? "" : ` · 被抢 ${cpu.steal_percent.toFixed(1)}%`}</small><br>
      <a class="btn small" href="/acct/${encodeURIComponent(item.account_meta.id)}/console/auto-trade.html">打开实盘页</a>
    </div>`;
  };

  // One column per account, so three or four sit side by side (.cards alone is a fixed four).
  const renderCards = (items) => (items.length
    ? html`<div class="cards accounts" style="grid-template-columns:repeat(${items.length}, minmax(0, 1fr))">${items.map(card)}</div>`
    : html`<p class="empty">没有读到账户列表</p>`);

  window.PolyOverview = Object.freeze({ compareConfig, renderConfig, renderResults, card, renderCards, CONFIG_ROWS });
  const root = P.mount("overview", "总览", "所有账户放一起看，对比哪套设置更好。", html`
    <section class="panel"><div class="panel-head"><h2>账户</h2><span class="panel-meta" data-asof></span></div><div data-cards></div></section>
    <section class="panel"><div class="panel-head"><h2>参数对比</h2></div><div data-config></div></section>
    <section class="panel"><div class="panel-head"><h2>结果对比</h2><span class="actions seg">${RANGES.map(([key, label]) => html`<button type="button" data-range="${key}">${label}</button>`)}</span></div><div data-results></div></section>`);
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  let range = "today";
  // Each account's own instance answers under its prefix; a failure leaves that card "--".
  const fetchJson = async (id, path) => {
    try {
      const response = await window.fetch(`/acct/${encodeURIComponent(id)}${path}`, { headers: { Accept: "application/json" } });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  const load = async () => {
    const list = (await P.api.accounts().catch(() => null))?.accounts || [];
    const items = await Promise.all(list.map(async (meta) => {
      const [status, today, stats, config, account, health] = await Promise.all([
        fetchJson(meta.id, "/api/runtime/status"), fetchJson(meta.id, "/api/stats/lead?range=today"),
        fetchJson(meta.id, `/api/stats/lead?range=${range}`), fetchJson(meta.id, "/api/strategy/config"),
        fetchJson(meta.id, "/api/account/snapshot"), fetchJson(meta.id, "/api/diagnostics/health")]);
      return { account_meta: meta, status, today, stats, config, account, health };
    }));
    P.put($("[data-cards]"), renderCards(items));
    P.put($("[data-config]"), renderConfig(compareConfig(items), list));
    P.put($("[data-results]"), renderResults(items.map((item) => ({ account: item.account_meta, stats: item.stats })), list));
    $("[data-asof]").textContent = `更新于 ${fmt.time(Date.now() / 1000)}`;
    for (const button of root.querySelectorAll("[data-range]")) button.classList.toggle("active", button.dataset.range === range);
  };
  // Polls (no push): one stream per account would use the browser's connections up.
  const refresh = P.every(5000, load);
  for (const button of root.querySelectorAll("[data-range]")) {
    button.addEventListener("click", () => { range = button.dataset.range; refresh(); });
  }
})();
