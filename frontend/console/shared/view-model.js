"use strict";
(() => {
  const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
  const assetIdFrom = (raw, index = 0) => String(first(raw.assetId, raw.asset_id, raw.asset, raw.symbol, raw.slug, `market-${index}`)).toLowerCase();
  const symbolFrom = (raw, assetId) => String(first(raw.symbol, raw.ticker, assetId.split("-")[0])).toUpperCase();
  const market = (raw = {}, index = 0) => {
    const assetId = assetIdFrom(raw, index);
    const symbol = symbolFrom(raw, assetId);
    return {
      assetId,
      symbol,
      name: String(first(raw.name, raw.title, symbol)),
      english: String(first(raw.english, raw.name_en, symbol)),
      icon: String(first(raw.icon, symbol.slice(0, 1))),
      tone: String(first(raw.tone, assetId)),
      cycle: String(first(raw.cycle, raw.duration, "5m")),
      marketId: String(first(raw.marketId, raw.market_id, raw.id, raw.slug, `${assetId}-5m`)),
      roundId: String(first(raw.roundId, raw.round_id, raw.round) ?? ""),
      startAt: first(raw.startAt, raw.start, null),
      endAt: first(raw.endAt, raw.end, null),
      yesBid: finite(first(raw.yesBid, raw.yes_bid, raw.up_bid)),
      yesAsk: finite(first(raw.yesAsk, raw.yes_ask, raw.up_ask)),
      noBid: finite(first(raw.noBid, raw.no_bid, raw.down_bid)),
      noAsk: finite(first(raw.noAsk, raw.no_ask, raw.down_ask)),
      volume: finite(first(raw.volume, raw.volumeUsd, raw.volume_usd), 0),
      liquidity: finite(first(raw.liquidity, raw.liquidityUsd, raw.liquidity_usd), 0),
      spread: finite(raw.spread),
      close: first(raw.close, raw.closeAt, raw.endAt, "--"),
      remaining: first(raw.remaining, raw.remainingText, "--"),
      quoteAt: first(raw.quoteAt, raw.quote_at, null),
      sequence: finite(raw.sequence, 0),
      sourceAt: first(raw.sourceAt, raw.source_at, null),
      expiresAt: first(raw.expiresAt, raw.expires_at, null),
      enabled: raw.enabled === true,
      current: raw.current === true || raw.running === true,
      nextRound: raw.nextRound === true || raw.next_round === true
    };
  };
  const catalog = (payload = {}) => {
    const list = Array.isArray(payload) ? payload : first(payload.items, payload.markets, payload.current_markets, []);
    return {
      items: list.map((item, index) => market(item, index)),
      source: String(first(payload.source, payload.node_label, "backend")),
      asOf: first(payload.asOf, payload.as_of, Date.now()),
      stale: payload.stale === true || payload.collector_online === false,
      error: payload.error || null
    };
  };
  const pool = (payload = {}, catalogItems = []) => {
    const known = new Set(catalogItems.map((item) => item.assetId));
    const desired = first(payload.desiredIds, payload.enabledIds, payload.enabled_ids, []);
    const current = first(payload.currentIds, payload.runningIds, payload.current_ids, []);
    const next = first(payload.nextRoundIds, payload.next_round_ids, []);
    const clean = (values) => Array.isArray(values) ? [...new Set(values.map(String).filter((id) => !known.size || known.has(id)))] : [];
    return { desiredIds: clean(desired), currentIds: clean(current), nextRoundIds: clean(next), effectiveRoundId: first(payload.effectiveRoundId, payload.effective_round_id, null), source: String(first(payload.source, "backend")), updatedAt: first(payload.updatedAt, payload.updated_at, Date.now()) };
  };
  const runtime = (payload = {}) => ({
    status: String(first(payload.status, payload.state, payload.running === true ? "running" : "stopped")),
    source: String(first(payload.source, "backend")),
    stale: payload.stale === true,
    asOf: first(payload.asOf, payload.as_of, Date.now()),
    runId: first(payload.runId, payload.run_id, null),
    strategyId: first(payload.strategyId, payload.strategy_id, null),
    markets: Array.isArray(payload.markets) ? payload.markets : [],
    error: payload.error || null
  });
  window.PolyPreviewViewModel = Object.freeze({ market, catalog, pool, runtime });
})();
