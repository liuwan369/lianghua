import './overview-block.css';
import './market-block.css';

type Market = {
  id: string;
  symbol: string;
  category: 'crypto' | 'weather' | 'macro';
  categoryLabel: string;
  duration: '5m' | '15m' | '30m' | '1h';
  durationLabel: string;
  title: string;
  close: string;
  remaining: string;
  yes: number;
  no: number;
  volume: number;
  liquidity: number;
  spread: number;
  eligible: boolean;
  status: string;
};

const markets: Market[] = [
  { id: 'btc-5m', symbol: 'BTC', category: 'crypto', categoryLabel: '虚拟货币', duration: '5m', durationLabel: '5 分钟', title: '比特币价格在本场结束时会上涨吗？', close: '14:10:00', remaining: '02:18', yes: 0.486, no: 0.514, volume: 284600, liquidity: 68400, spread: 0.006, eligible: true, status: '策略可用' },
  { id: 'eth-5m', symbol: 'ETH', category: 'crypto', categoryLabel: '虚拟货币', duration: '5m', durationLabel: '5 分钟', title: '以太坊价格在本场结束时会上涨吗？', close: '14:10:00', remaining: '02:18', yes: 0.521, no: 0.479, volume: 176300, liquidity: 42900, spread: 0.008, eligible: true, status: '策略可用' },
  { id: 'btc-15m', symbol: 'BTC', category: 'crypto', categoryLabel: '虚拟货币', duration: '15m', durationLabel: '15 分钟', title: '比特币价格在 15 分钟后会上涨吗？', close: '14:20:00', remaining: '12:18', yes: 0.503, no: 0.497, volume: 119800, liquidity: 31500, spread: 0.011, eligible: true, status: '策略可用' },
  { id: 'nyc-temp-15m', symbol: 'TEMP', category: 'weather', categoryLabel: '天气', duration: '15m', durationLabel: '15 分钟', title: '纽约当前小时温度会高于 22°C 吗？', close: '14:20:00', remaining: '12:18', yes: 0.612, no: 0.388, volume: 88200, liquidity: 9600, spread: 0.026, eligible: false, status: '适配器待接入' },
  { id: 'fed-1h', symbol: 'MACRO', category: 'macro', categoryLabel: '宏观', duration: '1h', durationLabel: '1 小时', title: '本小时美元指数会高于开盘价吗？', close: '15:00:00', remaining: '52:18', yes: 0.478, no: 0.522, volume: 51200, liquidity: 7400, spread: 0.031, eligible: false, status: '适配器待接入' },
];

const root = document.querySelector<HTMLElement>('#market-block-root');
if (!root) throw new Error('market block root missing');

const navItems = [
  ['◈', '总览', 'overview.html'],
  ['◇', '市场', 'market.html'],
  ['↗', '自动交易', 'auto-trade.html'],
  ['◒', '策略', 'strategy.html'],
  ['⚙', '设置', ''],
] as const;
const navMarkup = navItems.map(([icon, label, target]) => `<button class="nav-item${label === '市场' ? ' active' : ''}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === '市场' ? ' aria-current="page"' : ''}><span>${icon}</span>${label}</button>`).join('');

