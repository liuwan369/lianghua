"use strict";
(() => {
  /**
   * Lightweight integration boundary for the standalone preview.
   * Pages can keep their current markup while the mock source is replaced by
   * the real adapter later. Production must not use localStorage as runtime truth.
   */
  const VERSION = 1;
  const listeners = new Map();
  const emit = (name, value) => (listeners.get(name) || []).forEach((fn) => fn(value));
  const on = (name, fn) => {
    const list = listeners.get(name) || [];
    list.push(fn);
    listeners.set(name, list);
    return () => listeners.set(name, list.filter((item) => item !== fn));
  };
  const safeJson = (value) => {
    try { return JSON.stringify(value); } catch { return null; }
  };
  const storage = {
    read(key, fallback) {
      try {
        const value = JSON.parse(window.localStorage.getItem(key) || "null");
        if (value && value.version === VERSION) return value.data;
        // One-time compatibility for the earlier raw preview object.
        return value && typeof value === "object" ? value : fallback;
      } catch { return fallback; }
    },
    write(key, data) {
      try {
        const value = safeJson({ version: VERSION, data });
        if (value) window.localStorage.setItem(key, value);
        emit(`storage:${key}`, data);
        return true;
      } catch { return false; }
    },
    remove(key) { try { window.localStorage.removeItem(key); } catch {} }
  };
  const request = async (path, options = {}) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), options.timeout || 8000);
    try {
      const response = await fetch(`${PolyPreview.config.apiBase}${path}`, {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        signal: controller.signal
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) { const error = new Error((body && body.error) || `请求失败（状态码 ${response.status}）`); error.status = response.status; throw error; }
      if (!body || typeof body !== "object") throw new Error("接口未返回有效 JSON 数据，保留上次成功数据");
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("请求超时，页面保留上次成功数据");
      throw error;
    } finally { window.clearTimeout(timeout); }
  };
  const createResource = () => ({ data: null, error: null, receivedAt: 0, loading: false, stale: false });
  const format = {
    clock(value = Date.now()) { return new Date(value).toLocaleTimeString("zh-CN", { hour12: false }); },
    timestampMs(value) {
      if (value === null || value === undefined || value === "") return null;
      const number = Number(value);
      if (Number.isFinite(number)) return Math.abs(number) < 1e12 ? number * 1000 : number;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    },
    timestamp(value) {
      if (value === null || value === undefined || value === "") return null;
      const timestamp = this.timestampMs(value);
      const date = timestamp == null ? new Date(value) : new Date(timestamp);
      return Number.isNaN(date.getTime()) ? null : date;
    },
    time(value, fallback = "--:--:--") {
      const date = this.timestamp(value);
      return date ? date.toLocaleTimeString("zh-CN", { hour12: false }) : fallback;
    },
    readableError(value, fallback = "接口暂时不可用") {
      const raw = String(value ?? "").trim();
      if (!raw) return fallback;
      const labels = {
        stopped: "交易进程已停止",
        started: "交易进程已启动",
        running: "交易进程运行中",
        starting: "交易进程正在启动",
        stopping: "交易进程正在停止",
        paused: "已暂停新增订单",
        failed: "交易进程运行失败",
        order: "订单状态更新",
        fill: "订单成交",
        settlement: "结算状态更新",
        resolved: "市场结果已确认",
        cancel: "撤单状态更新",
        market_pool_unavailable: "运行池暂时不可用",
        account_rpc_failed: "区块链节点查询失败，请检查网络连接",
        account_check_failed: "账户检查未通过，请查看账户配置和授权",
        account_checker_unavailable: "服务器账户检查程序暂不可用",
        invalid_account_config: "账户配置格式不正确",
        wallet_address_mismatch: "钱包地址与签名私钥不匹配",
        approvals_missing: "交易授权未完成",
        settlement_credentials_unavailable: "结算凭据不可用",
        account_response_invalid: "服务器返回的账户数据无效",
        ledger_projection_unavailable: "账本数据暂不可用",
        ledger_projection_incomplete: "账本投影尚未追上运行记录",
        remote_orders_unconfirmed: "远端挂单状态尚未确认",
        remote_orders_state_unconfirmed: "远端挂单状态尚未确认",
        runtime_snapshot_stale: "运行状态已过期",
        strategy_config_unavailable: "策略配置暂不可用",
        order_recovery_pending: "订单状态仍在核对",
        market_feed_unhealthy: "行情数据异常，等待恢复",
        transport_disconnected: "行情连接中断，等待恢复",
        stale_book: "行情盘口已过期，暂不用于交易"
      };
      if (/market_feed_unhealthy/i.test(raw) && /transport_disconnected/i.test(raw)) return "行情连接中断，正在等待恢复";
      if (/market_feed_unhealthy/i.test(raw) && /stale_book/i.test(raw)) return "行情盘口已过期，暂不用于交易";
      if (/market_feed_unhealthy/i.test(raw) && /incomplete_book/i.test(raw)) return "行情深度不完整，暂不可交易";
      const code = raw.toLowerCase().replace(/^error[:_ -]*/, "").split(/[:：]/, 1)[0];
      if (labels[code]) return labels[code];
      const words = {
        market: "市场", feed: "行情源", unhealthy: "异常", transport: "连接", disconnected: "中断",
        stale: "过期", book: "盘口", incomplete: "不完整", complete: "完整", connected: "已连接",
        waiting: "等待", order: "订单", fill: "成交", settlement: "结算", reconciliation: "对账",
        pending: "待处理", failed: "失败", error: "异常", retrying: "重试中", rejected: "未接受",
        acknowledged: "已确认", confirmed: "已确认", unresolved: "待确认", unavailable: "暂不可用",
        strategy: "策略", decision: "判断", skipped: "已跳过", accepted: "已接受", credentials: "账户凭据",
        missing: "缺失", mismatch: "不匹配", timeout: "超时", rpc: "区块链节点", platform: "交易进程"
      };
      if (/^[a-z][a-z0-9_:\s-]*$/i.test(raw)) {
        const translated = code.split(/[_:\s-]+/).filter(Boolean).map((word) => words[word] || word).join(" · ");
        return translated && translated.split(" · ").every((word) => /[\u3400-\u9fff]/.test(word)) ? translated : fallback;
      }
      return /[\u3400-\u9fff]/.test(raw) ? raw : fallback;
    },
    money(value) { return Number.isFinite(value) ? `$${value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value.toFixed(0)}` : "--"; },
    escape(value) { return String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char])); }
  };
  const selectedAssetFromUrl = new URLSearchParams(window.location.search).get("assetId");
  const setSelectedAssetUrl = (assetId) => {
    config.selectedAssetId = assetId || null;
    const url = new URL(window.location.href);
    if (assetId) url.searchParams.set("assetId", assetId);
    else url.searchParams.delete("assetId");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const navigate = (target) => {
    if (!target) return;
    const url = new URL(target, window.location.href);
    const selected = new URLSearchParams(window.location.search).get("assetId");
    if (selected && !url.searchParams.has("assetId")) url.searchParams.set("assetId", selected);
    window.location.assign(`${url.pathname}${url.search}${url.hash}`);
  };
  const scopedQuery = (context = {}) => {
    const params = new URLSearchParams();
    if (context.range) params.set("range", context.range);
    if (context.assetId) params.set("assetId", context.assetId);
    if (context.marketId) params.set("marketId", context.marketId);
    if (context.roundId) params.set("roundId", context.roundId);
    if (context.runId) params.set("runId", context.runId);
    if (context.cursor) params.set("cursor", context.cursor);
    const query = params.toString();
    return query ? `?${query}` : "";
  };
  const accountPost = async (path, payload = {}) => {
    const base = new URL(config.apiBase || window.location.origin, window.location.href);
    if (window.location.protocol !== "https:" || base.origin !== window.location.origin) {
      throw new Error("账户密钥只允许通过 HTTPS 同源页面提交");
    }
    try {
      const result = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), credentials: "same-origin", redirect: "error", cache: "no-store", timeout: 55000 });
      if (result?.ok !== true || !result.report || typeof result.report !== "object" || Array.isArray(result.report)) throw new Error("账户接口未确认检查或保存成功");
      return result;
    } catch (error) {
      let message = error?.message || "账户请求失败，输入尚未保存";
      for (const value of Object.values(payload)) if (typeof value === "string" && value) message = message.split(value).join("[已隐藏]");
      message = message.replace(/(?:0x)?[a-fA-F0-9]{64}/g, "[已隐藏]").slice(0, 240);
      throw new Error(message);
    }
  };
  const api = {
    bootstrap: () => request("/api/bootstrap"),
    controlSession: async (token) => {
      const base = new URL(config.apiBase || window.location.origin, window.location.href);
      if (window.location.protocol !== "https:" || base.origin !== window.location.origin) throw new Error("控制会话仅允许通过 HTTPS 同源页面连接");
      try {
        const result = await request("/api/trading/auth/session", { method: "POST", headers: { "Content-Type": "application/json", "X-PM-Control-Token": token }, body: "{}", redirect: "error" });
        if (result.ok !== true) throw new Error("控制会话未获服务器确认");
        return result;
      } catch { throw new Error("控制会话连接失败，请检查控制密码及服务器部署配置"); }
    },
    markets: (query = "asset=crypto&duration=5m") => request(`/api/markets?${query}`),
    marketSnapshot: (marketId, context = {}) => request(`/api/markets/${encodeURIComponent(marketId)}/snapshot${scopedQuery({ ...context, marketId })}`),
    marketPool: (options) => request("/api/runtime/market-pool", options),
    runtimeStatus: (context = {}) => request(`/api/runtime/status${scopedQuery(context)}`),
    runtimeCommand: (payload) => request("/api/runtime/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    legacyRuntimeCommand: (payload) => request("/api/trading/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    strategyConfig: () => request("/api/strategy/config"),
    strategyDraft: (payload) => request("/api/strategy/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    legacyStrategySave: (payload) => request("/api/strategy-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    strategyActivate: (payload) => request("/api/strategy/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    presets: (options) => request("/api/strategy/presets", options),
    position: (roundId, context = {}) => request(`/api/rounds/${encodeURIComponent(roundId)}/position${scopedQuery({ ...context, roundId })}`),
    orders: (roundId, context = {}) => request(`/api/rounds/${encodeURIComponent(roundId)}/orders${scopedQuery({ ...context, roundId })}`),
    cancelOrder: (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST" }),
    flatten: () => request("/api/runtime/flatten", { method: "POST" }),
    accountSnapshot: () => request("/api/account/snapshot"),
    accountStatus: () => request("/api/account/status"),
    accountCheck: (payload = {}) => accountPost("/api/account/check", payload),
    accountSave: (payload = {}) => accountPost("/api/account/save", payload),
    diagnostics: () => request("/api/diagnostics/health"),
    metrics: (range = "today", context = {}) => request(`/api/metrics/summary${scopedQuery({ ...context, range })}`),
    events: (cursor = "", context = {}) => request(`/api/events${scopedQuery({ ...context, ...(cursor ? { cursor } : {}) })}`),
    fills: (context = {}) => request(`/api/fills${scopedQuery(context)}`),
    settlements: (context = {}) => request(`/api/settlements${scopedQuery(context)}`),
    legacyStatus: () => request("/api/v1/status"),
    legacyMarkets: () => request("/api/v1/markets"),
    legacyAccount: () => request("/api/account/status"),
    legacyAccountSnapshot: () => request("/api/v1/account-data"),
    legacyRuns: () => request("/api/v1/runs?limit=50"),
    legacyEvents: (runId) => request(`/api/v1/events?run_id=${encodeURIComponent(runId)}&limit=50`),
    legacySummary: (runId) => request(`/api/v1/summary?run_id=${encodeURIComponent(runId)}`),
    legacySystemMetrics: () => request("/api/v1/system-metrics"),
    legacyStrategyConfig: () => request("/api/strategy-config")
  };
  const runtimeConfig = window.__POLY_PREVIEW_CONFIG__ || {};
  // Backend is the default. Preserve an explicitly supplied mode for hosts
  // that use it as metadata, while keeping local/demo data disabled.
  const config = { apiBase: "", apiFlavor: "contract", marketCycle: "5m", strategyId: "btc-reversal", selectedAssetId: selectedAssetFromUrl, streams: {}, mode: "backend", ...runtimeConfig, demo: false };
  window.PolyPreview = Object.freeze({ VERSION, config, api, storage, request, createResource, format, navigate, setSelectedAssetUrl, on, emit });
})();
