"use strict";
(() => {
  const core = window.PolyPreview;
  const store = window.PolyPreviewStore;
  const vm = window.PolyPreviewViewModel;
  if (!core || !store || !vm) throw new Error("preview shared modules must load before api-adapter.js");
  const demoMode = () => core.config.mode === "local-preview";
  const modernOrLegacy = async (modern, legacy) => {
    if (core.config.apiFlavor === "legacy") return legacy ? legacy() : modern();
    try { return await modern(); } catch (error) {
      if (error?.status === 404 && legacy) return legacy();
      throw error;
    }
  };
  const adapter = {
    async loadMarkets() {
      if (demoMode()) return store.getState().marketCatalog;
      const raw = await modernOrLegacy(() => core.api.markets(), () => core.api.legacyMarkets());
      store.setMarketCatalog(raw);
      return store.getState().marketCatalog;
    },
    async loadRuntime() {
      if (demoMode()) return store.getState().runtime;
      const raw = await modernOrLegacy(() => core.api.runtimeStatus(), () => core.api.legacyStatus());
      return store.setSlice("runtime", { ...vm.runtime(raw), status: "ready" });
    },
    async loadStrategy() {
      if (demoMode()) return store.getState().strategy;
      const raw = await modernOrLegacy(() => core.api.strategyConfig(), () => core.api.legacyStrategyConfig());
      return store.setSlice("strategy", { status: "ready", data: raw, revision: raw.savedRevision ?? raw.revision ?? null, error: null });
    },
    async loadAccount() {
      if (demoMode()) return store.getState().account;
      const raw = await modernOrLegacy(() => core.api.accountSnapshot(), () => core.api.legacyAccount());
      return store.setSlice("account", { status: "ready", data: raw, error: null });
    },
    async loadDiagnostics() {
      if (demoMode()) return store.getState().diagnostics;
      const raw = await modernOrLegacy(() => core.api.diagnostics(), () => core.api.legacySystemMetrics());
      return store.setSlice("diagnostics", { status: "ready", data: raw, error: null });
    },
    async loadMetrics(runId) {
      if (demoMode()) return store.getState().metrics;
      let activeRunId = runId || store.getState().runtime.runId;
      if (!activeRunId) {
        try { activeRunId = (await adapter.loadRuntime()).runId; } catch {}
      }
      const raw = await modernOrLegacy(() => core.api.metrics(), () => activeRunId ? core.api.legacySummary(activeRunId) : Promise.reject(new Error("run id missing")));
      return store.setSlice("metrics", { status: "ready", data: raw, error: null });
    },
    async loadEvents(runId) {
      if (demoMode()) return store.getState().events;
      let activeRunId = runId || store.getState().runtime.runId;
      if (!activeRunId) {
        try { activeRunId = (await adapter.loadRuntime()).runId; } catch {}
      }
      const raw = await modernOrLegacy(() => core.api.events(), () => activeRunId ? core.api.legacyEvents(activeRunId) : Promise.reject(new Error("run id missing")));
      const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.events) ? raw.events : [];
      return store.setSlice("events", { status: "ready", items, cursor: raw?.cursor ?? raw?.next_before_id ?? null, data: raw, error: null });
    },
    async saveMarketPool(payload) {
      const next = vm.pool(payload, store.getState().marketCatalog.items);
      if (demoMode()) return store.setMarketPool(next);
      const raw = await core.api.marketPool({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      return store.setMarketPool(raw);
    },
    async commandRuntime(payload) {
      if (demoMode()) return { accepted: false, status: "preview", message: "设计稿演示：运行控制接口尚未连接" };
      const requestId = typeof payload?.requestId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.requestId)
        ? payload.requestId : crypto.randomUUID();
      const legacyPayload = {
        action: payload?.action,
        strategy_id: "btc-reversal",
        request_id: requestId,
        revision: Number.isInteger(payload?.revision) ? payload.revision : store.getState().strategy.revision
      };
      return modernOrLegacy(
        () => core.api.runtimeCommand(payload),
        async () => {
          const response = await core.api.legacyRuntimeCommand(legacyPayload);
          return { accepted: response?.ok === true, status: response?.status || response, requestId };
        }
      );
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
      store.setSlice("strategy", { status: "ready", data: raw, revision: raw.savedRevision ?? raw.revision ?? null, error: null });
      return raw;
    }
  };
  window.PolyPreviewAdapter = Object.freeze(adapter);
})();