root.innerHTML = `
  <div class="overview-preview market-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>TRADING CONSOLE</small></div></div>
      <div class="brand-card"><span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span><strong>Polymarket</strong></div>
      <p class="sidebar-copy">选择符合条件的短周期 YES / NO 市场。</p>
      <nav aria-label="市场设计稿导航">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>原型预览</span><small>数据待接入</small></div>
    </aside>

    <main class="preview-main market-main">
      <header class="preview-header market-header">
        <div class="hero-copy"><p class="eyebrow">MARKET DISCOVERY</p><div class="hero-title-row"><h1>市场</h1><span class="language-chip">YES / NO</span></div><p class="subtitle">从短周期二元市场中选择一个当前交易对象，再交给自动交易执行。</p><div class="market-header-actions"><span class="market-note"><i></i>只展示公开行情 · 设计稿演示</span><button class="hero-button" type="button" data-refresh-markets>刷新市场</button></div></div>
        <div class="market-header-side"><div class="header-status-grid"><article class="header-status"><span>候选市场</span><strong data-market-count>5 个</strong></article><article class="header-status"><span>可用市场</span><strong class="status-good" data-market-eligible>3 个</strong></article><article class="header-status"><span>当前市场</span><strong data-current-market>未选择</strong></article><article class="header-status"><span>数据状态</span><strong class="status-good">行情正常</strong></article></div></div>
      </header>

      <section class="market-filter-panel" aria-label="市场筛选">
        <div class="filter-heading"><div><p class="eyebrow">FILTER & RANK</p><h2>寻找可交易市场</h2></div><span class="filter-result" data-filter-result>显示 5 个市场</span></div>
        <div class="filter-groups"><div class="filter-group"><span>周期</span><div class="filter-chips" data-filter-group="duration"><button class="filter-chip active" data-filter="duration" data-value="all">全部</button><button class="filter-chip" data-filter="duration" data-value="5m">5 分钟</button><button class="filter-chip" data-filter="duration" data-value="15m">15 分钟</button><button class="filter-chip" data-filter="duration" data-value="30m">30 分钟</button><button class="filter-chip" data-filter="duration" data-value="1h">1 小时</button></div></div><div class="filter-group"><span>类别</span><div class="filter-chips" data-filter-group="category"><button class="filter-chip active" data-filter="category" data-value="all">全部</button><button class="filter-chip" data-filter="category" data-value="crypto">虚拟货币</button><button class="filter-chip" data-filter="category" data-value="weather">天气</button><button class="filter-chip" data-filter="category" data-value="macro">宏观</button></div></div><label class="sort-control"><span>排序</span><select data-sort><option value="volume">交易量最高</option><option value="liquidity">流动性最高</option><option value="remaining">最先结束</option></select></label></div>
      </section>

      <section class="market-layout">
        <div class="market-list-panel">
          <div class="list-heading"><div><p class="eyebrow">OPEN MARKETS</p><h2>短周期市场</h2></div><span class="list-caption">按当前筛选排序</span></div>
          <div class="market-list" data-market-list aria-live="polite"></div>
          <div class="list-footnote"><span class="info-dot">i</span><span>交易量用于排序，是否可交易还要同时满足流动性、价差、深度和结算规则检查。</span></div>
        </div>

        <aside class="market-detail-panel" aria-labelledby="market-detail-title">
          <div class="detail-heading"><div><p class="eyebrow">SELECTED MARKET</p><h2 id="market-detail-title" data-detail-title>比特币价格在本场结束时会上涨吗？</h2></div><span class="detail-state eligible" data-detail-state>策略可用</span></div>
          <div class="detail-meta"><span data-detail-category>虚拟货币</span><span data-detail-duration>5 分钟</span><span>结束 <b data-detail-close>14:10:00</b></span></div>
          <div class="detail-quote-grid"><div class="detail-quote yes-quote"><div><span class="outcome-dot"></span><span>YES</span></div><strong data-detail-yes>0.486</strong><small>买入价 · 46.8%</small></div><div class="detail-quote no-quote"><div><span class="outcome-dot"></span><span>NO</span></div><strong data-detail-no>0.514</strong><small>买入价 · 53.2%</small></div></div>
          <div class="detail-stats"><div><span>剩余时间</span><strong data-detail-remaining>02:18</strong></div><div><span>交易量</span><strong data-detail-volume>$284.6K</strong></div><div><span>流动性</span><strong data-detail-liquidity>$68.4K</strong></div><div><span>买卖价差</span><strong data-detail-spread>0.6¢</strong></div></div>
          <section class="readiness-section"><div class="readiness-heading"><span>策略准备检查</span><small data-readiness-summary>4 / 4 通过</small></div><ul class="readiness-list" data-readiness-list><li class="passed"><i>✓</i><span>YES / NO 结果完整</span><b>通过</b></li><li class="passed"><i>✓</i><span>盘口数据新鲜</span><b>通过</b></li><li class="passed"><i>✓</i><span>流动性满足最低要求</span><b>通过</b></li><li class="passed"><i>✓</i><span>结算时间和规则明确</span><b>通过</b></li></ul></section>
          <div class="detail-action"><button class="select-market-button" type="button" data-select-market>设为当前市场</button><small data-detail-action-note>设置后到自动交易页启动策略。</small></div>
        </aside>
      </section>
    </main>
  </div>
`;

const text = (selector: string, value: string) => { const node = document.querySelector<HTMLElement>(selector); if (node) node.textContent = value; };
const money = (value: number) => value >= 1000 ? `$${(value / 1000).toFixed(1)}K` : `$${value.toFixed(0)}`;
const selected = { market: markets[0], duration: 'all', category: 'all', sort: 'volume' };

document.querySelectorAll<HTMLElement>('[data-preview-nav]').forEach((button) => button.addEventListener('click', () => { const target = button.dataset.previewTarget; if (target) window.location.href = target; }));

const marketRow = (market: Market) => `<button class="market-row${market.id === selected.market.id ? ' selected' : ''}" type="button" data-market-id="${market.id}"><span class="market-symbol ${market.category}">${market.symbol}</span><span class="market-row-main"><strong>${market.title}</strong><small><b>${market.categoryLabel}</b><b>${market.durationLabel}</b><span>结束 ${market.close}</span></small></span><span class="market-row-price"><b>YES ${market.yes.toFixed(3)}</b><b>NO ${market.no.toFixed(3)}</b></span><span class="market-row-stats"><b>${money(market.volume)}</b><small>交易量</small></span><span class="market-row-state ${market.eligible ? 'ready' : 'waiting'}">${market.status}</span></button>`;

