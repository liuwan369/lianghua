import './overview-block.css';

const root = document.querySelector<HTMLElement>('#overview-block-root');
if (!root) throw new Error('overview block root missing');

const navItems = [
  ['◈', '总览', 'overview.html'],
  ['◇', '市场', 'market.html'],
  ['↗', '自动交易', 'auto-trade.html'],
  ['◒', '策略', 'strategy.html'],
  ['⚙', '设置', ''],
] as const;

const navMarkup = navItems
  .map(([icon, label, target]) => `<button class="nav-item${label === '总览' ? ' active' : ''}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === '总览' ? ' aria-current="page"' : ''}><span>${icon}</span>${label}</button>`)
  .join('');

root.innerHTML = `
  <div class="overview-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand">
        <span class="brand-mark">P</span>
        <div><strong>POLYMARKET</strong><small>TRADING CONSOLE</small></div>
      </div>
      <div class="brand-card">
        <span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span>
        <strong>Polymarket</strong>
      </div>
      <p class="sidebar-copy">面向 BTC 五分钟反转策略的交易控制台总览。</p>
      <nav aria-label="总览设计稿导航">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>原型预览</span><small>数据待接入</small></div>
    </aside>

    <main class="preview-main">
      <header class="preview-header">
        <div class="hero-copy">
          <p class="eyebrow">DASHBOARD CENTER</p>
          <div class="hero-title-row"><h1>总览</h1><span class="language-chip">简中</span></div>
          <p class="subtitle">查看当前交易状态、账户摘要、服务器状态和运行事件。</p>
          <div class="hero-actions"><button class="hero-button primary-action" type="button">一键启动自动化交易</button><button class="hero-button" type="button">保存配置</button><button class="hero-button" type="button">刷新状态</button><button class="hero-button exit-action" type="button">退出程序</button></div>
        </div>
        <div class="header-tools"><div class="header-status-grid">
          <article class="header-status"><span>当前品种</span><strong>比特币 5 分钟涨跌</strong></article>
          <article class="header-status"><span>自动化状态</span><strong>未启动</strong></article>
          <article class="header-status"><span>账户总资产</span><strong>--</strong></article>
          <article class="header-status"><span>可用余额</span><strong>--</strong></article>
        </div></div>
      </header>

      <section class="metrics-panel" aria-labelledby="metrics-title">
        <div class="panel-heading"><div><p class="eyebrow">PERFORMANCE SNAPSHOT</p><h2 id="metrics-title">交易统计</h2></div><span class="panel-meta">当前账户 · 只读摘要</span></div>
        <div class="metrics-grid">
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark blue-mark">单</span><div><h3>订单数</h3><p>已记录的订单数量</p></div></div><strong class="metric-primary">0</strong><dl class="metric-rows"><div><dt>今日</dt><dd>0</dd></div><div><dt>当月</dt><dd>0</dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark amber-mark">盈</span><div><h3>盈 / 亏</h3><p>胜负场次统计</p></div></div><strong class="metric-primary">0 <em>/</em> 0</strong><dl class="metric-rows"><div><dt>今日</dt><dd>0 / 0</dd></div><div><dt>当月</dt><dd>0 / 0</dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark green-mark">率</span><div><h3>胜率</h3><p>已完成场次的比例</p></div></div><strong class="metric-primary">0.00<em>%</em></strong><dl class="metric-rows"><div><dt>今日</dt><dd>0.00%</dd></div><div><dt>当月</dt><dd>0.00%</dd></div></dl></article>
          <article class="metric-group"><div class="metric-heading"><span class="metric-mark violet-mark">净</span><div><h3>累计盈利</h3><p>已结算净结果</p></div></div><strong class="metric-primary">0.00 <em>μUSD</em></strong><dl class="metric-rows"><div><dt>今日</dt><dd>0.00 μUSD</dd></div><div><dt>当月</dt><dd>0.00 μUSD</dd></div></dl></article>
        </div>
        <div class="metrics-footnote"><span class="info-dot">i</span><span>仅统计已取得的真实记录；后端接入后再显示真实账户数据。</span></div>
      </section>

      <section class="server-panel" aria-labelledby="server-title">
        <div class="panel-heading"><div><h2 id="server-title">服务器状态</h2></div><span class="panel-meta server-expired">服务器状态待接入</span></div>
        <div class="server-metrics"><div><span>CPU</span><strong>-- <em>· 2 核</em></strong></div><div><span>内存</span><strong>--</strong></div><div><span>磁盘</span><strong>--</strong></div><div><span>负载 1 / 5 / 15 分钟</span><strong>-- / -- / --</strong></div></div>
        <div class="server-services"><div><span>控制台</span><strong class="service-good">设计稿运行中</strong><small>数据待接入</small></div><div><span>行情采集</span><strong>待接入</strong><small>--</small></div><div><span>交易进程</span><strong>未启动</strong><small>--</small></div><div><span>账本投影</span><strong>待接入</strong><small>--</small></div></div>
      </section>

      <section class="log-panel" aria-labelledby="log-title">
        <div class="panel-heading"><div><p class="eyebrow">SERVICE ACTIVITY</p><h2 id="log-title">运行日志</h2></div><div class="log-state"><span class="state-dot"></span><span>设计稿预览</span><small>本地示例</small></div></div>
        <ol class="log-list" aria-live="polite">
          <li class="log-entry"><time>14:02:18.440</time><span class="log-icon good-icon">✓</span><div><strong>行情采集服务已连接</strong><p>等待当前 BTC 五分钟场次</p></div><span class="log-status good-text">已连接</span></li>
          <li class="log-entry"><time>14:02:17.902</time><span class="log-icon info-icon">i</span><div><strong>控制台已连接到配置</strong><p>btc-reversal · 配置版本 REV-001</p></div><span class="log-status info-text">已加载</span></li>
          <li class="log-entry"><time>14:02:15.106</time><span class="log-icon neutral-icon">•</span><div><strong>自动交易尚未启动</strong><p>已完成布局初始化，等待启动指令</p></div><span class="log-status muted-text">空闲</span></li>
          <li class="log-entry"><time>14:02:09.731</time><span class="log-icon good-icon">✓</span><div><strong>账户状态读取完成</strong><p>可用余额等待真实账户快照</p></div><span class="log-status good-text">完成</span></li>
        </ol>
        <div class="log-footer"><span><i class="tiny-dot"></i>只显示当前运行相关事件</span><span>历史事件放在订单与运行记录中</span></div>
      </section>
    </main>
  </div>
`;

document.querySelectorAll<HTMLElement>('[data-preview-nav]').forEach((button) => {
  button.addEventListener('click', () => {
    const target = button.dataset.previewTarget;
    if (target) window.location.href = target;
  });
});
