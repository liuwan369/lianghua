"use strict";
(() => {
  const finite = (value, fallback = null) => value != null && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value)) ? Number(value) : fallback;
  const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
  const payloadOf = (value) => value?.data && typeof value.data === "object" ? value.data : value;
  const assetIdFrom = (raw, index = 0) => String(first(raw.assetId, raw.asset_id, raw.asset, raw.symbol, raw.slug, `market-${index}`)).trim();
  const symbolFrom = (raw, assetId) => String(first(raw.symbol, raw.ticker, assetId.split("-")[0])).toUpperCase();
  const explicitlyEligible = (raw, assetId) => {
    const eligibility = raw.eligibility ?? raw.eligible;
    if (raw.supported === false || raw.canEnable === false || raw.can_enable === false) return false;
    if (eligibility === false || ["unsupported", "unavailable", "blocked"].includes(String(eligibility || "").toLowerCase())) return false;
    if (raw.supported === true || raw.canEnable === true || raw.can_enable === true || eligibility === true || ["supported", "eligible", "available"].includes(String(eligibility || "").toLowerCase())) return true;
    return false;
  };
  const orderBookFrom = (raw) => {
    const existing = raw.orderBook || raw.orderbook || raw.book;
    if (existing) return existing;
    const canonicalYes = raw.YES || raw.yes || raw.up;
    const canonicalNo = raw.NO || raw.no || raw.down;
    if (canonicalYes || canonicalNo) {
      const side = (value) => value && {
        bids: first(value.bids, value.bidLevels, value.bid_levels),
        asks: first(value.asks, value.askLevels, value.ask_levels)
      };
      const yes = side(canonicalYes);
      const no = side(canonicalNo);
      if (Array.isArray(yes?.bids) || Array.isArray(yes?.asks) || Array.isArray(no?.bids) || Array.isArray(no?.asks)) return { yes, no };
    }
    const levels = (side, kind) => first(
      raw[`${side}${kind[0].toUpperCase()}${kind.slice(1)}Levels`],
      raw[`${side}_${kind}_levels`],
      raw[`${side}${kind[0].toUpperCase()}${kind.slice(1)}_levels`]
    );
    const yes = { bids: levels("yes", "bid"), asks: levels("yes", "ask") };
    const no = { bids: levels("no", "bid"), asks: levels("no", "ask") };
    const up = { bids: first(raw.upBidLevels, raw.up_bid_levels), asks: first(raw.upAskLevels, raw.up_ask_levels) };
    const down = { bids: first(raw.downBidLevels, raw.down_bid_levels), asks: first(raw.downAskLevels, raw.down_ask_levels) };
    const hasLevels = (side) => Array.isArray(side.bids) || Array.isArray(side.asks);
    if (!hasLevels(yes) && !hasLevels(no) && !hasLevels(up) && !hasLevels(down)) return null;
    return { yes: hasLevels(yes) ? yes : up, no: hasLevels(no) ? no : down };
  };
  const market = (raw = {}, index = 0) => {
    const assetId = assetIdFrom(raw, index);
    const symbol = symbolFrom(raw, assetId);
    const yes = raw.YES || raw.yes || raw.up || {};
    const no = raw.NO || raw.no || raw.down || {};
    return {
      assetId,
      supported: raw.supported !== false,
      canEnable: explicitlyEligible(raw, assetId),
      eligibility: first(raw.eligibility, raw.eligible, raw.supported === false ? "unsupported" : null),
      symbol,
      name: String(first(raw.name, raw.title, symbol)),
      english: String(first(raw.english, raw.name_en, symbol)),
      icon: String(first(raw.icon, symbol.slice(0, 1))),
      tone: String(first(raw.tone, assetId)),
      cycle: String(first(raw.cycle, raw.duration, "5m")),
      marketId: first(raw.marketId, raw.market_id) == null ? null : String(first(raw.marketId, raw.market_id)),
      roundId: first(raw.roundId, raw.round_id) == null ? null : String(first(raw.roundId, raw.round_id)),
      yesToken: first(raw.yesToken, raw.yes_token, raw.YES?.token, raw.YES?.tokenId, raw.YES?.token_id, raw.YES?.assetId, raw.yes?.token, raw.yes?.tokenId, raw.yes?.token_id, raw.yes?.assetId, null),
      noToken: first(raw.noToken, raw.no_token, raw.NO?.token, raw.NO?.tokenId, raw.NO?.token_id, raw.NO?.assetId, raw.no?.token, raw.no?.tokenId, raw.no?.token_id, raw.no?.assetId, null),
      startAt: first(raw.startAt, raw.start, null),
      endAt: first(raw.endAt, raw.end, null),
      yesBid: finite(first(raw.yesBid, raw.yes_bid, raw.up_bid, yes.bid, yes.yesBid)),
      yesAsk: finite(first(raw.yesAsk, raw.yes_ask, raw.up_ask, yes.ask, yes.yesAsk)),
      noBid: finite(first(raw.noBid, raw.no_bid, raw.down_bid, no.bid, no.noBid)),
      noAsk: finite(first(raw.noAsk, raw.no_ask, raw.down_ask, no.ask, no.noAsk)),
      volume: finite(first(raw.volume, raw.volumeUsd, raw.volume_usd)),
      liquidity: finite(first(raw.liquidity, raw.liquidityUsd, raw.liquidity_usd)),
      spread: finite(raw.spread),
      close: first(raw.close, raw.closeAt, raw.endAt, "--"),
      remaining: first(raw.remaining, raw.remainingText, "--"),
      quoteAt: first(raw.quoteAt, raw.quote_at, null),
      sequence: finite(raw.sequence),
      sourceAt: first(raw.sourceAt, raw.source_at, null),
      expiresAt: first(raw.expiresAt, raw.expires_at, null),
      orderBook: orderBookFrom(raw),
      depthAvailable: raw.depthAvailable === true,
      strategyEligible: raw.strategyEligible === true,
      depthUnavailable: raw.depthUnavailable === true || raw.depth_unavailable === true,
      stale: raw.stale === true,
      staleReason: first(raw.staleReason, raw.stale_reason, null),
      enabled: raw.enabled === true,
      current: raw.current === true || raw.running === true,
      nextRound: raw.nextRound === true || raw.next_round === true
    };
  };
  const catalog = (payload = {}) => {
    payload = payloadOf(payload) || {};
    const list = Array.isArray(payload) ? payload : first(payload.items, payload.markets, payload.current_markets, []);
    const items = list.map((item, index) => market(item, index)).filter((item) => item.assetId.length > 0);
    const partial = payload.partial === true || payload.partial_data === true
      || payload.stale === true && items.some((item) => item.stale !== true) && items.some((item) => item.stale === true);
    return {
      items,
      source: String(first(payload.source, payload.node_label, "backend")),
      asOf: first(payload.asOf, payload.as_of, null),
      stale: payload.stale === true || payload.collector_online === false,
      partial,
      error: payload.error || payload.error_code || null
    };
  };
  const pool = (payload = {}, catalogItems = []) => {
    payload = payloadOf(payload) || {};
    const known = new Map(catalogItems.map((item) => [item.assetId, item]));
    const desired = first(payload.desiredIds, payload.enabledIds, payload.enabled_ids, []);
    const current = first(payload.currentIds, payload.runningIds, payload.current_ids, []);
    const next = first(payload.nextRoundIds, payload.next_round_ids, []);
    const clean = (values) => Array.isArray(values) ? [...new Set(values.map((value) => String(value).trim()).filter((id) =>
      id
    ))] : [];
    return { desiredIds: clean(desired), currentIds: clean(current), nextRoundIds: clean(next), effectiveRoundId: first(payload.effectiveRoundId, payload.effective_round_id, null), source: String(first(payload.source, "backend")), updatedAt: first(payload.updatedAt, payload.updated_at, null) };
  };
  const runtime = (payload = {}) => {
    payload = payloadOf(payload) || {};
    const status = String(first(payload.status, payload.state, payload.running === true ? "running" : payload.running === false ? "stopped" : "unavailable"));
    const processRunningValue = first(payload.processRunning, payload.process_running, payload.process?.running);
    return {
    status,
    state: status,
    processRunning: typeof processRunningValue === "boolean" ? processRunningValue : null,
    source: String(first(payload.source, "backend")),
    stale: payload.stale === true,
    asOf: first(payload.asOf, payload.as_of, null),
    runId: first(payload.runId, payload.run_id, null),
    strategyId: first(payload.strategyId, payload.strategy_id, null),
      assetId: first(payload.assetId, payload.asset_id, null),
      marketId: first(payload.marketId, payload.market_id, null),
      roundId: first(payload.roundId, payload.round_id, null),
    markets: Array.isArray(payload.markets) ? payload.markets : [],
    error: payload.error || null
    };
  };
  const matchesIdentity = (value, context) => {
    const raw = payloadOf(value) || {};
    const assetId = first(raw.assetId, raw.asset_id);
    const marketId = first(raw.marketId, raw.market_id);
    const roundId = first(raw.roundId, raw.round_id);
    return Boolean(context?.assetId && context?.marketId && context?.roundId && assetId != null && marketId != null && roundId != null
      && String(assetId) === String(context.assetId) && String(marketId) === String(context.marketId) && String(roundId) === String(context.roundId));
  };
  const timestampMs = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.abs(number) < 1e12 ? number * 1000 : number;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const hasFreshBbo = (value, now = Date.now()) => {
    const raw = payloadOf(value) || {};
    const quotes = [
      first(raw.yesBid, raw.yes_bid, raw.up_bid, raw.YES?.bid, raw.YES?.yesBid, raw.yes?.bid),
      first(raw.yesAsk, raw.yes_ask, raw.up_ask, raw.YES?.ask, raw.YES?.yesAsk, raw.yes?.ask),
      first(raw.noBid, raw.no_bid, raw.down_bid, raw.NO?.bid, raw.NO?.noBid, raw.no?.bid),
      first(raw.noAsk, raw.no_ask, raw.down_ask, raw.NO?.ask, raw.NO?.noAsk, raw.no?.ask)
    ];
    const sourceAt = timestampMs(first(raw.sourceAt, raw.source_at));
    const expiresAt = timestampMs(first(raw.expiresAt, raw.expires_at));
    const sequence = raw.sequence;
    return Boolean(first(raw.marketId, raw.market_id) && first(raw.roundId, raw.round_id))
      && sequence !== null && sequence !== undefined && sequence !== "" && typeof sequence !== "boolean"
      && Number.isFinite(Number(sequence)) && Number(sequence) >= 0
      && raw.stale !== true
      && sourceAt != null && expiresAt != null
      && sourceAt > 0 && sourceAt >= now - 5000 && sourceAt <= now + 5000 && expiresAt > now
      && quotes.every((quote) => Number.isFinite(Number(quote)) && Number(quote) > 0 && Number(quote) < 1);
  };
  const strategyAssetId = (strategy = {}) => {
    const value = strategy && typeof strategy === "object" ? strategy : {};
    return first(value.assetId, value.asset_id, value.data?.assetId, value.data?.asset_id, value.data?.config?.assetId, value.data?.config?.asset_id, value.config?.assetId, value.config?.asset_id);
  };
  const strategyAssetStartReason = (strategy, assetId) => {
    const target = strategyAssetId(strategy);
    if (!target) return "激活策略尚未确认目标币种";
    if (!assetId || String(target) !== String(assetId)) return "激活策略与所选市场不一致，请切换市场或重新激活策略";
    return "";
  };
  const isBtcStrategyConfig = (config = {}) => String(strategyAssetId(config) || "").toLowerCase() === "btc";
  window.PolyPreviewViewModel = Object.freeze({ market, catalog, pool, runtime, matchesIdentity, hasFreshBbo, strategyAssetId, strategyAssetStartReason, isBtcStrategyConfig });
})();
