"use strict";
(() => {
  const core = window.PolyPreview;
  const vm = window.PolyPreviewViewModel;
  const demo = window.PolyPreviewDemo;
  if (!core || !vm || !demo) throw new Error("preview shared modules must load before preview-store.js");
  const poolKey = "polymarket-design-market-pool-v1";
  const demoItems = demo.markets.map((item) => vm.market(item));
  const saved = core.config.mode === "local-preview" ? core.storage.read(poolKey, demo.marketPool) : demo.marketPool;
  const initialCatalog = core.config.mode === "local-preview"
    ? { status: "demo", items: demoItems, selectedId: "btc", source: "local-preview", stale: false, error: null, receivedAt: Date.now() }
    : { status: "unavailable", items: [], selectedId: null, source: "backend", stale: true, error: "行情目录尚未接入", receivedAt: 0 };
  const state = {
    marketCatalog: initialCatalog,
    marketPool: core.config.mode === "local-preview"
      ? { ...vm.pool(saved, demoItems), status: "demo", stale: false }
      : { desiredIds: [], currentIds: [], nextRoundIds: [], effectiveRoundId: null, source: "backend", status: "unavailable", stale: true, error: "运行池尚未接入" },
    runtime: { status: "unavailable", source: "local-preview", stale: true, asOf: null, markets: [], error: "后端尚未接入" },
    strategy: { status: "demo", revision: null, data: null, error: null },
    account: { status: "unavailable", data: null, error: "后端尚未接入" },
    diagnostics: { status: "unavailable", data: null, error: "后端尚未接入" },
    metrics: { status: "unavailable", data: null, error: "后端尚未接入" },
    events: { status: "demo", items: [], cursor: null, error: null }
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
  const setMarketPool = (value) => {
    const next = vm.pool(value, state.marketCatalog.items);
    update("marketPool", { ...next, status: "ready", stale: false, error: null });
    if (core.config.mode === "local-preview") core.storage.write(poolKey, { enabledIds: next.desiredIds, runningIds: next.currentIds, desiredIds: next.desiredIds, currentIds: next.currentIds, nextRoundIds: next.nextRoundIds });
    return next;
  };
  const setMarketCatalog = (value) => {
    const next = vm.catalog(value);
    const hasPrevious = state.marketCatalog.source !== "local-preview" && state.marketCatalog.items.length > 0;
    const keepPrevious = hasPrevious && (next.stale || next.error || next.items.length === 0);
    const items = keepPrevious ? state.marketCatalog.items : next.stale || next.error || next.items.length === 0 ? [] : next.items;
    const selected = items.some((item) => item.assetId === state.marketCatalog.selectedId) ? state.marketCatalog.selectedId : items[0]?.assetId || null;
    const status = next.stale ? (hasPrevious ? "stale" : "unavailable") : next.error ? (hasPrevious ? "error" : "unavailable") : next.items.length === 0 ? (hasPrevious ? "stale" : "unavailable") : "ready";
    const error = next.error || (next.items.length === 0 && !hasPrevious ? "市场目录暂无有效快照" : null);
    const result = { ...next, items, status, error, selectedId: selected, receivedAt: Date.now() };
    update("marketCatalog", result);
    update("marketPool", { ...vm.pool(state.marketPool, items), status: state.marketPool.status, stale: state.marketPool.stale, error: state.marketPool.error || null });
    return result;
  };
  const setSelectedMarket = (assetId) => update("marketCatalog", { selectedId: state.marketCatalog.items.some((item) => item.assetId === assetId) ? assetId : state.marketCatalog.selectedId });
  const setSlice = (slice, value) => update(slice, value);
  core.on(`storage:${poolKey}`, (value) => { if (value) update("marketPool", vm.pool(value, state.marketCatalog.items)); });
  window.PolyPreviewStore = Object.freeze({ poolKey, getState: () => state, subscribe, update, setSlice, setMarketCatalog, setMarketPool, setSelectedMarket });
})();
