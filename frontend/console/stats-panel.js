"use strict";
// 交易统计 + 服务器状态 + 清空数据 on the auto-trade page (UI-REDESIGN U7/U8).
// Moved from the deleted overview page; the headline is today (BUGS P2-24).
(() => {
  var panel = document.querySelector("#stats-panel-root");
  if (!panel) return;
  var store = window.PolyPreviewStore;
  var adapter = window.PolyPreviewAdapter;
  var vm = window.PolyPreviewViewModel;
  panel.innerHTML = `
      <section class="metrics-panel" aria-labelledby="metrics-title">
        <div class="panel-heading"><div><p class="eyebrow">运行表现</p><h2 id="metrics-title">\u4EA4\u6613\u7EDF\u8BA1</h2></div><span class="panel-meta">大字为今日（北京时间）· 只计已结算</span></div>
        <div class="metrics-grid">
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark blue-mark">\u5355</span><div><h3>\u8BA2\u5355\u6570</h3><p>\u5DF2\u8BB0\u5F55\u7684\u8BA2\u5355\u6570\u91CF</p></div></div><strong class="metric-primary" data-metric="orders-today">--</strong><dl class="metric-rows"><div><dt>本次运行</dt><dd data-metric="orders-current">--</dd></div><div><dt>\u5F53\u6708</dt><dd data-metric="orders-month">--</dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark amber-mark">\u76C8</span><div><h3>\u76C8 / \u4E8F</h3><p>\u80DC\u8D1F\u573A\u6B21\u7EDF\u8BA1</p></div></div><strong class="metric-primary"><span data-metric="wins-today">--</span> <em>/</em> <span data-metric="losses-today">--</span></strong><dl class="metric-rows"><div><dt>本次运行</dt><dd><span data-metric="wins-current">--</span> / <span data-metric="losses-current">--</span></dd></div><div><dt>\u5F53\u6708</dt><dd><span data-metric="wins-month">--</span> / <span data-metric="losses-month">--</span></dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark green-mark">\u7387</span><div><h3>\u80DC\u7387</h3><p>\u5DF2\u5B8C\u6210\u573A\u6B21\u7684\u6BD4\u4F8B</p></div></div><strong class="metric-primary"><span data-metric="rate-today">--</span><em>%</em></strong><small class="metric-note" data-metric="rate-sample" title="\u80DC\u7387\u5206\u6BCD\u53EA\u542B\u76C8\u4E8F\u5DF2\u786E\u5B9A\u7684\u573A\u6B21\uFF1B\u6837\u672C\u592A\u5C11\u65F6\u8BE5\u6BD4\u4F8B\u6CA1\u6709\u7EDF\u8BA1\u610F\u4E49">\u6837\u672C --</small><dl class="metric-rows"><div><dt>本次运行</dt><dd><span data-metric="rate-current">--</span>%</dd></div><div><dt>\u5F53\u6708</dt><dd><span data-metric="rate-month">--</span>%</dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark violet-mark">\u51C0</span><div><h3>\u5DF2\u7ED3\u7B97\u51C0\u76C8\u4E8F</h3><p>\u5DF2\u786E\u8BA4\u7ED3\u7B97\uFF0C\u5DF2\u6263\u624B\u7EED\u8D39</p></div></div><strong class="metric-primary"><span data-metric="pnl-today">--</span> <em>USDC</em></strong><small class="metric-note" data-metric="fee-share" title="\u624B\u7EED\u8D39\u6309\u5B98\u65B9\u516C\u5F0F\u5728\u64AE\u5408\u65F6\u786E\u5B9A\uFF1B\u8FD9\u91CC\u663E\u793A\u5B83\u5360\u6BDB\u5229\u7684\u6BD4\u4F8B">\u624B\u7EED\u8D39 --</small><small class="metric-note" data-metric="exposed-pnl" title="\u6210\u672C\u5728\u6210\u4EA4\u65F6\u5DF2\u7ECF\u53D1\u751F\uFF0C\u6536\u76CA\u8981\u7B49\u7ED3\u7B97\u786E\u8BA4\u3002\u8FD9\u4E2A\u6570\u5B57\u628A\u5DF2\u6295\u5165\u4F46\u672A\u786E\u8BA4\u7684\u573A\u6B21\u6309\u6700\u574F\u60C5\u51B5\u8BA1\u5165\uFF1B\u7ED3\u7B97\u786E\u8BA4\u540E\u4E24\u4E2A\u6570\u5B57\u81EA\u52A8\u6536\u655B">\u542B\u672A\u7ED3\u7B97\u6210\u672C --</small><dl class="metric-rows"><div><dt>本次运行</dt><dd><span data-metric="pnl-current">--</span> USDC</dd></div><div><dt>\u5F53\u6708</dt><dd><span data-metric="pnl-month">--</span> USDC</dd></div></dl></article>
        </div>
        <div class="metrics-footnote"><span class="info-dot">i</span><span><span data-metrics-state>\u4EC5\u7EDF\u8BA1\u5DF2\u53D6\u5F97\u7684\u771F\u5B9E\u8BB0\u5F55\uFF1B\u540E\u7AEF\u63A5\u5165\u540E\u518D\u663E\u793A\u771F\u5B9E\u8D26\u6237\u6570\u636E\u3002</span><small data-metrics-detail>待结算 -- · PnL 待核对 -- · 费用 --</small></span></div>
      </section>
      <section class="server-panel" aria-labelledby="server-title">
        <div class="panel-heading"><div><h2 id="server-title">\u670D\u52A1\u5668\u72B6\u6001</h2></div><button type="button" class="hero-button danger-action" data-stats-reset title="删除所有运行日志和统计数据；链上结算记录和策略配置不会删除">清空数据</button><span class="panel-meta server-expired">\u670D\u52A1\u5668\u72B6\u6001\u5F85\u63A5\u5165</span></div>
        <div class="server-metrics"><div><span>CPU</span><strong data-server="cpu">--</strong><svg class="metric-spark" data-spark="cpu" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points=""></polyline></svg></div><div><span>\u5185\u5B58</span><strong data-server="memory">--</strong><svg class="metric-spark" data-spark="memory" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points=""></polyline></svg></div><div><span>\u78C1\u76D8</span><strong data-server="disk">--</strong></div><div><span>\u8D1F\u8F7D 1 / 5 / 15 \u5206\u949F</span><strong data-server="load" title="1 \u5206\u949F / 5 \u5206\u949F / 15 \u5206\u949F \u5E73\u5747\u8D1F\u8F7D">-- / -- / --</strong></div></div>
        <div class="server-services" data-server-services><div><span>\u63A7\u5236\u53F0</span><strong>\u5F85\u540E\u7AEF\u786E\u8BA4</strong><small>--</small></div><div><span>\u884C\u60C5\u91C7\u96C6</span><strong>\u5F85\u63A5\u5165</strong><small>--</small></div><div><span>\u4EA4\u6613\u8FDB\u7A0B</span><strong>\u5F85\u540E\u7AEF\u786E\u8BA4</strong><small>--</small></div><div><span>\u8D26\u672C\u6295\u5F71</span><strong>\u5F85\u63A5\u5165</strong><small>--</small></div></div>
      </section>
      <p class="control-feedback" data-stats-message role="status" aria-live="polite"></p>
`;
  // Skip the write when the value is unchanged. Without this, every 3s/15s poll
  // rewrote dozens of identical textContent values and invalidated layout for
  // each one, since the store notifies subscribers even when a slice is equal.
  const text = (selector, value) => {
    const node = document.querySelector(selector);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  };
  const setHtml = (node, value) => { if (node && node.innerHTML !== value) node.innerHTML = value; };
  // Client-side ring buffer for resource sparklines. The diagnostics endpoint
  // exposes only the current sample, so the trend is built from observed polls.
  const SPARK_POINTS = 40;
  const sparkSeries = new Map();
  const pushSpark = (key, value) => {
    const series = sparkSeries.get(key) || [];
    if (value != null) {
      series.push(value);
      while (series.length > SPARK_POINTS) series.shift();
      sparkSeries.set(key, series);
    }
    const line = document.querySelector(`[data-spark="${key}"] polyline`);
    if (!line) return;
    if (series.length < 2) { if (line.getAttribute("points")) line.setAttribute("points", ""); return; }
    const max = Math.max(100, ...series);
    const step = 100 / (series.length - 1);
    const points = series.map((point, index) => `${(index * step).toFixed(1)},${(24 - point / max * 22 - 1).toFixed(1)}`).join(" ");
    if (line.getAttribute("points") !== points) line.setAttribute("points", points);
  };
  // Uptime was printed as raw seconds, so a day-old process read "86400 秒".
  const duration = (seconds) => {
    if (seconds == null || seconds === "") return "--";
    const total = Number(seconds);
    if (!Number.isFinite(total) || total < 0) return "--";
    const days = Math.floor(total / 86400);
    const hours = Math.floor(total % 86400 / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    if (days) return `${days} 天 ${hours} 小时`;
    if (hours) return `${hours} 小时 ${minutes} 分`;
    if (minutes) return `${minutes} 分 ${Math.floor(total % 60)} 秒`;
    return `${Math.floor(total)} 秒`;
  };
  const read = (source, keys, fallback = null) => {
    for (const key of keys) {
      const value = key.split(".").reduce((current, part) => current == null ? undefined : current[part], source);
      if (value !== undefined && value !== null) return value;
    }
    return fallback;
  };
  const finite = (value) => value != null && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value)) ? Number(value) : null;
  const bytes = (value) => {
    let amount = finite(value);
    if (amount == null || amount < 0) return "--";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
    return `${amount.toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
  };
  const formatMetric = (value, digits = 0) => {
    const number = finite(value);
    return number == null ? "--" : number.toFixed(digits);
  };
  const periodValue = (data, period, fields, rootFields = fields) => {
    const root = data?.summary || data || {};
    const bucket = data?.[period] || data?.periods?.[period] || root?.[period] || {};
    return read(bucket, fields, read(root, rootFields));
  };
  const periodBucket = (data, period) => {
    const root = data?.summary || data || {};
    return data?.[period] || data?.periods?.[period] || root?.[period] || root;
  };
  const renderMetrics = (resource) => {
    const data = resource?.data;
    const error = String(resource?.error || "");
    const noRun = /run not found|没有运行记录|当前运行标识尚未提供/i.test(error);
    text("[data-metrics-state]", resource?.status === "stale"
      ? `部分统计未更新，保留上次结果。${error ? ` ${error}` : ""}`
      : resource?.status === "unavailable"
        ? noRun ? "暂无已登记运行记录，统计暂不可用；账户配置和行情连接状态独立显示。"
          : error ? `统计读取失败：${error}` : "统计接口待接入。"
        : "大字为今日：按北京时间（UTC+8）零点起算，与日内止损同一天，只计已结算盈亏；下面是本次运行和当月。");
    if (!data) {
      // Returning early left the previous run's PnL and win counts in the DOM,
      // so after 清空数据 the console kept showing figures for deleted runs.
      panel.querySelectorAll("[data-metric]").forEach((node) => { node.textContent = "--"; });
      return;
    }
    const setMetric = (name, value) => text(`[data-metric="${name}"]`, value);
    ["current", "today", "month"].forEach((period) => {
      const suffix = period === "current" ? "current" : period;
      const orderCount = periodValue(data, period, ["orders", "orderCount", "order_count", "ordersCount"], ["orders", "orderCount", "order_count", "ordersCount"]);
      setMetric(`orders-${suffix}`, formatMetric(orderCount));
      setMetric(`wins-${suffix}`, formatMetric(periodValue(data, period, ["settled_wins", "wins", "winCount", "win_count"])));
      setMetric(`losses-${suffix}`, formatMetric(periodValue(data, period, ["settled_losses", "losses", "lossCount", "loss_count"])));
      const rate = finite(periodValue(data, period, ["winRate", "win_rate", "rate"], ["winRate", "win_rate", "rate"]));
      setMetric(`rate-${suffix}`, rate == null ? "--" : (rate <= 1 ? rate * 100 : rate).toFixed(2));
      setMetric(`pnl-${suffix}`, formatMetric(periodValue(data, period, ["pnlUsd", "pnl_usd", "profit", "settledPnl", "settled_pnl"], ["pnlUsd", "pnl_usd", "profit", "settledPnl", "settled_pnl"]), 2));
    });
    const currentFills = vm.uniqueFillCount(periodBucket(data, "current"));
    const todayFills = vm.uniqueFillCount(periodBucket(data, "today"));
    const pending = periodValue(data, "today", ["pending_settlements"], ["pending_settlements"]);
    const pendingPnl = periodValue(data, "today", ["settled_pnl_pending"], ["settled_pnl_pending"]);
    const fees = periodValue(data, "today", ["fees"], ["fees"]);
    const estimatedFees = periodValue(data, "today", ["estimated_fees"], ["estimated_fees"]);
    const display = (value, digits = 0) => value == null ? "--" : formatMetric(value, digits);
    // Win-rate denominator: a high percentage over one settled round is not a
    // track record, so show the sample size next to it.
    const wins = finite(periodValue(data, "today", ["settled_wins"], ["settled_wins"]));
    const losses = finite(periodValue(data, "today", ["settled_losses"], ["settled_losses"]));
    const sample = wins == null || losses == null ? null : wins + losses;
    text('[data-metric="rate-sample"]', sample == null ? "样本 --"
      : sample === 0 ? "样本 0 场 · 暂无结论"
        : `样本 ${sample} 场${sample < 20 ? " · 样本偏少" : ""}`);
    // Fees are a material cost (they took ~20% of the first profit), so surface
    // them and their share of gross profit instead of hiding them in the footer.
    const netPnl = finite(periodValue(data, "today", ["pnlUsd", "pnl_usd", "profit", "settledPnl", "settled_pnl"], ["pnlUsd", "pnl_usd", "profit", "settledPnl", "settled_pnl"]));
    const feeValue = finite(fees);
    const gross = netPnl != null && feeValue != null ? netPnl + feeValue : null;
    text('[data-metric="fee-share"]', feeValue == null ? "手续费 --"
      : gross != null && gross > 0
        ? `手续费 ${feeValue.toFixed(4)} · 占毛利 ${(feeValue / gross * 100).toFixed(1)}%`
        : `手续费 ${feeValue.toFixed(4)}`);
    // The settled figure ignores rounds whose capital is already spent but whose
    // payout is unproven, so it can read a loss as a profit. Show the exposed
    // figure beside it; the two converge as settlements confirm.
    const exposed = finite(periodValue(data, "today", ["exposedPnl", "exposed_pnl"], ["exposedPnl", "exposed_pnl"]));
    const unsettledCost = finite(periodValue(data, "today", ["unsettledCost", "unsettled_cost"], ["unsettledCost", "unsettled_cost"]));
    const unsettledRounds = finite(periodValue(data, "today", ["unsettledRounds", "unsettled_rounds"], ["unsettledRounds", "unsettled_rounds"]));
    // The settled figure is now published even when some rounds are unresolved,
    // so say so rather than letting a partial sum read as the final one.
    const pendingCount = finite(pendingPnl);
    {
      // Reset when nothing is pending; the note used to stick forever (BUGS P3-15).
      const heading = document.querySelector('[data-metric="pnl-today"]')?.closest(".metric-group")?.querySelector("h3 + p, p");
      if (heading && !pendingCount) heading.textContent = "已确认结算，已扣手续费";
    }
    if (pendingCount) {
      const heading = document.querySelector('[data-metric="pnl-today"]')?.closest(".metric-group")?.querySelector("h3 + p, p");
      if (heading) heading.textContent = `已确认结算，已扣手续费 · ${pendingCount} 场待核对`;
    }
    text('[data-metric="exposed-pnl"]', exposed == null ? "含未结算成本 --"
      : !unsettledRounds ? `含未结算成本 ${exposed > 0 ? "+" : ""}${exposed.toFixed(4)} · 已全部确认`
        : `含未结算成本 ${exposed > 0 ? "+" : ""}${exposed.toFixed(4)} USDC · ${unsettledRounds} 场待确认${
          unsettledCost == null ? "" : `（已投入 ${unsettledCost.toFixed(4)}）`}`);
    text("[data-metrics-detail]", `今日成交 ${display(todayFills)} · 本次运行 ${display(currentFills)} · 待结算 ${display(pending)} · PnL 待核对 ${display(pendingPnl)} · 已确认费用 ${display(fees, 4)} · 估算费用 ${display(estimatedFees, 4)}`);
  };
  const renderDiagnostics = (resource) => {
    const health = resource?.data;
    const data = health?.resources || health;
    if (!data) return;
    // Don't glue a percent sign onto a missing value ("--%"); degrade to "--".
    const percent = (value, digits = 1) => {
      const text = formatMetric(value, digits);
      return text === "--" ? "--" : `${text}%`;
    };
    text("[data-server=cpu]", `${percent(data.cpu?.percent)} · ${data.cpu?.cores ?? "--"} 核`);
    text("[data-server=memory]", `${percent(data.memory?.percent)} · ${bytes(data.memory?.used_bytes)} / ${bytes(data.memory?.total_bytes)}`);
    text("[data-server=disk]", `${percent(data.disk?.percent)} · 可用 ${bytes(data.disk?.free_bytes)}`);
    // The server keeps only the latest sample, so trend comes from what this page
    // has actually observed. No synthetic points: the line only grows as real
    // polls arrive, and stays empty until there are at least two samples.
    pushSpark("cpu", finite(data.cpu?.percent));
    pushSpark("memory", finite(data.memory?.percent));
    text("[data-server=load]", [data.load?.one, data.load?.five, data.load?.fifteen].map((value) => formatMetric(value, 2)).join(" / "));
    // The server reports this service as `trading` (verified against
    // /api/diagnostics/health). `trader` is kept as a compatibility alias so an
    // older payload still renders a Chinese label instead of a raw key.
    const names = { dashboard: "控制台", collector: "行情采集", trading: "交易进程", trader: "交易进程", projection: "账本投影" };
    const states = { active: "运行中", stopped: "未运行", inactive: "未运行", failed: "失败", activating: "启动中", deactivating: "停止中", unavailable: "不可用", unknown: "未知" };
    const services = document.querySelector("[data-server-services]");
    if (services && data.services) setHtml(services, Object.entries(data.services).map(([name, service]) => {
      const state = String(service?.state || "unknown");
      const stateClass = state === "active" ? "service-good" : state === "stopped" || state === "inactive" ? "" : "service-warning";
      return `<div><span>${window.PolyPreview.format.escape(names[name] || name)}</span><strong class="${stateClass}">${window.PolyPreview.format.escape(states[state] || state)}</strong><small>进程号 ${service?.pid ?? "--"} · 内存 ${bytes(service?.rss_bytes)} · 运行 ${duration(service?.uptime_seconds)}</small></div>`;
    }).join(""));
    const stamp = health.asOf == null ? "" : window.PolyPreview.format.time(health.asOf);
    text(".server-expired", resource?.status === "stale"
      ? `服务降级或采样过期${stamp ? ` · ${stamp}` : ""}`
      : stamp ? `更新 ${stamp}` : "等待系统采样");
  };
  store.subscribe("metrics", renderMetrics);
  store.subscribe("diagnostics", renderDiagnostics);
  renderMetrics(store.getState().metrics);
  renderDiagnostics(store.getState().diagnostics);
  var button = panel.querySelector("[data-stats-reset]");
  if (button) button.addEventListener("click", async () => {
    {
      if (button.disabled) return;
      const message = document.querySelector("[data-stats-message]");
      // Irreversible and it deletes real trade history, so require an explicit
      // confirmation. On-chain settlement state and strategy config survive.
      if (!window.confirm("清空全部运行日志和交易统计？\n\n删除：运行日志、成交/订单/结算投影、全部统计数字。\n保留：链上结算记录（未赎回的持仓不会丢）、策略配置、运行池。\n\n此操作不可撤销。")) return;
      button.disabled = true;
      const original = button.textContent;
      button.textContent = "清空中…";
      button.setAttribute("aria-busy", "true");
      if (message) { message.classList.remove("is-blocked"); message.textContent = "正在清空运行数据…"; }
      try {
        const result = await adapter.resetLedger();
        const report = result?.report || {};
        if (message) {
          const freed = typeof report.bytes === "number" ? ` · 释放 ${(report.bytes / 1e6).toFixed(0)} MB` : "";
          message.textContent = `已清空 ${report.journals ?? 0} 份运行日志和统计投影${freed}。链上结算记录与策略配置已保留。`;
        }
        await Promise.allSettled([adapter.loadRuntime(), adapter.loadMetrics(), adapter.loadDiagnostics()]);
      } catch (error) {
        if (message) {
          message.classList.add("is-blocked");
          message.textContent = `清空失败：${error?.message || "未知错误"}`;
        }
      } finally {
        button.disabled = false;
        button.textContent = original;
        button.removeAttribute("aria-busy");
      }
      return;
    }
  });
  // Server push re-renders at once; these timers are the fallback.
  var refreshMetrics = () => adapter.loadMetrics(null, ["today", "month", "run"]).catch(() => null);
  var refreshDiagnostics = () => adapter.loadDiagnostics().catch(() => null);
  void refreshMetrics(); void refreshDiagnostics();
  window.setInterval(() => { if (!document.hidden) void refreshMetrics(); }, 15000);
  window.setInterval(() => { if (!document.hidden) void refreshDiagnostics(); }, 15000);
  if (window.PolyPreviewStream) {
    window.PolyPreviewStream.onUpdate("/api/metrics/summary", () => void refreshMetrics());
    window.PolyPreviewStream.onUpdate("/api/diagnostics/health", () => void refreshDiagnostics());
  }
})();
