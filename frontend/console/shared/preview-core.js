"use strict";
// Console core: requests (answered from the push stream when it has the path),
// escaped HTML templates, number/time formats, polling and the page shell.
(() => {
  const config = { apiBase: "", ...(window.__POLY_PREVIEW_CONFIG__ || {}) };

  const request = async (path, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    // A pushed body is what this GET would return right now (shared/stream.js).
    if (method === "GET" && !options.noPush && window.PolyPreviewStream) {
      window.PolyPreviewStream.note(path);
      const pushed = window.PolyPreviewStream.cached(path);
      if (pushed) return pushed;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), options.timeout || 8000);
    try {
      const response = await window.fetch(`${config.apiBase}${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: options.body ? { "Content-Type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(label((body && body.error) || `请求失败（${response.status}）`));
        error.status = response.status;
        error.body = body;
        throw error;
      }
      if (!body || typeof body !== "object") throw new Error("接口没有返回有效数据");
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("请求超时");
      throw error;
    } finally { window.clearTimeout(timer); }
  };
  const post = (path, body, timeout) => request(path, { method: "POST", body, timeout });
  const query = (params) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(key, value);
    const text = search.toString();
    return text ? `?${text}` : "";
  };
  const api = {
    runtimeStatus: () => request("/api/runtime/status"),
    runtimeBook: () => request("/api/runtime/book"),
    runtimeCommand: (payload) => post("/api/runtime/commands", payload, 30000),
    strategyConfig: () => request("/api/strategy/config"),
    strategyDraft: (payload) => post("/api/strategy/drafts", payload),
    strategyActivate: (payload) => post("/api/strategy/activate", payload),
    position: (roundId, marketId) => request(`/api/rounds/${encodeURIComponent(roundId)}/position${query({ marketId })}`),
    roundOrders: (roundId, marketId) => request(`/api/rounds/${encodeURIComponent(roundId)}/orders${query({ marketId, limit: 10 })}`),
    accountSnapshot: () => request("/api/account/snapshot"),
    accountStatus: () => request("/api/account/status"),
    diagnostics: () => request("/api/diagnostics/health"),
    statsLead: (range) => request(`/api/stats/lead${query({ range })}`),
    // Older pages are read once, not subscribed to the push stream.
    ordersLead: ({ range, limit, before } = {}) => request(`/api/orders/lead${query({ range, limit, before })}`, { noPush: before != null }),
    events: (limit = 200) => request(`/api/events${query({ limit })}`),
    ledgerReset: () => post("/api/ledger/reset", { confirm: "RESET" }, 30000),
  };

  // --- escaped HTML: every interpolated value is escaped unless it is html`` output ---
  class Raw { constructor(text) { this.text = text; } toString() { return this.text; } }
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ESC[char]);
  const part = (value) => value instanceof Raw ? value.text : Array.isArray(value) ? value.map(part).join("")
    : value === null || value === undefined || value === false ? "" : esc(value);
  const html = (strings, ...values) => new Raw(strings.reduce((out, text, i) => out + text + (i < values.length ? part(values[i]) : ""), ""));
  // Replace an element's markup only when it changed.
  const put = (node, markup) => {
    if (!node) return;
    const text = String(markup);
    if (node.__html !== text) { node.__html = text; node.innerHTML = text; }
  };

  // --- formats ---
  const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const fmt = {
    money(value) {   // signed, 2 decimals
      const v = num(value);
      if (v === null) return "--";
      const fixed = Math.abs(v).toFixed(2);
      return fixed === "0.00" ? "$0.00" : `${v > 0 ? "+" : "-"}$${fixed}`;
    },
    usd(value) { const v = num(value); return v === null ? "--" : `$${v.toFixed(2)}`; },
    ms(value) { const v = num(value); return v === null ? "--" : `${Math.round(v)} ms`; },
    pct(ratio) { const v = num(ratio); return v === null ? "--" : `${(v * 100).toFixed(1)}%`; },
    price(value) {
      const v = num(value);
      if (v === null) return "--";
      return v.toFixed(Math.abs(v * 100 - Math.round(v * 100)) > 1e-6 ? 3 : 2);
    },
    bp(value) { const v = num(value); return v === null ? "--" : `${v.toFixed(1)} bp`; },
    shares(value) { const v = num(value); return v === null ? "--" : String(Number(v.toFixed(2))); },
    int(value) { const v = num(value); return v === null ? "--" : String(Math.round(v)); },
    btc(value) { const v = num(value); return v === null ? "--" : v.toFixed(2); },
    seconds(value) { const v = num(value); return v === null ? "--" : v < 10 ? `${v.toFixed(1)} 秒` : `${Math.round(v)} 秒`; },
    // Beijing time (UTC+8) from Unix seconds or milliseconds.
    bjDate(value) {
      const v = num(value);
      if (v === null || v <= 0) return null;
      return new Date((v < 1e12 ? v * 1000 : v) + 8 * 3600 * 1000).toISOString();
    },
    time(value) { const iso = fmt.bjDate(value); return iso ? iso.slice(11, 19) : "--"; },
    hm(value) { const iso = fmt.bjDate(value); return iso ? iso.slice(11, 16) : "--"; },
    dateTime(value) { const iso = fmt.bjDate(value); return iso ? `${iso.slice(5, 10)} ${iso.slice(11, 19)}` : "--"; },
    countdown(seconds) {
      const v = num(seconds);
      if (v === null) return "--";
      const s = Math.max(0, Math.floor(v));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    },
    tone(value) { const v = num(value); return v === null || Math.abs(v) < 0.005 ? "" : v > 0 ? "up" : "down"; },
  };

  const VENUES = { bybit: "Bybit", binance: "币安合约", okx: "OKX" };
  const LINES = { direct: "爱尔兰直连", tokyo: "东京转发" };
  const DIRECTIONS = { UP: "涨 UP", DOWN: "跌 DOWN" };
  const ORDER_STATUS = { CREATED: "已创建", SUBMITTING: "提交中", OPEN: "挂单中", PARTIAL: "部分买到", FILLED: "全部买到",
    CANCELLED: "没买到（FAK 作废）", REJECTED: "被拒绝", UNKNOWN: "待确认", ABANDONED: "已放弃" };
  const ERRORS = {
    runtime_snapshot_pending: "引擎刚启动，等待第一份运行快照",
    no_current_round: "当前没有进行中的场次",
    book_snapshot_unavailable: "还没有盘口快照",
    book_snapshot_stale: "盘口快照已过期",
    runtime_snapshot_stale: "运行状态已过期",
    ledger_projection_unavailable: "账本数据暂不可用",
    ledger_projection_incomplete: "账本还在追赶运行记录",
    trading_runtime_unavailable: "交易引擎状态不可用",
    resource_snapshot_stale: "主机资源数据过期",
    lead_feed_unhealthy: "信号源 10 秒内没有成交",
    relay_listener_down: "东京转发监听没有工作",
    account_bridge_unavailable: "账户读取不可用",
    account_not_configured: "服务器还没有配置账户",
    not_checked: "还没有检查",
    data_unavailable: "数据源暂时不可用",
    invalid_query: "查询参数不正确",
    record_not_found: "记录不存在",
    stream_capacity: "推送连接已满",
    // The engine's stop reasons (core.ts risk.reason); a skipped signal or a
    // round shows them as they are.
    "daily loss limit": "已达每日亏损上限，今天不再下单",
    "platform stopped": "引擎已停止",
    "unknown order requires reconciliation": "有订单状态待确认，等待对账",
    "restored orders require reconciliation": "重启后有未完成订单，等待对账",
    "failed trade requires reconciliation": "有成交失败，等待对账",
    "failed trade requires account reconciliation": "有成交失败，等待账户对账",
    "signed identity requires reconciliation": "订单编号不一致，等待对账",
    "state persistence failed": "状态保存失败，已停止下单",
    "account recovery in progress": "正在读取账户，稍后再下",
    "market reconciliation in progress": "本场订单待确认，稍后再下",
  };
  const label = (code) => {
    const text = String(code ?? "").trim();
    if (!text) return "";
    return text.split(/;\s*/).map((item) => ERRORS[item] || item).join("；");
  };

  // --- polling: one loop per data source, paused while the tab is hidden ---
  const every = (ms, fn) => {
    let timer = null;
    let busy = false;
    const run = async () => {
      window.clearTimeout(timer);
      timer = null;
      if (window.document.hidden) return;
      // Asked again while a read is in flight (a click): run right after it.
      if (busy) { timer = window.setTimeout(run, 200); return; }
      busy = true;
      try { await fn(); } catch { /* each loop shows its own error */ } finally { busy = false; }
      timer = window.setTimeout(run, ms);
    };
    window.document.addEventListener("visibilitychange", () => { if (!window.document.hidden && !timer) run(); });
    run();
    return run;
  };

  // --- page shell ---
  const NAV = [
    { key: "live", icon: "↗", label: "实盘", href: "auto-trade.html" },
    { key: "stats", icon: "▤", label: "统计", href: "stats.html" },
    { key: "history", icon: "☰", label: "历史", href: "history.html" },
    { key: "settings", icon: "⚙", label: "设置", href: "settings.html" },
  ];
  const shell = (active, title, subtitle, body) => html`
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>BTC 五分钟领先</small></div></div>
        <nav>${NAV.map((item) => html`<a class="nav-item${item.key === active ? " active" : ""}" href="${item.href}"${item.key === active ? html` aria-current="page"` : ""}><span>${item.icon}</span>${item.label}</a>`)}</nav>
        <div class="sidebar-status"><i data-push-dot></i><span data-push-state>连接中</span></div>
      </aside>
      <main class="main">
        <header class="page-header"><div><p class="eyebrow">BTC 五分钟 · binance-lead · 实盘</p><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="header-side" data-header-side></div></header>
        ${body}
      </main>
    </div>`;
  const mount = (active, title, subtitle, body) => {
    const root = window.document.querySelector("#app");
    if (!root) return null;
    put(root, shell(active, title, subtitle, body));
    window.setInterval(() => {
      const connected = window.PolyPreviewStream?.connected === true;
      const state = root.querySelector("[data-push-state]");
      if (state) state.textContent = connected ? "实时推送" : "轮询中";
      root.querySelector("[data-push-dot]")?.classList.toggle("off", !connected);
    }, 2000);
    return root;
  };

  window.PolyPreview = Object.freeze({ config, request, api, html, esc, put, fmt, num, label, every, mount, shell,
    VENUES, LINES, DIRECTIONS, ORDER_STATUS, Raw });
})();
