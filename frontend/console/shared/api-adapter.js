"use strict";
(() => {
  const core = window.PolyPreview;
  const store = window.PolyPreviewStore;
  const vm = window.PolyPreviewViewModel;
  if (!core || !store || !vm) throw new Error("preview shared modules must load before api-adapter.js");
  const errorText = (error) => error?.message || "接口暂时不可用，页面保留上次成功数据";
  const resourceStatus = (raw, fallback = "ready") => {
    if (["stale", "unavailable", "error", "degraded"].includes(raw?.status)) return raw.status;
    if (raw?.stale === true || raw?.collector_online === false || raw?.depthUnavailable === true || raw?.depth_unavailable === true) return "stale";
    if (raw?.available === false) return "unavailable";
    return fallback;
  };
  const hasSnapshot = (slice, resource) => {
    if (!resource) return false;
    if (slice === "marketCatalog") return Array.isArray(resource.items) && resource.items.length > 0;
    if (slice === "marketPool") return resource.receivedAt > 0 && resource.initialUnavailable !== true;
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
      ...(slice === "marketPool" ? { initialUnavailable: false } : {}),
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
      commandStatus: raw.commandStatus ?? raw.command_status ?? nested.commandStatus ?? nested.command_status,
      serviceState: raw.serviceState ?? raw.service_state ?? nested.serviceState ?? nested.service_state,
      remoteOrdersState: raw.remoteOrdersState ?? raw.remote_orders_state ?? nested.remoteOrdersState ?? nested.remote_orders_state,
      accepted: accepted === true,
      status: typeof nested.status === "string" ? nested.status : accepted === true ? "accepted" : "rejected",
      message: raw.message || nested.message || (accepted === true ? "指令已接收，等待运行状态确认" : "运行控制接口未接受指令")
    };
  };
  let runtimeRequest = null;
  const adapter = {
    async loadMarkets() {
      return readSlice("marketCatalog", async () => {
        const raw = await modernOrLegacy(() => core.api.markets(), () => core.api.legacyMarkets());
        store.setMarketCatalog(raw);
        return store.getState().marketCatalog;
      });
    },
    async loadMarketPool() {
      return readSlice("marketPool", async () => {
        const raw = await modernOrLegacy(() => core.api.marketPool(), null);
        const poolPayload = raw?.data && typeof raw.data === "object" ? raw.data : raw;
        const next = vm.pool(poolPayload, store.getState().marketCatalog.items);
        const status = resourceStatus(poolPayload);
        const current = store.getState().marketPool;
        const hasCurrent = hasSnapshot("marketPool", current);
        const hasPoolFields = poolPayload && typeof poolPayload === "object" && ["desiredIds", "enabledIds", "enabled_ids", "currentIds", "runningIds", "current_ids", "nextRoundIds", "next_round_ids", "effectiveRoundId", "effective_round_id"].some((key) => key in poolPayload);
        if (!hasPoolFields) {
          return store.setSlice("marketPool", {
            ...current,
            status: hasCurrent ? "stale" : "unavailable",
            stale: true,
            initialUnavailable: false,
            error: poolPayload?.error || "运行池没有返回有效快照"
          });
        }
        if (status !== "ready" && hasCurrent) {
          return store.setSlice("marketPool", {
            ...current,
            status,
            stale: true,
            initialUnavailable: false,
            error: raw?.error || "运行池快照已过期，保留上次成功数据"
          });
        }
        const initialUnavailable = !hasCurrent
          && poolPayload?.available === false
          && poolPayload?.error === "market_pool_unavailable"
          && next.desiredIds.length === 0
          && next.currentIds.length === 0
          && next.nextRoundIds.length === 0;
        return store.setSlice("marketPool", {
          ...next,
          status: initialUnavailable ? "unavailable" : status,
          stale: status !== "ready",
          receivedAt: status === "ready" ? Date.now() : current.receivedAt || 0,
          initialUnavailable,
          pendingDesiredIds: status === "ready" ? null : current.pendingDesiredIds,
          error: raw?.error || poolPayload?.error || null
        });
      });
    },
    async loadMarketSnapshot(marketId, context = {}) {
      try { return await core.api.marketSnapshot(marketId, context); }
      catch (error) {
        if (error?.status !== 404) throw error;
        const fallback = store.getState().marketCatalog.items.find((item) => item.marketId === marketId);
        if (fallback?.orderBook || fallback?.depthUnavailable || fallback?.sequence != null) return fallback;
        throw error;
      }
    },
    async loadPosition(roundId, context = {}) {
      if (!roundId) return null;
      return core.api.position(roundId, context);
    },
    async loadOrders(roundId, context = {}) {
      if (!roundId) return null;
      return core.api.orders(roundId, context);
    },
    async loadRuntime(context = null) {
      if (context) {
        try {
          const raw = await core.api.runtimeStatus(context);
          const data = raw?.data && typeof raw.data === "object" ? raw.data : raw;
          const markets = Array.isArray(data?.markets) ? data.markets : [];
          const scoped = markets.map((item) => ({ ...item, assetId: item.assetId ?? item.asset_id ?? data.assetId })).find((item) => vm.matchesIdentity(item, context));
          if (scoped) return { ...vm.runtime({ ...data, ...scoped, status: data.status || data.state }), connectionStatus: resourceStatus(data), stale: resourceStatus(data) !== "ready" };
          if (vm.matchesIdentity(data, context)) return vm.runtime(data);
          throw new Error("运行状态身份与所选资产不匹配");
        } catch (error) {
          return { status: "unavailable", stale: true, error: errorText(error), assetId: context.assetId, marketId: context.marketId, roundId: context.roundId };
        }
      }
      if (runtimeRequest) return runtimeRequest;
      runtimeRequest = readSlice("runtime", async () => {
        const raw = await modernOrLegacy(() => core.api.runtimeStatus(), () => core.api.legacyStatus());
        const model = vm.runtime(raw);
        const connectionStatus = resourceStatus(raw);
        const current = store.getState().runtime;
        if (connectionStatus !== "ready" && hasSnapshot("runtime", current)) {
          return store.setSlice("runtime", { ...current, status: connectionStatus, stale: true, connectionStatus, processRunning: model.processRunning, error: raw?.error || "运行状态已过期，保留最近成功数据" });
        }
        return store.setSlice("runtime", { ...model, runtimeState: model.status, connectionStatus, stale: connectionStatus !== "ready" });
      });
      try { return await runtimeRequest; }
      finally { runtimeRequest = null; }
    },
    async loadStrategy() {
      return readSlice("strategy", async () => {
        const raw = await modernOrLegacy(() => core.api.strategyConfig(), () => core.api.legacyStrategyConfig());
        const payload = raw?.data && typeof raw.data === "object" ? raw.data : raw || {};
        const status = resourceStatus(raw);
        const current = store.getState().strategy;
        if (status !== "ready" && (current.data || current.draft || current.revision != null)) {
          return store.setSlice("strategy", { ...current, status, stale: true, error: raw?.error || payload.error || "策略配置已过期，保留最近成功数据" });
        }
        return store.setSlice("strategy", {
          status,
          stale: status !== "ready",
          data: payload,
          draft: raw?.draft || payload.draft || null,
          revision: raw?.savedRevision ?? raw?.revision ?? payload.savedRevision ?? payload.revision ?? null,
          error: raw?.error || payload.error || null
        });
      });
    },
    async loadAccount() {
      return readSlice("account", async () => {
      const raw = await modernOrLegacy(() => core.api.accountSnapshot(), () => core.api.legacyAccountSnapshot());
      const data = raw || {};
      const status = resourceStatus(data);
      const current = store.getState().account;
      if (status !== "ready" && current.data) return store.setSlice("account", { ...current, status, stale: true, error: data.error || "账户快照已过期，保留最近成功数据" });
      return store.setSlice("account", { status, stale: status !== "ready", data, error: data.error || null });
    });
  },
    async loadAccountStatus() {
      return readSlice("accountStatus", async () => {
        const raw = await core.api.accountStatus();
        const status = resourceStatus(raw);
        const current = store.getState().accountStatus;
        if (status !== "ready" && current.data) return store.setSlice("accountStatus", { ...current, status, stale: true, error: raw?.error || "账户状态已过期，保留最近成功数据" });
        return store.setSlice("accountStatus", { status, stale: status !== "ready", data: raw, error: raw?.error || null });
      });
    },
    async checkAccount(payload = {}) {
      const raw = await core.api.accountCheck(payload);
      return raw;
    },
    async saveAccount(payload = {}) {
      return core.api.accountSave(payload);
    },
    async openControlSession(token) {
      if (!token?.trim()) throw new Error("请输入交易控制密码");
      return core.api.controlSession(token.trim());
    },
    async loadDiagnostics() {
      return readSlice("diagnostics", async () => {
        const raw = await modernOrLegacy(() => core.api.diagnostics(), () => core.api.legacySystemMetrics());
        const status = resourceStatus(raw);
        const current = store.getState().diagnostics;
        if (status !== "ready" && current.data) return store.setSlice("diagnostics", { ...current, status, stale: true, error: raw?.error || "诊断数据已过期，保留最近成功数据" });
        return store.setSlice("diagnostics", { status, stale: status === "stale", data: raw || {}, error: raw?.error || null });
      });
    },
    async loadMetrics(runId) {
      return readSlice("metrics", async () => {
        const legacySummary = async () => {
          const activeRunId = runId || store.getState().runtime.runId || (await adapter.loadRuntime()).runId;
          if (!activeRunId) throw new Error("当前运行标识尚未提供");
          return core.api.legacySummary(activeRunId);
        };
        const results = await Promise.allSettled([
          modernOrLegacy(() => core.api.metrics("today"), legacySummary),
          modernOrLegacy(() => core.api.metrics("run"), legacySummary)
        ]);
        const data = { ...(store.getState().metrics.data || {}), periodStatus: {} };
        ["today", "current"].forEach((period, index) => {
          const result = results[index];
          data.periodStatus[period] = result.status === "fulfilled" ? resourceStatus(result.value) : "stale";
          if (result.status === "fulfilled") data[period] = result.value;
        });
        if (results.every((result) => result.status === "rejected")) throw results[0].reason;
        const stale = Object.values(data.periodStatus).some((status) => status !== "ready");
        return store.setSlice("metrics", { status: stale ? "stale" : "ready", stale, data, error: stale ? "部分统计未更新，保留最近结果" : null });
      });
    },
    async loadEvents(runId, context = {}) {
      return readSlice("events", async () => {
        const eventContext = { ...context, ...(runId && !context.runId ? { runId } : {}) };
        const raw = await modernOrLegacy(() => core.api.events("", eventContext), async () => {
          const activeRunId = runId || store.getState().runtime.runId || (await adapter.loadRuntime()).runId;
          if (!activeRunId) throw new Error("当前运行标识尚未提供");
          return core.api.legacyEvents(activeRunId);
        });
        const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.events) ? raw.events : [];
        const status = resourceStatus(raw);
        const current = store.getState().events;
        if (status !== "ready" && (current.data || current.items?.length)) return store.setSlice("events", { ...current, status, stale: true, error: raw?.error || "事件已过期，保留最近成功数据" });
        return store.setSlice("events", { status, stale: status !== "ready", items, cursor: raw?.cursor ?? raw?.next_before_id ?? null, data: raw, error: raw?.error || null });
      });
    },
    async saveMarketPool(payload) {
      const next = vm.pool(payload, store.getState().marketCatalog.items);
      const current = store.getState().marketPool;
      const initialUnavailable = store.canInitializeMarketPool(current);
      if ((current.status !== "ready" || current.stale === true) && !initialUnavailable) throw new Error("运行池最近确认状态不可用，恢复服务器连接后再修改");
      if (initialUnavailable && next.desiredIds.length !== 1) throw new Error("首次创建运行池必须选择一个币种");
      const marketCatalog = store.getState().marketCatalog;
      const catalog = new Map(store.getState().marketCatalog.items.map((item) => [item.assetId, item]));
      for (const id of next.desiredIds) {
        const item = catalog.get(id);
        if (!item) throw new Error("资产 " + id + " 不在服务器市场目录中");
        if (!current.desiredIds.includes(id) && (!item.canEnable || !item.marketId || !item.roundId || item.cycle !== "5m" || initialUnavailable && (marketCatalog.status !== "ready" || marketCatalog.stale || item.stale))) throw new Error(item.symbol + " 缺少新鲜目录中的服务器运行资格或 marketId + roundId，未提交运行池");
      }
      if (initialUnavailable) store.setSlice("marketPool", { ...current, status: "unavailable", stale: true, initialUnavailable: false, error: null });
      const raw = await core.api.marketPool({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ desiredIds: next.desiredIds, effectiveRoundId: next.effectiveRoundId }) });
      if (raw?.accepted === false || resourceStatus(raw) !== "ready") throw new Error(raw?.error || "运行池变更未获服务器确认");
      const hasPoolFields = raw && typeof raw === "object" && ["desiredIds", "enabledIds", "enabled_ids", "currentIds", "runningIds", "current_ids", "nextRoundIds", "next_round_ids"].some((key) => key in raw);
      if (hasPoolFields) return store.setMarketPool(raw);
      return store.setSlice("marketPool", { ...current, status: "stale", stale: true, pendingDesiredIds: next.desiredIds, error: "已提交运行池变更，等待服务器确认；当前仍显示最近确认状态" });
    },
    async commandRuntime(payload) {
      const command = { ...(payload || {}) };
      if (command.action === "start" && !Number.isInteger(command.revision)) {
        await adapter.loadStrategy();
        const revision = store.getState().strategy.revision;
        if (Number.isInteger(revision)) command.revision = revision;
      }
      if (command.action === "start" && !(command.revision > 0)) throw new Error("请先在策略页面保存草稿并激活发布，再启动交易");
      command.requestId = uuid(command.requestId);
      const legacyPayload = {
        action: command.action,
        strategy_id: command.strategyId || core.config.strategyId,
        request_id: command.requestId,
        ...(command.assetId ? { asset_id: command.assetId } : {}),
        ...(command.marketIds ? { market_ids: command.marketIds } : {}),
        ...(Number.isInteger(command.revision) ? { revision: command.revision } : {}),
        ...(command.mode ? { mode: command.mode } : {})
      };
      const raw = await modernOrLegacy(() => core.api.runtimeCommand(command), () => core.api.legacyRuntimeCommand(legacyPayload));
      return commandResult(raw);
    },
    async saveStrategy(payload) {
      const state = store.getState();
      const strategyData = state.strategy?.data || {};
      const urlAssetId = new URLSearchParams(window.location.search).get("assetId");
      const assetId = [
        payload?.assetId,
        payload?.config?.assetId,
        state.marketCatalog?.selectedId,
        core.config.selectedAssetId,
        urlAssetId,
        strategyData?.assetId,
        strategyData?.config?.assetId,
        strategyData?.config?.asset_id
      ].find((value) => value !== undefined && value !== null && String(value).trim() !== "");
      if (!assetId) throw new Error("当前未选择资产，无法保存策略");
      const values = { ...(payload?.config || {}), ...Object.fromEntries(Object.entries(payload).filter(([key, value]) => key !== "config" && value !== undefined)) };
      const config = {
        triggerPrice: values.triggerPrice,
        confirmationPrice: values.confirmationPrice,
        maxBuyPrice: values.maxBuyPrice,
        stageShares: values.stageShares,
        maxStages: values.maxStages ?? values.stageShares?.length,
        roundBudgetUsd: values.roundBudgetUsd ?? null,
        totalBudgetUsd: values.totalBudgetUsd ?? null,
        dailyLossUsd: values.dailyLossUsd ?? null,
        durationMinutes: values.durationMinutes ?? 0,
        mode: values.mode || "live",
        maxQuoteAgeSeconds: values.maxQuoteAgeSeconds ?? 2,
        maxQuoteSkewSeconds: values.maxQuoteSkewSeconds ?? 1.5,
        assetId: String(assetId).trim()
      };
      const strategyId = payload?.strategyId || strategyData?.strategyId || core.config.strategyId;
      const modernPayload = {
        strategyId,
        expectedRevision: Number.isInteger(payload.expectedRevision) ? payload.expectedRevision : state.strategy.revision,
        assetId: String(assetId).trim(),
        config
      };
      if (core.config.apiFlavor === "legacy") {
        const raw = await core.api.legacyStrategySave({ expectedRevision: modernPayload.expectedRevision, config });
        const result = raw?.data && typeof raw.data === "object" ? { ...raw, ...raw.data } : raw || {};
        const revision = result.savedRevision ?? result.revision;
        if (!(result.ok === true || result.accepted === true || Number.isInteger(revision)) || !Number.isInteger(Number(revision)) || !result.config) throw new Error(result.error || "旧策略接口未确认保存成功，输入尚未发布");
        const published = { ...result, strategyId, savedRevision: Number(revision), revision: Number(revision), config: result.config };
        store.setSlice("strategy", { status: "ready", stale: false, data: published, draft: null, revision: Number(revision), error: null });
        return { accepted: true, published: true, revision: Number(revision), config: result.config, strategyId };
      }
      const raw = await core.api.strategyDraft(modernPayload);
      const result = raw?.data && typeof raw.data === "object" ? { ...raw, ...raw.data } : raw;
      if (result.accepted !== true || !result.draftId || !result.config || !Number.isInteger(result.expectedRevision)) throw new Error("服务器未返回有效策略草稿回执，尚未发布");
      store.setSlice("strategy", { draft: result });
      return result;
    },
    async activateStrategy(payload) {
      const raw = await core.api.strategyActivate(payload);
      const result = raw?.data && typeof raw.data === "object" ? { ...raw, ...raw.data } : raw;
      if (result?.accepted !== true || !Number.isInteger(result.revision) || result.revision <= 0) throw new Error(result?.error || "策略激活未获服务器确认，草稿仍未发布");
      // Let the confirmed follow-up read clear the draft. If that read is
      // stale or unavailable, the existing draft remains recoverable.
      await adapter.loadStrategy();
      return result;
    }
  };
  window.PolyPreviewAdapter = Object.freeze(adapter);
})();
