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
    processRunningFresh: payload.processRunningFresh === false || payload.process_running_fresh === false
      ? false : typeof processRunningValue === "boolean",
    commandStatus: first(payload.commandStatus, payload.command_status, null),
    remoteOrdersState: first(payload.remoteOrdersState, payload.remote_orders_state, null),
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
  const runtimeStartBlockReason = (payload = {}) => {
    const model = runtime(payload);
    if (model.processRunningFresh !== true) return "服务器进程状态未知，暂不允许启动";
    if (model.processRunning === true) return "服务器已确认进程正在运行，请先停止或等待状态确认";
    if (model.processRunning !== false) return "服务器进程状态未知，暂不允许启动";
    const state = String(first(payload.runtimeState, payload.runtime_state, model.status));
    if (!model.stale && ["running", "starting", "paused", "stopping"].includes(state)) return "服务器仍有运行状态，请先停止或等待状态确认";
    return "";
  };
  const catalogItemStartReason = (catalog = {}, item = null) => {
    if (!item) return "请先等待服务器返回完整市场身份";
    const status = String(catalog.status || "");
    if (["unavailable", "error"].includes(status) || catalog.error) return "行情目录暂不可用，等待服务器刷新";
    if (status !== "partial" && (status === "stale" || catalog.stale === true)) return "行情目录或行情已过期，暂不允许启动";
    if (item.stale === true) return "行情目录或行情已过期，暂不允许启动";
    return "";
  };
  const matchesIdentity = (value, context) => {
    const raw = payloadOf(value) || {};
    const assetId = first(raw.assetId, raw.asset_id);
    const marketId = first(raw.marketId, raw.market_id);
    const roundId = first(raw.roundId, raw.round_id);
    return Boolean(context?.assetId && context?.marketId && context?.roundId && assetId != null && marketId != null && roundId != null
      && String(assetId) === String(context.assetId) && String(marketId) === String(context.marketId) && String(roundId) === String(context.roundId));
  };
  const hasFreshBbo = (value) => {
    const raw = payloadOf(value) || {};
    const quotes = [
      first(raw.yesBid, raw.yes_bid, raw.up_bid, raw.YES?.bid, raw.YES?.yesBid, raw.yes?.bid),
      first(raw.yesAsk, raw.yes_ask, raw.up_ask, raw.YES?.ask, raw.YES?.yesAsk, raw.yes?.ask),
      first(raw.noBid, raw.no_bid, raw.down_bid, raw.NO?.bid, raw.NO?.noBid, raw.no?.bid),
      first(raw.noAsk, raw.no_ask, raw.down_ask, raw.NO?.ask, raw.NO?.noAsk, raw.no?.ask)
    ];
    const sequence = raw.sequence;
    // Freshness is decided by the server, which owns the authoritative clock and
    // snapshot gate. A browser cannot judge quote age against its own clock: any
    // client/server skew would permanently block trading. Trust the server's
    // `stale` verdict (set on expiry/disconnect per the API contract) plus the
    // presence of a valid identity, sequence, and priced two-sided book. The
    // real freshness gate runs server-side in snapshot-gate before any order.
    return Boolean(first(raw.marketId, raw.market_id) && first(raw.roundId, raw.round_id))
      && sequence !== null && sequence !== undefined && sequence !== "" && typeof sequence !== "boolean"
      && Number.isFinite(Number(sequence)) && Number(sequence) >= 0
      && raw.stale !== true
      && quotes.every((quote) => Number.isFinite(Number(quote)) && Number(quote) >= 0 && Number(quote) <= 1);
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
  // Single source for account balances. Overview and auto-trade previously used
  // different field chains, so the same snapshot could show a number on one page
  // and "--" on the other. `runtime` is the optional runtime slice used as a last
  // resort for the available figure.
  const accountBalance = (resource = {}, runtime = {}) => {
    const data = resource?.data && typeof resource.data === "object" ? resource.data : {};
    const collateralValue = data.collateral?.value;
    const collateralAvailable = data.collateral?.available === true
      ? (collateralValue && typeof collateralValue === "object"
        ? finite(first(collateralValue.availableUsd, collateralValue.available_usd, collateralValue.value, collateralValue.amount))
        : finite(collateralValue))
      : null;
    const lastCheck = data.last_check || data.lastCheck || {};
    const funds = runtime?.funds && typeof runtime.funds === "object" ? runtime.funds : {};
    const totalUsd = finite(first(data.totalUsd, data.total_usd, data.equity)) ?? collateralAvailable;
    const availableUsd = finite(first(data.availableUsd, data.available_usd, data.balance_occupancy?.spendable_balance))
      ?? collateralAvailable
      ?? finite(first(lastCheck.balance, lastCheck.availableUsd, lastCheck.available_usd))
      ?? finite(first(funds.availableUsd, funds.available_usd));
    return { totalUsd, availableUsd, stale: resource?.stale === true || resource?.status === "stale" };
  };
  // Single source for runtime state labels. Four copies had drifted, so the same
  // backend status rendered differently on each page.
  const runtimeStateLabel = (status) => {
    const key = String(status ?? "").toLowerCase();
    return { running: "运行中", starting: "启动中", paused: "已暂停", stopping: "停止中",
      stopped: "已停止", failed: "运行失败", idle: "空闲", unavailable: "运行状态不可用" }[key] || "";
  };
  // Shared account-readiness ladder. Overview and auto-trade previously kept
  // byte-identical copies of this chain, which is how their error dictionaries
  // drifted apart. `resource` is the accountStatus slice ({status, stale, error,
  // data}). Returns "" when the account is cleared to start.
  const accountStartBlockReason = (resource = {}) => {
    const account = resource?.data && typeof resource.data === "object" ? resource.data : {};
    if (resource?.status !== "ready" || resource?.stale === true || resource?.error) {
      return "账户状态已过期，正在自动重检；如持续失败请到设置页检查账户";
    }
    if (account.account_check_ready !== true) {
      return account.last_check_error
        ? `账户检查未通过：${window.PolyPreview.format.accountError(account.last_check_error, "请查看设置页账户检查结果")}`
        : "账户尚未检查通过，请到设置页检查已保存账户";
    }
    if (account.settlement_credentials_ready !== true) return "结算凭据尚未确认，请到设置页重新检查账户";
    if (account.server_live_enabled === false) return "服务器尚未开启实盘交易配置";
    const liveReady = typeof account.live_start_ready === "boolean" ? account.live_start_ready
      : typeof account.liveStartReady === "boolean" ? account.liveStartReady
        : account.execution_credentials_ready === true && account.account_check_ready === true;
    if (liveReady !== true) return "服务器尚未确认账户可启动交易";
    return "";
  };
  /**
   * Single source for the start-gate ladder. Overview and auto-trade each kept a
   * copy in a different order with different wording, so the two pages could
   * disagree about whether trading may start. Callers pass their own
   * `snapshotFresh` fact (overview judges the catalog row, auto-trade its
   * dedicated snapshot poll) plus the store slices; the order and the messages
   * live here. Returns "" when every gate passes.
   */
  const startBlockReason = (input = {}) => {
    const { catalog, pool, strategy, accountStatus, runtime, assetId, snapshotFresh, poolInitializable } = input;
    if (input.initialRead) return "正在读取服务器状态…";
    const runtimeBlock = runtimeStartBlockReason(runtime || {});
    if (runtimeBlock) return runtimeBlock;
    const item = (catalog?.items || []).find((market) => market.assetId === assetId);
    if (!assetId || !item?.marketId || !item.roundId) return "请先等待服务器返回完整市场身份";
    if (item.canEnable !== true) return "服务器尚未确认该市场可加入运行池";
    const catalogReason = catalogItemStartReason(catalog || {}, item);
    if (catalogReason) return catalogReason;
    if (!poolInitializable && (pool?.status !== "ready" || pool?.stale || !(pool?.desiredIds || []).includes(assetId))) {
      return "请先在市场页面确认运行池";
    }
    if (snapshotFresh !== true) return "当前盘口快照未新鲜确认，暂不允许启动";
    if (strategy?.status !== "ready" || strategy?.stale === true || strategy?.error || !(strategy?.revision > 0)) {
      return "请先在策略页面保存并激活有效版本";
    }
    const strategyAssetReason = strategyAssetStartReason(strategy, assetId);
    if (strategyAssetReason) return strategyAssetReason;
    return accountStartBlockReason(accountStatus || {});
  };
  const fillRecords = (payload) => {
    const raw = payloadOf(payload) || {};
    if (Array.isArray(raw)) return raw.filter((item) => item && typeof item === "object");
    const records = first(raw.fills, raw.trades, raw.executions, raw.fill_records);
    return Array.isArray(records) ? records.filter((item) => item && typeof item === "object") : [];
  };
  const fillIdentity = (record, scope = {}) => {
    const tradeId = first(record?.tradeId, record?.trade_id, record?.fillId, record?.fill_id);
    const orderId = first(record?.orderId, record?.order_id);
    const marketId = first(record?.marketId, record?.market_id, scope.marketId, scope.market_id);
    const roundId = first(record?.roundId, record?.round_id, scope.roundId, scope.round_id);
    // A fill without both market and round identity must not be merged with
    // another round, even when its trade/order ID happens to match.
    if ((tradeId == null && orderId == null) || marketId == null || roundId == null) return null;
    return [tradeId ?? "", orderId ?? "", marketId, roundId].map((value) => String(value)).join("\u001f");
  };
  const uniqueFills = (payload, scope = {}) => {
    const records = fillRecords(payload);
    const seen = new Map();
    let unidentified = 0;
    records.forEach((record) => {
      const key = fillIdentity(record, scope);
      if (!key) { unidentified += 1; return; }
      if (!seen.has(key)) seen.set(key, record);
    });
    return { items: [...seen.values()], count: records.length ? seen.size : null, unidentified };
  };
  const uniqueFillCount = (payload, scope = {}) => {
    const raw = payloadOf(payload) || {};
    const explicit = first(raw.uniqueFillCount, raw.unique_fill_count, raw.uniqueTradeCount, raw.unique_trade_count);
    if (explicit != null && Number.isFinite(Number(explicit))) return Number(explicit);
    const deduped = uniqueFills(raw, scope);
    if (deduped.count != null) return deduped.count;
    const serverCount = first(raw.fillCount, raw.fill_count);
    return serverCount != null && Number.isFinite(Number(serverCount)) ? Number(serverCount) : null;
  };
  const settlementStatus = (item = {}) => {
    const state = String(first(item.state, item.status, "unknown")).toLowerCase();
    const accounting = String(first(item.accountingState, item.accounting_state, "")).toLowerCase();
    const settlementRequired = first(item.settlementRequired, item.settlement_required);
    const redemptionRequired = first(item.redemptionRequired, item.redemption_required);
    // Older no-trade rows exposed settlementRequired=false without noTrade.
    const noTrade = item.noTrade === true || item.no_trade === true || accounting === "no_trade" || settlementRequired === false;
    let label;
    if (noTrade) label = state === "confirmed" ? "无成交 · 无需赎回" : "无成交 · 等待结算确认";
    else if (redemptionRequired === false) {
      label = state === "confirmed" ? "有成交 · 结算已确认 · 无需赎回"
        : state === "failed" ? "有成交 · 结算失败 · 无需赎回" : "有成交 · 等待结算确认 · 无需赎回";
    } else {
      label = state === "confirmed" && (item.payoutVerified ?? item.payout_verified) === true ? "结算已确认 · 到账已核实"
        : state === "confirmed" ? "结算已确认 · 到账待核实" : state === "failed" ? "结算失败" : "结算处理中";
    }
    return {
      state,
      noTrade,
      redemptionRequired,
      accounting,
      pnlError: first(item.pnlError, item.pnl_error),
      label
    };
  };
  const isBtcStrategyConfig = (config = {}) => {
    const candidate = config && typeof config === "object" ? config : {};
    return String(strategyAssetId(candidate) || "").toLowerCase() === "btc";
  };
  window.PolyPreviewViewModel = Object.freeze({ market, catalog, pool, runtime, runtimeStartBlockReason, catalogItemStartReason, accountStartBlockReason, startBlockReason, accountBalance, runtimeStateLabel, payloadOf, finite, matchesIdentity, hasFreshBbo, strategyAssetId, strategyAssetStartReason, fillRecords, fillIdentity, uniqueFills, uniqueFillCount, settlementStatus, isBtcStrategyConfig });
})();
