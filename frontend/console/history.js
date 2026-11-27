"use strict";
// 历史: every lead order (GET /api/orders/lead), 100 a page, newest first;
// a click on a row shows its timings and the rest of its record.
(() => {
  const P = window.PolyPreview;
  const { html, fmt, num, VENUES, LINES, DIRECTIONS, ORDER_STATUS } = P;
  const RANGES = [["run", "本次运行"], ["today", "今天"], ["7d", "7 天"], ["all", "全部"]];
  const PAGE = 100;
  const filled = (order) => !!order && (num(order.filled_shares) ?? 0) > 1e-8;

  const result = (order) => {
    // The exit sell (exitOnReverse): sold or not, and whether holding would have won.
    if (order.stage === "exit") {
      if (!filled(order)) {
        if (order.status && !["CANCELLED", "REJECTED", "ABANDONED"].includes(order.status)) return { text: "处理中", tone: "warn" };
        return { text: "没卖掉", tone: "" };
      }
      return order.outcome === "won" ? { text: "已卖（拿着会赢）", tone: "down" } : order.outcome === "lost" ? { text: "已卖（拿着会输）", tone: "up" }
        : { text: "已卖", tone: "" };
    }
    if (!filled(order)) {
      if (order.status && !["CANCELLED", "REJECTED", "ABANDONED"].includes(order.status)) return { text: "处理中", tone: "warn" };
      const hint = order.would_have_won === true ? "（买到会赢）" : order.would_have_won === false ? "（买到会输）" : "";
      return { text: `未成交${hint}`, tone: "" };
    }
    return order.outcome === "won" ? { text: "赢", tone: "up" } : order.outcome === "lost" ? { text: "输", tone: "down" } : { text: "待结算", tone: "warn" };
  };
  const ms = (value) => num(value) === null ? "--" : fmt.ms(value);
  const stamp = (value) => num(value) === null ? "--" : `${fmt.time(value)}.${String(Math.round(value % 1000)).padStart(3, "0")}`;
  const detail = (o) => {
    const items = [
      ["订单号", o.order_id || "--"], ["客户端编号", o.client_order_id || "--"], ["状态", `${ORDER_STATUS[o.status] || o.status || "--"}${o.venue_status ? ` · 交易所 ${o.venue_status}` : ""}`],
      ["成交均价", fmt.price(o.avg_fill_price)], ["手续费", fmt.usd(o.fee_usd)], ["信号涨跌", fmt.bp(o.move_bp)],
      ["信号价", fmt.btc(o.signal_price)], ["开盘线", `${o.open_line === "mean60" ? "开盘前 60 秒均价" : o.open_line === "tick" ? "开盘那一笔" : "--"} ${fmt.btc(o.open_value)}`],
      ["离开盘线", fmt.bp(o.band_bp)], ["开盘后", num(o.sec_since_open) === null ? "--" : `${o.sec_since_open.toFixed(1)} 秒`],
      ["交易所成交", stamp(o.trade_time_ms)], ["东京转发收到", stamp(o.relay_recv_ms)], ["爱尔兰收到", stamp(o.signal_recv_ms)],
      ["决策", stamp(o.decision_ms)], ["发出", stamp(o.post_sent_ms)], ["交易所回复", stamp(o.ack_ms)],
      ["成交→收到 t_signal", ms(o.t_signal_ms)], ["收到→决策 t_decide", ms(o.t_decide_ms)], ["决策→发出 t_post", ms(o.t_post_ms)],
      ["发出→回复 t_ack", ms(o.t_ack_ms)], ["总计 t_total", ms(o.t_total_ms)],
      ["卖单消失（我们收到）", stamp(o.ask_gone_ms)], ["卖单消失（交易所时间）", stamp(o.ask_gone_venue_ms)],
      ["成交后多久卖单消失", ms(o.ask_gone_after_trade_ms)], ["晚了", ms(o.late_by_ms)],
      ["盈亏来源", o.pnl_source === "official" ? "官方结算" : o.pnl_source === "ledger" ? "账本估算" : "--"],
      ...(o.stage === "exit" ? [["反向信号卖出", `信号时买一 ${fmt.price(o.bid_at_signal)} · 收回 ${fmt.usd(o.proceeds_usd)} · 比拿到结算 ${fmt.money(o.exit_vs_hold_usd)}`]] : []),
      ...(num(o.exit_shares) !== null ? [["反向信号卖出", `卖了 ${fmt.shares(o.exit_shares)} 股 · 收回 ${fmt.usd(o.exit_proceeds_usd)}（已算进盈亏）`]] : []),
      ...(num(o.edge) !== null ? [["按优势定股", `公允价 ${fmt.price(o.fair)} · 优势 ${o.edge >= 0 ? "+" : ""}${o.edge.toFixed(3)} · ${o.edge_sizing ? "已按" : "会按"} ${fmt.shares(o.edge_shares)} 股`]] : []),
      ...(o.stage === "gtc" ? [["限价单", `立即成交 ${fmt.shares(o.taker_shares)} 股 · 挂着成交 ${fmt.shares(o.maker_shares)} 股`]] : []),
      ...(o.stage === "retry" ? [["反向再试", `是 · 第一单没买到，跟在 ${o.parent_client_order_id || "--"} 后面`]] : []),
      ["挂单补单", o.stage === "gtc" || o.stage === "retry" ? "--" : o.stage === "rest" ? `是 · 跟在 ${o.parent_client_order_id || "--"} 后面` : o.rest_mode === "shadow" ? (num(o.rest_shadow_fill_ms) === null ? "模拟：5 秒内不会成交" : `模拟：${stamp(o.rest_shadow_fill_ms)} 会成交`) : o.rest_mode === "live" ? "已开启" : "--"],
    ];
    return html`<div class="detail-grid">${items.map(([k, v]) => html`<div><span>${k}</span> <b>${v}</b></div>`)}</div>${o.error ? html`<p class="error-line">错误：${o.error}</p>` : ""}`;
  };
  // One row per round (user 2026-11-19): the round's buy (gtc / fak, plus a
  // rest order after a miss, or a retry on a reverse signal after a 0-share
  // miss) and its reverse-signal sell (stage exit) side by side; the buy row's
  // PnL already counts what the sale got back.
  const roundKey = (o) => String(o.market_id ?? o.round_id ?? o.client_order_id ?? o.recv_ts);
  const groupRounds = (items) => {
    const byRound = new Map();
    for (const o of items) {
      const key = roundKey(o);
      const r = byRound.get(key) ?? byRound.set(key, { key, buy: null, rest: null, retry: null, sell: null, at: o.recv_ts }).get(key);
      if (o.stage === "exit") r.sell = o;
      else if (o.stage === "rest") r.rest = o;
      else if (o.stage === "retry") r.retry = o;
      else r.buy = o;
      r.at = Math.max(num(r.at) ?? 0, num(o.recv_ts) ?? 0);
    }
    return [...byRound.values()].filter((r) => r.buy || r.rest || r.retry).sort((a, b) => b.at - a.at);
  };
  // The order a round's row shows: the one that bought, else the last one tried
  // (a retry after the first buy missed).
  const mainOf = ({ buy, rest, retry }) => [buy, rest, retry].find(filled) ?? retry ?? buy ?? rest;
  const roundResult = ({ buy, rest, retry, sell }) => {
    const main = mainOf({ buy, rest, retry });
    if (!filled(main)) return result(main).text.startsWith("未成交") ? { ...result(main), text: result(main).text.replace("未成交", "没买到") } : result(main);
    if (sell && filled(sell)) {
      // What the sale did against holding: the held side lost = the sale saved
      // money; the held side won = it gave up some of the win.
      if (main.outcome === "won") return { text: "卖了（拿着会赢）", tone: "warn" };
      if (main.outcome === "lost") return { text: "卖了（拿着会输）", tone: "up" };
      return { text: "已卖，待结算", tone: "warn" };
    }
    return result(main);
  };
  const sellCell = (sell) => {
    if (!sell) return "--";
    if (filled(sell)) return `卖 ${fmt.shares(sell.filled_shares)} 股 @${fmt.price(sell.avg_fill_price ?? sell.limit_price)}`;
    if (sell.status && !["CANCELLED", "REJECTED", "ABANDONED"].includes(sell.status)) return "卖出处理中";
    return `没卖掉（限 ${fmt.price(sell.limit_price)}）`;
  };
  const renderRows = (rounds, open = new Set()) => {
    if (!rounds.length) return html`<tr><td colspan="12" class="empty">这个范围没有下单</td></tr>`;
    return html`${rounds.map((r) => {
      const main = mainOf(r);
      // A retry buys the other side: its shares are not added to the first buy's.
      const got = r.retry ? num(main.filled_shares) ?? 0 : (num(r.buy?.filled_shares) ?? 0) + (num(r.rest?.filled_shares) ?? 0);
      const pnl = [r.buy, r.rest, r.retry].reduce((sum, o) => (num(o?.pnl) === null ? sum : (sum ?? 0) + o.pnl), null);
      const res = roundResult(r);
      const tag = r.retry ? html`<span class="tag">反向再试</span> ` : main.stage === "gtc" ? html`<span class="tag">限价单</span> `
        : r.rest ? html`<span class="tag">吃单 + 挂单补单</span> ` : "";
      return html`<tr class="row-click" data-key="${r.key}"><td class="num">${fmt.dateTime(main.recv_ts)}</td><td class="num">${fmt.hm(main.round_start)}</td>
        <td class="l">${tag}${VENUES[main.venue] || main.venue || "--"} · ${LINES[main.line] || main.line || "--"}</td>
        <td class="l ${main.direction === "UP" ? "up" : "down"}">${DIRECTIONS[main.direction] || main.direction || "--"}</td>
        <td class="num">${fmt.price(main.ask_at_signal)}</td><td class="num">${fmt.price(main.limit_price)}</td>
        <td class="num">${fmt.shares(got)} / ${fmt.shares(main.shares)}${r.retry && filled(r.retry) && filled(r.buy) ? html`<br><small class="warn">两边都有：${DIRECTIONS[r.buy.direction]?.split(" ")[0] || ""} ${fmt.shares(r.buy.filled_shares)} 股</small>` : ""}</td><td class="l">${sellCell(r.sell)}</td>
        <td class="l ${res.tone}">${res.text}</td><td class="num ${fmt.tone(pnl)}">${fmt.money(pnl)}</td>
        <td class="num">${ms(main.t_total_ms)}</td><td class="num">${ms(main.late_by_ms)}</td></tr>${open.has(r.key) ? html`<tr class="detail"><td colspan="12">${roundDetail(r)}</td></tr>` : ""}`;
    })}`;
  };
  const roundDetail = (r) => html`${[["买入", r.buy], ["挂单补单", r.rest], ["反向再试", r.retry], ["反向信号卖出", r.sell]].filter(([, o]) => o)
    .map(([title, o]) => html`<h4 class="muted" style="margin:6px 0 2px">${title}</h4>${detail(o)}`)}`;
  window.PolyHistory = Object.freeze({ renderRows, result, detail, groupRounds, roundResult, roundKey });

  const root = P.mount("history", "历史", "每一笔下单：信号来源、价格、买到没有、结果和耗时。点一行看全部时间。", html`
    <section class="panel">
      <div class="panel-head"><div class="seg">${RANGES.map(([key, text]) => html`<button type="button" data-range="${key}">${text}</button>`)}</div>
        <span class="actions"><span class="panel-meta" data-meta></span><button class="btn small" type="button" data-reload>刷新</button></span></div>
      <p class="error-line" data-error></p>
      <div class="table-wrap"><table class="t"><thead><tr><th>时间</th><th>场次</th><th class="l">信号</th><th class="l">方向</th><th>卖价</th><th>限价</th><th>买到 / 股数</th><th class="l">反向卖出</th><th class="l">结果</th><th>盈亏</th><th>总耗时</th><th>晚了</th></tr></thead><tbody data-rows></tbody></table></div>
      <div class="form-foot"><button class="btn" type="button" data-more hidden>再看 ${PAGE} 条</button></div>
    </section>`);
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  const state = { range: "run", items: [], next: null, open: new Set() };
  const paint = () => {
    for (const button of root.querySelectorAll("[data-range]")) button.classList.toggle("active", button.dataset.range === state.range);
    const rounds = groupRounds(state.items);
    P.put($("[data-rows]"), renderRows(rounds, state.open));
    $("[data-more]").hidden = state.next == null;
    $("[data-meta]").textContent = `${rounds.length} 场`;
  };
  const load = async (more = false) => {
    const range = state.range;
    try {
      const data = await P.api.ordersLead({ range, limit: PAGE, before: more ? state.next : undefined });
      if (range !== state.range) return;
      if (data.available === false) { $("[data-error]").textContent = P.label(data.error) || "历史暂不可用"; return; }
      $("[data-error]").textContent = "";
      state.items = more ? [...state.items, ...(data.items || [])] : (data.items || []);
      state.next = data.next_before ?? null;
      paint();
    } catch (error) { $("[data-error]").textContent = `读取历史失败：${error.message}`; }
  };
  $("[data-rows]").addEventListener("click", (event) => {
    const row = event.target.closest?.("tr[data-key]");
    if (!row) return;
    const key = row.dataset.key;
    if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
    paint();
  });
  for (const button of root.querySelectorAll("[data-range]")) {
    button.addEventListener("click", () => { state.range = button.dataset.range; state.items = []; state.next = null; state.open.clear(); paint(); load(); });
  }
  $("[data-more]").addEventListener("click", () => load(true));
  $("[data-reload]").addEventListener("click", () => load());
  paint();
  load();
})();
