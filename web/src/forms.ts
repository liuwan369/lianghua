import { api } from './api/client';
import type { Account, Config, Obj } from './api/types';

/** Form drafts live only in the current page; polling never replaces edited fields. */
export function connectForms(saved?: { config: (value: Config) => void; account: () => void }) {
  const accountPanel = document.querySelector<HTMLElement>('#settings-account .form');
  if (accountPanel && !accountPanel.querySelector('[data-builder-credentials]')) {
    accountPanel.insertAdjacentHTML('beforeend', `<div data-builder-credentials class="field"><label for="accountBuilderApiKey">Builder API Key（选填）</label><input id="accountBuilderApiKey" type="password" maxlength="512" autocomplete="new-password" spellcheck="false"><small class="field-help">Deposit Wallet 赎回等 Builder Relayer 操作需要，与 Builder Code 不同。</small></div><div data-builder-credentials class="field"><label for="accountBuilderSecret">Builder Secret（配套填写）</label><input id="accountBuilderSecret" type="password" maxlength="512" autocomplete="new-password" spellcheck="false"><small class="field-help">从 Polymarket Settings → Builder 创建 Profile 后获取。</small></div><div data-builder-credentials class="field"><label for="accountBuilderPassphrase">Builder Passphrase（配套填写）</label><input id="accountBuilderPassphrase" type="password" maxlength="512" autocomplete="new-password" spellcheck="false"><small class="field-help">三项必须同时填写；不会回显或写入浏览器存储。</small></div>`);
  }
  const accountFields = Array.from(document.querySelectorAll<HTMLInputElement>('#settings-account input'));
  const accountButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#settings-account button'));
  const liveAuthButton = document.querySelector<HTMLButtonElement>('[data-live-auth-check]');
  const liveAuthState = document.querySelector<HTMLElement>('[data-live-auth-state]');
  const liveAuthMessage = document.querySelector<HTMLElement>('[data-live-auth-message]');
  const globalSave = document.querySelector<HTMLButtonElement>('[data-save]')!;
  const accountDirty = new Set<HTMLInputElement>();
  const bindings: Array<() => void> = [];
  let savedWallet = '', accountBusy = false, closed = false;
  let liveAuthBusy = false;
  const on = (el: Element, event: string, handler: EventListener) => {
    el.addEventListener(event, handler); bindings.push(() => el.removeEventListener(event, handler));
  };
  const accountMessage = (message: string) => {
    const node = document.querySelector('#settings-account .note');
    if (node) { node.textContent = message; node.setAttribute('role', 'status'); }
  };
  function buttons() {
    accountButtons.forEach(button => button.disabled = accountBusy);
    const active = document.querySelector('[data-setting].active')?.getAttribute('data-setting');
    globalSave.disabled = active === 'system' || accountBusy;
    globalSave.textContent = '保存账户';
    if (liveAuthButton) liveAuthButton.disabled = liveAuthBusy || closed;
  }
  const accountNames = ['wallet', 'owner_key', 'relayer_key', 'relayer_address', 'builder_api_key', 'builder_secret', 'builder_passphrase'];
  const accountLabels = ['资金钱包地址', 'Owner 签名私钥', 'Relayer API Key', 'Relayer 地址', 'Builder API Key', 'Builder Secret', 'Builder Passphrase'];
  accountFields.forEach((field, index) => {
    field.disabled = false; field.title = '仅在点击检查或保存时提交；空白密钥不会读取或回显';
    field.name = accountNames[index]; field.autocomplete = index === 1 || index === 2 || index >= 4 ? 'new-password' : 'off';
    field.setAttribute('aria-label', accountLabels[index]);
    if (index === 0 || index === 3) field.pattern = '0x[0-9a-fA-F]{40}';
    if (index === 1) field.pattern = '(0x)?[0-9a-fA-F]{64}';
    if (index === 0) field.required = true;
    on(field, 'input', () => { accountDirty.add(field); accountMessage('账户修改尚未保存。请通过当前 HTTPS 页面提交；保存不会启动交易。'); });
  });
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
          if (field.value === submitted[index]) { accountDirty.delete(field); if (index === 1 || index === 2 || index >= 4) field.value = ''; }
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
  function receiveConfig(_config: Config | null, _error: string | null) {}
  function receiveAccount(account: Account | null) {
    if (!account || accountBusy) return;
    savedWallet = account.wallet;
    if (!accountDirty.has(accountFields[0])) accountFields[0].value = savedWallet;
  }
  on(accountButtons[0], 'click', () => void accountAction(false));
  on(accountButtons[1], 'click', () => void accountAction(true));
  if (liveAuthButton) on(liveAuthButton, 'click', async () => {
    if (liveAuthBusy || closed) return;
    liveAuthBusy = true; buttons();
    if (liveAuthState) liveAuthState.textContent = '检查中';
    if (liveAuthMessage) liveAuthMessage.textContent = '正在读取服务器授权状态，不会下单。';
    try {
      const status = await api.status();
      if (closed) return;
      const unlocked = status.live_unlocked === true;
      if (liveAuthState) liveAuthState.textContent = unlocked ? '服务器已解锁' : '服务器仍锁定';
      if (liveAuthMessage) liveAuthMessage.textContent = unlocked
        ? '服务器交易连接已开启；策略使用已保存参数启动。检查本身不会下单。'
        : '服务器暂未开放真实交易；请查看运行状态中的具体原因。';
    } catch (error) {
      if (closed) return;
      if (liveAuthState) liveAuthState.textContent = '检查失败';
      if (liveAuthMessage) liveAuthMessage.textContent = `${error instanceof Error ? error.message : '服务器状态读取失败'}；未改变授权或交易状态。`;
    } finally { liveAuthBusy = false; if (!closed) buttons(); }
  });
  on(globalSave, 'click', () => {
    const active = document.querySelector('[data-setting].active')?.getAttribute('data-setting');
    if (active === 'account') void accountAction(true);
    else if (active === 'system') { accountMessage('系统诊断没有可保存的配置。'); globalSave.title = '系统诊断没有可保存的配置'; }
    else void accountAction(true);
  });
  document.querySelectorAll('[data-setting]').forEach(button => on(button, 'click', buttons));
  accountMessage('可通过当前 HTTPS 页面检查、保存账户。空白密钥在钱包不变时保留服务器配置，换钱包不会继承旧密钥。检查不会保存，保存不会启动交易。');
  buttons();
  return { receiveConfig, receiveAccount, close: () => { closed = true; bindings.forEach(remove => remove()); accountFields.filter(field => field.type === 'password').forEach(field => field.value = ''); } };
}
