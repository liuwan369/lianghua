/* Official rule snapshot, 2026-09-09. No wallet calls, persistence, or payouts. */
(() => {
  'use strict';
  const base = 'https://docs.polymarket.com/';
  const verified = '2026-09-09';
  const tiers = [
    {name:'未达档', min:0, rate:0, bonus:0},
    {name:'Bronze · 青铜', min:2000, rate:3, bonus:10},
    {name:'Silver · 白银', min:20000, rate:8, bonus:50},
    {name:'Gold · 黄金', min:200000, rate:18, bonus:250},
    {name:'Platinum · 铂金', min:1000000, rate:32, bonus:1500},
    {name:'Diamond · 钻石', min:4000000, rate:44, bonus:7500},
    {name:'Obsidian · 黑曜石', min:10000000, rate:50, bonus:25000}
  ];
  const fmt = n => n.toLocaleString('en-US', {maximumFractionDigits:2});
  const link = (path, title='官方规则') => `<a href="${base}${path}" target="_blank" rel="noopener noreferrer">${title} ↗</a>`;
  const ledger = '<div class="reward-ledger"><span>预计<b>--</b></span><span>待发放<b>--</b></span><span>已到账<b>--</b></span></div>';
  const programs = [
    {title:'吃单返佣', tag:'规则已核对 · 账户待核对', lead:'0% – 50% 手续费返还',
      text:'仅 Taker 成交累计近 30 天加权成交量（wV），Maker 成交不计档位。比例针对交易手续费，不是成交额。',
      detail:'wV = 成交金额 × (1 − 成交价) × 类别权重 × 官方活动倍数。Crypto 权重 2.3，Sports 1.0，Politics / Finance / Mentions / Tech 1.3，Economics / Culture / Weather / Other 1.7，Geopolitics 0。倍数需核对当期活动，不能自行假定有加成。每日 UTC 00:00（北京时间 08:00）更新及发放，最低累计发放额 1 pUSD。升级不追溯早先交易，实际生效以官方账户档位为准。近 30 天量减少后也可能降档。',
      source:'programs/taker-rebates', period:'文档生效：2026-05-28'},
    {title:'首次升级奖金', tag:'一次性奖励', lead:'10 – 25,000 pUSD / 档',
      text:'首次达到青铜、白银、黄金、铂金、钻石、黑曜石各档，奖金分别为 10、50、250、1,500、7,500、25,000 pUSD。',
      detail:'每个档位只奖励首次到达，不把反复升降档算成重复奖金。不预先累加所有奖金；应显示每档首次到达时间、官方确认及到账记录。当前账户的领取历史尚未获取。',
      source:'programs/taker-rebates', period:'文档生效：2026-05-28'},
    {title:'做市返佣', tag:'按市场奖励池份额', lead:'Crypto：20% 分配到做市池',
      text:'限价挂单提供流动性且被成交后才参与。20% 是手续费进入奖励池的比例，不是你成交额的 20%。',
      detail:'每笔手续费等价值 = 份数 × feeRate × p × (1−p)。个人日返佣 = 个人等价值 / 同市场总等价值 × 奖励池。Crypto 池比例 20%，Sports 15%，Finance / Politics / Economics / Culture / Weather / Other / Mentions / Tech 为 25%；免手续费的 Geopolitics 不适用。每日发放，最低累计 1 pUSD。实际计算须读取市场费用参数和官方账单。',
      source:'programs/maker-rebates', period:'当前文档快照 · 无固定个人比例'},
    {title:'流动性奖励', tag:'按有效挂单评分', lead:'价差、份数、双边深度共同评分',
      text:'无需等成交才评分；挂单需满足该市场最低奖励份数与最大允许价差。奖励占比来自你相对其他做市者的有效评分。',
      detail:'奖励份数门槛与交易最小订单量不是一回事。读取具体市场最低份数、最大价差（美分）、每日奖励池及起止日期，再显示当前挂单是否得分和个人份额。中间价在 0.10–0.90 范围内单边可折算得分；更极端价格要求双边有效流动性。UTC 00:00 日发放；文档规定低于 1 pUSD 不支付，不能承诺自动累计顺延。',
      source:'programs/liquidity-rewards', period:'逐市场配置 · 资格未接入'},
    {title:'赞助奖励 / 市场额外奖励', tag:'官方 API 有配置', lead:'平台奖励 + 赞助奖励',
      text:'官方奖励接口支持 sponsored 赞助池，并列出平台、赞助、总日奖励及赞助方数量。金额随市场与活动变化。',
      detail:'收益页分别展示来源、奖励资产、开始/结束日期、每日额度和个人到账。平台份额 + 赞助份额 = 总份额，不能把总额再加一次。专项活动若已包含在流动性池中，只作来源标签，不重复计收益。',
      source:'api-reference/rewards/get-current-active-rewards-configurations', period:'当期配置尚未查询'},
    {title:'邀请推荐奖励', tag:'需要符合推荐资格', lead:'直接 10% · 间接 5%',
      text:'按被推荐者扣除其档位返佣后的净交易手续费计算。推荐者需达到终身 10,000 美元成交量门槛。',
      detail:'新用户须在点击推荐链接后 30 天内注册。计奖截止为其注册后 30 天或达到 Platinum，先到者为准；Gold 仍计奖。每日 UTC 00:00 发放 pUSD。不是本人交易返佣，不能把自己账户间交易记为推荐收入。账户资格、有效推荐和到账均待核对。',
      source:'programs/referral-program', period:'文档生效：2026-05-28'},
    {title:'Builder 手续费收入', tag:'独立经营收入 · 非自营返佣', lead:'Taker ≤ 1% · Maker ≤ 0.5%',
      text:'为其他用户路由订单的应用可配置额外收费，默认 0。费用由用户支付，叠加平台手续费，不是平台凭空发奖金。',
      detail:'归属 Builder 收款账户，单独记经营收入；自己的交易账户支付的 Builder 费仍是成本，不能两边算收益。费率每 7 天最多改一次，安排后 3 天生效；显示当前费率及待生效版本。Builder 代码和资格没有接入，不能宣称本系统已收取或已获批。',
      source:'programs/builders/fees', period:'适用：对外提供交易应用'},
    {title:'Builder 周奖励 / Grants', tag:'需人工批准', lead:'按批准方案 · 无统一公开比例',
      text:'官方 Verified 档说明包括按量周奖励与 Grants，均 subject to approval。不是成交量一到就自动领取。',
      detail:'展示申请状态、批准编号、适用周期、有效归属量、批准金额、币种及到账。Unverified / Verified / Partner 是 Builder 身份层级，不能替代 Taker 交易档位。仅运行自营机器人不默认有这项收入。',
      source:'programs/builders/tiers', period:'批准及发放计划待核对'},
    {title:'持仓奖励', tag:'字段存在 · 规则待核对', lead:'暂不填写比例',
      text:'官方 MarketRewards 类型包含 holdingRewardsEnabled；本轮没有找到能确认当前利率、完整资格和付款规则的对应页面。',
      detail:'保留项目入口，但不填传闻利率、不将开关等于本账户有收益。需要补充官方当期规则、市场开关、有效持仓及账单证据；未核实前不估算、不计到账。',
      source:'market-data/market-details#liquidity-reward-settings', period:'规则待核对 · BTC 5 分钟适用性未知'}
  ];
  const card = p => `<article class="reward-card"><div class="reward-top"><h3>${p.title}</h3><span class="reward-status">${p.tag}</span></div><strong class="reward-lead">${p.lead}</strong><p>${p.text}</p>${ledger}<details><summary>资格、计算方式与发放规则</summary><p>${p.detail}</p></details><div class="reward-source">${link(p.source)}<span>${p.period}</span></div></article>`;
  const root = document.getElementById('reward-center');
  root.innerHTML = `
    <div class="head"><div><div class="eyebrow">PROFIT & REWARDS</div><h1>收益与奖励</h1><p>交易赚多少、奖励怎么算、距离下一档还有多少</p></div><span class="pill">官方规则核对：${verified}</span></div>
    <div class="reward-banner">演示页 · 已核对公开规则，未连接账户。金额、资格和活动进度尚未获取；-- 表示未知，不能视作 0 收益。</div>
    <nav class="reward-tabs" aria-label="收益内容"><a href="#reward-ledger-section">收益账单</a><a href="#reward-programs">返佣与奖励</a><a href="#reward-tier-section">档位进度</a><a href="#reward-events">专项活动</a><a href="#reward-payments">到账明细</a></nav>
    <section id="reward-ledger-section"><div class="section-title"><h2>收益账单</h2><div class="reward-controls"><label for="reward-period">统计周期</label><select id="reward-period"><option>今日</option><option>本月</option><option>近 30 天</option><option>全部历史</option></select><span id="reward-period-note" class="reward-caption" aria-live="polite">今日 · 账单未获取</span></div></div>
    <div class="stats">${[['已结算交易盈亏','未扣手续费'],['手续费与其他成本','平台费、Builder 费、实际其他成本'],['已到账交易返佣与奖励','不含预计、待发放和经营收入'],['最终净收益','账单不完整时不显示假合计']].map(([a,b])=>`<div class="stat"><label>${a}</label><strong>--</strong><small>${b}</small></div>`).join('')}</div>
    <p class="reward-caption">净收益 = 未扣费的已结算交易盈亏 − 实际费用 + 已到账交易返佣与奖励。若平台盈亏已含费用，不再重复扣费。未结算持仓另列；推荐和 Builder 收入单列经营账，不混进策略表现。</p></section>
    <section id="reward-programs"><h2 class="reward-subtitle">官方返佣与奖励计划</h2><p>项目全部保留。规则存在不等于账户已符合资格；以下数字是规则，不是你的收益。</p><div class="reward-grid">${programs.map(card).join('')}</div></section>
    <section id="reward-tier-section" class="panel"><div class="section-title"><h2>吃单档位与升级进度</h2><span class="reward-status">官方当前档位：未获取</span></div>
    <p class="reward-caption">近 30 天有效 wV：--　当前生效返佣：--　下一档还差：--　首次奖金领取记录：--</p>
    <div class="table-wrap"><table class="table reward-table"><thead><tr><th>档位</th><th>近 30 天 wV 门槛</th><th>手续费返还比例</th><th>首次升级奖金 pUSD</th></tr></thead><tbody>${tiers.map(t=>`<tr><td>${t.name}</td><td>${t.min ? fmt(t.min) : '低于 2,000'}</td><td>${t.rate}%</td><td>${t.bonus ? fmt(t.bonus) : '无'}</td></tr>`).join('')}</tbody></table></div>
    <div class="reward-preview"><div class="reward-inputs"><label for="reward-wv">试算近 30 天 wV（非账户数据）<input id="reward-wv" type="number" min="0" step="any" placeholder="例如：12000"></label><button class="reward-action" id="reward-example" type="button">查看 12,000 wV 示例</button><button class="reward-action" id="reward-clear" type="button">清空试算</button></div><output id="reward-tier-result" for="reward-wv" aria-live="polite">填入试算值后显示下一档差额，不修改策略或账户。</output><progress class="reward-progress" id="reward-progress" max="100" value="0" aria-label="下一档试算进度" hidden></progress></div>
    <p class="reward-caption">官方文档同时使用“到档后生效”和“下一次每日更新生效”的表述。界面以平台账户当前档位为准；试算跨线只提示待官方更新，不自动提高返佣。升级不追溯历史交易；滚动量到期后可能降档，宽限期未公布具体天数。试算奖金不能当作待到账奖金。</p>${link('programs/taker-rebates')}</section>
    <section id="reward-events"><h2 class="reward-subtitle">专项活动与历史活动</h2><p>活动作为独立来源显示，到账按唯一账单去重；已经包含在流动性池里的专项补贴不再加一次。</p><div class="reward-grid">
    <article class="reward-card"><div class="reward-top"><h3>Crypto TWAP 专项奖励</h3><span class="reward-status">文档期限已过 · 延期未核实</span></div><strong class="reward-lead">总额度上限 $1,000,000</strong><p>官方写明覆盖 8 月的 TWAP 加密市场。5 分钟池 $550,000，其中 BTC $300,000；15 分钟池 $350,000；4 小时池 $100,000。</p><p>现在是 9 月，不能当作当前活动。显示历史规则，当前有效资金池和账户可得额等待当期市场配置确认；池上限不是保证发放金额。</p><div class="reward-source">${link('programs/liquidity-rewards')}<span>本轮未发现延期依据</span></div></article>
    <article class="reward-card"><div class="reward-top"><h3>March Madness 流动性活动</h3><span class="reward-status">历史体育活动 · 不适用 BTC</span></div><strong class="reward-lead">官方公告 $2M+</strong><p>2026-03-17 更新公告；分赛前和赛中市场配置日奖励率，公告要求订单至少在簿 3.5 秒。不是所有市场通用等待规则。</p><p>仅保留历史说明和官方链接；不纳入当前 BTC 奖励估算。</p><div class="reward-source">${link('changelog/predictions','官方更新公告')}</div></article>
    <article class="reward-card"><div class="reward-top"><h3>当期新活动 / 加权倍数</h3><span class="reward-status">实时活动尚未接入</span></div><strong class="reward-lead">等待有效活动配置</strong><p>保留活动名称、适用市场、报名条件、奖励资产、起止日期、倍率、有效成交量和剩余门槛。未知倍率显示 --，不能套用旧活动。</p><p>本轮核对文档目录、奖励章节、公开 API 说明和更新公告；不宣称覆盖登录专属或临时定向活动。</p><div class="reward-source">${link('api-reference/rewards/get-current-active-rewards-configurations','当前奖励配置说明')}</div></article>
    </div></section>
    <details class="panel"><summary>其他产品的官方奖励（Perps，独立账本，不适用于 BTC 5 分钟预测市场）</summary><div class="reward-grid"><article class="reward-card"><h3>Perps 流动性奖励</h3><strong class="reward-lead">$75,000 / 日计划池</strong><p>各活跃永续市场均分预算，按做市参与、双边深度和在线率评分。近 7 天 maker 份额至少 1%；日周期 UTC 12:00 至次日 12:00。不是本系统预测市场收入。</p>${link('perps/liquidity-rewards')}</article><article class="reward-card"><h3>Perps 推荐奖励</h3><strong class="reward-lead">被推荐者手续费的 20%</strong><p>周发放、独立推荐码，非预测市场的 10% / 5% 计划；无单个推荐者收入上限。邀请名额随有效量升级，并非返佣比例随之升级。</p><details><summary>邀请名额档位</summary><p>起始 10 个；用完 10 个活跃邀请扩至总额 25。合计有效 Perps 量 $100,000 / $500,000 / $1,000,000 对应总邀请上限 100 / 250 / 500。合计量为自己和直接推荐者归属后的交易量，不含间接推荐。</p></details>${link('perps/referral-program')}</article></div></details>
    <section id="reward-payments" class="panel" style="margin-top:18px"><div class="section-title"><h2>到账明细与对账</h2><span class="reward-status">账户账单未接入</span></div><div class="table-wrap"><table class="table reward-table"><thead><tr><th>奖励项目</th><th>所属周期</th><th>资产 / 币种</th><th>金额</th><th>预计 / 待发放 / 已到账</th><th>到账凭证</th></tr></thead><tbody><tr><td colspan="6" class="reward-empty">尚未获取账单，不表示没有奖励。预计金额不会进入已到账合计。</td></tr></tbody></table></div><p class="reward-caption">核对账户、市场、周期、资产和付款凭证；同一笔到账只计一次。多个币种分开合计，缺少可靠换算价时不显示美元总额。API 收益累计值不自动当作转账到账证明。</p></section>
    <p class="reward-caption">核对日期 ${verified} · 文档快照，不自动刷新规则。公开规则可变；每次用于真实核算前必须重查有效期、市场参数及账户账单。</p>`;
  document.getElementById('open-income').addEventListener('click', () => {
    document.querySelector('[data-view="earnings"]').click();
    root.scrollIntoView({behavior:'smooth', block:'start'});
  });
  document.getElementById('reward-period').addEventListener('change', e => {
    document.getElementById('reward-period-note').textContent = `${e.target.value} · 账单未获取`;
  });
  const input = document.getElementById('reward-wv');
  const result = document.getElementById('reward-tier-result');
  const progress = document.getElementById('reward-progress');
  function update() {
    progress.hidden = true;
    if (!input.value.trim()) { result.textContent = '填入试算值后显示下一档差额，不修改策略或账户。'; return; }
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) { result.textContent = '请输入有效的非负 wV 数值。'; return; }
    const index = tiers.reduce((chosen,t,i) => value >= t.min ? i : chosen, 0);
    const current = tiers[index], next = tiers[index+1];
    const prefix = `试算 ${input.value} wV：${index === 0 ? '尚未达到青铜量门槛' : '达到 ' + current.name + ' 的量门槛'}，对应 ${current.rate}% 手续费返还规则；不代表官方已升档。`;
    if (!next) { result.textContent = prefix + '已达表内最高档。首次奖金是否可领需查历史，不重复计奖。'; return; }
    progress.hidden = false;
    progress.value = Math.min(100, (value-current.min)/(next.min-current.min)*100);
    const gap = next.min - value;
    const gapLabel = gap < 0.01 ? '<0.01' : '约 ' + fmt(gap);
    result.textContent = prefix + `距 ${next.name} 还差 ${gapLabel} wV；下一档 ${next.rate}%。首次到达的官方奖金为 ${fmt(next.bonus)} pUSD，是否可领待核对。进度条按当前档到下一档区间计算。`;
  }
  input.addEventListener('input', update);
  document.getElementById('reward-example').addEventListener('click', () => { input.value='12000'; update(); });
  document.getElementById('reward-clear').addEventListener('click', () => { input.value=''; update(); });
})();
