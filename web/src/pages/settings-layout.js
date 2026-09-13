// Original approved form markup; no demo persistence or execution.
export function mountSettings() {
  const defaults = Object.freeze({capital:100, order:5, market:10, target:0.98, cap:0.99,
    inventoryMode:'auto', inventory:10, life:15, hedgeWait:10, stopOpen:30, stopHedge:10,
    layers:'single', spacing:0.01, fallback:'wait', slippage:0.01, hedgeLoss:1,
    mode:'paper', duration:0, submitted:100, dailyLoss:10, concurrency:1,
    disconnect:'stop', stale:250, stopPolicy:'hold', effective:'restart', maxOrders:50,
    pairCost:0.99, decisionInterval:0, defensiveCancel:0});
  const fields = [
    ['pairCost','引擎配对成本参数','USD / 对','对应现有引擎的配对与加仓成本参数。补仓仍有独立规则，不代表补仓成本硬上限。',0.9,1],
    ['decisionInterval','最短决策间隔','毫秒','限制策略重算频率；0 表示每次有效盘口更新均可判断，不改变行情过期阈值。',0,60000],
    ['defensiveCancel','逆向波动撤单阈值','基点','相对挂单时 BTC 价格的逆向变化阈值；1 基点为 0.01%，0 关闭此规则。撤单请求仍需确认。',0,1000],
    ['capital','策略可用本金','USD','只允许策略占用这部分资金，不等于账户全部余额。',0.01,100000],
    ['order','每笔最多投入','USD','单笔委托名义金额上限；手续费等成本还需预留。',0.01,1000],
    ['market','单场最多占用','USD','同一五分钟市场的持仓成本、有效挂单和费用预留上限。',0.01,100000],
    ['target','目标配对成本','USD / 对','希望一份 UP 加一份 DOWN 的成本达到多少。',0.9,1],
    ['cap','补仓成本硬上限','USD / 对','超过就停止追价。目标与硬上限可以相同；仍需检查未配对风险。',0.9,1],
    ['inventory','最大未配对份数','份','两边相差的最大份数。自动方案：单场预算 ÷ 硬上限，向下取整。',1,100000],
    ['life','挂单最长保留','秒','到期撤单重算；价格异常或风险超限可提前撤单。',1,300],
    ['hedgeWait','补仓等待时间','秒','一边成交后等待多久再进入选定的风险处理流程。',1,300],
    ['stopOpen','结束前停止开新仓','秒','不再增加新仓位，已有不平衡仓位仍可按规则补齐。',0,299],
    ['stopHedge','结束前停止补仓','秒','停止新增补仓委托并处理剩余挂单；不得晚于市场结束。',0,299],
    ['spacing','两档价格间距','USD','例如 0.01 为 1 美分；不是收益率，正式执行需对齐最小报价步长。',0.001,0.1],
    ['slippage','最大吃单滑点','USD / 份','执行价格相对决策时可见价格最多变差多少。',0,0.1],
    ['hedgeLoss','风险处理损失上限','USD / 场','用于应急补仓或减仓方案，不是保证市场最终只亏这么多。',0.01,100000],
    ['duration','运行时长','分钟','0 表示持续运行，直到手动停止或风控触发。',0,1440],
    ['submitted','本次累计提交金额上限','USD','按订单名义金额累计，撤单后不退回此计数；与资金占用不同。',0.01,100000],
    ['dailyLoss','每日亏损停止线','USD','达到停止线暂停开新仓并核对仓位；损失可能超过触发线。',0.01,100000],
    ['concurrency','同时参与市场数','场','控制并发占用。本演示只开放单市场流程。',1,10],
    ['stale','行情过期阈值','毫秒','行情过期时暂停新订单，并进入撤单核对流程。',50,5000],
    ['maxOrders','本次最多提交订单','笔','累计提交订单保险丝，不是只数成交笔数。',1,10000]
  ];
  const $=id=>document.getElementById(id);
  const input = key => {
    const [,label,unit,help,min,max]=fields.find(f=>f[0]===key);
    return `<div class="field"><label for="setting-${key}">${label}</label><div class="settings-unit"><input id="setting-${key}" type="number" min="${min}" max="${max}" step="${['inventory','concurrency','maxOrders'].includes(key)?'1':'any'}" value="${defaults[key]}" aria-describedby="help-${key}"><span>${unit}</span></div><small id="help-${key}">${help}</small></div>`;
  };
  const select=(key,label,choices,help)=>`<div class="field"><label for="setting-${key}">${label}</label><select id="setting-${key}" aria-describedby="help-${key}">${choices.map(([value,text])=>`<option value="${value}">${text}</option>`).join('')}</select><small id="help-${key}">${help}</small></div>`;
  $('settings-strategy').innerHTML=`<h2>策略参数</h2><div class="settings-intro">演示配置 · 用来讨论规则与操作流程，不会配置正式引擎。基本参数可试填，尚未验证的动作不会放行启动。</div><div class="settings-form">
    <h3 class="settings-group">资金与配对成本</h3><div class="form">${['capital','order','market','target','cap'].map(input).join('')}${select('inventoryMode','未配对份数上限',[['auto','自动计算（演示公式）'],['manual','手动填写']], '自动上限会显示具体数字；它是风险限制，不是最优参数。')}${input('inventory')}<div class="field"><label>成本口径</label><div class="note">比较买入成本时计入已知费用；未确认奖励不抵成本。真实费用、滑点和可用余额仍需正式接口核对。</div></div></div>
    <h3 class="settings-group">挂单与收尾</h3><div class="form">${['life','hedgeWait','stopOpen','stopHedge'].map(input).join('')}</div>
    <details class="settings-advanced"><summary>高级设置 · 双档与补仓失败处理</summary><p class="settings-check-foot">以下高级动作可以预览配置，选择未验证功能时将禁用演示启动。不是已实现的实盘能力。</p><div class="form">${select('layers','挂单档数',[['single','单档限价挂单'],['double','双档挂单 · 待验证']],'便宜一档是否成交仍取决于行情与排队。')}${input('spacing')}${select('fallback','到时仍未补齐',[['wait','停止追价，等待并提示风险'],['taker','允许吃单补齐 · 待验证'],['sell','减持多余仓位 · 待验证']],'等待不等于没有风险，可能留单边仓位到结算。')}${input('slippage')}${input('hedgeLoss')}</div></details></div>`;
  $('settings-run').innerHTML=`<h2>运行设置</h2><div class="settings-intro">资金占用上限、累计提交上限和亏损停止线分别计算，不能互相替代。此处不提供自动实盘启动。</div><div class="settings-form"><h3 class="settings-group">模式与运行范围</h3><div class="form">${select('mode','交易模式',[['paper','演示模拟'],['live','真实交易 · 此演示不支持']],'真钱功能只能在正式系统完成账户与订单验收后开放。')}${input('duration')}${input('submitted')}${input('maxOrders')}${input('dailyLoss')}${input('concurrency')}</div><h3 class="settings-group">连接异常与停止</h3><div class="form">${select('disconnect','断线处理',[['stop','停止新单 → 尝试撤单 → 核对仓位']],'网络断开时可能撤单失败，必须显示待核对；重连后不立即重启。')}${input('stale')}${select('stopPolicy','停止后的持仓',[['hold','保留持仓，等待结算'],['sell','按损失限制减仓 · 待验证']],'停止并撤单不会自动把已有持仓卖掉。')}${select('effective','修改何时生效',[['restart','保存后，下次启动生效'],['nextMarket','下一场生效 · 待验证']],'运行中不会悄悄改变参数。保存配置与当前生效配置分开显示。')}</div></div>`;
  $('settings-run').insertAdjacentHTML('beforeend', `<div class="settings-checks" data-live-auth-panel>
    <div class="section-title"><h2>实盘授权状态</h2><span data-live-auth-state>未检查</span></div>
    <p class="settings-check-foot">授权开启功能尚未接入；当前仅能查询服务器锁定状态。</p>
    <button type="button" data-live-auth-check>检查服务器授权状态</button>
    <div role="status" aria-live="polite" data-live-auth-message>尚未查询。</div>
  </div>`);
  const checkHTML=suffix=>`<div class="settings-checks panel"><div class="section-title"><h2>启动前检查</h2><span data-check-state>检查中</span></div><div class="settings-example"><label for="example-price-${suffix}">示例市场最低 5 份 · 委托价格（非实时行情）</label><input id="example-price-${suffix}" data-example-price type="number" min="0.01" max="0.99" step="0.01" value="0.50"> USD / 份</div><ul class="settings-check-list" data-setting-checks></ul><p class="settings-check-foot">当前实际账户余额、真实市场最小量和费用：未接入。演示通过不等于正式系统可下单。</p><div class="settings-footer"><span data-effective-summary class="settings-check-foot"></span><div class="settings-actions"><button type="button" data-settings-save>保存演示设置</button><button type="button" data-settings-reset>恢复演示默认值</button></div></div><div role="status" aria-live="polite" class="settings-feedback" data-settings-message></div></div>`;
  for(const name of ['strategy','run']) $( `settings-${name}`).insertAdjacentHTML('beforeend',checkHTML(name));

  $('settings-strategy').querySelector('.settings-form').insertAdjacentHTML('beforeend',
    `<h3 class="settings-group" data-engine-extension>现有引擎参数</h3><div class="form" data-engine-extension>${['pairCost','decisionInterval','defensiveCancel'].map(input).join('')}</div>`);

}
