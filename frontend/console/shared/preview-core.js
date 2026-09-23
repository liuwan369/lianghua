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
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("请求超时，页面保留上次成功数据");
      throw error;
    } finally { window.clearTimeout(timeout); }
  };
  const createResource = () => ({ data: null, error: null, receivedAt: 0, loading: false, stale: false });
  const format = {
    clock(value = Date.now()) { return new Date(value).toLocaleTimeString("zh-CN", { hour12: false }); },
    timestamp(value) {
      if (value === null || value === undefined || value === "") return null;
      const number = Number(value);
      const date = Number.isFinite(number) ? new Date(Math.abs(number) < 1e12 ? number * 1000 : number) : new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    },
    time(value, fallback = "--:--:--") {
      const date = this.timestamp(value);
      return date ? date.toLocaleTimeString("zh-CN", { hour12: false }) : fallback;
    },
    money(value) { return Number.isFinite(value) ? `$${value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value.toFixed(0)}` : "--"; },
    escape(value) { return String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char])); }
  };
  const navigate = (target) => { if (target) window.location.assign(target); };
  const api = {
    bootstrap: () => request("/api/bootstrap"),
    markets: (query = "asset=crypto&duration=5m") => request(`/api/markets?${query}`),
    marketSnapshot: (marketId) => request(`/api/markets/${encodeURIComponent(marketId)}/snapshot`),
    marketPool: (options) => request("/api/runtime/market-pool", options),
    runtimeStatus: () => request("/api/runtime/status"),
    runtimeCommand: (payload) => request("/api/runtime/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    legacyRuntimeCommand: (payload) => request("/api/trading/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    strategyConfig: () => request("/api/strategy/config"),
    strategyDraft: (payload) => request("/api/strategy/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    legacyStrategySave: (payload) => request("/api/strategy-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    strategyActivate: (payload) => request("/api/strategy/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    presets: (options) => request("/api/strategy/presets", options),
    position: (roundId) => request(`/api/rounds/${encodeURIComponent(roundId)}/position`),
    orders: (roundId) => request(`/api/rounds/${encodeURIComponent(roundId)}/orders`),
    cancelOrder: (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST" }),
    flatten: () => request("/api/runtime/flatten", { method: "POST" }),
    accountSnapshot: () => request("/api/account/snapshot"),
    accountStatus: () => request("/api/account/status"),
    accountCheck: (payload = {}) => request("/api/account/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
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
  const config = { apiBase: "", mode: "local-preview", apiFlavor: "contract", demo: true, marketCycle: "5m", strategyId: "btc-reversal", streams: {}, ...runtimeConfig };
  window.PolyPreview = Object.freeze({ VERSION, config, api, storage, request, createResource, format, navigate, on, emit });
  window.addEventListener("storage", (event) => {
    if (config.mode === "local-preview" && event.key) emit(`storage:${event.key}`, storage.read(event.key, null));
  });
})();
