/* Demo settings only. Does not read credentials or call a trading endpoint. */
(() => {
  'use strict';
  const defaults = Object.freeze({capital:100, order:5, market:10, target:0.98, cap:0.99,
    inventoryMode:'auto', inventory:10, life:15, hedgeWait:10, stopOpen:30, stopHedge:10,
    layers:'single', spacing:0.01, fallback:'wait', slippage:0.01, hedgeLoss:1,
    mode:'paper', duration:0, submitted:100, dailyLoss:10, concurrency:1,
    disconnect:'stop', stale:250, stopPolicy:'hold', effective:'restart', maxOrders:50});
  const fields = [
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
  const options = {inventoryMode:['auto','manual'], layers:['single','double'], fallback:['wait','taker','sell'],
    mode:['paper','live'], disconnect:['stop'],stopPolicy:['hold','sell'],effective:['restart','nextMarket']};
  const unused=(key,c)=>(key==='inventory'&&c.inventoryMode==='auto') ||
    (key==='spacing'&&c.layers==='single') || (key==='slippage'&&c.fallback==='wait') ||
    (key==='hedgeLoss'&&c.fallback==='wait'&&c.stopPolicy==='hold');
  function normalize(c){const result={...c};for(const key of Object.keys(defaults))if(unused(key,c))result[key]=defaults[key];return result;}
  function validate(c, price=0.5) {
    const errors=[], notes=[];
    for(const [key,label,,,min,max] of fields) {
      if(unused(key,c)) continue;
      const v=c[key];
      if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max) errors.push(`${label}需在 ${min}–${max} 之间。`);
    }
    for(const [key,values] of Object.entries(options)) if(!values.includes(c[key])) errors.push('选项无效，请重新选择。');
    for(const key of ['inventory','concurrency','maxOrders']) if(!unused(key,c)&&!Number.isInteger(c[key])) errors.push('份数、并发市场数和订单数须为整数。');
    if(c.target>c.cap) errors.push('目标配对成本不能高于补仓成本硬上限。');
    if(c.order>c.market) errors.push('每笔上限不能超过单场上限。');
    if(c.market*c.concurrency>c.capital) errors.push('单场上限 × 同时参与市场数不能超过策略本金。');
    if(c.submitted<c.order) errors.push('本次累计提交金额上限不能小于每笔上限。');
    if(c.dailyLoss>c.capital) errors.push('每日亏损停止线不能超过策略本金。');
    if(c.stopHedge>c.stopOpen) errors.push('应先停止开新仓，再停止补仓：补仓截止秒数不能大于开仓截止秒数。');
    if(c.duration!==0&&c.duration<0.1) errors.push('运行时长应为 0 或至少 0.1 分钟。');
    const inventory = c.inventoryMode==='auto' ? Math.floor(c.market/c.cap) : c.inventory;
    if(!Number.isFinite(inventory)||inventory<1) errors.push('计算后的未配对上限不足 1 份。');
    const priceValid=typeof price==='number'&&Number.isFinite(price)&&price>0&&price<1;
    if(price!==null){
      if(!priceValid) errors.push('示例委托价格需大于 0 且小于 1。');
      else if(c.order+1e-9<price*5) errors.push(`示例市场最低 5 份，$${price.toFixed(2)} 时至少需要 $${(price*5).toFixed(2)}；当前每笔金额不足。`);
    }
    if(c.layers==='double') notes.push('双档挂单尚未在此演示执行器中验证。');
    if(c.fallback!=='wait') notes.push('吃单补仓 / 卖出减仓仅展示方案，尚未在此演示执行器中验证。');
    if(c.stopPolicy==='sell') notes.push('停止后自动减仓尚未验证。');
    if(c.mode==='live') notes.push('此页面不接真实交易，不能开启真钱模式。');
    if(c.effective!=='restart') notes.push('下一场生效尚未接入，此演示仅支持下次启动生效。');
    if(c.concurrency!==1) notes.push('多市场并发尚未接入此演示。');
    return {errors,notes,inventory, minimum:priceValid?price*5:null, canPreview:errors.length===0&&notes.length===0};
  }
  if(typeof module!=='undefined'&&module.exports) module.exports={defaults,validate,normalize};
  if(typeof document==='undefined') return;
  const $=id=>document.getElementById(id);
  const storageKey='pm-demo-settings-v2';
  const cash=n=>Number(n).toFixed(2);
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
  const checkHTML=suffix=>`<div class="settings-checks panel"><div class="section-title"><h2>启动前检查</h2><span data-check-state>检查中</span></div><div class="settings-example"><label for="example-price-${suffix}">示例市场最低 5 份 · 委托价格（非实时行情）</label><input id="example-price-${suffix}" data-example-price type="number" min="0.01" max="0.99" step="0.01" value="0.50"> USD / 份</div><ul class="settings-check-list" data-setting-checks></ul><p class="settings-check-foot">当前实际账户余额、真实市场最小量和费用：未接入。演示通过不等于正式系统可下单。</p><div class="settings-footer"><span data-effective-summary class="settings-check-foot"></span><div class="settings-actions"><button type="button" data-settings-save>保存演示设置</button><button type="button" data-settings-reset>恢复演示默认值</button></div></div><div role="status" aria-live="polite" class="settings-feedback" data-settings-message></div></div>`;
  for(const name of ['strategy','run']) $( `settings-${name}`).insertAdjacentHTML('beforeend',checkHTML(name));
  let saved={...defaults}, active=null, price=0.5, saveMessage='';
  function fill(c){ for(const k of Object.keys(defaults)) $(`setting-${k}`).value=String(c[k]); }
  function read(){ return normalize(Object.fromEntries(Object.keys(defaults).map(k=>[k,typeof defaults[k]==='number' ? ($(`setting-${k}`).value.trim()===''?NaN:Number($(`setting-${k}`).value)) : $(`setting-${k}`).value]))); }
  function same(a,b){return Object.keys(defaults).every(k=>Object.is(a[k],b[k]));}
  try {
    const raw=localStorage.getItem(storageKey);
    if(raw){const data=JSON.parse(raw);const c=normalize(Object.fromEntries(Object.keys(defaults).map(k=>[k,data[k]])));if(validate(c,null).errors.length===0){saved=c;saveMessage='已恢复此浏览器保存的演示参数；当前示例价格另作启动检查。';}else saveMessage='旧演示参数不完整或无效，已使用默认值。';}
  } catch {saveMessage='无法读取浏览器演示配置，使用默认值。';}
  fill(saved);
  function message(text){document.querySelectorAll('[data-settings-message]').forEach(e=>e.textContent=text);}
  function refresh(){
    const c=read(),v=validate(c,price);
    $('setting-inventory').disabled=c.inventoryMode==='auto';
    if(c.inventoryMode==='auto'&&Number.isFinite(v.inventory)) $('setting-inventory').value=String(v.inventory);
    $('setting-spacing').disabled=c.layers==='single';
    for(const key of ['slippage','hedgeLoss']) $(`setting-${key}`).disabled=unused(key,c);
    const rows=[`策略本金 $${cash(c.capital)}；单场最多占用 $${cash(c.market)}；单笔名义金额 $${cash(c.order)}。`,
      `最大未配对 ${v.inventory} 份${c.inventoryMode==='auto'?'（演示自动公式）':''}；目标 $${cash(c.target)}，补仓硬上限 $${cash(c.cap)}。`,
      `本次累计提交上限 $${cash(c.submitted)} / ${c.maxOrders} 笔；撤单不恢复累计额度。`,
      `结束前 ${c.stopOpen} 秒停止开新仓，${c.stopHedge} 秒停止补仓；挂单最长 ${c.life} 秒。`,
      ...(v.minimum===null?[]:[`示例最低单金额 $${cash(v.minimum)}（5 份 × $${cash(price)}），真实参数以当时市场为准。`]),...v.errors.map(e=>'需修改：'+e),...v.notes.map(e=>'待验证：'+e)];
    document.querySelectorAll('[data-setting-checks]').forEach(list=>{list.replaceChildren();rows.forEach(text=>{const li=document.createElement('li');li.textContent=text;if(text.startsWith('需修改'))li.className='bad';if(text.startsWith('待验证'))li.className='warn';list.append(li);});});
    document.querySelectorAll('[data-check-state]').forEach(e=>e.textContent=v.errors.length?'参数需修改':v.notes.length?'方案待验证':'演示参数检查通过');
    const dirty=!same(read(),saved);
    document.querySelectorAll('[data-effective-summary]').forEach(e=>e.textContent=(dirty?'有未保存修改。':'已保存演示配置。')+(active?` 本次生效：每笔 $${cash(active.order)} / 硬上限 $${cash(active.cap)}。`:' 尚未启动演示。'));
    document.querySelectorAll('[data-start]').forEach(e=>{e.disabled=Boolean(active)||!v.canPreview||dirty;e.title=active?'请先停止当前演示':dirty?'先保存演示设置':!v.canPreview?'请查看设置中的检查结果':'';});
    const displayed=active||saved;
    document.querySelectorAll('#view-home .row').forEach(row=>{if(row.querySelector('span')?.textContent==='本次投入上限'||row.querySelector('span')?.textContent==='策略可用本金（演示）'){row.querySelector('span').textContent='策略可用本金（演示）';row.querySelector('b').textContent='$'+cash(displayed.capital);}});
    document.querySelectorAll('#view-trade .row').forEach(row=>{if(row.querySelector('span')?.textContent==='目标成本上限'){row.querySelector('b').textContent='$'+cash(displayed.target)+' / 硬上限 $'+cash(displayed.cap);}});
  }
  function save(){const c=read(),v=validate(c,price);if(v.errors.length){message('未保存：'+v.errors.join(' '));return;}try{localStorage.setItem(storageKey,JSON.stringify(c));saved={...c};message(v.notes.length?'已保存讨论方案；包含待验证功能，不能启动。':'演示设置已保存，下次启动生效；正式策略没有改变。');}catch{message('保存失败：浏览器存储不可用，请检查权限。');}refresh();}
  document.querySelectorAll('#settings-strategy input,#settings-strategy select,#settings-run input,#settings-run select').forEach(e=>e.addEventListener('input',()=>{if(e.hasAttribute('data-example-price')){price=e.value.trim()===''?NaN:Number(e.value);document.querySelectorAll('[data-example-price]').forEach(x=>{if(x!==e)x.value=e.value;});}refresh();}));
  document.querySelectorAll('[data-settings-save]').forEach(e=>e.addEventListener('click',save));
  document.querySelectorAll('[data-settings-reset]').forEach(e=>e.addEventListener('click',()=>{fill(defaults);refresh();message('已恢复默认草稿，点击保存后才用于下次演示。');}));
  const topSave=document.querySelector('[data-save]');
  topSave.textContent='保存演示参数';
  topSave.onclick=save;
  document.querySelectorAll('[data-setting]').forEach(button=>button.addEventListener('click',()=>{
    const relevant=['strategy','run'].includes(button.dataset.setting);
    topSave.disabled=!relevant;
    topSave.title=relevant?'仅保存演示策略与运行参数':'账户操作使用账户页按钮';
  }));
  // The original demo invents a fixed $4.90 fill. Replace it with honest preview feedback.
  document.querySelectorAll('[data-start]').forEach(e=>e.onclick=()=>{const c=read();if(active||!same(c,saved)||!validate(c,price).canPreview)return;active={...saved};$('status').textContent='配置预览中 · 不执行交易';$('homeStrategy').textContent='演示配置已载入，未撮合成交';$('homeLog').textContent=`已载入演示：本金 $${cash(c.capital)}，每笔上限 $${cash(c.order)}，补仓硬上限 $${cash(c.cap)}。没有生成订单或成交。`;$('tradeLog').textContent=$('homeLog').textContent;refresh();});
  document.querySelectorAll('[data-stop],[data-exit]').forEach(e=>e.onclick=()=>{active=null;$('status').textContent='演示已停止';$('homeStrategy').textContent='未运行';$('homeLog').textContent='配置预览已停止；没有真实订单或持仓变化。';$('tradeLog').textContent=$('homeLog').textContent;refresh();});
  message(saveMessage);
  refresh();
})();
