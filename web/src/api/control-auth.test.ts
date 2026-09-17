import { afterEach,expect,it,vi } from 'vitest';
import { mutationHeaders,post } from './client';
afterEach(()=>{vi.unstubAllGlobals();document.body.replaceChildren();});
it('passes the control password only as a header and hides it from server error text',async()=>{
  document.body.innerHTML='<input id="controlToken" type="password">';(document.getElementById('controlToken') as HTMLInputElement).value='current-session-only';
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:false,error:'invalid current-session-only'}),{status:403}));vi.stubGlobal('fetch',fetch);
  expect(mutationHeaders()['X-PM-Control-Token']).toBe('current-session-only');await expect(post('/api/trading/control',{action:'pause'})).rejects.toThrow('invalid [已隐藏]');
  expect(fetch.mock.calls[0][1].body).not.toContain('current-session-only');expect(fetch.mock.calls[0][1].headers['X-PM-Control-Token']).toBe('current-session-only');
});
it('guides a rejected password to the ordinary settings page',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:401})));await expect(post('/api/trading/control',{action:'start'})).rejects.toThrow('设置 → 系统诊断');
});
