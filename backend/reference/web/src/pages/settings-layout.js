export function mountSettings() {
  const accountPanel = document.getElementById('settings-account');
  if (!accountPanel || accountPanel.querySelector('[data-control-auth]')) return;
  accountPanel.insertAdjacentHTML('beforeend', `<div class="settings-checks" data-control-auth><div class="field"><label for="controlToken">交易控制密码</label><input id="controlToken" type="password" autocomplete="current-password" placeholder="输入后保存到服务器"><small>保存后写入服务器私有账户配置；页面不会回显密码。浏览器只保留有时效的控制会话，服务重启后仍可用已保存密码。</small></div><div class="settings-actions"><button type="button" data-control-token-apply disabled>保存控制密码</button></div><div role="status" aria-live="polite" data-control-token-message>尚未保存交易控制密码。</div></div><div class="settings-checks" data-live-auth-panel><div class="section-title"><h2>交易连接</h2><span data-live-auth-state>未检查</span></div><button type="button" data-live-auth-check>检查服务器状态</button><div role="status" aria-live="polite" data-live-auth-message>尚未查询。</div></div>`);
}
