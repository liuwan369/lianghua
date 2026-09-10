import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, validate } from './client';

afterEach(()=>vi.unstubAllGlobals());

const market = { slug:'btc-1', start:100, end:400, up_bid:.49, up_ask:.5, down_bid:.49, down_ask:.5, ask_sum:1, quote_at:'2026-01-01T00:00:00Z' };
describe('versioned API validation', () => {
  it('accepts complete config and rejects unknown shape', () => {
    expect(() => validate('config', {schemaVersion:1, revision:2, savedAt:null, params:{}, capabilities:{}})).not.toThrow();
    expect(() => validate('config', {schemaVersion:1, revision:2, savedAt:null, params:{}})).toThrow();
  });
  it('rejects malformed market rows instead of rendering stale prices', () => {
    const valid = {schemaVersion:1, asOf:100, node_label:'Dublin', collector_online:true, cache_age_seconds:1, current_markets:[market]};
    expect(() => validate('markets', valid)).not.toThrow();
    expect(() => validate('markets', {...valid, current_markets:[{...market, up_ask:'0.5'}]})).toThrow();
  });
  it('requires the explicit account safety fields', () => {
    expect(() => validate('account', {wallet:'',wallet_configured:false,owner_signer_configured:false,relayer_api_configured:false,config_error:null,last_check:null})).not.toThrow();
    expect(() => validate('account', {wallet:'',wallet_configured:false})).toThrow();
  });
  it('uses no cached network response when the endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', {status:503})));
    const { api } = await import('./client');
    await expect(api.config()).rejects.toThrow('读取失败（HTTP 503）');
    vi.unstubAllGlobals();
  });
  it('does not reflect submitted credentials in an account failure', async () => {
    const owner_key='a'.repeat(64), relayer_key='synthetic-relayer-test-only';
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:false,error:`rejected ${owner_key} ${relayer_key}`} ),{status:400})));
    const error=await api.checkAccount({wallet:'',owner_key,relayer_key}).catch(e=>e as Error);
    expect((error as Error).message).toContain('HTTP 400');
    expect((error as Error).message).not.toContain(owner_key);
    expect((error as Error).message).not.toContain(relayer_key);
  });
  it('rejects proxy HTML and malformed save confirmations', async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response('<html>upstream failed</html>',{status:502}));
    vi.stubGlobal('fetch',fetch);
    await expect(api.saveConfig({},3)).rejects.toThrow('HTTP 502');
    fetch.mockResolvedValue(new Response(JSON.stringify({ok:true,status:{}})));
    await expect(api.saveConfig({},3)).rejects.toThrow();
  });
});
