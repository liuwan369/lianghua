import { afterEach,expect,it } from 'vitest';
import { mountLayout } from '../layout';
import { renderReversal } from './reversal-runtime';
import type { Status } from '../api/types';
afterEach(()=>document.body.replaceChildren());
function mount(){document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);}
function fixture():Status{return {schemaVersion:1,asOf:100,running:true,engine:'platform',mode:'live',run_id:'run',projection:{run_id:'run',state:'ready',stale:false},stats:{runtime:{engine:'platform',status:'running',stale:false,source_at:100,expires_at:110,positions:[{tokenId:'up',shares:5,costUsd:3.5}],strategy_runtime:{strategyId:'btc-reversal',paused:false,currentRound:{marketId:'0x-condition-id',name:'btc-five',startsAt:90,endsAt:390,upTokenId:'up',downTokenId:'down',config:{maxStages:4},configRevision:'3',confirmationCount:1,nextDirection:'DOWN',nextShares:18,status:'running',reason:'等待相反方向触发',stages:[{stage:1,direction:'UP',shares:5,price:.7,filledShares:5,status:'FILLED',trigger:'initial_band_entry'}]}},books:[{tokenId:'up',stale:false,market_expired:false,ts:99.9,bid:.69,ask:.70,bids:[[.69,20]],asks:[[.7,30]]},{tokenId:'down',stale:false,market_expired:false,ts:99.8,bid:.29,ask:.3,bids:[[.29,40]],asks:[[.3,50]]}]} }} as unknown as Status;}
it('renders currentRound fields and array-shaped depth from the actual server contract',()=>{
  mount();expect(renderReversal(fixture(),100)).toEqual({marketId:'0x-condition-id',marketName:'btc-five'});
  expect(document.querySelector('[data-reversal-next]')!.textContent).toBe('DOWN · 18.00 份');expect(document.querySelector('[data-reversal-revision]')!.textContent).toContain('3');expect(document.querySelector('[data-reversal-timeline]')!.textContent).toContain('已成交');expect(document.querySelector('[data-reversal-up]')!.textContent).toBe('5.0000');expect(document.querySelector('[data-reversal-down]')!.textContent).toBe('0.0000');expect(document.querySelector('[data-reversal-outcomes]')!.textContent).toBe('-- / --');
  expect(document.querySelector('[data-reversal-depth]')!.textContent).toContain('0.6900');expect(document.querySelector('[data-reversal-depth]')!.textContent).toContain('30.00');expect(document.querySelector('[data-book-age]')!.textContent).toContain('200 ms');
});
it('clears stale or cross-run depth, holdings and decision state instead of showing it as live',()=>{
  mount();const status=fixture();renderReversal(status,100);renderReversal(status,111);expect(document.querySelector('[data-reversal-up]')!.textContent).toBe('--');expect(document.querySelector('[data-reversal-next]')!.textContent).toBe('--');expect(document.querySelector('[data-reversal-depth]')!.textContent).not.toContain('0.6900');
  status.projection!.run_id='old';expect(renderReversal(status,100)).toBeNull();
});
