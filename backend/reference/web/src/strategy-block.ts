import './overview-block.css';
import './strategy-block.css';

const root = document.querySelector<HTMLElement>('#strategy-block-root');
if (!root) throw new Error('strategy block root missing');

const navItems = [
  ['◈', '总览', 'overview.html'],
  ['◇', '市场', 'market.html'],
  ['↗', '自动交易', 'auto-trade.html'],
  ['◒', '策略', 'strategy.html'],
  ['⚙', '设置', ''],
] as const;

const navMarkup = navItems.map(([icon, label, target]) => `<button class="nav-item${label === '策略' ? ' active' : ''}" type="button" data-preview-nav="${label}" data-preview-target="${target}"${label === '策略' ? ' aria-current="page"' : ''}><span>${icon}</span>${label}</button>`).join('');

root.innerHTML = `
  <div class="overview-preview strategy-preview" data-theme="deep-sea">
    <aside class="preview-sidebar">
      <div class="preview-brand"><span class="brand-mark">P</span><div><strong>POLYMARKET</strong><small>TRADING CONSOLE</small></div></div>
      <div class="brand-card"><span class="brand-card-logo" aria-hidden="true"><i></i><b>P</b></span><strong>Polymarket</strong></div>
      <p class="sidebar-copy">面向 BTC 五分钟反转策略的交易控制台。</p>
      <nav aria-label="策略设计稿导航">${navMarkup}</nav>
      <div class="sidebar-status"><i></i><span>原型预览</span><small>数据待接入</small></div>
    </aside>

    <main class="preview-main strategy-main">
      <header class="preview-header strategy-header">
        <div class="hero-copy"><p class="eyebrow">STRATEGY CONFIGURATION</p><div class="hero-title-row"><h1>策略</h1><span class="language-chip">BTC · 5m</span></div><p class="subtitle">调整单一 BTC 五分钟反转策略的触发、分阶段买入和运行边界。</p></div>
        <div class="strategy-header-side"><span class="strategy-state-chip"><i></i>设计稿 · 未连接</span><div class="header-status-grid"><article class="header-status"><span>策略标识</span><strong>btc-reversal</strong></article><article class="header-status"><span>当前版本</span><strong>REV-001</strong></article><article class="header-status"><span>运行模式</span><strong>实盘策略</strong></article><article class="header-status"><span>生效时机</span><strong>下一场次</strong></article></div></div>
      </header>

      <section class="strategy-identity-panel">
        <div class="strategy-identity-icon">↯</div><div class="strategy-identity-copy"><p class="eyebrow">ACTIVE STRATEGY</p><h2>BTC 五分钟反转</h2><p>跟随方向反转，按确认次数分阶段买入；同一方向不会重复加仓。</p></div><div class="identity-tags"><span class="identity-tag active-tag"><i></i>唯一运行策略</span><span class="identity-tag">版本 REV-001</span></div>
      </section>

      <section class="strategy-layout">
        <div class="strategy-form-panel">
          <div class="panel-heading"><div><p class="eyebrow">CONFIGURATION</p><h2>策略参数</h2></div><span class="panel-meta">修改只影响下一场次</span></div>
          <div class="strategy-tabs" role="tablist"><button type="button" class="strategy-tab active" data-strategy-tab="parameters" role="tab" aria-selected="true">策略参数</button><button type="button" class="strategy-tab" data-strategy-tab="runtime" role="tab" aria-selected="false">运行设置</button></div>

          <div class="strategy-pane" data-strategy-pane="parameters">
            <div class="preset-row"><div><strong>快速参考</strong><small>填入后仍可继续修改，保存才会生效。</small></div><div class="preset-actions" data-preset-list><div class="preset-item" data-preset-item><button type="button" class="preset-choice" data-preset data-preset-trigger="67" data-preset-confirm="70" data-preset-max="70" data-preset-stages="5,18,54,130">70 美分参考</button><button type="button" class="preset-remove" data-remove-preset aria-label="删除 70 美分参考">×</button></div><div class="preset-item" data-preset-item><button type="button" class="preset-choice" data-preset data-preset-trigger="70" data-preset-confirm="75" data-preset-max="75" data-preset-stages="5,22,75,236">75 美分参考</button><button type="button" class="preset-remove" data-remove-preset aria-label="删除 75 美分参考">×</button></div><button type="button" class="add-preset" data-add-preset>＋ 添加参考</button></div></div>
            <div class="preset-editor" data-preset-editor hidden><div><strong>添加参考参数</strong><small>保存到本地设计稿列表，后续可继续删除。</small></div><div class="preset-editor-fields"><label>名称<input type="text" value="新参考" data-preset-new-name></label><label>触发价<input type="number" value="67" data-preset-new-trigger></label><label>确认价<input type="number" value="70" data-preset-new-confirm></label><label>最高买入<input type="number" value="70" data-preset-new-max></label></div><div class="preset-editor-actions"><button type="button" class="secondary-button" data-cancel-preset>取消</button><button type="button" class="save-button" data-create-preset>添加到列表</button></div></div>
            <div class="config-section"><div class="config-section-heading"><div><span class="section-number">01</span><div><h3>触发与买入价格</h3><p>控制什么时候进入反转、确认方向，以及最高限价。</p></div></div><span class="section-state">价格单位 · 美分</span></div><div class="field-grid three-fields">
              <label class="strategy-field"><span>触发价</span><div><input type="number" step="1" value="67" data-field="trigger"><b>¢</b></div><small>卖一从下方跨过此价格时触发。</small></label>
              <label class="strategy-field"><span>反转确认价</span><div><input type="number" step="1" value="70" data-field="confirm"><b>¢</b></div><small>用于记录方向确认，不延迟下一阶段。</small></label>
              <label class="strategy-field"><span>最高买入价</span><div><input type="number" step="1" value="70" data-field="maxPrice"><b>¢</b></div><small>限价不追高，未成交余量继续挂单。</small></label>
            </div></div>

            <div class="config-section stages-config"><div class="config-section-heading"><div><span class="section-number">02</span><div><h3>每阶段新增份额</h3><p>新方向反转时进入下一阶段，同方向不重复加仓。</p></div></div><label class="stage-count"><span>阶段数</span><input type="number" min="1" max="8" value="4" data-stage-count></label></div><div class="stage-input-grid" data-stage-inputs>
              <label class="stage-input stage-one"><span><i>1</i>第一阶段</span><div><input type="number" value="5" data-stage="1"><b>份</b></div><small>首次进入触发区</small></label>
              <label class="stage-input stage-two"><span><i>2</i>第二阶段</span><div><input type="number" value="18" data-stage="2"><b>份</b></div><small>第一次反转确认</small></label>
              <label class="stage-input stage-three"><span><i>3</i>第三阶段</span><div><input type="number" value="54" data-stage="3"><b>份</b></div><small>第二次反转确认</small></label>
              <label class="stage-input stage-four"><span><i>4</i>第四阶段</span><div><input type="number" value="130" data-stage="4"><b>份</b></div><small>第三次反转确认</small></label>
            </div></div>
            <div class="budget-hint" data-budget-hint><span class="info-dot">i</span><span>按最高买入价计算的全部阶段名义成本 <strong>$1.45</strong>。交易费用另计。</span></div>
          </div>

          <div class="strategy-pane" data-strategy-pane="runtime" hidden>
            <div class="config-section"><div class="config-section-heading"><div><span class="section-number">03</span><div><h3>资金与运行时间</h3><p>限制单场投入、策略总占用和自动停止条件。</p></div></div><span class="section-state">可选边界</span></div><div class="field-grid runtime-fields">
              <label class="strategy-field"><span>单场资金上限</span><div><input type="number" placeholder="未设置" data-runtime-field="roundBudget"><b>USD</b></div><small>包括本场持仓、未完成买单和费用预留。</small></label>
              <label class="strategy-field"><span>策略总资金上限</span><div><input type="number" placeholder="未设置" data-runtime-field="totalBudget"><b>USD</b></div><small>限制本策略同时占用的资金。</small></label>
              <label class="strategy-field"><span>每日亏损停止线</span><div><input type="number" placeholder="未设置" data-runtime-field="lossLimit"><b>USD</b></div><small>达到后暂停新增订单，保留已有订单。</small></label>
              <label class="strategy-field"><span>运行时长</span><div><input type="number" value="0" data-runtime-field="duration"><b>分钟</b></div><small>0 表示持续运行，直到手动停止。</small></label>
            </div></div><div class="runtime-note"><span class="info-dot">i</span><span>暂停新增会保留现有订单；停止会撤销余量，已成交持仓保留。运行时长在下次启动时生效。</span></div>
          </div>

          <div class="strategy-savebar"><span class="save-state" data-save-state>当前没有未保存修改</span><div><button type="button" class="secondary-button" data-reset>撤销修改</button><button type="button" class="save-button" data-save>保存策略</button></div></div>
        </div>

        <aside class="strategy-aside">
          <section class="preview-card"><div class="panel-heading"><div><p class="eyebrow">LIVE PREVIEW</p><h2>参数预览</h2></div><span class="preview-dot"><i></i>待保存</span></div><div class="preview-price"><span>触发价</span><strong data-preview-trigger>0.67 <em>USD</em></strong><span class="preview-arrow">→</span><div><span>最高买入</span><strong data-preview-max>0.70 <em>USD</em></strong></div></div><div class="preview-steps"><div class="preview-step-heading"><span>分阶段买入计划</span><b data-preview-total>207 份</b></div><ol><li><i>1</i><span>进入触发区</span><strong data-preview-stage="1">5 份</strong></li><li><i>2</i><span>第一次确认</span><strong data-preview-stage="2">18 份</strong></li><li><i>3</i><span>第二次确认</span><strong data-preview-stage="3">54 份</strong></li><li><i>4</i><span>第三次确认</span><strong data-preview-stage="4">130 份</strong></li></ol></div></section>
          <section class="activation-card"><div class="activation-heading"><span class="activation-icon">◷</span><div><h3>生效规则</h3><p>不会立即改变当前运行</p></div></div><div class="activation-line"><i class="done"></i><div><strong>保存配置</strong><small>保存后生成新版本</small></div></div><div class="activation-line"><i></i><div><strong>下一场次启用</strong><small>当前场次继续使用旧版本</small></div></div><div class="activation-line"><i></i><div><strong>自动交易读取</strong><small>启动时加载已保存参数</small></div></div></section>
          <section class="guardrail-card"><div class="guardrail-heading"><span>策略约束</span><b>4 项</b></div><ul><li><i>✓</i>单一 BTC 五分钟反转策略</li><li><i>✓</i>价格使用限价，不追高</li><li><i>✓</i>同方向不重复加仓</li><li><i>✓</i>保存不会自动启动交易</li></ul></section>
        </aside>
      </section>
    </main>
  </div>
`;

