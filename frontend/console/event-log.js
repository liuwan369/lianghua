"use strict";
// 运行日志 (event stream) on the settings page (UI-REDESIGN U9), moved from
// the deleted overview page.
(() => {
  var panel = document.querySelector("#event-log-root");
  if (!panel) return;
  var store = window.PolyPreviewStore;
  var adapter = window.PolyPreviewAdapter;
  panel.innerHTML = `
      <section class="log-panel" aria-labelledby="log-title">
        <div class="panel-heading"><div><p class="eyebrow">\u7CFB\u7EDF\u4E8B\u4EF6</p><h2 id="log-title">\u8FD0\u884C\u65E5\u5FD7</h2></div><div class="log-state"><span class="state-dot"></span><span data-events-state>\u4E8B\u4EF6\u5F85\u63A5\u5165</span><small>\u670D\u52A1\u5668\u6570\u636E</small></div></div>
        <ol class="log-list" data-event-log-list aria-live="polite">
          <li class="log-entry"><time>--</time><span class="log-icon neutral-icon">\u2022</span><div><strong>\u8FD0\u884C\u4E8B\u4EF6\u5F85\u540E\u7AEF\u8FD4\u56DE</strong><p>\u672A\u6536\u5230\u670D\u52A1\u5668\u4E8B\u4EF6\uFF0C\u6CA1\u6709\u5047\u6570\u636E\u5C55\u793A</p></div><span class="log-status muted-text">\u5F85\u63A5\u5165</span></li>
        </ol>
        <div class="log-footer"><span><i class="tiny-dot"></i>\u53EA\u663E\u793A\u5F53\u524D\u8FD0\u884C\u76F8\u5173\u4E8B\u4EF6</span></div>
      </section>
`;
  const text = (selector, value) => {
    const node = document.querySelector(selector);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  };
  const setHtml = (node, value) => { if (node && node.innerHTML !== value) node.innerHTML = value; };
  const renderEvents = (resource) => {
    text("[data-events-state]", resource?.status === "stale" ? "数据过期 · 保留最近事件" : resource?.status === "ready" ? "已读取" : "事件待接入");
    const list = document.querySelector("[data-event-log-list]");
    if (list) list.classList.toggle("is-stale", resource?.status !== "ready" || resource?.stale === true);
    if (resource?.status !== "ready") return;
    const items = Array.isArray(resource.items) ? resource.items : [];
    if (!list) return;
    if (!items.length) { setHtml(list, '<li class="log-entry"><time>--</time><span class="log-icon neutral-icon">•</span><div><strong>暂无运行事件</strong><p>后端返回新的事件后会在这里追加。</p></div><span class="log-status muted-text">空闲</span></li>'); return; }
    const icon = { error: "!", warning: "!", warn: "!", success: "✓", good: "✓" };
    const activityNames = {
      platform_status: { running: "交易进程已启动", starting: "交易进程正在启动", paused: "已暂停新增订单", stopping: "正在停止交易", stopped: "交易进程已停止", failed: "交易进程异常退出" },
      order: "订单状态更新",
      order_ack: "平台已确认订单",
      fill: "收到成交回报",
      settlement: "结算状态更新",
      resolved: "市场结果已确认",
      quote: "盘口报价已更新",
      cancel: "撤单状态更新",
      unresolved: "结算仍待确认",
      error: "运行异常"
    };
    const errorNames = {
      market_feed_unhealthy: "行情连接中断，等待数据恢复",
      market_feed_disconnected: "行情连接中断，等待数据恢复",
      stale_book: "盘口数据已过期，暂不触发交易",
      transport_disconnected: "行情传输连接断开",
      market_snapshot_rejected: "行情快照未通过校验",
      feed_processing_failed: "行情处理失败",
      order_recovery_pending: "订单状态仍在核对",
      startup_account_recovery_pending: "启动时账户订单核对未完成",
      cash_flow_refresh_pending: "账户资金数据等待刷新",
      // Codes that actually appear in production and previously rendered as raw
      // English. account_recovery_started is a coordination signal, not a fault.
      account_recovery_started: "账户订单开始核对",
      settlement_drain_timeout: "结算收尾超时，仍有场次未确认",
      settlement_pass_timeout: "结算轮询超时",
      settlement_terminal_failure: "结算失败，已终止重试",
      platform_run_failed: "交易进程运行失败",
      user_feed_not_ready: "账户回报通道尚未就绪",
      journal_failed: "运行记录写入失败",
      process_failed: "交易进程异常退出",
      ledger_projection_incomplete: "账本投影尚未追上运行记录",
      remote_orders_unconfirmed: "远端挂单状态尚未确认",
      remote_orders_state_unconfirmed: "远端挂单状态尚未确认"
    };
    const stateNames = { running: "运行中", starting: "启动中", paused: "已暂停", stopping: "停止中", stopped: "已停止", failed: "失败", open: "挂单中", matched: "已撮合", filled: "已成交", canceled: "已撤销", cancelled: "已撤销", confirmed: "已确认", pending: "待确认", rejected: "已拒绝", unconfirmed: "尚未确认", stale: "已过期", unavailable: "暂不可用" };
    const statusNames = { stopped: "交易进程已停止", started: "交易进程已启动", running: "交易进程运行中", starting: "交易进程正在启动", stopping: "交易进程正在停止", paused: "已暂停新增订单", failed: "交易进程运行失败", order: "订单状态更新", fill: "订单成交", settlement: "结算状态更新", resolved: "市场结果已确认", cancel: "撤单状态更新" };
    const hashPattern = /0x[a-fA-F0-9]{32,}/g;
    const shorten = (value) => String(value).replace(hashPattern, (hash) => `${hash.slice(0, 10)}…${hash.slice(-7)}`).replace(/\b\d{30,}\b/g, "关联当前市场");
    const readableEvent = (value, fallback) => {
      const raw = String(value ?? "").trim();
      if (!raw) return fallback;
      const safe = shorten(raw);
      if (/[\u3400-\u9fff]/.test(safe)) return safe;
      const translated = window.PolyPreview.format.readableError(safe, "");
      return translated && translated !== safe ? translated : fallback;
    };
    // Collapse consecutive repeats before rendering: a retry loop must read as
    // one line with a count, otherwise 300+ identical notices bury the one real
    // failure. Severity comes from the code's meaning, not the channel it used.
    const markup = window.PolyPreviewViewModel.collapseEvents(items, 20).map((group) => {
      const item = group.item;
      const repeats = group.count;
      const state = String(item.status || item.state || "").toLowerCase();
      const kind = String(item.kind || item.event || "").toLowerCase();
      const severity = window.PolyPreviewViewModel.eventSeverity(item);
      const time = item.time || item.createdAt || item.created_at || item.timestamp || "--";
      const code = String(item.code || "").toLowerCase();
      const fallbackMessage = (kind === "platform_status" && activityNames[kind]?.[state])
        || statusNames[state]
        || errorNames[code]
        || errorNames[kind]
        || activityNames[kind]
        || (severity === "error" || severity === "critical" ? "交易链路发生异常" : "运行状态已更新");
      // The backend degrades an empty message to the literal kind (e.g. "error"),
      // which is truthy and would shadow the precise errorNames[code] label. Treat
      // a message equal to the kind as absent so the code-based label wins.
      const rawMessage = item.message && String(item.message).toLowerCase() !== kind ? item.message : null;
      const message = errorNames[code] || readableEvent(rawMessage || item.reason || item.detail, fallbackMessage);
      const asset = String(item.assetId || item.asset_id || "").toUpperCase();
      const marketId = item.marketId || item.market_id;
      const roundId = item.roundId || item.round_id;
      const orderState = stateNames[state] || "";
      const phase = String(item.phase || item.failure_phase || "").trim();
      const orderRef = item.orderId || item.order_id || item.clientOrderId || item.client_order_id;
      const identity = [asset, marketId ? `市场 ${shorten(marketId)}` : "", roundId ? `场次 ${String(roundId).slice(-10)}` : ""].filter(Boolean).join(" · ");
      const detailParts = [];
      const rawDetail = item.detail && item.detail !== item.message ? item.detail : item.reason && item.reason !== item.message ? item.reason : null;
      if (rawDetail) detailParts.push(readableEvent(rawDetail, "服务器已返回附加状态"));
      // A repeat count is the most important fact in a retry loop: it shows the
      // action keeps running without succeeding. Lead with it.
      if (repeats > 1) {
        const firstTime = window.PolyPreview.format.time(
          group.oldest?.time || group.oldest?.createdAt || group.oldest?.created_at, "");
        detailParts.push(firstTime ? `重复 ${repeats} 次 · 最早 ${firstTime}` : `重复 ${repeats} 次`);
      }
      // Surface the raw code and phase: they are the fields that actually tell an
      // operator what happened, and were previously dropped from the log line.
      if (code && !errorNames[code]) detailParts.push(`错误码 ${code}`);
      if (phase && phase !== "event") detailParts.push(`阶段 ${phase}`);
      if (orderState) detailParts.push(`订单：${orderState}`);
      // price/shares are null on non-trade events; Number(null) === 0 would print a
      // misleading "价格 0.000", so require a real positive number.
      const price = item.price == null ? null : Number(item.price);
      if (price != null && Number.isFinite(price) && price > 0) detailParts.push(`价格 ${price.toFixed(3)}`);
      const size = (item.shares ?? item.size);
      const sizeNum = size == null ? null : Number(size);
      if (sizeNum != null && Number.isFinite(sizeNum) && sizeNum > 0) detailParts.push(`${sizeNum.toFixed(2)} 份`);
      if (orderRef) detailParts.push(`订单号 ${shorten(orderRef)}`);
      if (identity) detailParts.push(identity);
      const detail = detailParts.join(" · ") || (severity === "error" || severity === "critical" ? "未完成的操作不会显示为成功。" : "来自服务器的运行状态记录。");
      const statusClass = severity === "error" || severity === "warning" || severity === "warn" ? "muted-text" : severity === "success" || severity === "good" ? "good-text" : "info-text";
      const severityLabel = severity === "error" || severity === "critical" ? "异常" : severity === "warning" || severity === "warn" ? "警告" : severity === "success" || severity === "good" ? "成功" : "信息";
      return `<li class="log-entry"><time>${window.PolyPreview.format.escape(window.PolyPreview.format.time(time, "--:--:--"))}</time><span class="log-icon ${statusClass.replace("-text", "-icon")}">${icon[severity] || "i"}</span><div><strong>${window.PolyPreview.format.escape(message)}</strong><p title="${window.PolyPreview.format.escape(detail)}">${window.PolyPreview.format.escape(detail)}</p></div><span class="log-status ${statusClass}">${severityLabel}</span></li>`;
    }).join("");
    // Only touch the DOM when the rendered log actually differs. The list was
    // rebuilt on every 15s poll, which cancelled text selection, dropped :hover
    // and replayed all entries to screen readers via aria-live.
    setHtml(list, markup);
  };
  store.subscribe("events", renderEvents);
  // A run-level feed: scoped to the current run, not to one round.
  // Re-read the run each time: loading it once at page load kept showing the
  // previous run's events after a new run started (BUGS F2).
  var refresh = () => adapter.loadRuntime().catch(() => null).then(() => {
    const runId = store.getState().runtime?.runId || null;
    return adapter.loadEvents(runId, runId ? { runId } : {}).catch(() => null);
  });
  void refresh();
  window.setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
  if (window.PolyPreviewStream) window.PolyPreviewStream.onUpdate("/api/events", () => void refresh());
})();
