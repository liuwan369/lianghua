export function mountSettings() {
  document.getElementById('settings-system').insertAdjacentHTML('beforeend', `<div class="field"><label for="controlToken">交易控制密码</label><input id="controlToken" type="password" autocomplete="off" placeholder="需要操作时填写"><small>只保留在本次页面中，用于保存参数、启停和账户操作，刷新后清空。</small></div><div class="settings-checks" data-live-auth-panel><div class="section-title"><h2>交易连接</h2><span data-live-auth-state>未检查</span></div><button type="button" data-live-auth-check>检查服务器状态</button><div role="status" aria-live="polite" data-live-auth-message>尚未查询。</div></div>`);
}
