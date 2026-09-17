import { afterEach, expect, it, vi } from 'vitest';
import { connectForms } from './forms';
import { mountLayout } from './layout';

let form: ReturnType<typeof connectForms>;
afterEach(() => { form?.close(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function mount() {
  document.body.innerHTML = '<div id="app"></div>';
  mountLayout(document.getElementById('app')!);
  form = connectForms();
  return document.querySelector<HTMLButtonElement>('[data-live-auth-check]')!;
}
function response(unlocked: boolean) {
  return new Response(JSON.stringify({
    schemaVersion: 1, running: false, mode: 'paper', live_unlocked: unlocked,
    asOf: 1, run_id: null, account_id: null, config_revision: null,
    params: {}, stats: {}, stop_result: {}, projection: null,
  }));
}

it.each([false, true])('reports the actual lock state (%s) using only GET', async unlocked => {
  const fetch = vi.fn().mockResolvedValue(response(unlocked));
  vi.stubGlobal('fetch', fetch);
  const button = mount();
  expect(fetch).not.toHaveBeenCalled();
  expect(document.querySelector('[data-live-auth-confirm]')).toBeNull();
  button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('/api/v1/status', expect.objectContaining({method: 'GET'}));
  expect(document.querySelector('[data-live-auth-state]')!.textContent)
    .toBe(unlocked ? '服务器已解锁' : '服务器仍锁定');
});

it('clears an earlier unlocked result when the next check fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(true))
    .mockResolvedValueOnce(new Response('{}', {status: 503})));
  const button = mount();
  button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  button.click();
  await vi.waitFor(() => expect(document.querySelector('[data-live-auth-state]')!.textContent).toBe('检查失败'));
  expect(document.querySelector('[data-live-auth-message]')!.textContent).toContain('503');
});

it.each(['success', 'failure'])('deduplicates checks and ignores late %s after close', async outcome => {
  let resolve!: (value: Response) => void;
  let reject!: (reason: Error) => void;
  const fetch = vi.fn().mockReturnValue(new Promise<Response>((ok, fail) => { resolve = ok; reject = fail; }));
  vi.stubGlobal('fetch', fetch);
  const button = mount();
  button.click(); button.click();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  form.close();
  const panel = document.querySelector('[data-live-auth-panel]')!;
  const before = panel.textContent;
  if (outcome === 'success') resolve(response(true)); else reject(new TypeError('offline'));
  await new Promise(done => setTimeout(done, 20));
  expect(panel.textContent).toBe(before);
});
