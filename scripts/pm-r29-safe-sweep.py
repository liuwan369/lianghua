from __future__ import annotations
import argparse, gc, json, subprocess, sys, tempfile
from pathlib import Path

def main() -> int:
    ap=argparse.ArgumentParser(description='Memory-isolated local risk sweep')
    ap.add_argument('--sqlite', nargs='+', required=True); ap.add_argument('--history-dir', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--max-markets', type=int, default=20); ap.add_argument('--max-combinations', type=int, default=4)
    ap.add_argument('--resolution-labels', help='Verified official resolution report passed to each replay')
    ap.add_argument('--experiment', choices=['baseline', 'pair_cap', 'quote_start_delay'], default='baseline',
                    help='bounded one-variable diagnostic')
    a=ap.parse_args(); results=[]
    # Each child handles one bounded replay and exits, returning all memory to OS.
    if a.experiment == 'pair_cap':
        # Change only pair eligibility; all other assumptions remain fixed.
        presets=[
          {'order_size':'10','pair_cap':str(value),'queue_factor':'0.25',
           'max_inventory_imbalance':'10','taker_fee_rate':'0.07'}
          for value in (0.95, 0.97, 0.99, 1.02)
        ][:max(1,a.max_combinations)]
    elif a.experiment == 'quote_start_delay':
        # Change only the candidate quote start delay; all other assumptions remain fixed.
        presets=[
          {'order_size':'10','pair_cap':'0.97','queue_factor':'0.25',
           'max_inventory_imbalance':'10','taker_fee_rate':'0.07',
           'quote_start_delay_ms':str(value)}
          for value in (0, 5000, 15000, 30000)
        ][:max(1,a.max_combinations)]
    else:
        presets=[
          {'order_size':'10','pair_cap':'0.97','queue_factor':'0.25','max_inventory_imbalance':'10','taker_fee_rate':'0.07'},
          {'order_size':'10','pair_cap':'0.99','queue_factor':'0.50','max_inventory_imbalance':'10','taker_fee_rate':'0.07'},
          {'order_size':'20','pair_cap':'0.97','queue_factor':'0.25','max_inventory_imbalance':'30','taker_fee_rate':'0.07'},
          {'order_size':'20','pair_cap':'0.99','queue_factor':'0.50','max_inventory_imbalance':'30','taker_fee_rate':'0.07'},
        ][:max(1,a.max_combinations)]
    for i,p in enumerate(presets,1):
        with tempfile.NamedTemporaryFile(suffix='.json',delete=False) as f: tmp=Path(f.name)
        cmd=[sys.executable,'scripts/pm-r26-historical-shadow-replay.py','--sqlite',*a.sqlite,'--history-dir',a.history_dir,'--out',str(tmp),'--max-markets',str(a.max_markets),'--order-size',p['order_size'],'--pair-cap',p['pair_cap'],'--queue-factor',p.get('queue_factor','0.25'),'--max-inventory-imbalance',p['max_inventory_imbalance'],'--taker-fee-rate',p['taker_fee_rate'],'--quote-start-delay-ms',p.get('quote_start_delay_ms','15000')]
        if a.resolution_labels:
            cmd += ['--resolution-labels', a.resolution_labels]
        run=subprocess.run(cmd,capture_output=True,text=True)
        if run.returncode:
            tmp.unlink(missing_ok=True); raise SystemExit(run.stderr[-2000:])
        payload=json.loads(tmp.read_text(encoding='utf-8')); tmp.unlink(missing_ok=True)
        # Preserve replay-level diagnostic counters in the sweep artifact so
        # every parameter row explains zero fills without reopening temp JSON.
        results.append({'parameters':p,'summary':payload.get('summary',{}),
                        'diagnostic_rejections': {
                            strategy: data.get('diagnostic_rejections', {})
                            for strategy, data in payload.get('summary', {}).items()
                        },
                        'coverage':payload.get('coverage',{})})
        print(f'completed {i}/{len(presets)}',flush=True); gc.collect()
    Path(a.out).parent.mkdir(parents=True,exist_ok=True); Path(a.out).write_text(json.dumps({
        'run_type':'pm-r29_memory_isolated_sweep', 'experiment': a.experiment,
        'single_variable': a.experiment in {'pair_cap', 'quote_start_delay'},
        'fixed_assumptions': ({'order_size':'10','queue_factor':'0.25',
                              'max_inventory_imbalance':'10','taker_fee_rate':'0.07'}
                             if a.experiment in {'pair_cap', 'quote_start_delay'} else None),
        'results':results},ensure_ascii=False,indent=2),encoding='utf-8')
    return 0
if __name__=='__main__': raise SystemExit(main())
