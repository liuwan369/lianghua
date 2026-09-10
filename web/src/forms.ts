import { api } from './api/client';
import type { Account, Config, Obj } from './api/types';

export const fieldMap: Record<string, string> = {
  order: 'order_usd', life: 'maker_life_sec', mode: 'mode', duration: 'duration_min',
  submitted: 'max_total_usd', maxOrders: 'max_orders',
};
type Control = HTMLInputElement | HTMLSelectElement;

/** Form drafts live only in the current page; polling never replaces edited fields. */
export function connectForms(saved?: { config: (value: Config) => void; account: () => void }) {
  const fields = Array.from(document.querySelectorAll<Control>('#settings-strategy [id^="setting-"],#settings-run [id^="setting-"]'));
  const accountFields = Array.from(document.querySelectorAll<HTMLInputElement>('#settings-account input'));
  const accountButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#settings-account button'));
  const globalSave = document.querySelector<HTMLButtonElement>('[data-save]')!;
  const saves = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-settings-save]'));
  const resets = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-settings-reset]'));
  const dirty = new Set<string>();
  const accountDirty = new Set<HTMLInputElement>();
  const bindings: Array<() => void> = [];
  let latest: Config | null = null, baseline: Config | null = null;
  let savedWallet = '', configBusy = false, accountBusy = false, closed = false;
  let configError: string | null = null, configMessage = '';
  const key = (field: Control) => field.id.slice('setting-'.length);
  const supported = (field: Control) => !!fieldMap[key(field)];
  const on = (el: Element, event: string, handler: EventListener) => {
    el.addEventListener(event, handler); bindings.push(() => el.removeEventListener(event, handler));
  };
  const accountMessage = (message: string) => {
    const node = document.querySelector('#settings-account .note');
    if (node) { node.textContent = message; node.setAttribute('role', 'status'); }
  };
  function feedback() {
    const drafts = fields.filter(field => !supported(field) && field.value !== '').length;
    const message = [configError, configMessage || '已接入字段可保存到服务器；其余字段仅供本页填写，尚未接入引擎。',
      drafts ? `${drafts} 项未接入字段仅保留在本页，刷新后丢弃，不会保存或生效。` : ''].filter(Boolean).join(' ');
    document.querySelectorAll('[data-settings-message]').forEach(el => el.textContent = message);
  }
  function buttons() {
    saves.forEach(button => button.disabled = configBusy);
    resets.forEach(button => button.disabled = configBusy);
    accountButtons.forEach(button => button.disabled = accountBusy);
    const active = document.querySelector('[data-setting].active')?.getAttribute('data-setting');
    globalSave.disabled = active === 'system' || (active === 'account' ? accountBusy : configBusy);
    globalSave.title = active === 'system' ? '系统诊断没有可保存的配置' : '';
    globalSave.textContent = active === 'account' ? '保存账户' : '保存设置';
  }
  for (const field of fields) {
    field.disabled = false;
    field.title = supported(field) ? '保存到服务器，下次启动生效' : '仅本页草稿：未接入引擎，不会保存或生效';
    field.dataset.persistence = supported(field) ? 'server' : 'draft';
    if (field instanceof HTMLInputElement) {
      field.placeholder = supported(field) ? '等待服务器配置，可先填写' : '仅本页草稿 · 未接入';
      field.required = supported(field);
    }
    if (field instanceof HTMLSelectElement) {
      const blank = Array.from(field.options).find(option => option.value === '');
      if (blank) blank.textContent = supported(field) ? '等待服务器配置' : '仅本页草稿 · 未接入';
    }
    if (!supported(field)) {
      const help = document.getElementById(`help-${key(field)}`);
      if (help) help.textContent = `${help.textContent} 仅本页草稿，未保存、未生效。`;
    }
    const changed = () => {
      if (!dirty.size) baseline = latest;
      dirty.add(key(field)); configMessage = '修改尚未保存。'; feedback();
    };
    on(field, 'input', changed); on(field, 'change', changed);
  }
  document.querySelectorAll<HTMLInputElement>('[data-example-price]').forEach(field => { field.disabled = false; field.title = '示例输入，不是实时行情或启动校验'; });
  const modeLive = document.querySelector<HTMLOptionElement>('#setting-mode option[value="live"]');
  if (modeLive) modeLive.textContent = '真实交易 · 保存不会解锁或启动';
  const accountNames = ['wallet', 'owner_key', 'relayer_key', 'relayer_address'];
  accountFields.forEach((field, index) => {
    field.disabled = false; field.title = '仅在点击检查或保存时提交；空白密钥不会读取或回显';
    field.name = accountNames[index]; field.autocomplete = index === 1 || index === 2 ? 'new-password' : 'off';
    field.setAttribute('aria-label', ['资金钱包地址', 'Owner 签名私钥', 'Relayer API Key', 'Relayer 地址'][index]);
    if (index === 0 || index === 3) field.pattern = '0x[0-9a-fA-F]{40}';
    if (index === 1) field.pattern = '(0x)?[0-9a-fA-F]{64}';
    if (index === 0) field.required = true;
    on(field, 'input', () => { accountDirty.add(field); accountMessage('账户修改尚未保存。请通过当前 HTTPS 页面提交；保存不会启动交易。'); });
  });
  async function saveSettings() {
    if (configBusy || closed) return;
    if (!latest || configError) { configMessage = '配置读取失败或尚未完成，请刷新后再保存；草稿已保留。'; feedback(); return; }
    const modified = fields.filter(field => supported(field) && dirty.has(key(field)));
    if (!modified.length) { configMessage = '没有已接入字段需要保存。未接入字段不会提交到服务器。'; feedback(); return; }
    for (const field of modified) {
      if (!field.reportValidity()) { configMessage = '请修正已接入字段的格式或范围，尚未保存。'; feedback(); return; }
    }
    const base = baseline || latest;
    const params: Obj = { ...base.params };
    const submitted = new Map(modified.map(field => [field, field.value]));
    for (const field of modified) params[fieldMap[key(field)]] = field instanceof HTMLSelectElement ? field.value : Number(field.value);
    configBusy = true; configMessage = '正在保存已接入字段…'; buttons(); feedback();
    try {
      const result = await api.saveConfig(params, base.revision);
      if (closed) return;
      for (const [field, value] of submitted) if (field.value === value) dirty.delete(key(field));
      baseline = result; receiveConfig(result, null);
      saved?.config(result);
      configMessage = `已接入字段已保存为版本 ${result.revision}，下次启动生效；未启动或解锁交易。`;
    } catch (error) { configMessage = `${error instanceof Error ? error.message : '保存失败'}；草稿已保留。版本冲突时请先核对或撤销未保存修改。`; }
    finally { configBusy = false; if (!closed) { buttons(); feedback(); } }
  }
  async function accountAction(save: boolean) {
    if (accountBusy || closed) return;
    for (const field of accountFields) if (!field.reportValidity()) return;
    const payload: Obj = {};
    for (const field of accountFields) if (field.value.trim()) payload[field.name] = field.value.trim();
    const submitted = accountFields.map(field => field.value);
    accountBusy = true; buttons(); accountMessage(save ? '正在检查并保存账户…' : '正在检查账户，尚未保存…');
    try {
      const response = await (save ? api.saveAccount(payload) : api.checkAccount(payload));
      if (closed) return;
      const report = response.report;
      if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('账户响应格式不完整，请刷新核对结果');
      const result = report as Obj;
      if (save) {
        savedWallet = String(payload.wallet || '');
        accountFields.forEach((field, index) => {
          if (field.value === submitted[index]) { accountDirty.delete(field); if (index === 1 || index === 2) field.value = ''; }
        });
        saved?.account();
      }
      accountFields.forEach((field, index) => {
        if (field.type === 'password' && field.value === submitted[index]) { field.value = ''; accountDirty.delete(field); }
      });
      accountMessage(`${save ? '账户已保存，已提交的密钥已从输入框清除。' : '检查完成，尚未保存账户。已提交密钥已从输入框清除；保存新密钥时需重新填写。'}账户就绪：${result.account_ready === true ? '是' : '否'}；签名匹配：${result.signer_matches === true ? '是' : '否'}；授权就绪：${result.approvals_ready === true ? '是' : '否'}。未启动交易。`);
    } catch (error) { accountMessage(`${error instanceof Error ? error.message : '账户操作失败'}；未确认保存成功，输入已保留。`); }
    finally { accountBusy = false; if (!closed) buttons(); }
  }
  function receiveConfig(config: Config | null, error: string | null) {
    configError = error;
    if (config && (!latest || config.revision >= latest.revision)) {
      latest = config;
      if (!dirty.size) baseline = config;
      for (const field of fields) if (supported(field) && !dirty.has(key(field))) {
        const value = config.params[fieldMap[key(field)]];
        field.value = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      }
    }
    feedback();
  }
  function receiveAccount(account: Account | null) {
    if (!account || accountBusy) return;
    savedWallet = account.wallet;
    if (!accountDirty.has(accountFields[0])) accountFields[0].value = savedWallet;
  }
  for (const button of saves) on(button, 'click', () => void saveSettings());
  for (const button of resets) {
    button.textContent = '撤销未保存修改';
    on(button, 'click', () => {
      if (configBusy) return;
      dirty.clear(); baseline = latest;
      for (const field of fields) if (!supported(field)) field.value = '';
      configMessage = '已撤销本页未保存修改；已接入字段恢复为最近读取的服务器配置，未向服务器写入。';
      receiveConfig(latest, configError);
    });
  }
  on(accountButtons[0], 'click', () => void accountAction(false));
  on(accountButtons[1], 'click', () => void accountAction(true));
  on(globalSave, 'click', () => {
    const active = document.querySelector('[data-setting].active')?.getAttribute('data-setting');
    if (active === 'account') void accountAction(true);
    else if (active === 'system') { accountMessage('系统诊断没有可保存的配置。'); globalSave.title = '系统诊断没有可保存的配置'; }
    else void saveSettings();
  });
  document.querySelectorAll('[data-setting]').forEach(button => on(button, 'click', buttons));
  accountMessage('可通过当前 HTTPS 页面检查、保存账户。空白密钥在钱包不变时保留服务器配置，换钱包不会继承旧密钥。检查不会保存，保存不会启动交易。');
  buttons(); feedback();
  return { receiveConfig, receiveAccount, close: () => { closed = true; bindings.forEach(remove => remove()); accountFields.filter(field => field.type === 'password').forEach(field => field.value = ''); } };
}
