import { describe, expect, it } from 'vitest';
import { activeMarkets, quotePair, usableMarket, marketMessage } from './ui';
import type { Resource, Markets } from './api/types';

const data: Markets = {schemaVersion:1,asOf:1000,node_label:'Dublin',collector_online:true,cache_age_seconds:1,current_markets:[{slug:'b',start:900,end:1300,up_bid:.4,up_ask:.45,down_bid:.5,down_ask:.52,ask_sum:.97,quote_at:new Date(999000).toISOString()},{slug:'a',start:900,end:1200,up_bid:null,up_ask:null,down_bid:.5,down_ask:.52,ask_sum:null,quote_at:null}]};
const resource: Resource<Markets> = {data,error:null,receivedAt:1000000,loading:false};
describe('market read model', () => {
  it('sorts active markets by end then slug', () => expect(activeMarkets(resource,1000000)).toHaveLength(2));
  it('clears a quote when collector or timestamp is stale', () => {
    expect(usableMarket(data.current_markets[0], resource, 1000000)).toBe(true);
    expect(usableMarket(data.current_markets[0], {...resource, data:{...data,cache_age_seconds:16}}, 1000000)).toBe(false);
  });
  it('does not fabricate a missing side', () => expect(quotePair(data.current_markets[1], 'up', true)).toBe('-- / --'));
  it('rejects missing and crossed prices even when timestamp is fresh',()=>{
    const m=data.current_markets[0];
    expect(usableMarket({...m,up_bid:null},resource,1000000)).toBe(false);
    expect(usableMarket({...m,up_bid:.6,up_ask:.4},resource,1000000)).toBe(false);
    expect(usableMarket({...m,quote_at:new Date(980000).toISOString()},resource,1000000)).toBe(false);
  });
  it('reports the connection failure instead of hiding it as an empty book',()=>{
    expect(marketMessage({...resource,data:{...data,collector_online:false,error_code:'collector_connection_failed'}},1000000)).toContain('SSH');
  });
});
