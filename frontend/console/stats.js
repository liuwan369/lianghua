"use strict";
// 统计: GET /api/stats/lead?range= rendered as plain CSS bars and tables.
(() => {
  const P = window.PolyPreview;
  const { html, fmt, num, VENUES, LINES } = P;
  const RANGES = [["run", "本次运行"], ["today", "今天"], ["7d", "7 天"], ["all", "全部"]];
  const LATE_BUCKETS = [["<0", "< 0 ms"], ["0-50", "0–50 ms"], ["50-100", "50–100 ms"], ["100-200", "100–200 ms"], ["200-400", "200–400 ms"], [">400", "> 400 ms"]];
  const STAGES = [["t_signal_ms", "成交→爱尔兰收到"], ["t_decide_ms", "收到→决策"], ["t_post_ms", "决策→发出"], ["t_ack_ms", "发出→交易所回复"]];
  const SKIPS = [["time_window", "不在下单时间窗"], ["band", "离开盘线太远 / 开盘线未知"], ["ask_too_high", "卖价高于上限"], ["book", "盘口不可用"],
    ["budget", "预算或余额不够 / 日亏损上限"], ["paused", "已暂停"], ["already_attempted", "本场已下过单"], ["other", "其他"]];

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
    funnel: renderFunnel(data?.funnel), misses: renderMisses(data?.misses), late: renderLate(data?.late_by_ms),
    latency: renderLatency(data?.latency), sources: renderBySource(data?.by_source), skips: renderSkips(data?.skips), hours: renderHours(data?.by_hour),
  });
  window.PolyStats = Object.freeze({ renderAll, renderFunnel, renderMisses, renderLate, renderLatency, renderBySource, renderSkips, renderHours });

  const section = (key, title, meta = "") => html`<section class="panel"><div class="panel-head"><h2>${title}</h2><span class="panel-meta">${meta}</span></div><div data-part="${key}"></div></section>`;
  const root = P.mount("stats", "统计", "领先策略的漏斗、没买到的单、速度和按来源的结果，全部从账本算。", html`
    <section class="panel"><div class="panel-head"><div class="seg" data-ranges>${RANGES.map(([key, text]) => html`<button type="button" data-range="${key}">${text}</button>`)}</div><span class="panel-meta" data-meta></span></div><p class="error-line" data-error></p></section>
    ${section("funnel", "漏斗", "信号 → 下单 → 买到 → 结算 → 赢")}
    ${section("misses", "没买到的单")}
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