const text = (selector: string, value: string) => {
  const node = document.querySelector<HTMLElement>(selector);
  if (node) node.textContent = value;
};

document.querySelectorAll<HTMLElement>('[data-preview-nav]').forEach((button) => {
  button.addEventListener('click', () => {
    const target = button.dataset.previewTarget;
    if (target) window.location.href = target;
  });
});

const parameterPane = document.querySelector<HTMLElement>('[data-strategy-pane="parameters"]');
const runtimePane = document.querySelector<HTMLElement>('[data-strategy-pane="runtime"]');
document.querySelectorAll<HTMLButtonElement>('[data-strategy-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    const runtime = button.dataset.strategyTab === 'runtime';
    parameterPane?.toggleAttribute('hidden', runtime);
    runtimePane?.toggleAttribute('hidden', !runtime);
    document.querySelectorAll<HTMLElement>('[data-strategy-tab]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
  });
});

const field = (key: string) => document.querySelector<HTMLInputElement>(`[data-field="${key}"]`);
const updatePreview = () => {
  const trigger = Number(field('trigger')?.value) || 0;
  const max = Number(field('maxPrice')?.value) || 0;
  text('[data-preview-trigger]', `${(trigger / 100).toFixed(2)} USD`);
  text('[data-preview-max]', `${(max / 100).toFixed(2)} USD`);
  let total = 0;
  document.querySelectorAll<HTMLInputElement>('[data-stage]').forEach((input) => {
    const value = Number(input.value) || 0;
    total += value;
    text(`[data-preview-stage="${input.dataset.stage}"]`, `${value} 份`);
  });
  text('[data-preview-total]', `${total} 份`);
  text('[data-save-state]', '有未保存修改');
};

