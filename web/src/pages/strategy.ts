export const strategyPageMarkup = `<div class="head strategy-head"><div><div class="eyebrow">STRATEGY CENTER · PLUG-IN READY</div><h1>策略</h1><p>选择策略、维护策略专属参数，并复用统一的行情、订单和风险底座。</p></div><div class="head-actions"><span class="chip" data-strategy-state>策略接入暂停 · 当前仅配置</span><button type="button" class="primary" data-strategy-add>添加策略</button></div></div><div class="panel strategy-registry"><div class="section-title"><h2>策略列表</h2><span class="muted">当前会话草稿 · 后端注册接口待接入</span></div><div class="strategy-create" data-strategy-create hidden><div class="form"><div class="field"><label for="strategy-new-id">策略 ID</label><input id="strategy-new-id" autocomplete="off" placeholder="例如：my-maker" pattern="[A-Za-z0-9._-]{2,64}"><small>用于运行记录和订单归属，只允许字母、数字、点、下划线和短横线。</small></div><div class="field"><label for="strategy-new-name">显示名称</label><input id="strategy-new-name" autocomplete="off" placeholder="例如：我的做市策略"><small>页面显示名称，可以使用中文。</small></div></div><div class="strategy-create-actions"><button type="button" data-strategy-create-cancel>取消</button><button type="button" class="primary" data-strategy-create-submit>加入本次会话</button></div><p class="settings-feedback" data-strategy-create-message role="status"></p></div><div class="strategy-list" data-strategy-list></div></div><div class="panel strategy-active"><div class="section-title"><div><h2 data-strategy-active-name>稳定做市</h2><p class="muted" data-strategy-active-id>stableLive</p></div><span class="pill warn" data-strategy-active-status>暂停接入</span></div><div class="strategy-parameters"><div class="field"><label for="strategy-params">策略专属参数草稿</label><textarea id="strategy-params" data-strategy-params rows="8" spellcheck="false">{}</textarea><small>只保存在当前页面会话；策略执行器接入后才会应用。刷新页面不会保留，JSON 无效时不会覆盖原草稿。</small></div><div class="strategy-contract"><h3>统一底座</h3><div class="row"><span>行情</span><b>市场、盘口和深度</b></div><div class="row"><span>执行</span><b>下单、撤单、替换和成交回报</b></div><div class="row"><span>风险</span><b>资金、库存、日损失和订单数</b></div><div class="row"><span>状态</span><b>当前策略不会自动下单</b></div></div></div></div><div class="strategy-config" data-strategy-config><div class="section-title"><h2>运行与引擎参数</h2><span class="muted">当前为共享配置草稿；策略接口接入后再按策略应用</span></div><div id="settings-strategy"></div><div id="settings-run"></div></div>`;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character));

type StrategyDraft = { id: string; name: string; status: string; params: string };

export function mountStrategy() {
  const root = document.getElementById('view-strategy');
  const list = root?.querySelector<HTMLElement>('[data-strategy-list]');
  const create = root?.querySelector<HTMLElement>('[data-strategy-create]');
  const params = root?.querySelector<HTMLTextAreaElement>('[data-strategy-params]');
  if (!root || !list || !create || !params) return;
  const strategies: StrategyDraft[] = [{ id: 'stableLive', name: '稳定做市', status: '暂停接入', params: '{}' }];
  let activeId = strategies[0].id;
  const setText = (selector: string, value: string) => { const node = root.querySelector<HTMLElement>(selector); if (node) node.textContent = value; };
  const saveParams = () => {
    const active = strategies.find(item => item.id === activeId);
    if (!active) return;
    try { JSON.parse(params.value); active.params = params.value; }
    catch { setText('[data-strategy-state]', '参数 JSON 无效 · 未保存'); }
  };
  const render = () => {
    const active = strategies.find(item => item.id === activeId) || strategies[0];
    activeId = active.id;
    list.innerHTML = strategies.map(item => `<button type="button" class="strategy-list-item ${item.id === activeId ? 'active' : ''}" data-strategy-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.id)} · ${escapeHtml(item.status)}</span></button>`).join('');
    setText('[data-strategy-active-name]', active.name);
    setText('[data-strategy-active-id]', active.id);
    setText('[data-strategy-active-status]', active.status);
    params.value = active.params;
    list.querySelectorAll<HTMLButtonElement>('[data-strategy-id]').forEach(button => button.addEventListener('click', () => { saveParams(); activeId = button.dataset.strategyId || activeId; render(); }));
  };
  root.querySelector<HTMLButtonElement>('[data-strategy-add]')?.addEventListener('click', () => { create.hidden = false; root.querySelector<HTMLInputElement>('#strategy-new-id')?.focus(); });
  root.querySelector<HTMLButtonElement>('[data-strategy-create-cancel]')?.addEventListener('click', () => { create.hidden = true; });
  root.querySelector<HTMLButtonElement>('[data-strategy-create-submit]')?.addEventListener('click', () => {
    const idInput = root.querySelector<HTMLInputElement>('#strategy-new-id');
    const nameInput = root.querySelector<HTMLInputElement>('#strategy-new-name');
    const message = root.querySelector<HTMLElement>('[data-strategy-create-message]');
    const id = idInput?.value.trim() || '', name = nameInput?.value.trim() || '';
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(id) || !name) { if (message) message.textContent = '请填写有效的策略 ID 和显示名称。'; return; }
    if (strategies.some(item => item.id === id)) { if (message) message.textContent = '策略 ID 已存在。'; return; }
    strategies.push({ id, name, status: '待接入', params: '{}' });
    activeId = id; create.hidden = true; if (idInput) idInput.value = ''; if (nameInput) nameInput.value = ''; if (message) message.textContent = ''; render();
  });
  params.addEventListener('change', saveParams);
  for (const id of ['settings-strategy', 'settings-run']) {
    const panel = document.getElementById(id);
    if (panel) root.querySelector('[data-strategy-config]')?.append(panel);
  }
  render();
}
