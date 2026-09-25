"use strict";
(() => {
  const core = window.PolyPreview;
  const vm = window.PolyPreviewViewModel;
  if (!core || !vm) throw new Error("preview shared modules must load before preview-store.js");
  const initialCatalog = { status: "unavailable", items: [], selectedId: null, source: "backend", stale: true, partial: false, error: "行情目录尚未接入", receivedAt: 0 };
  const state = {
    marketCatalog: initialCatalog,
    marketPool: { desiredIds: [], currentIds: [], nextRoundIds: [], effectiveRoundId: null, source: "backend", status: "unavailable", stale: true, error: "运行池尚未接入", receivedAt: 0, initialUnavailable: false },
    runtime: { status: "unavailable", source: "backend", stale: true, asOf: null, markets: [], error: "后端尚未接入" },
    strategy: { status: "unavailable", revision: null, data: null, error: "策略配置尚未接入" },
    account: { status: "unavailable", data: null, error: "后端尚未接入" },
    accountStatus: { status: "unavailable", data: null, error: "账户配置状态尚未接入" },
    diagnostics: { status: "unavailable", data: null, error: "后端尚未接入" },
    metrics: { status: "unavailable", data: null, error: "后端尚未接入" },
    events: { status: "unavailable", items: [], cursor: null, error: null }
  };
  const subscribers = new Map();
  const notify = (slice) => (subscribers.get(slice) || []).forEach((listener) => listener(state[slice], state));
  const update = (slice, patch) => { state[slice] = { ...state[slice], ...patch }; notify(slice); return state[slice]; };
  const subscribe = (slice, listener) => {
    const list = subscribers.get(slice) || [];
    list.push(listener);
    subscribers.set(slice, list);
    listener(state[slice], state);
    return () => subscribers.set(slice, list.filter((item) => item !== listener));
  };
  const canInitializeMarketPool = (value) => Boolean(value?.initialUnavailable === true
    && !(value.receivedAt > 0)
    && value.error === "market_pool_unavailable"
    && Array.isArray(value.desiredIds) && value.desiredIds.length === 0
    && Array.isArray(value.currentIds) && value.currentIds.length === 0
    && Array.isArray(value.nextRoundIds) && value.nextRoundIds.length === 0);
  const setMarketPool = (value) => {
    const next = vm.pool(value, state.marketCatalog.items);
    const result = { ...next, status: "ready", stale: false, error: null, pendingDesiredIds: null, receivedAt: Date.now(), initialUnavailable: false };
    update("marketPool", result);
    return result;
  };
  const setMarketCatalog = (value) => {
    const next = vm.catalog(value);
    const hasPrevious = state.marketCatalog.items.length > 0;
    const previousItems = state.marketCatalog.items;
    const keepPrevious = hasPrevious && !next.partial && (next.stale || next.error || next.items.length === 0);
    const items = next.partial
      ? (() => {
        const incoming = new Map(next.items.map((item) => [item.assetId, item]));
        const merged = previousItems.map((previous) => {
          const current = incoming.get(previous.assetId);
          if (!current) return previous;
          return current.stale === true ? { ...previous, stale: true, staleReason: current.staleReason || next.error || "该资产行情已过期" } : current;
        });
        next.items.forEach((item) => { if (!previousItems.some((previous) => previous.assetId === item.assetId)) merged.push(item); });
        return merged;
      })()
      : keepPrevious ? previousItems : next.items;
    const requested = state.marketCatalog.selectedId || core.config.selectedAssetId;
    const selected = items.some((item) => item.assetId === requested) ? requested : requested ? null : items[0]?.assetId || null;
    const status = next.partial ? "partial" : next.stale ? (hasPrevious ? "stale" : "unavailable") : next.error ? (hasPrevious ? "error" : "unavailable") : next.items.length === 0 ? (hasPrevious ? "stale" : "unavailable") : "ready";
    const error = next.error || (next.items.length === 0 && !hasPrevious ? "市场目录暂无有效快照" : null);
    const result = {
      ...next,
      items,
      source: keepPrevious ? state.marketCatalog.source : next.source,
      asOf: keepPrevious ? state.marketCatalog.asOf : next.asOf,
      status,
      stale: next.partial ? false : next.stale,
      error,
      selectedId: selected,
      receivedAt: keepPrevious ? state.marketCatalog.receivedAt : Date.now()
    };
    update("marketCatalog", result);
    return result;
  };
  const setSelectedMarket = (assetId) => {
    const selectedId = state.marketCatalog.items.some((item) => item.assetId === assetId) ? assetId : null;
    core.setSelectedAssetUrl(selectedId);
    return update("marketCatalog", { selectedId });
  };
  const setSlice = (slice, value) => update(slice, value);
  window.PolyPreviewStore = Object.freeze({ getState: () => state, subscribe, update, setSlice, setMarketCatalog, setMarketPool, setSelectedMarket, canInitializeMarketPool });
})();
