"use strict";
// 实盘: run control, today's figures, the signal sources and the current round.
(() => {
  const P = window.PolyPreview;
  const { html, fmt, num, VENUES, LINES, DIRECTIONS, ORDER_STATUS } = P;
  const ALL_VENUES = ["bybit", "binance", "okx"];
  const HEALTHY_MS = 10000;

  // --- run state and commands ---
  const STATES = {
    running: { text: "运行中", tone: "ok" }, paused: { text: "已暂停", tone: "warn" },
    stopped: { text: "已停止", tone: "" }, failed: { text: "已停止（异常退出）", tone: "bad" },
    starting: { text: "启动中", tone: "warn" }, stopping: { text: "停止中", tone: "warn" },
    unknown: { text: "状态未知", tone: "" },
  };
  const runState = (status, pendingStop = false) => {
    if (!status) return "unknown";
    if (status.processRunning === true) {
      if (pendingStop) return "stopping";
      return status.status === "paused" ? "paused" : status.status === "running" ? "running" : "starting";
    }
    return status.status === "failed" ? "failed" : "stopped";
  };
  // Which buttons a state allows.
  const allowed = (state) => ({
    start: state === "stopped" || state === "failed",
    pause: state === "running",
    resume: state === "paused",
    stop: state === "running" || state === "paused" || state === "starting",
  });
  const uuid = () => {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const commandPayload = (action, revision) => ({ action, requestId: uuid(), revision });
  const confirmText = (action, revision, config) => action === "start"
    ? `确认启动实盘交易？\n\n这是真钱。引擎会按已发布的参数 r${revision} 自动下单：每场最多一笔，每笔 ${config?.shares ?? "?"} 股。中途启动会等下一场开始。`
    : action === "stop" ? "确认停止实盘交易？\n\n这是真钱账户。停止后不再下新单；已经买到的持仓不会卖出，等市场结算。" : null;
  // Sends one command. start and stop need the operator's confirmation;
  // returns null when nothing was sent.
  const command = async (action, revision, config, ask = (text) => window.confirm(text)) => {
    if (!["start", "pause", "resume", "stop"].includes(action)) throw new Error("未知操作");
    if (action === "start" && !(Number.isInteger(revision) && revision > 0)) throw new Error("还没有发布策略参数，请先到设置页保存");
    const question = confirmText(action, revision, config);
    if (question && !ask(question)) return null;
    return P.api.runtimeCommand(commandPayload(action, revision));
  };

  // --- signal sources ---
  const lineStats = (counters) => {
    if (!counters) return null;
    const mean = num(counters.leadMeanMs) ?? (counters.leadCount > 0 ? counters.leadSumMs / counters.leadCount : null);
    return { ...counters, leadMeanMs: mean };
  };
  const renderSources = (status, nowMs) => {
    const lines = status?.leadLines;
    const running = status?.processRunning === true;
    if (!running && !lines) return html`<p class="empty">引擎没在运行，没有信号源数据</p>`;
    const venues = Array.isArray(status?.leadVenues) ? status.leadVenues : ALL_VENUES;
    const relayOn = status?.leadRelay !== false;
    const cards = ALL_VENUES.map((venue) => {
      if (!venues.includes(venue)) return html`<div class="source"><h3>${VENUES[venue]}</h3><p class="muted">本次运行没有启用</p></div>`;
      const byLine = lines?.venues?.[venue] || {};
      const direct = lineStats(byLine.direct);
      const tokyo = lineStats(byLine.tokyo);
      const row = (line, counters, enabled) => {
        if (!enabled) return html`<div class="line"><span class="dot"></span><b>${LINES[line]}</b><small>未开启</small></div>`;
        const age = counters && counters.lastAt > 0 ? nowMs - counters.lastAt : null;
        // A stopped engine leaves its last counters: grey, no age, not "bad".
        const tone = !running ? "" : age === null ? "bad" : age < HEALTHY_MS ? "ok" : "bad";
        const when = !running ? "已停" : age === null ? "没有成交" : `${fmt.seconds(Math.max(0, age) / 1000)}前`;
        return html`<div class="line"><span class="dot ${tone}"></span><b>${LINES[line]}</b><span>${when}</span><small>先到 ${fmt.int(counters?.delivered ?? null)} 笔</small></div>`;
      };
      const total = (direct?.delivered || 0) + (tokyo?.delivered || 0);
      const lead = relayOn && total > 0
        ? html`<p>东京先到 ${fmt.pct((tokyo?.delivered || 0) / total)} · 平均早 ${fmt.ms(tokyo?.leadMeanMs)}</p>` : "";
      return html`<div class="source"><h3>${VENUES[venue]}</h3>${row("direct", direct, true)}${row("tokyo", tokyo, relayOn)}${lead}</div>`;
    });
    const relay = lines?.relay;
    const relayLine = !relayOn ? "东京转发：本次运行没有开启"
      : !relay ? "东京转发监听：没有数据"
      : relay.error ? `东京转发监听出错：${relay.error}`
      : `东京转发监听：${relay.listening ? "正在监听" : "没有监听"}${relay.port ? ` 端口 ${relay.port}` : ""} · 收到 ${fmt.int(relay.messages)} 条 · 接受 ${fmt.int(relay.accepted)} 条`
        + ((relay.badMac || relay.badFormat || relay.badSource) ? ` · 被拒 ${fmt.int((relay.badMac || 0) + (relay.badFormat || 0) + (relay.badSource || 0))} 条` : "");
    if (!running) {
      return html`<p class="note">引擎已停，下面是上次运行的统计（转发收到 ${fmt.int(relay?.messages ?? null)} 条）。</p><div class="sources">${cards}</div>`;
    }
    const relayTone = relayOn && (!relay || relay.error || !relay.listening) ? "bad" : "";
    return html`<div class="sources">${cards}</div><p class="note ${relayTone}">${relayLine}。圆点绿色 = 10 秒内收到过成交。</p>`;
  };

  // --- current round ---
  const ROUND_STATUS = { waiting_start: "等待开盘", waiting_next_round: "中途启动，本场不交易，等下一场", running: "进行中", ended: "已结束" };
  const signalResult = (signal) => signal.outcome === "order_submitted"
    ? html`<span class="tag up">已下单</span> 限价 ${fmt.price(signal.limit_price)}`
    : signal.outcome === "no_round" ? html`<span class="tag">不在场次内</span>`
    : signal.outcome === "stopping" ? html`<span class="tag warn">停机中</span>`
    : html`<span class="tag warn">跳过</span> ${P.label(signal.reason)}`;
  const renderSignals = (signals, roundId) => {
    const mine = (Array.isArray(signals) ? signals : []).filter((s) => roundId && String(s.round_id) === String(roundId))
      .sort((a, b) => (b.received_at || 0) - (a.received_at || 0));
    if (!mine.length) return html`<p class="empty">本场还没有信号</p>`;
    return html`<div class="table-wrap"><table class="t"><thead><tr><th>时间</th><th class="l">交易所</th><th class="l">线路</th><th class="l">方向</th><th>涨跌</th><th class="l">结果</th></tr></thead><tbody>${mine.map((s) => html`<tr><td class="num">${fmt.time(s.received_at)}</td><td class="l">${VENUES[s.venue] || s.venue || "--"}</td><td class="l">${LINES[s.line] || s.line || "--"}</td><td class="l ${s.direction === "UP" ? "up" : "down"}">${DIRECTIONS[s.direction] || s.direction || "--"}</td><td class="num">${fmt.bp(s.move_bp)}</td><td class="wrap">${signalResult(s)}</td></tr>`)}</tbody></table></div>`;
  };
  const sideTop = (name, side) => html`<div class="book-side"><h3 class="${name === "UP" ? "up" : "down"}">${DIRECTIONS[name]}</h3>
    <div class="quote"><span>买价</span><b class="num">${fmt.price(side?.bid)}</b><small class="muted">${fmt.shares(side?.bidSize)} 股</small></div>
    <div class="quote"><span>卖价</span><b class="num">${fmt.price(side?.ask)}</b><small class="muted">${fmt.shares(side?.askSize)} 股</small></div></div>`;
  const levels = (name, side) => {
    const asks = (side?.asks || []).slice(0, 5);
    const bids = (side?.bids || []).slice(0, 5);
    const rows = Array.from({ length: Math.max(asks.length, bids.length) }, (_, i) => html`<tr><td class="num">${bids[i] ? fmt.price(bids[i][0]) : ""}</td><td class="num">${bids[i] ? fmt.shares(bids[i][1]) : ""}</td><td class="num">${asks[i] ? fmt.price(asks[i][0]) : ""}</td><td class="num">${asks[i] ? fmt.shares(asks[i][1]) : ""}</td></tr>`);
    return html`<div><h3 class="${name === "UP" ? "up" : "down"}">${DIRECTIONS[name]}</h3><table class="t"><thead><tr><th>买价</th><th>量</th><th>卖价</th><th>量</th></tr></thead><tbody>${rows.length ? rows : html`<tr><td colspan="4" class="empty">没有深度</td></tr>`}</tbody></table></div>`;
  };
  const renderBook = (book) => {
    if (!book || book.running === false) return { top: html`<p class="empty">引擎没在运行，没有盘口</p>`, depth: "", meta: "" };
    if (!book.available) return { top: html`<p class="empty">${P.label(book.error) || "盘口暂不可用"}</p>`, depth: "", meta: "" };
    const age = num(book.ageMs);
    const meta = `${age === null ? "" : `${fmt.seconds(age / 1000)}前的盘口`}（引擎每 2 秒写一次，页面每秒刷新，最多比交易所晚约 3 秒）${book.stale ? " · 已过期" : ""}${book.twoSided ? "" : " · 一边没有卖价"}`;
    return { top: html`<div class="book">${sideTop("UP", book.up)}${sideTop("DOWN", book.down)}</div>`,
      depth: html`<div class="book">${levels("UP", book.up)}${levels("DOWN", book.down)}</div>`, meta };
  };
  const renderOpenLine = (order) => {
    if (!order || num(order.open_value) === null) return html`<p class="muted">开盘线：本场下单后才有记录</p>`;
    return html`<p class="muted">开盘线（${order.open_line === "mean60" ? "开盘前 60 秒均价" : "开盘那一笔"}）${fmt.btc(order.open_value)} · 信号时离开盘线 ${fmt.bp(order.band_bp)}</p>`;
  };
  const renderPosition = (position, orders) => {
    const attempt = position?.attempt;
    if (!attempt) return html`<p class="empty">${P.label(position?.reason) || "本场还没有下单"}</p>`;
    const list = Array.isArray(orders?.orders) ? orders.orders : [];
    const pnl = position.outcomePnl || {};
    return html`<dl class="kv">
      <dt>下单</dt><dd><b class="${attempt.direction === "UP" ? "up" : "down"}">${DIRECTIONS[attempt.direction] || attempt.direction}</b> ${fmt.shares(attempt.shares)} 股 · 限价 ${fmt.price(attempt.price)} · 信号时卖价 ${fmt.price(attempt.askAtSignal)}</dd>
      <dt>信号</dt><dd>${VENUES[attempt.venue] || attempt.venue || "--"} · ${LINES[attempt.line] || attempt.line || "--"} · ${fmt.bp(attempt.moveBp)} · ${fmt.time(attempt.signalAt)}</dd>
      <dt>结果</dt><dd>${ORDER_STATUS[attempt.status] || attempt.status || "--"} · 买到 ${fmt.shares(attempt.filledShares)} / ${fmt.shares(attempt.shares)} 股${attempt.error ? ` · ${attempt.error}` : ""}</dd>
      <dt>持仓</dt><dd>UP ${fmt.shares(position.yesShares)} 股 · DOWN ${fmt.shares(position.noShares)} 股 · 均价 ${fmt.price(position.averagePrice)} · 成本 ${fmt.usd(position.occupiedUsd)}</dd>
      <dt>结算后</dt><dd>如果涨 <span class="${fmt.tone(pnl.yes)}">${fmt.money(pnl.yes)}</span> · 如果跌 <span class="${fmt.tone(pnl.no)}">${fmt.money(pnl.no)}</span></dd>
      ${list.map((o) => html`<dt>订单</dt><dd>${ORDER_STATUS[o.status] || o.status || "--"} · 买到 ${fmt.shares(o.filledShares ?? o.filled_shares)} 股 · 均价 ${fmt.price(o.averagePrice ?? o.average_price)} · 手续费 ${fmt.usd(o.fee)}</dd>`)}
    </dl>`;
  };
  const strategyNote = (c) => {
    if (!c) return "策略参数还没读到。";
    const venues = (c.leadVenues || ALL_VENUES).map((v) => VENUES[v] || v).join("/");
    const band = c.openBandBp > 0 ? `价格离${c.openLine === "mean60" ? "开盘前 60 秒均价" : "开盘那一笔"} ±${c.openBandBp} bp 以内、` : "";
    return `策略：${venues} 任一家 ${c.windowMs} ms 内涨跌 ≥ ${c.thresholdBp} bp（${c.tokyoRelay ? "爱尔兰直连或东京转发，谁先到用谁" : "只用爱尔兰直连"}），在开盘后第 ${c.fromSec}–${c.toSec} 秒、${band}信号那边卖价 ≤ ${fmt.price(c.maxAsk)} 时，按卖价 + ${fmt.price(c.limitPremium)} 限价${c.entryOrder === "gtc" ? "单" : " FAK"} 买 ${c.edgeSizing ? `按优势 5/${c.shares}/15` : c.shares} 股；一场最多一笔${c.regimePause ? "，行情太乱就暂停" : ""}；${c.exitOnReverse ? "买到后第一个反向信号就卖出，否则持有到结算" : "持有到结算"}。`;
  };
  // 本次第几场: rounds that started at or after the run started (countsTowardRoundLimit).
  const roundNumber = (startedAt, roundStart) => {
    if (!(startedAt > 0) || !(roundStart > 0) || roundStart < startedAt) return null;
    return Math.floor((roundStart - Math.ceil(startedAt / 300) * 300) / 300) + 1;
  };
  const availableUsd = (snapshot) => {
    const occupancy = snapshot?.occupancy;
    if (occupancy?.available === true && num(occupancy.balance_after_open_buy_notional) !== null) return occupancy.balance_after_open_buy_notional;
    return snapshot?.collateral?.available === true ? num(snapshot.collateral.value) : null;
  };

  // --- 完整链路: the newest lead_order from exchange trade to venue reply ---
  // All *_ms are epoch ms (cli/platform.ts leadOrderFields); trade_time_ms is
  // the exchange's clock, the others ours, so offsets include the clock skew.
  const signedMs = (value) => { const v = num(value); return v === null ? "--" : `${v < 0 ? "-" : "+"}${Math.abs(Math.round(v))} ms`; };
  const since = (later, earlier) => num(later) === null || num(earlier) === null ? null : later - earlier;
  const filledOf = (o) => num(o?.filled_shares) > 0;
  const missedOf = (o) => num(o?.filled_shares) === 0;
  const chainRows = (o) => {
    const at = (ms) => since(ms, o.trade_time_ms);
    const rows = [{ name: `交易所成交（${VENUES[o.venue] || o.venue || "--"}）`, offset: num(o.trade_time_ms) === null ? null : 0 }];
    if (o.line === "tokyo") rows.push({ name: "东京收到并转发", offset: at(o.relay_recv_ms) });
    rows.push({ name: `爱尔兰收到信号（${LINES[o.line] || o.line || "--"}）`, offset: at(o.signal_recv_ms) },
      { name: "引擎决策", offset: at(o.decision_ms) },
      { name: "订单发出", offset: at(o.post_sent_ms) },
      { name: "便宜卖单消失（卖价超过限价）", offset: at(o.ask_gone_ms), missing: "回复前一直在" },
      { name: `交易所回复：${filledOf(o) ? `买到 ${fmt.shares(o.filled_shares)}/${fmt.shares(o.shares)} 股` : missedOf(o) ? "没买到" : "--"}`, offset: at(o.ack_ms) });
    // 本段用时: from the nearest earlier row that has a time (a missing row
    // would otherwise blank the next segment too).
    let previous = null;
    return rows.map((row) => {
      const segment = row.offset === null || previous === null ? null : row.offset - previous;
      if (row.offset !== null) previous = row.offset;
      return { ...row, segment };
    });
  };
  const chainVerdict = (o) => {
    const gone = since(o.ask_gone_ms, o.trade_time_ms);
    const ack = since(o.ack_ms, o.trade_time_ms);
    if (filledOf(o)) return { tone: "up", text: `买到了${num(o.ask_gone_ms) === null ? "，卖单在回复前没消失" : ""}` };
    if (missedOf(o) && gone !== null && ack !== null) {
      const late = ack - gone;
      return { tone: "bad", text: late >= 0
        ? `卖单在第 ${Math.round(gone)} ms 消失，我们第 ${Math.round(ack)} ms 才到，晚了 ${Math.round(late)} ms`
        : `卖单在第 ${Math.round(gone)} ms 消失，我们第 ${Math.round(ack)} ms 就到了，比它早 ${Math.round(-late)} ms，还是没买到` };
    }
    return { tone: "", text: "数据不全" };
  };
  const median = (values) => {
    const list = values.filter((v) => num(v) !== null).sort((a, b) => a - b);
    if (!list.length) return { n: 0, median: null };
    const mid = Math.floor(list.length / 2);
    return { n: list.length, median: list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2 };
  };
  const chainMedians = (items) => {
    const missed = items.filter(missedOf);
    const pick = (list, key) => median(list.map((o) => o[key]));
    return [
      ["成交→爱尔兰收到（爱尔兰直连）", pick(items.filter((o) => o.line === "direct"), "t_signal_ms")],
      ["成交→爱尔兰收到（东京转发）", pick(items.filter((o) => o.line === "tokyo"), "t_signal_ms")],
      ["收到→决策", pick(items, "t_decide_ms")],
      ["决策→发出", pick(items, "t_post_ms")],
      ["发出→交易所回复", pick(items, "t_ack_ms")],
      ["总计（成交→交易所回复）", pick(items, "t_total_ms")],
      ["成交→卖单消失（没买到的）", pick(missed, "ask_gone_after_trade_ms")],
      ["晚了多少（没买到的）", pick(missed, "late_by_ms")],
    ];
  };
  const renderChain = (items) => {
    const list = Array.isArray(items) ? items : [];
    const o = list[0];
    const stats = chainMedians(list);
    const medians = html`<h3>最近 ${list.length} 单中位数</h3><div class="table-wrap"><table class="t"><thead><tr><th class="l">环节</th><th>单数</th><th>中位数</th></tr></thead><tbody>${stats.map(([name, s]) => html`<tr><td class="l">${name}</td><td class="num">${s.n}</td><td class="num">${fmt.ms(s.median)}</td></tr>`)}</tbody></table></div>`;
    if (!o) return html`<div class="chain"><div><h3>最近一单完整链路</h3><p class="empty">本次运行还没有下单</p></div><div>${medians}</div></div>`;
    const verdict = chainVerdict(o);
    const rows = chainRows(o).map((row) => html`<tr><td class="l">${row.name}</td><td class="num">${row.offset === null && row.missing ? row.missing : signedMs(row.offset)}</td><td class="num">${fmt.ms(row.segment)}</td></tr>`);
    return html`<div class="chain"><div>
      <h3>最近一单完整链路</h3>
      <p class="muted" data-chain-head>${fmt.dateTime(o.trade_time_ms)} 北京时间 · <span class="${o.direction === "UP" ? "up" : "down"}">${DIRECTIONS[o.direction] || o.direction || "--"}</span> · 信号时卖价 ${fmt.price(o.ask_at_signal)} → 限价 ${fmt.price(o.limit_price)}</p>
      <div class="table-wrap"><table class="t"><thead><tr><th class="l">环节</th><th>距交易所成交</th><th>本段用时</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="chain-verdict ${verdict.tone}" data-chain-verdict>${verdict.text}</p>
      ${o.error ? html`<p class="error-line">交易所回复：${o.error}</p>` : ""}
      <p class="note">成交时间是交易所的时钟，其余是爱尔兰本机时钟，差值含两边的时钟偏差。</p>
    </div><div>${medians}</div></div>`;
  };

  window.PolyLive = Object.freeze({ runState, allowed, commandPayload, command, confirmText, renderSources, renderSignals,
    renderBook, renderPosition, renderOpenLine, strategyNote, roundNumber, availableUsd, renderChain, chainMedians, STATES });

  // --- page ---
  const root = P.mount("live", "实盘", "引擎现在在做什么：信号源、当前场盘口、本场的信号和下单。", html`
    <section class="panel">
      <div class="panel-head"><div class="actions">
        <button class="btn primary" type="button" data-cmd="start">启动</button>
        <button class="btn" type="button" data-cmd="pause">暂停</button>
        <button class="btn" type="button" data-cmd="resume">继续</button>
        <button class="btn danger" type="button" data-cmd="stop">停止</button>
      </div><span class="panel-meta" data-run-meta></span></div>
      <p class="feedback" data-feedback role="status" aria-live="polite"></p>
    </section>
    <div class="cards" data-cards></div>
    <section class="panel"><div class="panel-head"><h2>信号源</h2><span class="panel-meta">每家交易所两条线路：爱尔兰直连、东京转发</span></div><div data-sources></div></section>
    <section class="panel">
      <div class="panel-head"><h2 data-round-title>当前场</h2><span class="panel-meta" data-round-meta></span></div>
      <div data-round-reason></div>
      <div data-book-top></div>
      <p class="muted" data-book-meta></p>
      <details><summary>五档深度</summary><div data-book-depth></div></details>
      <div data-open-line></div>
      <div class="grid2">
        <div class="panel"><div class="panel-head"><h2>本场信号</h2><span class="panel-meta">最新在前</span></div><div data-signals></div></div>
        <div class="panel"><div class="panel-head"><h2>本场下单与持仓</h2></div><div data-position></div></div>
      </div>
    </section>
    <section class="panel"><div class="panel-head"><h2>完整链路</h2><span class="panel-meta">从交易所成交到交易所回复，每一段花了多久</span></div><div data-chain></div></section>
    <p class="note" data-strategy-note></p>`);
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  const state = { status: null, book: null, config: null, account: null, today: null, run: null, position: null, orders: null, leadOrders: null, pendingStop: false, busy: false };
  const feedback = (text, bad = false) => { const node = $("[data-feedback]"); node.textContent = text; node.classList.toggle("bad", bad); };

  const renderHeader = () => {
    const s = state.status;
    const key = runState(s, state.pendingStop);
    const view = STATES[key];
    const config = state.config;
    const round = s?.currentRound;
    const number = roundNumber(num(s?.startedAt), num(round?.startsAt));
    const max = config?.config?.maxRounds;
    const published = config?.savedRevision;
    const running = s?.configRevision;
    P.put($("[data-header-side]"), html`<span class="pill big"><span class="dot ${view.tone}"></span>${view.text}</span>
      <span class="panel-meta">${s?.processRunning ? `本次第 ${number ?? "--"} 场 / ${max > 0 ? `共 ${max} 场` : "不限场数"}` : (max > 0 ? `每次运行 ${max} 场` : "每次运行不限场数")}</span>
      <span class="panel-meta">参数版本 ${s?.processRunning && running ? `运行 r${running}` : ""}${published ? ` 已发布 r${published}` : " 未发布"}${s?.processRunning && running && published && running !== published ? "（下一场生效）" : ""}</span>`);
    const can = allowed(key);
    for (const button of root.querySelectorAll("[data-cmd]")) button.disabled = state.busy || !can[button.dataset.cmd];
    $("[data-run-meta]").textContent = s?.startedAt && s.processRunning ? `启动于 ${fmt.dateTime(s.startedAt)}` : (s?.stopResult?.message || "");
  };
  const renderCards = () => {
    const risk = state.status?.risk;
    const loss = state.config?.config?.dailyLossUsd;
    const dayPnl = state.status?.processRunning ? num(risk?.dailyPnlUsd) : null;
    // The engine stops new orders once the day's equity change reaches -loss (core.ts).
    const left = num(loss) === null || dayPnl === null ? null : Math.max(0, loss + dayPnl);
    const today = state.today?.funnel;
    const run = state.run?.funnel;
    const snapshot = state.account;
    P.put($("[data-cards]"), html`
      <div class="card"><span>今日盈亏（北京时间）</span><strong class="${fmt.tone(today?.pnl_usd)}">${fmt.money(today?.pnl_usd)}</strong><small>已结算 ${fmt.int(today?.settled)} 单 · 赢 ${fmt.int(today?.won)}</small></div>
      <div class="card"><span>离每日止损还剩</span><strong>${num(loss) === null ? "未设置" : left === null ? "--" : fmt.usd(left)}</strong><small>${num(loss) === null ? "设置页可设每日亏损上限" : `上限 ${fmt.usd(loss)}${dayPnl === null ? " · 引擎运行时才有当日权益变化" : ` · 引擎当日 ${fmt.money(dayPnl)}`}`}</small></div>
      <div class="card"><span>可用余额</span><strong>${fmt.usd(availableUsd(snapshot))}</strong><small>${snapshot?.stale ? "账户数据过期" : `账户读取 ${fmt.time(snapshot?.asOf)}`}</small></div>
      <div class="card"><span>本次运行 买到 / 下单</span><strong>${fmt.int(run?.filled)} / ${fmt.int(run?.orders)}</strong><small>买到率 ${fmt.pct(run?.fill_rate)} · 盈亏 ${fmt.money(run?.pnl_usd)}</small></div>`);
  };
  const renderRound = () => {
    const s = state.status;
    const round = s?.currentRound;
    const now = Date.now();
    $("[data-round-title]").textContent = round ? `当前场 ${fmt.hm(round.startsAt)}–${fmt.hm(round.endsAt)}` : "当前场";
    $("[data-round-meta]").textContent = round ? `还剩 ${fmt.countdown(round.endsAt - now / 1000)} · 开盘后第 ${Math.max(0, Math.floor(now / 1000 - round.startsAt))} 秒` : "";
    P.put($("[data-round-reason]"), round
      ? html`<p class="muted">${ROUND_STATUS[round.status] || round.status || ""}${round.reason ? ` · ${P.label(round.reason)}` : ""}</p>`
      : html`<p class="empty">${s?.processRunning ? "引擎在等场次" : "引擎没在运行"}</p>`);
    const book = renderBook(state.book);
    P.put($("[data-book-top]"), book.top);
    P.put($("[data-book-depth]"), book.depth || html`<p class="empty">没有深度</p>`);
    $("[data-book-meta]").textContent = book.meta;
    const order = (state.leadOrders?.items || []).find((item) => round && String(item.round_id) === String(round.roundId));
    P.put($("[data-open-line]"), renderOpenLine(order));
    P.put($("[data-signals]"), renderSignals(s?.leadSignals, round?.roundId));
    P.put($("[data-position]"), round ? renderPosition(state.position, state.orders) : html`<p class="empty">没有当前场</p>`);
  };
  const render = () => {
    renderHeader();
    renderCards();
    P.put($("[data-sources]"), renderSources(state.status, Date.now()));
    renderRound();
    P.put($("[data-chain]"), renderChain(state.leadOrders?.items));
    $("[data-strategy-note]").textContent = strategyNote(state.status?.currentRound?.config || state.config?.config);
  };
  const load = (key, fn) => async () => {
    try { state[key] = await fn(); } catch (error) { if (key === "status") feedback(`读取运行状态失败：${error.message}`, true); }
  };
  P.every(1000, async () => {
    await Promise.all([load("status", P.api.runtimeStatus)(), load("book", P.api.runtimeBook)()]);
    if (state.status?.processRunning !== true) state.pendingStop = false;
    const round = state.status?.currentRound;
    if (round?.roundId) {
      await Promise.all([load("position", () => P.api.position(round.roundId, round.marketId))(),
        load("orders", () => P.api.roundOrders(round.roundId, round.marketId))()]);
    }
    render();
  });
  P.every(3000, async () => { await load("leadOrders", () => P.api.ordersLead({ range: "run", limit: 20 }))(); render(); });
  P.every(10000, async () => {
    await Promise.all([load("config", P.api.strategyConfig)(), load("account", P.api.accountSnapshot)(),
      load("today", () => P.api.statsLead("today"))(), load("run", () => P.api.statsLead("run"))()]);
    render();
  });
  for (const button of root.querySelectorAll("[data-cmd]")) {
    button.addEventListener("click", async () => {
      const action = button.dataset.cmd;
      state.busy = true;
      renderHeader();
      try {
        const result = await command(action, state.config?.savedRevision, state.config?.config);
        if (result) {
          if (action === "stop") state.pendingStop = true;
          feedback({ start: "已发送启动，等引擎确认（中途启动会等下一场）", pause: "已发送暂停，等引擎确认", resume: "已发送继续，等引擎确认", stop: "已发送停止，等引擎退出" }[action]);
        }
      } catch (error) {
        feedback(`${button.textContent}失败：${error.message}`, true);
      } finally {
        state.busy = false;
        renderHeader();
      }
    });
  }
})();
