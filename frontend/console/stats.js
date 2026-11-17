"use strict";
// 统计: GET /api/stats/lead?range= rendered as plain CSS bars and tables.
(() => {
  const P = window.PolyPreview;
  const { html, fmt, num, VENUES, LINES } = P;
  const RANGES = [["run", "本次运行"], ["today", "今天"], ["7d", "7 天"], ["all", "全部"]];
  const LATE_BUCKETS = [["<0", "< 0 ms"], ["0-50", "0–50 ms"], ["50-100", "50–100 ms"], ["100-200", "100–200 ms"], ["200-400", "200–400 ms"], [">400", "> 400 ms"]];
  const STAGES = [["t_signal_ms", "成交→爱尔兰收到"], ["t_decide_ms", "收到→决策"], ["t_post_ms", "决策→发出"], ["t_ack_ms", "发出→交易所回复"]];
  const SKIPS = [["time_window", "不在下单时间窗"], ["band", "离开盘线太远 / 开盘线未知"], ["ask_too_high", "卖价高于上限"], ["book", "盘口不可用"],
    ["budget", "预算或余额不够 / 日亏损上限"], ["paused", "已暂停"], ["mid_round_start", "中途启动，等下一场"], ["already_attempted", "本场已下过单"], ["other", "其他"]];

  const bar = (labelText, value, max, valueText, tone = "") => {
    const width = max > 0 && num(value) !== null ? Math.max(0, Math.min(100, (Math.abs(value) / max) * 100)) : 0;
    return html`<div class="bar-row"><span>${labelText}</span><div class="bar"><i class="${tone}" style="width:${width.toFixed(1)}%"></i></div><span>${valueText}</span></div>`;
  };
  const card = (title, value, small = "", tone = "") => html`<div class="card"><span>${title}</span><strong class="${tone}">${value}</strong><small>${small}</small></div>`;

  const renderFunnel = (f) => {
    if (!f) return html`<p class="empty">没有数据</p>`;
    return html`<div class="funnel">
      ${card("信号", fmt.int(f.signals))}
      ${card("窗口内信号", fmt.int(f.signals_in_window), "落在某一场里")}
      ${card("下单", fmt.int(f.orders))}
      ${card("买到", fmt.int(f.filled), `买到率 ${fmt.pct(f.fill_rate)}`)}
      ${card("已结算", fmt.int(f.settled))}
      ${card("赢", fmt.int(f.won), `胜率 ${fmt.pct(f.win_rate)}`)}
      ${card("盈亏", fmt.money(f.pnl_usd), `手续费 ${fmt.usd(f.fees_usd)}${f.pnl_source === "official" ? " · 官方结算" : f.pnl_source === "mixed" ? " · 部分官方" : f.pnl_source === "ledger" ? " · 账本估算" : ""}`, fmt.tone(f.pnl_usd))}
    </div>`;
  };
  const renderMisses = (m) => {
    if (!m) return html`<p class="empty">没有数据</p>`;
    return html`<div class="cards">
      ${card("没买到", `${fmt.int(m.count)} 单`, `已出结果 ${fmt.int(m.resolved)} 单`)}
      ${card("其中会赢", `${fmt.int(m.would_have_won)} 单`, m.resolved ? `占已出结果 ${fmt.pct(m.would_have_won / m.resolved)}` : "")}
      ${card("如果都买到", fmt.money(m.hypothetical_pnl_if_filled), "按限价成交、扣手续费估算", fmt.tone(m.hypothetical_pnl_if_filled))}
    </div>`;
  };
  // Rest after a miss: the live rest orders, or with the rest off what the
  // shadow says a 5 s rest would have filled (queue ignored, so optimistic).
  const renderRest = (rest, gtc) => {
    if (!rest) return html`<p class="empty">没有数据</p>`;
    const live = rest.live || {}, shadow = rest.shadow || {};
    // entryOrder gtc: one limit order per round, its remainder rests.
    const gtcCards = gtc?.orders ? html`<div class="cards">
      ${card("限价单", `${fmt.int(gtc.orders)} 单`, `买到 ${fmt.int(gtc.filled)} 单 · ${fmt.pct(gtc.fill_rate)}`)}
      ${card("挂上后才成交", `${fmt.int(gtc.rested_fills)} 单`, "剩余部分挂着时被买走（不收手续费）")}
      ${card("股数", `立即 ${fmt.shares(gtc.taker_shares)} · 挂单 ${fmt.shares(gtc.maker_shares)}`, "立即 = 吃单成交，挂单 = 挂着时成交")}
    </div>` : "";
    const liveCards = live.orders ? html`<div class="cards">
      ${card("挂单补单", `${fmt.int(live.orders)} 单`, `买到 ${fmt.int(live.filled)} 单 · ${fmt.pct(live.fill_rate)}`)}
      ${card("已结算", `${fmt.int(live.settled)} 单`, `赢 ${fmt.int(live.won)} · 胜率 ${fmt.pct(live.win_rate)}`)}
      ${card("挂单盈亏", fmt.money(live.pnl_usd), "挂单不收手续费", fmt.tone(live.pnl_usd))}
    </div>` : "";
    const shadowCards = shadow.misses ? html`<div class="cards">
      ${card("模拟：没买到", `${fmt.int(shadow.misses)} 单`, "挂单关着，只记录")}
      ${card("5 秒内会成交", `${fmt.int(shadow.would_fill)} 单`, `占 ${fmt.pct(shadow.would_fill_rate)}`)}
      ${card("其中会赢", `${fmt.int(shadow.won)} / ${fmt.int(shadow.settled)} 单`, `胜率 ${fmt.pct(shadow.win_rate)}`)}
      ${card("模拟盈亏", fmt.money(shadow.pnl_if_filled_usd), "按限价、不排队估算，偏乐观", fmt.tone(shadow.pnl_if_filled_usd))}
    </div>` : "";
    if (!liveCards && !shadowCards && !gtcCards) return html`<p class="empty">还没有没买到的单</p>`;
    return html`${gtcCards}${liveCards}${shadowCards}<p class="note">吃单+补单：吃单没买到后，在同一限价挂只挂单的买单，几秒后撤。限价单：一张单，能成交的立即成交，剩下的挂着，几秒后撤。</p>`;
  };
  // Shadow exit (records only): selling what a round held on its 3rd opposite
  // signal at the bid then, against holding to the close.
  const renderExit = (e) => {
    if (!e) return html`<p class="empty">没有数据</p>`;
    if (!e.held_rounds) return html`<p class="empty">还没有持仓的场</p>`;
    return html`<div class="cards">
      ${card("买到的场", `${fmt.int(e.held_rounds)} 场`, `已出结果 ${fmt.int(e.settled)} 场`)}
      ${card("会卖出", `${fmt.int(e.would_sell)} 场`, `占 ${fmt.pct(e.would_sell_rate)} · 卖价中位 ${fmt.price(e.bid_p50)}`)}
      ${card("误卖（本来会赢）", `${fmt.int(e.mistaken)} 场`, `占卖出 ${fmt.pct(e.mistaken_rate)} · 少赚 ${fmt.money(e.mistaken_cost_usd)}`, "down")}
      ${card("止损（本来会输）", `${fmt.int(e.saved)} 场`, `少亏 ${fmt.money(e.saved_usd)}`, "up")}
      ${card("如果开了", fmt.money(e.net_usd), "比拿到结算多赚（负 = 少赚）", fmt.tone(e.net_usd))}
    </div><p class="note">只记录不卖：买到后第 3 个反向信号时按当时买一价卖掉（扣吃单手续费），和拿到结算比。</p>`;
  };
  // Exit on the first reverse signal (exitOnReverse): shadow while off (a sell
  // at the bid then, against holding to the close), the sells while on.
  const FIRST_SKIPS = { off: "开关关着", paused: "已暂停", halted: "账户停止交易", market_blocked: "本场等交易所确认", buy_working: "买单还在处理",
    no_bid: "没有买一价", no_rules: "交易所规则不可用", below_min_size: "持仓不到最小股数",
    too_late: "等到收盘前 5 秒还没卖", restart: "等卖时引擎重启" };
  const renderExitFirst = (e) => {
    if (!e) return html`<p class="empty">没有数据</p>`;
    if (!e.held_rounds) return html`<p class="empty">还没有持仓的场</p>`;
    const shadow = e.shadow || {}, live = e.live || {};
    const skips = Object.entries(e.skips || {}).filter(([key]) => key !== "off");
    return html`<div class="cards">
      ${card("买到的场", `${fmt.int(e.held_rounds)} 场`, `出现反向信号 ${fmt.int(e.triggered)} 场 · 占 ${fmt.pct(e.trigger_rate)}`)}
      ${live.sells ? html`${card("实盘卖出", `${fmt.int(live.filled)} / ${fmt.int(live.sells)} 单`, `卖到 ${fmt.pct(live.fill_rate)} · 收回 ${fmt.money(live.proceeds_usd)}`)}
        ${card("误卖 / 止损", `${fmt.int(live.mistaken)} / ${fmt.int(live.saved)} 场`, `已出结果 ${fmt.int(live.settled)} 场`)}
        ${card("实盘比拿到结算", fmt.money(live.net_vs_hold_usd), "正 = 多赚 / 少亏", fmt.tone(live.net_vs_hold_usd))}` : ""}
      ${shadow.rounds ? html`${card("模拟：会卖出", `${fmt.int(shadow.rounds)} 场`, `误卖 ${fmt.int(shadow.mistaken)} · 止损 ${fmt.int(shadow.saved)}`)}
        ${card("如果开了", fmt.money(shadow.net_usd), "按买一价卖（扣吃单手续费），比拿到结算", fmt.tone(shadow.net_usd))}` : ""}
    </div>${skips.length ? html`<p class="note">开着但没卖：${skips.map(([key, n], i) => html`${i ? " · " : ""}${FIRST_SKIPS[key] || key} ${fmt.int(n)} 场`)}</p>` : ""}
    <p class="note">买到后第一个反方向信号就按买一价 - 0.08 吃单卖掉持仓，一场只卖一次。开关关着时只记录当时的买一价。</p>`;
  };
  // Size by edge (edgeSizing): the fair value at the signal less the limit
  // and fee. Shadow while off: each order's result scaled to the shares its
  // edge would have picked.
  const TIERS = [["low", "优势 < -0.04（买 5 股）"], ["mid", "中间（原股数）"], ["high", "优势 ≥ 0.07（买 15 股）"]];
  const renderEdge = (e) => {
    if (!e) return html`<p class="empty">没有数据</p>`;
    if (!e.judged) return html`<p class="empty">还没有带优势记录的单（新版本部署后开始记录）</p>`;
    const shadow = e.shadow || {}, live = e.live || {}, tiers = e.tiers || {};
    const diff = num(shadow.sized_pnl_usd) === null || num(shadow.actual_pnl_usd) === null ? null : shadow.sized_pnl_usd - shadow.actual_pnl_usd;
    return html`<div class="table-wrap"><table class="t"><thead><tr><th class="l">优势档</th><th>已出结果</th><th>胜率</th><th>盈亏</th></tr></thead><tbody>
      ${TIERS.map(([key, text]) => html`<tr><td class="l">${text}</td><td class="num">${fmt.int(tiers[key]?.settled ?? 0)}</td><td class="num">${fmt.pct(tiers[key]?.win_rate ?? null)}</td><td class="num ${fmt.tone(tiers[key]?.pnl_usd)}">${fmt.money(tiers[key]?.pnl_usd ?? null)}</td></tr>`)}
      </tbody></table></div>
      <div class="cards" style="margin-top:10px">
      ${shadow.settled ? html`${card("模拟：按优势定股", fmt.money(shadow.sized_pnl_usd), `原股数 ${fmt.money(shadow.actual_pnl_usd)} · ${fmt.int(shadow.settled)} 单`, fmt.tone(shadow.sized_pnl_usd))}
        ${card("如果开了", fmt.money(diff), "比原股数多赚（负 = 少赚）", fmt.tone(diff))}` : ""}
      ${live.settled ? card("实盘按优势定股", fmt.money(live.pnl_usd), `${fmt.int(live.settled)} 单`, fmt.tone(live.pnl_usd)) : ""}
    </div><p class="note">优势 = 信号时的公允价（离开盘线多远、剩多少秒、前 5 分钟波动）- 限价 - 手续费。模拟按同样的成交价把盈亏换算成 5 / 15 股，偏乐观（大单不一定都能买到）。</p>`;
  };
  // Shadow regime pause (records only): orders whose signal came in a wild
  // market (more than 12 signals, or a 1 s std above 0.89 bp, in 5 min).
  const renderRegime = (g) => {
    if (!g) return html`<p class="empty">没有数据</p>`;
    if (!g.judged) return html`<p class="empty">还没有带行情记录的单（新版本部署后开始记录）</p>`;
    return html`<div class="cards">
      ${card("记录的单", `${fmt.int(g.judged)} 单`, `会暂停 ${fmt.int(g.would_pause)} 单 · 占 ${fmt.pct(g.would_pause_rate)}`)}
      ${card("暂停原因", `信号多 ${fmt.int(g.by_signals)} · 波动大 ${fmt.int(g.by_vol)}`, "前 5 分钟信号 > 12 或每秒波动 > 0.89 bp")}
      ${card("会暂停的单", `赢 ${fmt.int(g.paused_won)} / ${fmt.int(g.paused_settled)} 场`, `胜率 ${fmt.pct(g.paused_win_rate)} · 盈亏 ${fmt.money(g.paused_pnl_usd)}`, fmt.tone(g.paused_pnl_usd))}
      ${card("留下的单", `${fmt.int(g.kept_settled)} 场`, `胜率 ${fmt.pct(g.kept_win_rate)} · 盈亏 ${fmt.money(g.kept_pnl_usd)}`, fmt.tone(g.kept_pnl_usd))}
      ${card("如果开了暂停", fmt.money(g.net_if_paused_usd), "正 = 少亏，负 = 少赚", fmt.tone(g.net_if_paused_usd))}
    </div><p class="note">只记录不暂停：每单记下信号前 5 分钟的信号数和波动，太乱的单"如果开了暂停就不下"。</p>`;
  };
  const renderLate = (late) => {
    if (!late) return html`<p class="empty">没有数据</p>`;
    const histogram = late.histogram || {};
    const max = Math.max(0, ...LATE_BUCKETS.map(([key]) => histogram[key] || 0));
    const gone = late.ask_gone_after_trade_ms || {};
    return html`<p class="note">卖单消失之后我们的单才到交易所的时间差（只算没买到的单，负数 = 我们先到但还是没买到）。</p>
      <dl class="kv"><dt>单数</dt><dd>${fmt.int(late.n)}</dd><dt>p10 / 中位 / p90</dt><dd>${fmt.ms(late.p10)} / ${fmt.ms(late.p50)} / ${fmt.ms(late.p90)}</dd></dl>
      <div class="bars" style="margin-top:10px">${LATE_BUCKETS.map(([key, text]) => bar(text, histogram[key] || 0, max, `${fmt.int(histogram[key] || 0)} 单`, "warn"))}</div>
      <p class="note">交易所成交后多久卖单消失：没买到的 中位 ${fmt.ms(gone.missed?.p50)} · 慢的10% ${fmt.ms(gone.missed?.p90)}（${fmt.int(gone.missed?.n)} 单）；买到的 中位 ${fmt.ms(gone.filled?.p50)} · 慢的10% ${fmt.ms(gone.filled?.p90)}（${fmt.int(gone.filled?.n)} 单）</p>`;
  };
  const renderLatency = (latency) => {
    if (!latency) return html`<p class="empty">没有数据</p>`;
    const medians = STAGES.map(([key]) => Math.max(0, num(latency[key]?.p50) ?? 0));
    const sum = medians.reduce((a, b) => a + b, 0);
    const stack = sum > 0 ? html`<div class="stack">${STAGES.map(([key, text], i) => html`<i class="c${i}" title="${text} ${fmt.ms(latency[key]?.p50)}" style="width:${((medians[i] / sum) * 100).toFixed(1)}%"></i>`)}</div>` : html`<p class="empty">还没有下单</p>`;
    const rows = [...STAGES, ["t_total_ms", "总计（成交→交易所回复）"]];
    return html`${stack}<div class="legend">${STAGES.map(([key, text], i) => html`<span><i class="c${i}"></i>${text} ${fmt.ms(latency[key]?.p50)}</span>`)}</div>
      <div class="table-wrap" style="margin-top:10px"><table class="t"><thead><tr><th>阶段</th><th>单数</th><th>中位</th><th>慢的10%</th></tr></thead><tbody>
      ${rows.map(([key, text]) => html`<tr><td>${text}</td><td class="num">${fmt.int(latency[key]?.n)}</td><td class="num">${fmt.ms(latency[key]?.p50)}</td><td class="num">${fmt.ms(latency[key]?.p90)}</td></tr>`)}
      </tbody></table></div><p class="note">成交时间用交易所的钟，其余用我们的钟，所以第一段和总计含两边的时钟误差。</p>`;
  };
  const renderBySource = (bySource) => {
    const rows = bySource?.rows || [];
    const lines = bySource?.lines || [];
    const table = rows.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>交易所</th><th class="l">线路</th><th>下单</th><th>买到</th><th>买到率</th><th>赢</th><th>胜率</th><th>盈亏</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr><td>${VENUES[r.venue] || r.venue || "--"}</td><td class="l">${LINES[r.line] || r.line || "--"}</td><td class="num">${fmt.int(r.orders)}</td><td class="num">${fmt.int(r.filled)}</td><td class="num">${fmt.pct(r.fill_rate)}</td><td class="num">${fmt.int(r.won)}</td><td class="num">${fmt.pct(r.win_rate)}</td><td class="num ${fmt.tone(r.pnl_usd)}">${fmt.money(r.pnl_usd)}</td></tr>`)}
      </tbody></table></div>` : html`<p class="empty">还没有下单</p>`;
    const lead = lines.length ? html`<p class="note">${lines.map((l, i) => html`${i ? " · " : ""}${VENUES[l.venue] || l.venue}：东京先到 ${fmt.pct(l.tokyo_first_share)}，平均早 ${fmt.ms(l.tokyo_lead_mean_ms)}`)}（取当前运行最新的线路计数）</p>` : "";
    return html`${table}${lead}`;
  };
  const renderSkips = (skips) => {
    if (!skips) return html`<p class="empty">没有数据</p>`;
    const max = Math.max(0, ...SKIPS.map(([key]) => skips[key] || 0));
    return html`<div class="bars">${SKIPS.map(([key, text]) => bar(text, skips[key] || 0, max, `${fmt.int(skips[key] || 0)} 次`))}</div>`;
  };
  const renderHours = (hours) => {
    const rows = Array.isArray(hours) ? hours : [];
    if (!rows.length) return html`<p class="empty">没有数据</p>`;
    const maxPnl = Math.max(0, ...rows.map((r) => Math.abs(num(r.pnl_usd) ?? 0)));
    return html`<div class="table-wrap"><table class="t"><thead><tr><th>小时</th><th>下单</th><th>买到</th><th>赢</th><th>盈亏</th><th class="l" style="width:35%"></th></tr></thead><tbody>
      ${rows.map((r) => html`<tr><td class="num">${String(r.hour).padStart(2, "0")}:00</td><td class="num">${fmt.int(r.orders)}</td><td class="num">${fmt.int(r.filled)}</td><td class="num">${fmt.int(r.won)}</td><td class="num ${fmt.tone(r.pnl_usd)}">${r.pnl_usd === null ? "--" : fmt.money(r.pnl_usd)}</td><td class="l"><div class="bar"><i class="${(r.pnl_usd || 0) >= 0 ? "up" : "down"}" style="width:${maxPnl > 0 ? ((Math.abs(r.pnl_usd || 0) / maxPnl) * 100).toFixed(1) : 0}%"></i></div></td></tr>`)}
      </tbody></table></div>`;
  };
  const renderAll = (data) => ({
    funnel: renderFunnel(data?.funnel), misses: renderMisses(data?.misses), rest: renderRest(data?.rest, data?.gtc), exit: renderExit(data?.exit_shadow), exitFirst: renderExitFirst(data?.exit_first), edge: renderEdge(data?.edge_sizing), regime: renderRegime(data?.regime), late: renderLate(data?.late_by_ms),
    latency: renderLatency(data?.latency), sources: renderBySource(data?.by_source), skips: renderSkips(data?.skips), hours: renderHours(data?.by_hour),
  });
  window.PolyStats = Object.freeze({ renderAll, renderFunnel, renderMisses, renderRest, renderExit, renderExitFirst, renderEdge, renderRegime, renderLate, renderLatency, renderBySource, renderSkips, renderHours });

  const section = (key, title, meta = "") => html`<section class="panel"><div class="panel-head"><h2>${title}</h2><span class="panel-meta">${meta}</span></div><div data-part="${key}"></div></section>`;
  const root = P.mount("stats", "统计", "领先策略的漏斗、没买到的单、速度和按来源的结果，全部从账本算。", html`
    <section class="panel"><div class="panel-head"><div class="seg" data-ranges>${RANGES.map(([key, text]) => html`<button type="button" data-range="${key}">${text}</button>`)}</div><span class="panel-meta" data-meta></span></div><p class="error-line" data-error></p></section>
    ${section("funnel", "漏斗", "信号 → 下单 → 买到 → 结算 → 赢")}
    ${section("misses", "没买到的单")}
    ${section("rest", "没买到后挂单")}
    ${section("exitFirst", "反向信号就卖出", "买到后第一个反向信号就卖")}
    ${section("edge", "按优势定股数", "优势大多买，优势小少买")}
    ${section("exit", "反向信号卖出（模拟）", "第 3 个反向信号就卖，只记录")}
    ${section("regime", "行情太乱就暂停（模拟）", "信号前 5 分钟太乱就不下，只记录")}
    <div class="grid2">${section("late", "晚了多少毫秒")}${section("latency", "速度分解", "每笔单从交易所成交到收到回复")}</div>
    ${section("sources", "按信号源")}
    <div class="grid2">${section("skips", "跳过原因", "有信号但没下单")}${section("hours", "按小时（北京时间）", "按场次开始时间")}</div>`);
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  let range = new URLSearchParams(window.location.search).get("range") || "run";
  if (!RANGES.some(([key]) => key === range)) range = "run";
  const paint = (data) => {
    for (const button of root.querySelectorAll("[data-range]")) button.classList.toggle("active", button.dataset.range === range);
    const parts = renderAll(data?.available === false ? null : data);
    for (const [key, markup] of Object.entries(parts)) P.put($(`[data-part="${key}"]`), markup);
    $("[data-meta]").textContent = data?.available ? `${fmt.int(data.run_count)} 次运行 · ${data.from ? `从 ${fmt.dateTime(data.from)} ` : ""}到 ${fmt.dateTime(data.to)}${data.stale ? " · 数据过期" : ""}` : "";
    $("[data-error]").textContent = data?.available === false ? P.label(data.error) || "统计暂不可用" : "";
  };
  const refresh = P.every(10000, async () => {
    const asked = range;
    try {
      const data = await P.api.statsLead(asked);
      if (asked === range) paint(data);
    } catch (error) { $("[data-error]").textContent = `读取统计失败：${error.message}`; }
  });
  for (const button of root.querySelectorAll("[data-range]")) {
    button.addEventListener("click", () => { range = button.dataset.range; paint(null); refresh(); });
  }
  paint(null);
})();
