#!/usr/bin/env python3
"""Detailed, read-only diagnosis for one paper dashboard JSONL run."""
from __future__ import annotations

import argparse
import collections
import json
import math
from pathlib import Path
from typing import Any


def f(value: Any, default: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def market(event: dict[str, Any]) -> str:
    return str(event.get("market_slug") or "<unknown>")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    counts: collections.Counter[str] = collections.Counter()
    rejections: collections.Counter[str] = collections.Counter()
    rows: dict[str, dict[str, Any]] = {}
    lines = malformed = 0
    min_ts: float | None = None
    max_ts: float | None = None

    with args.path.open("r", encoding="utf-8", errors="replace") as stream:
        for raw in stream:
            lines += 1
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                malformed += 1
                continue
            if not isinstance(event, dict):
                malformed += 1
                continue
            name = str(event.get("event") or "unknown")
            counts[name] += 1
            ts = f(event.get("recv_ts"))
            if ts is not None:
                min_ts = ts if min_ts is None else min(min_ts, ts)
                max_ts = ts if max_ts is None else max(max_ts, ts)
            key = market(event)
            row = rows.setdefault(key, {"fills": [], "resolutions": [], "exposures": [], "orders": [], "order_count": 0, "quotes": 0, "rejections": collections.Counter()})
            if name == "fill":
                row["fills"].append({
                    "ts": ts,
                    "engine_ts": f(event.get("engine_ts")),
                    "sec_into_market": f(event.get("sec_into_market")),
                    "side": str(event.get("side") or "").upper(),
                    "price": f(event.get("price"), 0.0),
                    "shares": f(event.get("shares"), 0.0),
                    "is_maker": event.get("is_maker"),
                    "fee_usdc": f(event.get("fee"), 0.0),
                })
            elif name == "resolved":
                row["resolutions"].append({k: event.get(k) for k in ("recv_ts", "winner", "pnl", "fees", "up_shares", "down_shares", "cost", "fills", "pair_cost", "matched_pair_over_1")})
            elif name == "inventory_exposure":
                row["exposures"].append({k: event.get(k) for k in ("recv_ts", "upShares", "downShares", "residualShares", "cost", "fees", "worstCaseLoss", "pendingOrders", "state", "reason")})
            elif name == "order_submit":
                row["order_count"] += 1
                if len(row["orders"]) < 1000:
                    row["orders"].append({k: event.get(k) for k in ("recv_ts", "engine_ts", "side", "price", "shares", "token_id")})
            elif name == "quote":
                row["quotes"] += 1
            elif name == "decision_rejected":
                code = str(event.get("code") or event.get("reason") or "unknown")
                row["rejections"][code] += 1
                rejections[code] += 1

    markets: dict[str, Any] = {}
    for key, row in rows.items():
        fills = sorted(row["fills"], key=lambda item: item["ts"] or 0.0)
        first = fills[0] if fills else None
        second = fills[1] if len(fills) > 1 else None
        paired = bool(first and second and first["side"] in {"UP", "DOWN"} and second["side"] in {"UP", "DOWN"} and first["side"] != second["side"])
        pair_cost = None
        pair_shares = None
        if paired:
            pair_shares = min(first["shares"] or 0.0, second["shares"] or 0.0)
            pair_cost = pair_shares * ((first["price"] or 0.0) + (second["price"] or 0.0))
        order_keys = [(item.get("side"), item.get("price"), item.get("shares"), item.get("token_id")) for item in row["orders"]]
        unique_orders = len(set(order_keys))
        markets[key] = {
            "quotes": row["quotes"],
            "order_submit_count": row["order_count"],
            "order_submit_sample_truncated": row["order_count"] > len(row["orders"]),
            "unique_order_shapes_in_first_1000": unique_orders,
            "fills": fills,
            "first_leg": first,
            "second_leg": second,
            "interleg_seconds": round((second["ts"] - first["ts"]), 6) if paired and first and second and first["ts"] is not None and second["ts"] is not None else None,
            "paired": paired,
            "paired_shares": pair_shares,
            "pair_cost_usdc_from_fills": round(pair_cost, 8) if pair_cost is not None else None,
            "pair_cost_per_share_from_fills": round(pair_cost / pair_shares, 8) if pair_cost is not None and pair_shares else None,
            "fees_usdc_from_fills": round(sum(item["fee_usdc"] or 0.0 for item in fills), 8),
            "resolutions": row["resolutions"],
            "exposures": row["exposures"],
            "rejections": dict(row["rejections"]),
        }

    report = {
        "schema_version": 1,
        "input": {"path": str(args.path), "lines": lines, "malformed_lines": malformed, "first_recv_ts": min_ts, "last_recv_ts": max_ts, "span_seconds": round(max_ts - min_ts, 6) if min_ts is not None and max_ts is not None else None},
        "event_counts": dict(counts),
        "rejections": dict(rejections),
        "markets": markets,
        "sample_assessment": {
            "markets_seen": len(markets),
            "fills": counts.get("fill", 0),
            "resolved_markets": counts.get("resolved", 0),
            "paired_markets": sum(1 for item in markets.values() if item["paired"]),
            "single_leg_markets": sum(1 for item in markets.values() if item["fills"] and not item["paired"]),
            "enough_for_default_freeze": False,
            "reason": "Only one paired market and two fills in a six-minute window; no statistical estimate of fill rate, adverse selection, or tail behavior.",
        },
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "lines": lines, "malformed_lines": malformed, "span_seconds": report["input"]["span_seconds"], "event_counts": dict(counts)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