document.querySelectorAll<HTMLInputElement>('[data-field], [data-stage], [data-runtime-field]').forEach((input) => input.addEventListener('input', updatePreview));
const applyPreset = (button: HTMLElement) => {
  const stages = (button.dataset.presetStages || '').split(',').map(Number).filter(Number.isFinite);
  field('trigger')!.value = button.dataset.presetTrigger || '67';
  field('confirm')!.value = button.dataset.presetConfirm || '70';
  field('maxPrice')!.value = button.dataset.presetMax || '70';
  stages.forEach((value, index) => { const input = document.querySelector<HTMLInputElement>(`[data-stage="${index + 1}"]`); if (input) input.value = String(value); });
  updatePreview();
  text('[data-save-state]', `已填入“${button.textContent?.trim() || '参考参数'}”，尚未保存`);
};

const bindPresetItem = (item: HTMLElement) => {
  item.querySelector<HTMLElement>('[data-preset]')?.addEventListener('click', (event) => applyPreset(event.currentTarget as HTMLElement));
  item.querySelector<HTMLElement>('[data-remove-preset]')?.addEventListener('click', () => {
    item.remove();
    text('[data-save-state]', '参考参数已删除，尚未保存');
  });
};
document.querySelectorAll<HTMLElement>('[data-preset-item]').forEach(bindPresetItem);

