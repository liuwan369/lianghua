from __future__ import annotations

import argparse
import gzip
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ADDRESS = "0x3048d65321be3497164cdfc2996f94f98a2e7537"


def rpc(tx: str, url: str) -> dict:
    r = requests.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionReceipt", "params": [tx]}, timeout=30)
    r.raise_for_status()
    payload = r.json()
    if payload.get("error") or not payload.get("result"):
        raise RuntimeError(str(payload.get("error") or "missing receipt"))
    return payload["result"]


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify target rebate/reward Activity rows as on-chain token transfers")
    ap.add_argument("--history-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--address", default=ADDRESS)
    ap.add_argument("--rpc-url", default="https://polygon.drpc.org")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    rows = {}; duplicate = 0
    for path in sorted(Path(args.history_dir).glob("*.json.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            data = json.load(fh)
        for row in data.get("records", []):
            if str(row.get("address") or "").lower() != args.address.lower() or row.get("type") not in {"MAKER_REBATE", "TAKER_REBATE", "REWARD"}:
                continue
            tx = str(row.get("transactionHash") or "").lower()
            if not tx:
                continue
            if tx in rows: duplicate += 1
            rows[tx] = row
    results = []
    def one(item):
        tx, row = item
        receipt = rpc(tx, args.rpc_url)
        incoming = []
        target_topic = "0x" + "0" * 24 + args.address.lower().removeprefix("0x")
        for log in receipt.get("logs", []):
            topics = [str(x).lower() for x in log.get("topics", [])]
            if len(topics) < 3 or topics[0] != TRANSFER_TOPIC or topics[2] != target_topic:
                continue
            data = str(log.get("data") or "0x")
            if len(data) < 66:
                continue
            incoming.append({"token": log.get("address"), "amount_raw": int(data[2:66], 16), "amount_usdc_6dp": int(data[2:66], 16) / 1_000_000})
        expected = float(row.get("usdcSize") or 0)
        observed = sum(x["amount_usdc_6dp"] for x in incoming)
        return {"tx": tx, "type": row.get("type"), "expected_usdc": expected, "observed_incoming_usdc": observed, "difference_usdc": observed - expected, "block": int(receipt["blockNumber"], 16), "transfers": incoming}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(one, item) for item in rows.items()]
        for i, f in enumerate(as_completed(futures), 1):
            try: results.append(f.result())
            except Exception as e: results.append({"error": str(e)})
            if i % 10 == 0 or i == len(futures): print(f"checked {i}/{len(futures)}", flush=True)
    ok = [x for x in results if not x.get("error") and abs(x["difference_usdc"]) < 0.00001]
    by_type = {}
    for typ in {x.get("type") for x in ok}:
        subset = [x for x in ok if x.get("type") == typ]
        by_type[typ] = {"count": len(subset), "expected_usdc": round(sum(x["expected_usdc"] for x in subset), 6), "observed_usdc": round(sum(x["observed_incoming_usdc"] for x in subset), 6)}
    out = {"run_type": "pm-r32_verify_incentive_transfers", "trade_authorization": False, "address": args.address, "source": "Polygon eth_getTransactionReceipt Transfer logs", "activity_unique_transactions": len(rows), "duplicate_rows": duplicate, "verified_exact": len(ok), "failed_or_mismatched": len(results) - len(ok), "by_type": by_type, "results": results}
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: out[k] for k in ["activity_unique_transactions", "verified_exact", "failed_or_mismatched", "by_type"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
