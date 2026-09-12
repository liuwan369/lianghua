"""Summarize existing journals without credentials, orders, or network writes."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import math
from pathlib import Path


METRICS = (
    "market_age", "book_processing", "strategy_decision", "order_sign",
    "order_ack", "cancel_ack", "fill_report", "reaction",
)


def summary(values):
    values = sorted(values)
    def percentile(q):
        return round(values[max(0, math.ceil(len(values) * q) - 1)], 6) if values else None
    return {"samples": len(values), "p50_ms": percentile(.5),
            "p95_ms": percentile(.95), "p99_ms": percentile(.99),
            "min_ms": values[0] if values else None,
            "max_ms": values[-1] if values else None}


def audit(root):
    groups = defaultdict(list)
    events = Counter()
    rejected = Counter()
    sources = []
    for path in sorted(root.rglob("*.jsonl")):
        rows = latency_rows = 0
        first = last = None
        with path.open("rb") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except (ValueError, UnicodeError):
                    rejected["invalid_json"] += 1
                    continue
                if not isinstance(row, dict):
                    rejected["non_object"] += 1
                    continue
                rows += 1
                event = row.get("event")
                if isinstance(event, str):
                    events[event] += 1
                if event != "latency":
                    continue
                metric, value = row.get("metric"), row.get("duration_ms")
                if metric not in METRICS:
                    rejected["unknown_metric"] += 1
                    continue
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    rejected["invalid_duration"] += 1
                    continue
                mode = "live" if row.get("live") is True else "paper" if row.get("live") is False else "unknown"
                if row.get("mode") not in (None, mode):
                    rejected["mode_conflict"] += 1
                    continue
                groups[(mode, metric)].append(float(value))
                latency_rows += 1
                ts = row.get("recv_ts")
                if isinstance(ts, (float, int)) and not isinstance(ts, bool) and math.isfinite(ts):
                    first = ts if first is None else min(first, ts)
                    last = ts if last is None else max(last, ts)
        if rows:
            sources.append({"path": str(path.relative_to(root)), "rows": rows,
                            "latency_rows": latency_rows, "first_latency_epoch": first,
                            "last_latency_epoch": last})
    return {"generated_at": datetime.now(timezone.utc).isoformat(),
            "evidence_type": "historical_journal_measurements", "new_orders_submitted": 0,
            "sources": sources, "event_counts": dict(events), "rejected_rows": dict(rejected),
            "metrics": {mode: {metric: summary(groups[(mode, metric)]) for metric in METRICS}
                        for mode in ("live", "paper", "unknown")},
            "limitations": ["Journal mode is recorded evidence, not independently verified execution.",
                            "ACK latency is not fill waiting time or proof of resting visibility.",
                            "Historical execution timings do not establish current network latency.",
                            "Quantiles from small samples do not establish tail reliability."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if not args.root.is_dir():
        parser.error("journal root must be an existing directory")
    rendered = json.dumps(audit(args.root), ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
