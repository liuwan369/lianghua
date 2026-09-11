from __future__ import annotations
import argparse, gc, json, subprocess, sys, tempfile
from pathlib import Path

def main() -> int:
    ap=argparse.ArgumentParser(description='Memory-isolated local risk sweep')
    ap.add_argument('--sqlite', nargs='+', required=True); ap.add_argument('--history-dir', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--max-markets', type=int, default=20); ap.add_argument('--max-combinations', type=int, default=4)
    a=ap.parse_args(); results=[]
    # Each child handles one bounded replay and exits, returning all memory to OS.
    presets=[
      {'order_size':'10','pair_cap':'0.97','max_inventory_imbalance':'10','taker_fee_rate':'0.07'},
      {'order_size':'10','pair_cap':'0.99','max_inventory_imbalance':'10','taker_fee_rate':'0.07'},
      {'order_size':'20','pair_cap':'0.97','max_inventory_imbalance':'30','taker_fee_rate':'0.07'},
      {'order_size':'20','pair_cap':'0.99','max_inventory_imbalance':'30','taker_fee_rate':'0.07'},
    ][:max(1,a.max_combinations)]
    for i,p in enumerate(presets,1):
        with tempfile.NamedTemporaryFile(suffix='.json',delete=False) as f: tmp=Path(f.name)
        cmd=[sys.executable,'scripts/pm-r26-historical-shadow-replay.py','--sqlite',*a.sqlite,'--history-dir',a.history_dir,'--out',str(tmp),'--max-markets',str(a.max_markets),'--order-size',p['order_size'],'--max-inventory-imbalance',p['max_inventory_imbalance'],'--taker-fee-rate',p['taker_fee_rate']]
        run=subprocess.run(cmd,capture_output=True,text=True)
        if run.returncode:
            tmp.unlink(missing_ok=True); raise SystemExit(run.stderr[-2000:])
        payload=json.loads(tmp.read_text(encoding='utf-8')); tmp.unlink(missing_ok=True)
        results.append({'parameters':p,'summary':payload.get('summary',{}),'coverage':payload.get('coverage',{})})
        print(f'completed {i}/{len(presets)}',flush=True); gc.collect()
    Path(a.out).parent.mkdir(parents=True,exist_ok=True); Path(a.out).write_text(json.dumps({'run_type':'pm-r29_memory_isolated_sweep','results':results},ensure_ascii=False,indent=2),encoding='utf-8')
    return 0
if __name__=='__main__': raise SystemExit(main())
