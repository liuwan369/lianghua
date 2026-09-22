import './overview-block.css';
import './auto-trade-block.css';

// src/auto-trade-block.ts
var root = document.querySelector("#auto-trade-block-root");
if (!root) throw new Error("auto trade block root missing");
const navItems = [
  ["\u25C8", "\u603B\u89C8", "overview.html"],
  ["\u25C7", "\u5E02\u573A", "market.html"],
  ["\u2197", "\u81EA\u52A8\u4EA4\u6613", "auto-trade.html"],
  ["\u25D2", "\u7B56\u7565", "strategy.html"],
  ["\u2699", "\u8BBE\u7F6E", ""]
] as const;
const navMarkup = navItems.map(([icon, label, target]) => `<button class="nav-item${label === "\u81EA\u52A8\u4EA4\u6613" ? " active" : ""}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === "\u81EA\u52A8\u4EA4\u6613" ? ' aria-current="page"' : ""}><span>${icon}</span>${label}</button>`).join("");
const depthRows = (prices: number[], sizes: number[], tone: string) => prices.map((price, index) => `<tr><td>${index + 1}</td><td class="depth-price ${tone}">${price.toFixed(3)}</td><td>${sizes[index].toFixed(1)}</td><td><span class="depth-bar ${tone}" style="--depth:${Math.round(sizes[index] / 62 * 100)}%"></span></td></tr>`).join('');
root.innerHTML = `
  <div class="overview-preview auto-trade-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand">
        <span class="brand-mark">P</span>
        <div><strong>POLYMARKET</strong><small>TRADING CONSOLE</small></div>
      </div>
      <div class="brand-card">
        <span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span>
        <strong>Polymarket</strong>
      </div>
      <p class="sidebar-copy">\u9762\u5411 BTC \u4E94\u5206\u949F\u53CD\u8F6C\u7B56\u7565\u7684\u5B9E\u65F6\u4EA4\u6613\u63A7\u5236\u53F0\u3002</p>
      <nav aria-label="\u81EA\u52A8\u4EA4\u6613\u9884\u89C8\u5BFC\u822A">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>\u539F\u578B\u9884\u89C8</span><small>\u6570\u636E\u5F85\u63A5\u5165</small></div>
    </aside>

    <main class="preview-main auto-trade-main">
      <header class="preview-header trade-header">
        <div class="hero-copy">
          <p class="eyebrow">LIVE CONTROL \xB7 BTC REVERSAL</p>
          <div class="hero-title-row"><h1>\u81EA\u52A8\u4EA4\u6613</h1><span class="language-chip">5 \u5206\u949F</span></div>
          <p class="subtitle">\u76D8\u53E3\u3001\u7B56\u7565\u5224\u65AD\u3001\u5F53\u524D\u6301\u4ED3\u548C\u8BA2\u5355\u72B6\u6001\u96C6\u4E2D\u67E5\u770B\uFF0C\u5B9E\u65F6\u6570\u636E\u5404\u81EA\u72EC\u7ACB\u66F4\u65B0\u3002</p>
          <div class="hero-actions">
            <button class="hero-button primary-action" type="button" data-action="start">\u542F\u52A8\u81EA\u52A8\u4EA4\u6613</button>
            <button class="hero-button" type="button" data-action="pause">\u6682\u505C\u65B0\u589E</button>
            <button class="hero-button exit-action" type="button" data-action="stop">\u505C\u6B62\u5E76\u64A4\u4F59\u91CF</button>
          </div>
        </div>
        <div class="trade-header-side">
          <span class="live-chip"><i></i><b data-live-status>\u8FD0\u884C\u4E2D</b><small data-live-clock>00:00:42</small></span>
          <div class="header-status-grid">
            <article class="header-status"><span>\u5F53\u524D\u5E02\u573A</span><strong>BTC / 5m UP-DOWN</strong></article>
            <article class="header-status"><span>\u6570\u636E\u8FDE\u63A5</span><strong class="status-good">WebSocket \u5DF2\u8FDE\u63A5</strong></article>
            <article class="header-status"><span>\u4EA4\u6613\u6A21\u5F0F</span><strong>\u5B9E\u76D8 \xB7 \u5355\u7B56\u7565</strong></article>
            <article class="header-status"><span>\u8D26\u6237\u4F59\u989D</span><strong>-- USDC</strong></article>
          </div>
        </div>
      </header>

      <section class="latency-panel" aria-labelledby="latency-title">
        <div class="panel-heading compact-heading">
          <div><p class="eyebrow">EXECUTION TELEMETRY</p><h2 id="latency-title">\u4EA4\u6613\u901F\u5EA6</h2></div>
          <div class="latency-heading-meta"><span class="sample-dot"></span><span>\u5F53\u524D\u8FD0\u884C p95</span><button type="button" class="quiet-button">\u67E5\u770B\u5168\u90E8\u5EF6\u8FDF</button></div>
        </div>
        <div class="latency-grid">
          <article class="latency-card"><span>\u884C\u60C5\u5230\u51B3\u7B56</span><strong><b data-latency="decision">84</b><em>ms</em></strong><small>WebSocket \u6536\u5230\u884C\u60C5\u5230\u7B56\u7565\u5B8C\u6210</small></article>
          <article class="latency-card"><span>\u4E0B\u5355\u786E\u8BA4</span><strong><b data-latency="order">126</b><em>ms</em></strong><small>HTTP \u53D1\u51FA\u8BA2\u5355\u5230\u5E73\u53F0\u786E\u8BA4</small></article>
          <article class="latency-card"><span>\u64A4\u5355\u786E\u8BA4</span><strong><b data-latency="cancel">112</b><em>ms</em></strong><small>\u53D1\u51FA\u64A4\u5355\u5230\u5E73\u53F0\u660E\u786E\u53D6\u6D88</small></article>
          <article class="latency-card latency-accent"><span>\u6574\u8F6E\u53CD\u5E94</span><strong><b data-latency="round">248</b><em>ms</em></strong><small>\u89E6\u53D1\u884C\u60C5\u6536\u5230\u5230\u8BA2\u5355\u786E\u8BA4</small></article>
        </div>
        <p class="latency-caption">\u5EF6\u8FDF\u53EA\u53CD\u6620\u4EE3\u7801\u94FE\u8DEF\uFF0C\u4E0D\u5305\u542B\u7B49\u5F85\u5BF9\u624B\u6210\u4EA4\u548C\u94FE\u4E0A\u786E\u8BA4\u3002\u65E0\u6837\u672C\u65F6\u663E\u793A --\u3002</p>
      </section>

      <section class="trade-summary-grid" aria-label="\u5F53\u524D\u7B56\u7565\u6458\u8981">
        <article class="summary-card"><div class="summary-icon blue-icon">\u25F7</div><div><span>\u5F53\u524D\u573A\u6B21</span><strong data-round>BTC-2026-09-21 14:05</strong><small data-countdown>\u8DDD\u7ED3\u675F 02:18</small></div></article>
        <article class="summary-card"><div class="summary-icon violet-icon">\u21AF</div><div><span>\u5F53\u524D\u9636\u6BB5</span><strong data-stage>\u89C2\u5BDF\u786E\u8BA4</strong><small>\u786E\u8BA4\u53CD\u8F6C <b data-confirmations>2</b> / 3 \u6B21</small></div></article>
        <article class="summary-card"><div class="summary-icon amber-icon">\u2192</div><div><span>\u4E0B\u4E00\u7B14</span><strong data-next>\u7B49\u5F85\u4FE1\u53F7</strong><small>\u53C2\u6570\u7248\u672C REV-001</small></div></article>
        <article class="summary-card"><div class="summary-icon green-icon">\u2713</div><div><span>\u7B56\u7565\u72B6\u6001</span><strong data-strategy-status>\u8FD0\u884C\u4E2D</strong><small>\u66F4\u65B0\u65F6\u95F4 <b data-status-age>0.8s</b></small></div></article>
      </section>

      <section class="trade-main-grid">
        <article class="trade-panel orderbook-panel" aria-labelledby="orderbook-title">
          <div class="panel-heading">
            <div><p class="eyebrow">LIVE ORDER BOOK</p><h2 id="orderbook-title">\u5F53\u524D\u76D8\u53E3</h2></div>
            <div class="book-live"><i></i><span>\u5B9E\u65F6</span><small data-book-age>0.3s</small></div>
          </div>
          <div class="quote-strip">
            <div class="quote-box up-quote"><span><i></i>UP \u4E70\u4E00 / \u5356\u4E00</span><strong><b data-quote="up-bid">0.486</b><em>/</em><b data-quote="up-ask">0.492</b></strong></div>
            <div class="quote-box down-quote"><span><i></i>DOWN \u4E70\u4E00 / \u5356\u4E00</span><strong><b data-quote="down-bid">0.508</b><em>/</em><b data-quote="down-ask">0.514</b></strong></div>
          </div>
          <div class="depth-toolbar"><div><strong>\u4E94\u6863\u6DF1\u5EA6</strong><span>\u4E70\u5356\u4E24\u4FA7\u5B9E\u65F6\u663E\u793A</span></div><span class="depth-source">\u516C\u5F00\u884C\u60C5 \xB7 \u9875\u9762\u53EA\u8BFB</span></div>
          <div class="depth-columns">
            <section class="depth-book up-depth" aria-label="UP \u4E94\u6863\u6DF1\u5EA6">
              <div class="depth-book-title"><span class="direction-dot up-dot"></span><strong>UP</strong><small>\u4E70\u5165\u65B9\u5411</small></div>
              <table class="depth-table"><thead><tr><th>\u6863\u4F4D</th><th>\u4EF7\u683C</th><th>\u6570\u91CF</th><th>\u6DF1\u5EA6</th></tr></thead><tbody data-depth="up">${depthRows([0.486, 0.483, 0.479, 0.474, 0.468], [18.4, 26.2, 41.8, 51.2, 61.7], "bid")}</tbody></table>
              <div class="depth-divider"><span>\u5356\u51FA</span><span>---</span></div>
              <table class="depth-table asks"><tbody>${depthRows([0.492, 0.496, 0.501, 0.507, 0.514], [12.7, 23.4, 31.8, 45.6, 56.8], "ask")}</tbody></table>
            </section>
            <section class="depth-book down-depth" aria-label="DOWN \u4E94\u6863\u6DF1\u5EA6">
              <div class="depth-book-title"><span class="direction-dot down-dot"></span><strong>DOWN</strong><small>\u5356\u51FA\u65B9\u5411</small></div>
              <table class="depth-table"><thead><tr><th>\u6863\u4F4D</th><th>\u4EF7\u683C</th><th>\u6570\u91CF</th><th>\u6DF1\u5EA6</th></tr></thead><tbody data-depth="down">${depthRows([0.508, 0.504, 0.499, 0.493, 0.487], [16.8, 29.6, 37.2, 48.4, 63.5], "bid")}</tbody></table>
              <div class="depth-divider"><span>\u5356\u51FA</span><span>---</span></div>
              <table class="depth-table asks"><tbody>${depthRows([0.514, 0.518, 0.523, 0.529, 0.536], [11.3, 21.9, 34.7, 43.5, 58.2], "ask")}</tbody></table>
            </section>
          </div>
          <div class="book-decision"><span class="decision-mark">\u21AF</span><div><span>\u4EA4\u6613\u5224\u65AD</span><strong data-decision>\u7B49\u5F85\u786E\u8BA4\uFF0C\u4E0D\u4E0B\u5355</strong><small data-decision-reason>\u53CD\u8F6C\u4FE1\u53F7\u9700\u8981\u8FDE\u7EED\u786E\u8BA4\uFF0C\u5F53\u524D\u76D8\u53E3\u4EC5\u7528\u4E8E\u89C2\u5BDF\u3002</small></div><b class="decision-state" data-decision-state>\u89C2\u5BDF\u4E2D</b></div>
        </article>

        <article class="trade-panel position-panel" aria-labelledby="position-title">
          <div class="panel-heading">
            <div><p class="eyebrow">ROUND POSITION</p><h2 id="position-title">\u672C\u573A\u6301\u4ED3\u4E0E\u7ED3\u679C</h2></div>
            <span class="panel-meta">\u5F53\u524D\u573A\u6B21 \xB7 \u672A\u7ED3\u7B97</span>
          </div>
          <div class="position-hero"><div><span>\u672C\u573A\u51C0\u6295\u5165</span><strong data-invested>12.42 <em>USDC</em></strong></div><span class="position-badge">\u98CE\u9669\u53D7\u63A7</span></div>
          <div class="holding-grid">
            <div class="holding-item up-holding"><span>UP \u4EFD\u989D</span><strong data-holding="up">18.50</strong><small>\u5747\u4EF7 <b data-average="up">0.482</b></small></div>
            <div class="holding-item down-holding"><span>DOWN \u4EFD\u989D</span><strong data-holding="down">7.00</strong><small>\u5747\u4EF7 <b data-average="down">0.511</b></small></div>
          </div>
          <div class="result-grid"><div><span>\u5DF2\u4E70\u5165 / \u8BA2\u5355\u5360\u7528</span><strong><b data-bought>25.50</b> / <b data-occupied>12.42</b> USDC</strong></div><div><span>UP \u80DC / DOWN \u80DC\u9884\u8BA1\u7ED3\u679C</span><strong class="result-values"><b data-outcome="up">+5.31</b><em>/</em><b data-outcome="down">-3.58</b> USDC</strong></div></div>
          <div class="stage-section">
            <div class="stage-heading"><div><span>\u9636\u6BB5\u8FDB\u5EA6</span><small>\u9636\u6BB5\u72B6\u6001\u5F52\u5165\u672C\u573A\u7ED3\u679C</small></div><b data-stage-progress>2 / 4</b></div>
            <div class="stage-track"><i data-progress-fill></i></div>
            <ol class="stage-timeline" data-stage-timeline>
              <li class="complete"><span>\u2713</span><div><strong>\u8BFB\u53D6\u573A\u6B21</strong><small>\u5DF2\u9501\u5B9A\u5F53\u524D BTC \u4E94\u5206\u949F\u5E02\u573A</small></div><time>14:05:00</time></li>
              <li class="complete"><span>\u2713</span><div><strong>\u91C7\u96C6\u76D8\u53E3</strong><small>\u53CC\u8FB9\u4E94\u6863\u6DF1\u5EA6\u5DF2\u540C\u6B65</small></div><time>14:05:04</time></li>
              <li class="current"><span>3</span><div><strong>\u89C2\u5BDF\u786E\u8BA4</strong><small>\u7B49\u5F85\u7B2C 3 \u6B21\u53CD\u8F6C\u786E\u8BA4</small></div><time>\u8FDB\u884C\u4E2D</time></li>
              <li><span>4</span><div><strong>\u6267\u884C\u4E0E\u7ED3\u7B97</strong><small>\u786E\u8BA4\u540E\u624D\u5141\u8BB8\u8FDB\u5165\u4E0B\u5355\u9636\u6BB5</small></div><time>\u5F85\u8FDB\u5165</time></li>
            </ol>
          </div>
          <p class="result-note"><span class="info-dot">i</span>\u9884\u8BA1\u7ED3\u679C\u6309\u5DF2\u6210\u4EA4\u4EFD\u989D\u548C\u5B9E\u9645\u6210\u672C\u8BA1\u7B97\uFF0C\u6700\u7EC8\u4EE5\u5B98\u65B9\u7ED3\u679C\u548C\u5230\u8D26\u4E3A\u51C6\u3002</p>
        </article>
      </section>

      <section class="orders-panel trade-panel" aria-labelledby="orders-title">
        <div class="panel-heading">
          <div><p class="eyebrow">ORDER LIFECYCLE</p><h2 id="orders-title">\u5F53\u524D\u8FD0\u884C\u8BA2\u5355</h2></div>
          <div class="orders-meta"><span class="orders-count"><b data-order-count>2</b> \u4E2A\u8BA2\u5355</span><button type="button" class="quiet-button">\u67E5\u770B\u5168\u90E8</button></div>
        </div>
        <div class="orders-table-wrap"><table class="orders-table"><thead><tr><th>\u65F6\u95F4</th><th>\u65B9\u5411</th><th>\u4EF7\u683C</th><th>\u6570\u91CF</th><th>\u6210\u4EA4\u989D</th><th>\u72B6\u6001</th></tr></thead><tbody><tr><td>14:05:12.842</td><td><span class="order-direction up-text">UP \u4E70\u5165</span></td><td>0.482</td><td>18.50</td><td>8.92 USDC</td><td><span class="order-status filled">\u5DF2\u6210\u4EA4</span></td></tr><tr><td>14:05:13.105</td><td><span class="order-direction down-text">DOWN \u4E70\u5165</span></td><td>0.511</td><td>7.00</td><td>3.50 USDC</td><td><span class="order-status pending">\u90E8\u5206\u6210\u4EA4</span></td></tr></tbody></table></div>
      </section>

      <section class="activity-panel trade-panel" aria-labelledby="activity-title">
        <div class="panel-heading"><div><p class="eyebrow">RUN ACTIVITY</p><h2 id="activity-title">\u6700\u8FD1\u52A8\u4F5C</h2></div><span class="panel-meta">\u5F53\u524D\u8FD0\u884C\u4E8B\u4EF6</span></div>
        <ol class="activity-list" aria-live="polite"><li><time>14:05:13.105</time><span class="activity-icon pending-icon">\u2197</span><div><strong>DOWN \u4E70\u5165\u8BA2\u5355\u90E8\u5206\u6210\u4EA4</strong><small>7.00 \u4EFD \xB7 \u6210\u4EA4\u5747\u4EF7 0.511 \xB7 \u8BA2\u5355\u5360\u7528 3.50 USDC</small></div><b class="activity-tag pending-tag">\u90E8\u5206\u6210\u4EA4</b></li><li><time>14:05:12.842</time><span class="activity-icon good-icon">\u2713</span><div><strong>UP \u4E70\u5165\u8BA2\u5355\u5DF2\u6210\u4EA4</strong><small>18.50 \u4EFD \xB7 \u6210\u4EA4\u5747\u4EF7 0.482 \xB7 \u8BA2\u5355\u786E\u8BA4\u8017\u65F6 126ms</small></div><b class="activity-tag good-tag">\u5DF2\u5B8C\u6210</b></li><li><time>14:05:08.440</time><span class="activity-icon info-icon">i</span><div><strong>\u53CD\u8F6C\u786E\u8BA4\u7B2C 2 \u6B21</strong><small>\u76D8\u53E3\u4EF7\u5DEE 0.006 \xB7 \u7B49\u5F85\u8FDE\u7EED\u4FE1\u53F7</small></div><b class="activity-tag info-tag">\u89C2\u5BDF\u4E2D</b></li></ol>
      </section>
    </main>
  </div>
`;
const text = (selector: string, value: string) => {
  const node = document.querySelector<HTMLElement>(selector);
  if (node) node.textContent = value;
};
const pulse = (selector: string) => {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) return;
  node.classList.remove("value-updated");
  void node.offsetWidth;
  node.classList.add("value-updated");
};
var tick = 0;
var seconds = 42;
var base = {
  upBid: 0.486,
  upAsk: 0.492,
  downBid: 0.508,
  downAsk: 0.514
};
var updateLiveData = () => {
  tick += 1;
  seconds += 1;
  const wave = Math.sin(tick / 3) * 15e-4;
  const quotes = {
    upBid: base.upBid + wave,
    upAsk: base.upAsk + wave,
    downBid: base.downBid - wave,
    downAsk: base.downAsk - wave
  };
  for (const [key, value] of Object.entries(quotes)) {
    text(`[data-quote="${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}"]`, value.toFixed(3));
    pulse(`[data-quote="${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}"]`);
  }
  text("[data-book-age]", `${(0.2 + tick % 4 * 0.1).toFixed(1)}s`);
  text("[data-status-age]", `${(0.4 + tick % 8 * 0.1).toFixed(1)}s`);
  const remaining = Math.max(0, 138 - tick);
  text("[data-countdown]", `\u8DDD\u7ED3\u675F ${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`);
  text("[data-live-clock]", `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`);
  const latencies = {
    decision: 84 + Math.round(Math.sin(tick / 4) * 7),
    order: 126 + Math.round(Math.sin(tick / 5) * 12),
    cancel: 112 + Math.round(Math.cos(tick / 6) * 9),
    round: 248 + Math.round(Math.sin(tick / 5) * 14)
  };
  for (const [key, value] of Object.entries(latencies)) {
    text(`[data-latency="${key}"]`, String(value));
    pulse(`[data-latency="${key}"]`);
  }
};
document.querySelectorAll<HTMLElement>('[data-action]').forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    const status = action === "start" ? "\u8FD0\u884C\u4E2D" : action === "pause" ? "\u5DF2\u6682\u505C\u65B0\u589E" : "\u5DF2\u505C\u6B62";
    text("[data-live-status]", status);
    text("[data-strategy-status]", status);
    document.querySelectorAll("[data-action]").forEach((item) => item.classList.remove("is-selected"));
    button.classList.add("is-selected");
  });
});
document.querySelectorAll<HTMLElement>('[data-preview-nav]').forEach((button) => {
  button.addEventListener('click', () => {
    const target = button.dataset.previewTarget;
    if (target) {
      window.location.href = target;
      return;
    }
    document.querySelectorAll<HTMLElement>('[data-preview-nav]').forEach((item) => {
      item.classList.toggle('active', item === button);
      if (item === button) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  });
});
window.setInterval(updateLiveData, 1e3);

