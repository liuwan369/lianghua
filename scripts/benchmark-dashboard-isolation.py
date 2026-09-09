"""Local synthetic performance evidence, never connects to a trading account.

Compares the same Node Engine.onBook workload with/without a busy projection
worker. Numbers are local CPU/event-loop timings, NOT exchange/network latency.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import time

from dashboard.read_model import ReadModel

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "_external/btc-5m-market-trading-bot"
CODE = r'''
import { performance } from 'node:perf_hooks';
import { Engine } from './dist/live/engine.js';
const percentile=(a,p)=>a.slice().sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))];
const e=new Engine({}); const samples=[], loop=[];
for(let market=0;market<150;market++) {
 const start=1000+market*300; e.reset(start,start+300);
 for(let i=0;i<500;i++) {
  const t=performance.now();
  e.onBook(start+i*0.5,0.48,0.50,0.49,0.51);
  samples.push(performance.now()-t);
 }
 const t=performance.now(); await new Promise(r=>setImmediate(r)); loop.push(performance.now()-t);
}
console.log(JSON.stringify({samples:samples.length,decision_p50_ms:percentile(samples,.5),
 decision_p95_ms:percentile(samples,.95),decision_p99_ms:percentile(samples,.99),
 yield_p95_ms:percentile(loop,.95)}));
'''


def measure():
    result = subprocess.run(["node", "--input-type=module", "-e", CODE], cwd=ENGINE,
                            capture_output=True, text=True, timeout=60, check=True)
    return json.loads(result.stdout.strip().splitlines()[-1])


def main():
    report = {"scope": "local synthetic, no network/orders/signing; not zero-impact proof", "pairs": []}
    with tempfile.TemporaryDirectory(prefix="pm-isolation-") as temporary:
        directory = Path(temporary)
        journal = directory / "synthetic.jsonl"
        line = json.dumps({"event": "fill", "market_slug": "benchmark", "price": .4, "shares": 5, "fee": 0}) + "\n"
        with journal.open("w") as output:
            for _ in range(100):
                output.write(line * 1000)
        model = ReadModel(directory / "view")
        try:
            measure()  # warmup, excluded
            for index in range(3):
                model.close()
                baseline = measure()
                model._next_restart = 0
                run_id = "load-" + str(index)
                model.select(run_id, "paper", None, journal, index + 1)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline and model.snapshot(run_id).get("state") == "waiting":
                    time.sleep(.02)
                loaded = measure()
                read_times = []
                for _ in range(500):
                    before = time.perf_counter()
                    model.snapshot(run_id)
                    read_times.append((time.perf_counter()-before)*1000)
                report["pairs"].append({"baseline": baseline, "loaded": loaded,
                    "snapshot_read_p95_ms": sorted(read_times)[475],
                    "worker_state": model.snapshot(run_id).get("state")})
        finally:
            model.close()
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