const editor = document.querySelector<HTMLElement>('[data-preset-editor]');
document.querySelector('[data-add-preset]')?.addEventListener('click', () => editor?.toggleAttribute('hidden', false));
document.querySelector('[data-cancel-preset]')?.addEventListener('click', () => editor?.toggleAttribute('hidden', true));
document.querySelector('[data-create-preset]')?.addEventListener('click', () => {
  const name = document.querySelector<HTMLInputElement>('[data-preset-new-name]')?.value.trim() || '新参考';
  const trigger = Number(document.querySelector<HTMLInputElement>('[data-preset-new-trigger]')?.value);
  const confirm = Number(document.querySelector<HTMLInputElement>('[data-preset-new-confirm]')?.value);
  const max = Number(document.querySelector<HTMLInputElement>('[data-preset-new-max]')?.value);
  if (![trigger, confirm, max].every((value) => Number.isFinite(value) && value > 0)) {
    text('[data-save-state]', '请先填写有效的参考价格');
    return;
  }
  const stages = Array.from(document.querySelectorAll<HTMLInputElement>('[data-stage]')).map((input) => Number(input.value) || 0);
  const item = document.createElement('div');
  item.className = 'preset-item';
  item.dataset.presetItem = '';
  const choice = document.createElement('button');
  choice.type = 'button'; choice.className = 'preset-choice'; choice.dataset.preset = ''; choice.dataset.presetTrigger = String(trigger); choice.dataset.presetConfirm = String(confirm); choice.dataset.presetMax = String(max); choice.dataset.presetStages = stages.join(','); choice.textContent = name;
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'preset-remove'; remove.dataset.removePreset = ''; remove.setAttribute('aria-label', `删除 ${name}`); remove.textContent = '×';
  item.append(choice, remove);
  const list = document.querySelector<HTMLElement>('[data-preset-list]');
  const add = document.querySelector<HTMLElement>('[data-add-preset]');
  if (list && add) list.insertBefore(item, add);
  bindPresetItem(item);
  editor?.toggleAttribute('hidden', true);
  text('[data-save-state]', `已添加“${name}”，尚未保存`);
});

document.querySelector('[data-reset]')?.addEventListener('click', () => {
  field('trigger')!.value = '67'; field('confirm')!.value = '70'; field('maxPrice')!.value = '70';
  ['5', '18', '54', '130'].forEach((value, index) => { const input = document.querySelector<HTMLInputElement>(`[data-stage="${index + 1}"]`); if (input) input.value = value; });
  updatePreview(); text('[data-save-state]', '已恢复设计稿默认参数');
});

document.querySelector('[data-save]')?.addEventListener('click', () => text('[data-save-state]', '设计稿演示：保存接口尚未连接'));
