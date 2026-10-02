"use strict";
// 模拟交易页：真实策略跑在真实行情上，数每场出手几次（第 1 次触发 + 每次反向触发），
// 不设上限，用来决定阶梯要几档。数据来自 /api/sim 与 /api/sim/overview，只读，
// 绝不碰实盘下单、账本或实盘配置。
(() => {
  const { request, format, navMarkup, navigate } = window.PolyPreview;
  const COINS = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"];
  const DAYS = [1, 3, 7, 10];
  const LADDER = 4;          // 阶梯档数：5/20/60/140 股
  const PAGE_SIZE = 50;
  const CHIPS_SHOWN = 12;
  const params = new URLSearchParams(window.location.search);
  let assetId = COINS.includes((params.get("assetId") || "").toLowerCase()) ? params.get("assetId").toLowerCase() : "btc";
  let days = DAYS.includes(Number(params.get("days"))) ? Number(params.get("days")) : 10;
  let filter = "all";
  let page = 0;
  let sim = null;
  let overview = null;
  const expanded = new Set();
  const esc = format.escape;

  const root = document.querySelector("#sim-block-root");
  if (!root) throw new Error("sim block root missing");

  root.innerHTML = `
  <div class="settings-preview sim-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>交易控制台</small></div></div>
      <div class="brand-card"><span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span><strong>Polymarket</strong></div>
      <p class="sidebar-copy">用真实行情回放真实策略，只数出手次数，不下任何单。</p>
      <nav aria-label="控制台导航">${navMarkup("sim")}</nav>
      <div class="sidebar-status"><i></i><span>模拟数据</span><small>只读 · 不下单</small></div>
    </aside>
    <main class="settings-main sim-main">
      <header class="preview-header">
        <div class="hero-copy"><p class="eyebrow">模拟交易 · 出手次数</p><div class="hero-title-row"><h1>模拟交易</h1><span class="language-chip">真实行情 · 不下单</span></div>
        <p class="subtitle">每场策略会出手几次，决定阶梯要几档。</p></div>
      </header>

      <section class="sim-controls" aria-label="筛选">
        <div class="sim-pills" role="group" aria-label="币种" data-coins></div>
        <div class="sim-pills" role="group" aria-label="时间范围" data-days></div>
        <span class="sim-updated" data-source role="status" aria-live="polite"></span>
        <button type="button" class="action-button" data-refresh><span aria-hidden="true">↻</span>刷新</button>
      </section>

      <section class="sim-panel sim-conclusion" aria-label="一句话结论">
        <p class="eyebrow">一句话结论</p>
        <p class="sim-conclusion-text" data-conclusion>读取中…</p>
        <p class="sim-definition">出手 = 第 1 次触发（任一边卖价从 0.67 下方涨到 0.67 以上）+ 之后每次反向触发。同一边重复上穿不算。</p>
      </section>

      <section class="sim-stats" aria-label="汇总">
        <article class="sim-stat"><span>场次</span><strong data-stat-rounds>--</strong><small data-stat-rounds-sub>有行情的场次</small></article>
        <article class="sim-stat"><span>平均每场出手</span><strong data-stat-avg>--</strong><small data-stat-avg-sub>次</small></article>
        <article class="sim-stat"><span>单场最多出手</span><strong data-stat-max>--</strong><small data-stat-maxround>--</small></article>
        <article class="sim-stat sim-stat-warn"><span>超过 ${LADDER} 次的场次</span><strong data-stat-over4>--</strong><small data-stat-over4-sub>${LADDER} 档阶梯不够用的比例</small></article>
      </section>

      <section class="sim-panel" aria-labelledby="sim-chart-title">
        <div class="panel-heading"><div><p class="eyebrow">分布</p><h3 id="sim-chart-title">每场出手几次</h3></div><span class="panel-meta">0 到最大值全部列出</span></div>
        <p class="sim-legend"><i class="sim-key sim-zero"></i>0 次：没出手 <i class="sim-key sim-ladder"></i>1–${LADDER} 次：${LADDER} 档阶梯够用 <i class="sim-key sim-over"></i>超过 ${LADDER} 次：阶梯用完</p>
        <div class="sim-chart-head" aria-hidden="true"><span>出手次数</span><span>场数（条越长越多）</span><span>场数</span><span>占比</span><span>≤N 次累计</span></div>
        <ol class="sim-chart" data-chart aria-label="每场出手次数分布"></ol>
      </section>

      <section class="sim-panel" aria-labelledby="sim-coins-title">
        <div class="panel-heading"><div><p class="eyebrow">对比</p><h3 id="sim-coins-title">七个币对比</h3></div><span class="panel-meta">点一行切换币种</span></div>
        <div class="sim-scroll"><table class="sim-table">
          <thead><tr><th scope="col">币种</th><th scope="col">场次</th><th scope="col">平均出手</th><th scope="col">中位数</th><th scope="col">最多</th><th scope="col">≤${LADDER} 次占比</th><th scope="col">&gt;${LADDER} 次场数</th><th scope="col">模拟盈亏(前${LADDER}档)</th></tr></thead>
          <tbody data-overview></tbody>
        </table></div>
      </section>

      <section class="sim-panel" aria-labelledby="sim-rounds-title">
        <div class="panel-heading"><div><p class="eyebrow">明细</p><h3 id="sim-rounds-title">场次明细</h3></div><span class="panel-meta" data-rounds-caption></span></div>
        <div class="sim-pills" role="group" aria-label="筛选场次" data-filters></div>
        <div class="sim-scroll"><table class="sim-table">
          <thead><tr><th scope="col">时间（北京）</th><th scope="col">出手次数</th><th scope="col">方向序列</th><th scope="col">赢方</th><th scope="col">模拟盈亏(前${LADDER}档)</th><th scope="col"><span class="sim-sr">展开</span></th></tr></thead>
          <tbody data-rounds></tbody>
        </table></div>
        <div class="sim-pager" data-pager></div>
      </section>

      <p class="sim-footnote" role="note">模拟：假设每次出手都按当时卖价成交（≤0.70），不含滑点与延迟；盈亏只按前 4 档 5/20/60/140 股估算，实盘会更差。</p>
    </main>
  </div>`;

  const el = (selector) => root.querySelector(selector);
  const pad = (n) => String(n).padStart(2, "0");
  const beijing = (startsAt) => {
    if (!Number.isFinite(startsAt)) return "--";
    const date = new Date(startsAt * 1000 + 8 * 3600 * 1000);
    return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  };
  const pct = (part, whole, digits = 0) => (whole ? ((part * 100) / whole).toFixed(digits) : "0");
  const money = (value) => (Number.isFinite(value)
    ? `<span class="${value > 0 ? "sim-up" : value < 0 ? "sim-down" : ""}">${value > 0 ? "+" : ""}${value.toFixed(2)}</span>` : "--");
  const dirText = (dir) => (dir === "UP" ? "涨" : dir === "DOWN" ? "跌" : "未定");
  const dirClass = (dir) => (dir === "UP" ? "sim-up" : dir === "DOWN" ? "sim-down" : "");
  const pill = (attr, value, label, active) =>
    `<button type="button" class="sim-pill${active ? " active" : ""}" ${attr}="${esc(value)}" aria-pressed="${active}">${esc(label)}</button>`;

  const renderControls = () => {
    el("[data-coins]").innerHTML = COINS.map((coin) => pill("data-coin", coin, coin.toUpperCase(), coin === assetId)).join("");
    el("[data-days]").innerHTML = DAYS.map((value) => pill("data-day", value, `${value} 天`, value === days)).join("");
    el("[data-filters]").innerHTML = [["all", "全部"], ["over4", `只看 >${LADDER} 次`], ["zero", "只看 0 次"]]
      .map(([key, label]) => pill("data-filter", key, label, key === filter)).join("");
  };

  const renderSummary = () => {
    const summary = sim.summary;
    const dist = summary.distribution || {};
    const total = summary.rounds || 0;
    const coin = assetId.toUpperCase();
    let within = 0;
    for (let value = 0; value <= LADDER; value += 1) within += dist[String(value)] || 0;
    const over = total - within;
    const maxAt = summary.maxRound ? beijing(summary.maxRound.startsAt) : "--";
    el("[data-conclusion]").textContent = total
      ? `${coin} 最近 ${days} 天 ${total} 场：${pct(dist["1"] || 0, total)}% 只出手 1 次，${pct(within, total)}% 不超过 ${LADDER} 次；`
        + `最多一场出手 ${summary.maxFirings} 次（${maxAt}）。按 ${LADDER} 档阶梯，${pct(over, total)}% 的场次会不够用。`
      : `${coin} 最近 ${days} 天还没有模拟场次。`;
    el("[data-stat-rounds]").textContent = String(total);
    el("[data-stat-rounds-sub]").textContent = `有行情的场次，其中 ${summary.withFiring || 0} 场有出手`;
    el("[data-stat-avg]").textContent = String(summary.avgFirings ?? 0);
    el("[data-stat-avg-sub]").textContent = `次 · 中位数 ${summary.medianFirings ?? "--"} 次`;
    el("[data-stat-max]").textContent = String(summary.maxFirings || 0);
    el("[data-stat-maxround]").textContent = summary.maxRound ? `次 · ${maxAt}（北京）` : "次";
    el("[data-stat-over4]").textContent = `${over} 场`;
    el("[data-stat-over4-sub]").textContent = `占 ${pct(over, total, 1)}%，${LADDER} 档阶梯不够用`;
  };

  const renderChart = () => {
    const summary = sim.summary;
    const dist = summary.distribution || {};
    const total = summary.rounds || 0;
    const max = summary.maxFirings || 0;
    const peak = Math.max(1, ...Object.values(dist));
    const compact = max > 30;
    let cumulative = 0;
    const rows = [];
    for (let value = 0; value <= max && total; value += 1) {
      const count = dist[String(value)] || 0;
      cumulative += count;
      const tone = value === 0 ? "sim-zero" : value <= LADDER ? "sim-ladder" : "sim-over";
      // Rare values stay visible: a minimum bar width and the count always printed.
      const width = count ? Math.max(1.5, (count / peak) * 100) : 0;
      rows.push(`<li class="sim-row ${tone}${compact && !count ? " sim-row-empty" : ""}">`
        + `<span class="sim-row-label">出手 ${value} 次</span>`
        + `<span class="sim-row-track"><i style="width:${width.toFixed(1)}%"></i></span>`
        + `<b class="sim-row-count">${count} 场</b>`
        + `<span class="sim-row-pct">${pct(count, total, 1)}%</span>`
        + `<span class="sim-row-cum">≤${value} 次 ${pct(cumulative, total, 1)}%</span></li>`);
    }
    el("[data-chart]").innerHTML = rows.join("") || `<li class="sim-empty">暂无数据</li>`;
  };

  const renderOverview = () => {
    const body = el("[data-overview]");
    if (!overview) { body.innerHTML = `<tr><td colspan="8" class="sim-empty">暂无数据</td></tr>`; return; }
    body.innerHTML = (overview.coins || []).map((row) => {
      const active = row.assetId === assetId;
      const within = row.rounds ? (100 - row.over4Pct).toFixed(1) : "0";
      return `<tr class="sim-coin-row${active ? " active" : ""}" data-coin-row="${esc(row.assetId)}" tabindex="0" aria-current="${active}">`
        + `<th scope="row">${esc(String(row.assetId).toUpperCase())}</th><td>${row.rounds}</td><td>${row.avgFirings}</td>`
        + `<td>${row.medianFirings}</td><td>${row.maxFirings}</td><td>${within}%</td>`
        + `<td class="${row.over4 ? "sim-warn" : ""}">${row.over4}（${row.over4Pct}%）</td><td>${money(row.simPnl4Total)}</td></tr>`;
    }).join("");
  };

  const renderRounds = () => {
    const all = sim.rounds || [];
    const shown = all.filter((round) => {
      const firings = Number(round.firings) || 0;
      return filter === "over4" ? firings > LADDER : filter === "zero" ? firings === 0 : true;
    });
    const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    el("[data-rounds-caption]").textContent = `${shown.length} / ${all.length} 场 · 最新在前`;
    el("[data-rounds]").innerHTML = shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((round) => {
      const key = String(round.roundId);
      const firings = Number(round.firings) || 0;
      const events = round.events || [];
      const open = expanded.has(key);
      const chips = events.slice(0, CHIPS_SHOWN).map((event) => `<span class="sim-chip ${dirClass(event.dir)}">${dirText(event.dir)}</span>`).join("")
        + (events.length > CHIPS_SHOWN ? `<span class="sim-chip sim-more">+${events.length - CHIPS_SHOWN}</span>` : "");
      const detail = open
        ? `<tr class="sim-detail-row"><td colspan="6"><ol class="sim-events">${events.map((event) =>
          `<li>第 ${event.i} 次 · 第 ${Math.round(event.t)} 秒 · <span class="${dirClass(event.dir)}">${dirText(event.dir)}</span> · 卖价 ${Number(event.ask).toFixed(2)} · ${event.shares} 股</li>`).join("") || "<li>本场没有出手</li>"}</ol></td></tr>`
        : "";
      return `<tr class="sim-round-row" data-round="${esc(key)}" data-firings="${firings}">`
        + `<td>${beijing(round.startsAt)}</td><td class="sim-firings${firings > LADDER ? " sim-warn" : ""}">${firings}</td>`
        + `<td><span class="sim-chips">${chips || "—"}</span></td>`
        + `<td class="${dirClass(round.winner)}">${dirText(round.winner)}</td><td>${money(round.simPnl4)}</td>`
        + `<td><button class="action-button sim-expand" type="button" data-expand="${esc(key)}" aria-expanded="${open}">${open ? "收起" : "展开"}</button></td></tr>${detail}`;
    }).join("") || `<tr><td colspan="6" class="sim-empty">没有符合条件的场次</td></tr>`;
    el("[data-pager]").innerHTML = pages > 1
      ? `<button type="button" class="action-button" data-page="${page - 1}"${page ? "" : " disabled"}>上一页</button>`
        + `<span>第 ${page + 1} / ${pages} 页</span>`
        + `<button type="button" class="action-button" data-page="${page + 1}"${page < pages - 1 ? "" : " disabled"}>下一页</button>`
      : "";
  };

  const render = () => {
    renderControls();
    renderOverview();
    if (!sim) return;
    renderSummary();
    renderChart();
    renderRounds();
  };

  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    const source = el("[data-source]");
    try {
      const [simData, overviewData] = await Promise.all([
        request(`/api/sim?assetId=${encodeURIComponent(assetId)}&days=${days}`),
        request(`/api/sim/overview?days=${days}`).catch(() => null),
      ]);
      sim = { rounds: simData.rounds || [], summary: simData.summary || { rounds: 0, maxFirings: 0, distribution: {} } };
      overview = overviewData;
      render();
      source.textContent = `更新于 ${format.clock()}`;
      source.classList.remove("sim-error");
    } catch (error) {
      source.textContent = format.readableError(error && error.message, "模拟数据暂不可用");
      source.classList.add("sim-error");
    } finally {
      loading = false;
    }
  };

  const syncUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("assetId", assetId);
    url.searchParams.set("days", String(days));
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };
  const reload = () => { expanded.clear(); page = 0; syncUrl(); renderControls(); load(); };
  const switchCoin = (coin) => { if (COINS.includes(coin)) { assetId = coin; reload(); } };

  root.addEventListener("click", (event) => {
    const hit = (attr) => { const node = event.target.closest(`[${attr}]`); return node ? node.getAttribute(attr) : null; };
    let value;
    if ((value = hit("data-coin")) !== null || (value = hit("data-coin-row")) !== null) { switchCoin(value); return; }
    if ((value = hit("data-day")) !== null) { days = Number(value); reload(); return; }
    if ((value = hit("data-filter")) !== null) { filter = value; page = 0; render(); return; }
    if ((value = hit("data-page")) !== null) { page = Math.max(0, Number(value)); renderRounds(); return; }
    if ((value = hit("data-expand")) !== null) { if (expanded.has(value)) expanded.delete(value); else expanded.add(value); renderRounds(); return; }
    if (hit("data-refresh") !== null) { load(); return; }
    if ((value = hit("data-preview-target")) !== null) navigate(value);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest && event.target.closest("[data-coin-row]");
    if (row) { event.preventDefault(); switchCoin(row.getAttribute("data-coin-row")); }
  });
  if (window.PolyPreviewStream) window.PolyPreviewStream.onUpdate("/api/sim", () => load());
  renderControls();
  load();
})();