const renderList = () => {
  const filtered = markets.filter((market) => (selected.duration === 'all' || market.duration === selected.duration) && (selected.category === 'all' || market.category === selected.category)).sort((a, b) => selected.sort === 'liquidity' ? b.liquidity - a.liquidity : selected.sort === 'remaining' ? a.remaining.localeCompare(b.remaining) : b.volume - a.volume);
  if (filtered.length && !filtered.some((market) => market.id === selected.market.id)) selected.market = filtered[0];
  const list = document.querySelector<HTMLElement>('[data-market-list]');
  if (!list) return;
  list.innerHTML = filtered.length ? filtered.map(marketRow).join('') : '<div class="market-empty"><span>⌁</span><strong>没有符合条件的市场</strong><small>调整周期或类别筛选后再试。</small></div>';
  text('[data-filter-result]', `显示 ${filtered.length} 个市场`);
  list.querySelectorAll<HTMLElement>('[data-market-id]').forEach((row) => row.addEventListener('click', () => { const market = markets.find((item) => item.id === row.dataset.marketId); if (market) { selected.market = market; renderList(); renderDetail(); } }));
};

const renderDetail = () => {
  const market = selected.market;
  text('[data-detail-title]', market.title); text('[data-detail-category]', market.categoryLabel); text('[data-detail-duration]', market.durationLabel); text('[data-detail-close]', market.close); text('[data-detail-yes]', market.yes.toFixed(3)); text('[data-detail-no]', market.no.toFixed(3)); text('[data-detail-remaining]', market.remaining); text('[data-detail-volume]', money(market.volume)); text('[data-detail-liquidity]', money(market.liquidity)); text('[data-detail-spread]', `${(market.spread * 100).toFixed(1)}¢`);
  const state = document.querySelector<HTMLElement>('[data-detail-state]'); state?.classList.toggle('eligible', market.eligible); state?.classList.toggle('waiting', !market.eligible); if (state) state.textContent = market.status;
  const list = document.querySelector<HTMLElement>('[data-readiness-list]');
  if (list) list.innerHTML = market.eligible ? '<li class="passed"><i>✓</i><span>YES / NO 结果完整</span><b>通过</b></li><li class="passed"><i>✓</i><span>盘口数据新鲜</span><b>通过</b></li><li class="passed"><i>✓</i><span>流动性满足最低要求</span><b>通过</b></li><li class="passed"><i>✓</i><span>结算时间和规则明确</span><b>通过</b></li>' : '<li class="passed"><i>✓</i><span>YES / NO 结果完整</span><b>通过</b></li><li class="passed"><i>✓</i><span>盘口数据新鲜</span><b>通过</b></li><li class="failed"><i>!</i><span>市场适配器</span><b>待接入</b></li><li class="failed"><i>!</i><span>策略运行条件</span><b>未通过</b></li>';
  text('[data-readiness-summary]', market.eligible ? '4 / 4 通过' : '2 / 4 通过');
  const button = document.querySelector<HTMLButtonElement>('[data-select-market]'); if (button) { button.disabled = !market.eligible; button.textContent = market.eligible ? '设为当前市场' : '当前市场暂不可用'; }
  text('[data-detail-action-note]', market.eligible ? '设置后到自动交易页启动策略。' : '该类别暂未接入策略适配器。');
};

document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => button.addEventListener('click', () => { const group = button.dataset.filter; if (group === 'duration') selected.duration = button.dataset.value || 'all'; if (group === 'category') selected.category = button.dataset.value || 'all'; document.querySelectorAll(`[data-filter="${group}"]`).forEach((item) => item.classList.toggle('active', item === button)); renderList(); renderDetail(); }));
document.querySelector<HTMLSelectElement>('[data-sort]')?.addEventListener('change', (event) => { selected.sort = (event.target as HTMLSelectElement).value; renderList(); renderDetail(); });
document.querySelector('[data-select-market]')?.addEventListener('click', () => { text('[data-current-market]', selected.market.symbol + ' · ' + selected.market.durationLabel); text('[data-detail-action-note]', '已设为当前市场，可前往自动交易启动。'); const button = document.querySelector<HTMLButtonElement>('[data-select-market]'); if (button) button.textContent = '当前市场已选中'; button?.classList.add('selected'); });
document.querySelector('[data-refresh-markets]')?.addEventListener('click', () => { text('[data-filter-result]', '市场已刷新 · 演示数据'); renderList(); });
renderList(); renderDetail();
