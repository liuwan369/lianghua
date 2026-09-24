"use strict";
(() => {
  const core = window.PolyPreview;
  const store = window.PolyPreviewStore;
  const vm = window.PolyPreviewViewModel;
  if (!core || !store || !vm) throw new Error("preview shared modules must load before api-adapter.js");
  const demoMode = () => core.config.mode === "local-preview";
  const errorText = (error) => error?.message || "接口暂时不可用，页面保留上次成功数据";
  const resourceStatus = (raw, fallback = "ready") => {
    if (raw?.stale === true || raw?.collector_online === false) return "stale";
    if (raw?.available === false) return "unavailable";
    return fallback;
  };
  const hasSnapshot = (slice, resource) => {
    if (!resource) return false;
    if (slice === "marketCatalog") return Array.isArray(resource.items) && resource.items.length > 0;
    if (slice === "events") return resource.data != null || Array.isArray(resource.items) && resource.items.length > 0;
    if (slice === "runtime") return resource.status !== "unavailable" && (resource.asOf != null || resource.runId != null || Array.isArray(resource.markets) && resource.markets.length > 0);
    return resource.data != null;
  };
  const retainOnError = (slice, error) => {
    const current = store.getState()[slice] || {};
    const retainedState = slice === "runtime" ? (current.runtimeState || current.status) : undefined;
    return store.setSlice(slice, {
      ...current,
      status: hasSnapshot(slice, current) ? "stale" : "unavailable",
      ...(retainedState ? { runtimeState: retainedState } : {}),
      stale: true,
      error: errorText(error),
      lastErrorAt: Date.now()
    });
  };
  const readSlice = async (slice, operation) => {
    try { return await operation(); }
    catch (error) { return retainOnError(slice, error); }
  };
  const modernOrLegacy = async (modern, legacy) => {
    if (core.config.apiFlavor === "legacy") return legacy ? legacy() : modern();
    try { return await modern(); } catch (error) {
      if (error?.status === 404 && legacy) return legacy();
      throw error;
    }
  };
  const uuid = (value) => {
    if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const random = Math.random() * 16 | 0;
      const value = char === "x" ? random : random & 3 | 8;
      return value.toString(16);
    });
  };
  const commandResult = (raw = {}) => {
    const nested = raw.status && typeof raw.status === "object" ? raw.status : raw;
    const accepted = raw.accepted ?? raw.ok ?? nested.accepted;
    return {
      ...nested,
      accepted: accepted === true,
      status: typeof nested.status === "string" ? nested.status : accepted === true ? "accepted" : "rejected",
      message: raw.message || nested.message || (accepted === true ? "指令已接收，等待运行状态确认" : "运行控制接口未接受指令")
    };
  };
  let runtimeRequest = null;
  const adapter = {
    async loadMarkets() {
      if (demoMode()) return store.getState().marketCatalog;
      return readSlice("marketCatalog", async () => {
        const raw = await modernOrLegacy(() => core.api.markets(), () => core.api.legacyMarkets());
        store.setMarketCatalog(raw);
        return store.getState().marketCatalog;
      });
    },
    async loadMarketPool() {
      if (demoMode()) return store.getState().marketPool;
      return readSlice("marketPool", async () => {
        const raw = await modernOrLegacy(() => core.api.marketPool(), null);
        const next = vm.pool(raw, store.getState().marketCatalog.items);
        return store.setSlice("marketPool", { ...next, status: raw?.stale ? "stale" : "ready", stale: raw?.stale === true, error: raw?.error || null });
      });
    },
    async loadMarketSnapshot(marketId) {
      if (demoMode()) return null;
      return core.api.marketSnapshot(marketId);
    },
    async loadPosition(roundId) {
      if (demoMode() || !roundId) return null;
      return core.api.position(roundId);
    },
    async loadOrders(roundId) {
      if (demoMode() || !roundId) return null;
      return core.api.orders(roundId);
    },
    async loadRuntime() {
      if (demoMode()) return store.getState().runtime;
      if (runtimeRequest) return runtimeRequest;
      runtimeRequest = readSlice("runtime", async () => {
        const raw = await modernOrLegacy(() => core.api.runtimeStatus(), () => core.api.legacyStatus());
        const model = vm.runtime(raw);
        return store.setSlice("runtime", { ...model, runtimeState: model.status, connectionStatus: "ready", stale: false, error: null });
      });
      try { return await runtimeRequest; }
      finally { runtimeRequest = null; }
    },
    async loadStrategy() {
      if (demoMode()) return store.getState().strategy;
      return readSlice("strategy", async () => {
        const raw = await modernOrLegacy(() => core.api.strategyConfig(), () => core.api.legacyStrategyConfig());
        const data = raw || {};
        return store.setSlice("strategy", { status: resourceStatus(data), stale: resourceStatus(data) === "stale", data, revision: data.savedRevision ?? data.revision ?? null, error: data.error || null });
      });
    },
    async loadAccount() {
      if (demoMode()) return store.getState().account;
      return readSlice("account", async () => {
      const raw = await modernOrLegacy(() => core.api.accountSnapshot(), () => core.api.legacyAccountSnapshot());
      const data = raw || {};
      return store.setSlice("account", { status: resourceStatus(data), stale: resourceStatus(data) === "stale", data, error: data.error || null });
    });
  },
    async loadAccountStatus() {
      if (demoMode()) return store.getState().account;
      return readSlice("account", async () => {
        const raw = await core.api.accountStatus();
        const current = store.getState().account;
        const status = resourceStatus(raw);
        return store.setSlice("account", { ...current, status, stale: status === "stale", data: { ...(current.data || {}), ...(raw || {}) }, error: raw?.error || null });
      });
    },
    async checkAccount(payload = {}) {
      if (demoMode()) return { ok: false, status: "preview", message: "设计稿演示：账户检查接口尚未连接" };
      const raw = await modernOrLegacy(() => core.api.accountCheck(payload), () => core.api.accountCheck(payload));
      return raw || { ok: true, status: "checked" };
    },
    async loadDiagnostics() {
      if (demoMode()) return store.getState().diagnostics;
      return readSlice("diagnostics", async () => {
        const raw = await modernOrLegacy(() => core.api.diagnostics(), () => core.api.legacySystemMetrics());
        const status = resourceStatus(raw);
        return store.setSlice("diagnostics", { status, stale: status === "stale", data: raw || {}, error: raw?.error || null });
      });
    },
    async loadMetrics(runId) {
      if (demoMode()) return store.getState().metrics;
      return readSlice("metrics", async () => {
        let activeRunId = runId || store.getState().runtime.runId;
        if (!activeRunId) activeRunId = (await adapter.loadRuntime()).runId;
        const raw = await modernOrLegacy(() => core.api.metrics(), () => activeRunId ? core.api.legacySummary(activeRunId) : Promise.reject(new Error("run id missing")));
        return store.setSlice("metrics", { status: "ready", stale: false, data: raw, error: null });
      });
    },
    async loadEvents(runId) {
      if (demoMode()) return store.getState().events;
      return readSlice("events", async () => {
        let activeRunId = runId || store.getState().runtime.runId;
        if (!activeRunId) activeRunId = (await adapter.loadRuntime()).runId;
        const raw = await modernOrLegacy(() => core.api.events(), () => activeRunId ? core.api.legacyEvents(activeRunId) : Promise.reject(new Error("run id missing")));
        const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.events) ? raw.events : [];
        return store.setSlice("events", { status: "ready", stale: false, items, cursor: raw?.cursor ?? raw?.next_before_id ?? null, data: raw, error: null });
      });
    },
    async saveMarketPool(payload) {
      const next = vm.pool(payload, store.getState().marketCatalog.items);
      if (demoMode()) return store.setMarketPool(next);
      const raw = await core.api.marketPool({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ desiredIds: next.desiredIds, effectiveRoundId: next.effectiveRoundId }) });
      const hasPoolFields = raw && typeof raw === "object" && ["desiredIds", "enabledIds", "enabled_ids", "currentIds", "runningIds", "current_ids", "nextRoundIds", "next_round_ids"].some((key) => key in raw);
      const result = hasPoolFields ? raw : { ...next, source: raw?.source || "backend", updatedAt: raw?.updatedAt || raw?.updated_at || null };
      return store.setMarketPool(result);
    },
    async commandRuntime(payload) {
      if (demoMode()) return { accepted: false, status: "preview", message: "设计稿演示：运行控制接口尚未连接" };
      const command = { ...(payload || {}) };
      if (command.action === "start" && !Number.isInteger(command.revision)) {
        await adapter.loadStrategy();
        const revision = store.getState().strategy.revision;
        if (Number.isInteger(revision)) command.revision = revision;
      }
      command.requestId = uuid(command.requestId);
      const legacyPayload = {
        action: command.action,
        strategy_id: command.strategyId || core.config.strategyId,
        request_id: command.requestId,
        ...(Number.isInteger(command.revision) ? { revision: command.revision } : {}),
        ...(command.mode ? { mode: command.mode } : {})
      };
      const raw = await modernOrLegacy(() => core.api.runtimeCommand(command), () => core.api.legacyRuntimeCommand(legacyPayload));
      return commandResult(raw);
    },
    async saveStrategy(payload) {
      if (demoMode()) return { accepted: false, status: "preview", message: "设计稿演示：策略保存接口尚未连接" };
      const legacyPayload = {
        expectedRevision: store.getState().strategy.revision,
        config: {
          triggerPrice: payload.triggerPrice,
          confirmationPrice: payload.confirmationPrice,
          maxBuyPrice: payload.maxBuyPrice,
          stageShares: payload.stageShares,
          maxStages: payload.stageShares?.length || 0,
          roundBudgetUsd: payload.roundBudgetUsd ?? null,
          totalBudgetUsd: payload.totalBudgetUsd ?? null,
          dailyLossUsd: payload.dailyLossUsd ?? null,
          durationMinutes: payload.durationMinutes ?? 0,
          mode: payload.mode || "live",
          maxQuoteAgeSeconds: payload.maxQuoteAgeSeconds ?? 2,
          maxQuoteSkewSeconds: payload.maxQuoteSkewSeconds ?? 1.5
        }
      };
      const raw = await modernOrLegacy(() => core.api.strategyDraft(payload), () => core.api.legacyStrategySave(legacyPayload));
      const data = raw || {};
      store.setSlice("strategy", { status: resourceStatus(data), stale: resourceStatus(data) === "stale", data, revision: data.savedRevision ?? data.revision ?? null, error: data.error || null });
      return data;
    },
    async activateStrategy(payload) {
      if (demoMode()) return { accepted: false, status: "preview", message: "设计稿演示：策略激活接口尚未连接" };
      const raw = await core.api.strategyActivate(payload);
      return raw || { accepted: true, status: "accepted" };
    }
  };
  window.PolyPreviewAdapter = Object.freeze(adapter);
})();
