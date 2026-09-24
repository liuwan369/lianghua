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
      if (!response.ok) { const error = new Error((body && body.error) || `请求失败（HTTP ${response.status}）`); error.status = response.status; throw error; }
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
    if (context.assetId) params.set("assetId", context.assetId);
    if (context.marketId) params.set("marketId", context.marketId);
    if (context.roundId) params.set("roundId", context.roundId);
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
    metrics: (range = "today") => request(`/api/metrics/summary?range=${encodeURIComponent(range)}`),
    events: (cursor = "") => request(`/api/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
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
