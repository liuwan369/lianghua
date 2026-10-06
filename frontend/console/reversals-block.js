"use strict";
// 反转统计: how many times the reversal trigger fires per round, counted from
// the market recordings by the server (/api/reversals). Counts only: no orders,
// fills or money. Definition: REVERSAL.md.
(() => {
  const { request, format, navMarkup, navigate } = window.PolyPreview;
  const COINS = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"];
  const DAYS = [1, 3, 7, 10];
  const PAGE = 50;
  const params = new URLSearchParams(window.location.search);
  let assetId = COINS.includes((params.get("assetId") || "").toLowerCase()) ? params.get("assetId").toLowerCase() : "btc";
  let days = DAYS.includes(Number(params.get("days"))) ? Number(params.get("days")) : 7;
  let page = 0;
  let last = null;

  const root = document.querySelector("#reversals-block-root");
  if (!root) throw new Error("reversals block root missing");
  const esc = (value) => format.escape(String(value ?? ""));
  const pills = (name, values, label) => values.map((value) =>
    `<button type="button" class="rv-pill" data-${name}="${value}" aria-pressed="false">${label(value)}</button>`).join("");

  root.innerHTML = `
  <div class="settings-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>交易控制台</small></div></div>
      <p class="sidebar-copy">用录下来的真实行情，数每场反转了几次。</p>
      <nav aria-label="控制台导航">${navMarkup("reversals")}</nav>
      <div class="sidebar-status"><i></i><span>录制行情</span><small data-source>读取中</small></div>
    </aside>
    <main class="settings-main rv-main">
      <header class="preview-header">
        <div class="hero-copy">
          <p class="eyebrow">反转统计</p>
          <div class="hero-title-row"><h1>反转统计</h1><span class="language-chip">只数次数</span></div>
          <p class="subtitle">反转 = 对面卖价从 0.67 以下涨到 0.67 或以上（同一边重复上穿不算）；两边卖价之和 &gt; 1.05 的报价不参与；快收盘时一边没卖价不参与。第 1 次上穿算触发，之后每次对面上穿算一次反转。</p>
        </div>
      </header>

      <section class="rv-controls" aria-label="筛选">
        <div class="rv-pills" role="group" aria-label="币种">${pills("coin", COINS, (c) => c.toUpperCase())}</div>
        <div class="rv-pills" role="group" aria-label="天数">${pills("days", DAYS, (d) => `${d} 天`)}</div>
      </section>

      <section class="rv-cards" aria-label="汇总">
        <article class="rv-card"><span>场次</span><strong data-total-rounds>--</strong><small data-total-incomplete></small></article>
        <article class="rv-card"><span>平均每场触发</span><strong data-total-avg>--</strong><small data-total-median></small></article>
        <article class="rv-card"><span>单场最多</span><strong data-total-max>--</strong><small data-total-max-round></small></article>
        <article class="rv-card rv-card-warn"><span>超过 4 次的场次</span><strong data-total-over4>--</strong><small data-total-over4-pct></small></article>
        <article class="rv-card"><span>第 1 次触发那边最后赢</span><strong data-total-first-win>--</strong><small>只算看得出赢家的场次</small></article>
      </section>

      <section class="diagnostic-panel rv-panel" aria-labelledby="rv-days-title">
        <div class="panel-heading"><div><p class="eyebrow">每天</p><h3 id="rv-days-title">每天多少次</h3></div></div>
        <div class="rv-scroll"><table class="rv-table">
          <thead><tr><th scope="col">日期（北京）</th><th scope="col">场次</th><th scope="col">平均触发</th><th scope="col">最多</th>
            <th scope="col">0 次</th><th scope="col">1 次</th><th scope="col">2 次</th><th scope="col">3 次</th><th scope="col">4 次</th><th scope="col">5 次及以上</th><th scope="col">备注</th></tr></thead>
          <tbody data-days-body></tbody>
        </table></div>
      </section>

      <section class="diagnostic-panel rv-panel" aria-labelledby="rv-dist-title">
        <div class="panel-heading"><div><p class="eyebrow">分布</p><h3 id="rv-dist-title">每场触发几次</h3></div><span class="panel-meta">0 到最大值全部列出</span></div>
        <div class="rv-dist" data-dist></div>
      </section>

      <section class="diagnostic-panel rv-panel" aria-labelledby="rv-ladder-title">
        <div class="panel-heading"><div><p class="eyebrow">按策略测</p><h3 id="rv-ladder-title">阶梯 <span data-ladder-name>5 / 13 / 60</span> 的结果</h3></div><span class="panel-meta">STRATEGY.md 第 6 条</span></div>
        <p class="rv-hint">每次触发挂 0.70 限价：触发那一刻卖价 ≤ 0.70 才算买到（按当时卖价加手续费），否则这一档没买到；最多 3 档，之后不再加仓，持仓留到收盘。只算录全了最后一分钟、看得出赢家的场次。没算排队和抢单，实盘会差一些。</p>
        <div class="rv-cards rv-cards-3">
          <article class="rv-card"><span>合计</span><strong data-ladder-total>--</strong><small data-ladder-rounds></small></article>
          <article class="rv-card"><span>每场平均</span><strong data-ladder-per>--</strong><small>美元</small></article>
          <article class="rv-card rv-card-warn"><span>最差一场</span><strong data-ladder-worst>--</strong><small>美元</small></article>
        </div>
        <div class="rv-scroll"><table class="rv-table">
          <thead><tr><th scope="col">触发几次</th><th scope="col">场次</th><th scope="col">合计</th><th scope="col">每场平均</th></tr></thead>
          <tbody data-ladder-body></tbody>
        </table></div>
      </section>

      <section class="diagnostic-panel rv-panel" aria-labelledby="rv-coins-title">
        <div class="panel-heading"><div><p class="eyebrow">对比</p><h3 id="rv-coins-title">7 个币</h3></div><span class="panel-meta">点一行切换币种</span></div>
        <div class="rv-scroll"><table class="rv-table">
          <thead><tr><th scope="col">币</th><th scope="col">场次</th><th scope="col">平均触发</th><th scope="col">中位数</th><th scope="col">最多</th><th scope="col">超过 4 次</th><th scope="col">第 1 次触发那边赢</th></tr></thead>
          <tbody data-coins-body></tbody>
        </table></div>
      </section>

      <section class="diagnostic-panel rv-panel" aria-labelledby="rv-rounds-title">
        <div class="panel-heading"><div><p class="eyebrow">明细</p><h3 id="rv-rounds-title">每一场</h3></div><span class="panel-meta" data-rounds-meta></span></div>
        <div class="rv-scroll"><table class="rv-table">
          <thead><tr><th scope="col">时间（北京）</th><th scope="col">触发次数</th><th scope="col">方向和第几秒</th><th scope="col">赢方</th></tr></thead>
          <tbody data-rounds-body></tbody>
        </table></div>
        <div class="rv-pager"><button type="button" class="action-button" data-prev>上一页</button><span data-page></span><button type="button" class="action-button" data-next>下一页</button></div>
      </section>
    </main>
  </div>`;

  const el = (selector) => root.querySelector(selector);
  const set = (selector, value) => { const node = el(selector); if (node) node.textContent = value; };
  const beijing = (unix, withDate = true) => {
    if (!Number.isFinite(unix)) return "--";
    const date = new Date((unix + 8 * 3600) * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
    return withDate ? `${date.getUTCMonth() + 1}-${pad(date.getUTCDate())} ${time}` : time;
  };
  const side = (value) => value === "UP" ? "涨" : value === "DOWN" ? "跌" : "未定";
  const num = (value, digits = 2) => Number.isFinite(value) ? String(Math.round(value * 10 ** digits) / 10 ** digits) : "--";
  const pct = (value) => Number.isFinite(value) ? `${num(value, 1)}%` : "--";

  const renderTotal = (total) => {
    set("[data-total-rounds]", total.rounds ?? "--");
    set("[data-total-incomplete]", total.incomplete ? `另有 ${total.incomplete} 场录制不完整，没算` : "全部场次都完整");
    set("[data-total-avg]", num(total.avgFirings));
    set("[data-total-median]", Number.isFinite(total.medianFirings) ? `中位数 ${total.medianFirings} 次` : "");
    set("[data-total-max]", total.maxFirings ?? "--");
    set("[data-total-max-round]", total.maxRound ? `${beijing(total.maxRound.startsAt)}（场次 ${total.maxRound.roundId}）` : "");
    set("[data-total-over4]", total.over4 ?? "--");
    set("[data-total-over4-pct]", `占 ${pct(total.over4Pct)}`);
    set("[data-total-first-win]", pct(total.firstFiringWinPct));
  };

  const renderDays = (rows) => {
    const body = el("[data-days-body]");
    if (!rows.length) { body.innerHTML = `<tr><td colspan="11" class="rv-empty">这段时间没有录制</td></tr>`; return; }
    body.innerHTML = rows.map((day) => {
      const d = day.distribution || {};
      const atLeast5 = Object.entries(d).reduce((sum, [k, v]) => sum + (Number(k) >= 5 ? v : 0), 0);
      return `<tr><td>${esc(day.date)}</td><td>${day.rounds}</td><td>${num(day.avgFirings)}</td><td>${day.maxFirings}</td>
        <td>${d["0"] || 0}</td><td>${d["1"] || 0}</td><td>${d["2"] || 0}</td><td>${d["3"] || 0}</td><td>${d["4"] || 0}</td>
        <td class="${atLeast5 ? "rv-warn" : ""}">${atLeast5}</td><td class="rv-note">${day.partialRounds ? (day.partialRounds >= day.rounds ? "缺最后约50秒盘口" : `其中 ${day.partialRounds} 场缺最后约50秒盘口`) : "完整"}</td></tr>`;
    }).join("");
  };

  const renderDist = (distribution, rounds) => {
    const box = el("[data-dist]");
    const values = Object.keys(distribution || {}).map(Number).sort((a, b) => a - b);
    if (!values.length || !rounds) { box.innerHTML = `<p class="rv-empty">暂无数据</p>`; return; }
    const peak = Math.max(1, ...values.map((v) => distribution[String(v)]));
    let cumulative = 0;
    box.innerHTML = values.map((value) => {
      const count = distribution[String(value)];
      cumulative += count;
      const width = count ? Math.max(1.5, (count / peak) * 100) : 0;
      const tone = value === 0 ? "rv-bar-zero" : value <= 4 ? "rv-bar-in" : "rv-bar-over";
      return `<div class="rv-dist-row${count ? "" : " rv-dist-empty"}">
        <span class="rv-dist-label">触发 ${value} 次</span>
        <span class="rv-dist-track"><i class="${tone}" style="width:${width}%"></i></span>
        <b>${count} 场</b><span>${pct((100 * count) / rounds)}</span><span class="rv-dist-cum">≤${value} 次 ${pct((100 * cumulative) / rounds)}</span></div>`;
    }).join("");
  };

  const money = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${num(value)}` : "--";
  const renderLadder = (ladder) => {
    if (!ladder) return;
    set("[data-ladder-name]", (ladder.ladder || []).join(" / "));
    set("[data-ladder-total]", money(ladder.total));
    set("[data-ladder-rounds]", `${ladder.rounds} 场`);
    set("[data-ladder-per]", money(ladder.perRound));
    set("[data-ladder-worst]", money(ladder.worst));
    const rows = Object.entries(ladder.byFirings || {});
    el("[data-ladder-body]").innerHTML = rows.length ? rows.map(([key, group]) => `<tr><td>${esc(key)} 次</td><td>${group.rounds}</td>
      <td class="${group.total < 0 ? "rv-loss" : "rv-gain"}">${money(group.total)}</td><td>${money(group.perRound)}</td></tr>`).join("")
      : `<tr><td colspan="4" class="rv-empty">还没有录全最后一分钟的场次</td></tr>`;
  };

  const renderCoins = (coins) => {
    el("[data-coins-body]").innerHTML = (coins || []).map((coin) => `<tr class="rv-coin-row${coin.assetId === assetId ? " active" : ""}" data-pick="${esc(coin.assetId)}" tabindex="0">
      <th scope="row">${esc(coin.assetId.toUpperCase())}</th><td>${coin.rounds}</td><td>${num(coin.avgFirings)}</td><td>${coin.medianFirings ?? "--"}</td>
      <td>${coin.maxFirings}</td><td>${coin.over4}（${pct(coin.over4Pct)}）</td><td>${pct(coin.firstFiringWinPct)}</td></tr>`).join("");
  };

  const renderRounds = (rounds) => {
    const pages = Math.max(1, Math.ceil(rounds.length / PAGE));
    page = Math.min(page, pages - 1);
    const slice = rounds.slice(page * PAGE, page * PAGE + PAGE);
    set("[data-rounds-meta]", `最近 ${rounds.length} 场，最新在前`);
    set("[data-page]", `第 ${page + 1} / ${pages} 页`);
    el("[data-rounds-body]").innerHTML = slice.length ? slice.map((round) => {
      const chips = (round.sides || []).map((s, i) =>
        `<span class="rv-chip ${s === "UP" ? "rv-up" : "rv-down"}">${side(s)} ${num(round.seconds[i], 1)}s</span>`).join("");
      return `<tr><td>${beijing(round.startsAt)}</td><td class="${round.firings > 4 ? "rv-warn" : ""}"><b>${round.firings}</b></td>
        <td class="rv-chips">${chips || '<span class="rv-none">没有触发</span>'}</td><td>${side(round.winner)}</td></tr>`;
    }).join("") : `<tr><td colspan="4" class="rv-empty">暂无数据</td></tr>`;
  };

  const syncControls = () => {
    for (const coin of COINS) el(`[data-coin="${coin}"]`)?.setAttribute("aria-pressed", String(coin === assetId));
    for (const value of DAYS) el(`[data-days="${value}"]`)?.setAttribute("aria-pressed", String(value === days));
    const url = new URL(window.location.href);
    url.searchParams.set("assetId", assetId); url.searchParams.set("days", String(days));
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };

  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    try {
      const [data, overview] = await Promise.all([
        request(`/api/reversals?assetId=${encodeURIComponent(assetId)}&days=${days}`),
        request(`/api/reversals/overview?days=${days}`),
      ]);
      last = data;
      renderTotal(data.total || {});
      renderDays(data.days || []);
      renderDist((data.total || {}).distribution, (data.total || {}).rounds);
      renderLadder((data.total || {}).ladder);
      renderCoins(overview.coins);
      renderRounds(data.rounds || []);
      set("[data-source]", `已更新 ${format.clock()}`);
    } catch (error) {
      set("[data-source]", format.readableError(error && error.message, "统计暂不可用"));
    } finally {
      loading = false;
    }
  };

  root.addEventListener("click", (event) => {
    const target = event.target;
    const nav = target.closest("[data-preview-target]");
    if (nav) { navigate(nav.getAttribute("data-preview-target")); return; }
    const coin = target.closest("[data-coin]") || target.closest("[data-pick]");
    if (coin) { assetId = coin.getAttribute("data-coin") || coin.getAttribute("data-pick"); page = 0; syncControls(); load(); return; }
    const day = target.closest("[data-days]");
    if (day) { days = Number(day.getAttribute("data-days")); page = 0; syncControls(); load(); return; }
    if (target.closest("[data-prev]") && last) { page = Math.max(0, page - 1); renderRounds(last.rounds || []); }
    if (target.closest("[data-next]") && last) { page += 1; renderRounds(last.rounds || []); }
  });
  if (window.PolyPreviewStream) window.PolyPreviewStream.onUpdate("/api/reversals", () => load());
  syncControls();
  load();
})();
