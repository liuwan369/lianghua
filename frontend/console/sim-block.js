"use strict";
// 模拟交易页：用真实行情数据，统计真实策略每场会触发多少次（首次 + 每次反转），
// 不设上限。重点是次数——最多可能到 67 次，看清分布好决定阶梯怎么写。
// 数据来自采集器里跑的真实策略（/api/sim），绝不碰实盘下单、账本或实盘配置。
(() => {
  const { request, format, navMarkup, navigate } = window.PolyPreview;
  const COINS = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"];
  const DAYS = [1, 3, 7, 10];
  const params = new URLSearchParams(window.location.search);
  let assetId = COINS.includes((params.get("assetId") || "").toLowerCase()) ? params.get("assetId").toLowerCase() : "btc";
  let days = DAYS.includes(Number(params.get("days"))) ? Number(params.get("days")) : 10;
  const expanded = new Set();

  const root = document.querySelector("#sim-block-root");
  if (!root) throw new Error("sim block root missing");
  const nav = navMarkup("sim");

  root.innerHTML = `
  <div class="overview-preview sim-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>交易控制台</small></div></div>
      <p class="sidebar-copy">用真实行情回放真实策略，只数触发次数，不下任何单。</p>
      <nav aria-label="控制台导航">${nav}</nav>
      <div class="sidebar-status"><i></i><span data-sidebar-state>模拟数据</span><small data-sidebar-detail>读取 /api/sim</small></div>
    </aside>
    <main class="preview-main sim-main">
      <header class="preview-header sim-header">
        <div class="hero-copy">
          <p class="eyebrow">模拟交易 · 触发次数统计</p>
          <div class="hero-title-row"><h1>模拟交易</h1><span class="language-chip">真实行情 · 不下单</span></div>
          <p class="subtitle">同一套真实反转策略跑在真实盘口上，统计每场触发次数（首次触发 + 每次反转），不设上限。次数越多，阶梯要越深。</p>
          <p class="sim-caveat" role="note">模拟：假设每次触发都按卖价成交（≤0.70），不含滑点，实盘会更差。</p>
        </div>
      </header>

      <section class="sim-controls" aria-label="筛选">
        <div class="sim-field">
          <label for="sim-coin">币种</label>
          <select id="sim-coin" data-coin>${COINS.map((coin) => `<option value="${coin}">${coin.toUpperCase()}</option>`).join("")}</select>
        </div>
        <div class="sim-field">
          <label for="sim-days">时间范围</label>
          <select id="sim-days" data-days>${DAYS.map((value) => `<option value="${value}">${value} 天</option>`).join("")}</select>
        </div>
        <button class="hero-button" type="button" data-refresh>刷新</button>
        <span class="sim-source" data-source aria-live="polite"></span>
      </section>

      <section class="sim-bignums" aria-label="汇总">
        <article class="sim-stat"><span>场次总数</span><strong data-stat-rounds>--</strong></article>
        <article class="sim-stat"><span>有触发的场次</span><strong data-stat-withfiring>--</strong></article>
        <article class="sim-stat sim-stat-max"><span>单场最多触发</span><strong data-stat-max>--</strong><small data-stat-maxround></small></article>
        <article class="sim-stat"><span>平均触发次数</span><strong data-stat-avg>--</strong></article>
      </section>

      <section class="sim-dist" aria-label="每场触发次数分布">
        <div class="list-heading"><div><p class="eyebrow">分布</p><h2>每场触发次数分布</h2></div><span class="list-caption">0 到最大值全部显示，不截断</span></div>
        <div class="sim-chart" data-chart role="img" aria-label="每场触发次数分布柱状图"></div>
      </section>

      <section class="sim-rounds" aria-label="场次明细">
        <div class="list-heading"><div><p class="eyebrow">明细</p><h2>场次明细（最新在前）</h2></div><span class="list-caption" data-rounds-caption></span></div>
        <table class="sim-table">
          <thead><tr><th scope="col">时间（北京）</th><th scope="col">触发</th><th scope="col">反转</th><th scope="col">赢方</th><th scope="col">模拟盈亏(前4)</th><th scope="col"></th></tr></thead>
          <tbody data-rounds></tbody>
        </table>
      </section>
    </main>
  </div>`;

  const el = (selector) => root.querySelector(selector);
  const coinSelect = el("[data-coin]");
  const daysSelect = el("[data-days]");
  coinSelect.value = assetId;
  daysSelect.value = String(days);

  const beijing = (startsAt) => {
    if (!Number.isFinite(startsAt)) return "--";
    const date = new Date(startsAt * 1000 + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getUTCMonth() + 1}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  };
  const esc = format.escape;

  const renderStats = (summary) => {
    el("[data-stat-rounds]").textContent = summary.rounds;
    el("[data-stat-withfiring]").textContent = summary.withFiring;
    el("[data-stat-max]").textContent = summary.maxFirings;
    el("[data-stat-avg]").textContent = summary.avgFirings;
    const maxRound = summary.maxRound;
    el("[data-stat-maxround]").textContent = maxRound ? `在 ${beijing(maxRound.startsAt)}（场次 ${maxRound.roundId}）` : "";
  };

  const renderChart = (distribution, maxFirings) => {
    const chart = el("[data-chart]");
    const counts = [];
    for (let value = 0; value <= maxFirings; value += 1) counts.push(distribution[String(value)] || 0);
    const peak = Math.max(1, ...counts);
    if (!counts.length) { chart.innerHTML = `<p class="sim-empty">暂无数据</p>`; return; }
    chart.innerHTML = counts.map((count, value) => {
      const height = Math.round((count / peak) * 100);
      return `<div class="sim-bar" title="触发 ${value} 次：${count} 场">
        <span class="sim-bar-count">${count || ""}</span>
        <span class="sim-bar-fill" style="height:${height}%"></span>
        <span class="sim-bar-label">${value}</span></div>`;
    }).join("");
  };

  const renderRounds = (rounds) => {
    const body = el("[data-rounds]");
    el("[data-rounds-caption]").textContent = `${rounds.length} 场`;
    if (!rounds.length) { body.innerHTML = `<tr><td colspan="6" class="sim-empty">暂无数据</td></tr>`; return; }
    body.innerHTML = rounds.map((round) => {
      const key = round.roundId;
      const open = expanded.has(key);
      const winner = round.winner === "UP" ? "涨" : round.winner === "DOWN" ? "跌" : "未定";
      const pnl = Number.isFinite(round.simPnl4) ? round.simPnl4.toFixed(2) : "--";
      const events = (round.events || []).map((event) =>
        `<li><span class="sim-ev-i">#${event.i}</span><span>${Math.round(event.t)}s</span>
         <span class="sim-ev-dir sim-ev-${event.dir === "UP" ? "up" : "down"}">${event.dir === "UP" ? "涨" : "跌"}</span>
         <span>卖价 ${Number(event.ask).toFixed(2)}</span><span>${event.shares} 股</span></li>`).join("");
      const detail = open
        ? `<tr class="sim-detail-row"><td colspan="6"><ul class="sim-events">${events || '<li>无触发</li>'}</ul></td></tr>`
        : "";
      return `<tr class="sim-round-row" data-round="${esc(key)}">
        <td>${beijing(round.startsAt)}</td>
        <td class="sim-firings">${round.firings}</td>
        <td>${round.reversals}</td>
        <td>${winner}</td>
        <td>${pnl}</td>
        <td><button class="sim-expand" type="button" data-expand="${esc(key)}" aria-expanded="${open}">${open ? "收起" : "展开"}</button></td>
      </tr>${detail}`;
    }).join("");
  };

  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    const source = el("[data-source]");
    try {
      const data = await request(`/api/sim?assetId=${encodeURIComponent(assetId)}&days=${days}`);
      const summary = data.summary || { rounds: 0, withFiring: 0, maxFirings: 0, avgFirings: 0, distribution: {} };
      renderStats(summary);
      renderChart(summary.distribution || {}, summary.maxFirings || 0);
      renderRounds(data.rounds || []);
      source.textContent = `已更新 · ${format.clock()}`;
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

  coinSelect.addEventListener("change", () => { assetId = coinSelect.value; expanded.clear(); syncUrl(); load(); });
  daysSelect.addEventListener("change", () => { days = Number(daysSelect.value); syncUrl(); load(); });
  el("[data-refresh]").addEventListener("click", load);
  root.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-preview-target]");
    if (nav) { navigate(nav.getAttribute("data-preview-target")); return; }
    const expand = event.target.closest("[data-expand]");
    if (expand) {
      const key = expand.getAttribute("data-expand");
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      const data = window.PolyPreviewStream && window.PolyPreviewStream.cached(`/api/sim?assetId=${encodeURIComponent(assetId)}&days=${days}`);
      if (data) renderRounds(data.rounds || []); else load();
    }
  });
  if (window.PolyPreviewStream) {
    window.PolyPreviewStream.onUpdate("/api/sim", () => load());
  }
  load();
})();
