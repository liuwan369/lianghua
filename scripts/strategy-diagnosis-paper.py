#!/usr/bin/env python3
"""Stream a paper dashboard JSONL and attribute fills, pairing, fees and inventory.

The dashboard file can be multi-gigabyte, so this script keeps only per-market
state and emits a compact JSON report.  It deliberately distinguishes observed
paper events from inferred settlement/markout values.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import statistics
from pathlib import Path
from typing import Any


SIDES = {"UP", "DOWN"}


def num(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def market_key(event: dict[str, Any]) -> str:
    return str(event.get("market_slug") or event.get("market") or "<unknown>")


def side(event: dict[str, Any]) -> str:
    return str(event.get("side") or event.get("token_side") or "").upper()


def add_fill(state: dict[str, Any], event: dict[str, Any]) -> None:
    fill_side = side(event)
    if fill_side not in SIDES:
        fill_side = "UNKNOWN"
    shares = num(event.get("shares", event.get("size", event.get("fill_shares"))))
    price = num(event.get("price", event.get("fill_price")))
    cost = num(event.get("cost", event.get("total_cost_usdc")), shares * price)
    fee = num(event.get("fee", event.get("fees", event.get("fee_usdc"))))
    # Paper engine marks simulated executions with is_maker; preserve unknown
    # rather than silently classifying missing liquidity as taker.
    if "is_maker" in event:
        liquidity = "maker" if bool(event.get("is_maker")) else "taker"
    else:
        liquidity = str(event.get("liquidity") or event.get("role") or "unknown").lower()
    row = {
        "side": fill_side,
        "shares": shares,
        "price": price,
        "cost_usdc": cost,
        "fee_usdc": fee,
        "liquidity": liquidity,
        "ts": num(event.get("recv_ts", event.get("timestamp", event.get("engine_ts"))), 0.0),
    }
    state["fills"].append(row)
    state["fill_count"] += 1
    state["fill_shares"] += shares
    state["fill_notional_usdc"] += cost
    state["fees_usdc"] += fee
    state["liquidity_counts"][liquidity] += 1
    state["liquidity_fees"][liquidity] += fee
    state["liquidity_cost"][liquidity] += cost
    state["side_shares"][fill_side] += shares
    state["side_cost"][fill_side] += cost


def new_state() -> dict[str, Any]:
    return {
        "fills": [],
        "fill_count": 0,
        "fill_shares": 0.0,
        "fill_notional_usdc": 0.0,
        "fees_usdc": 0.0,
        "liquidity_counts": collections.Counter(),
        "liquidity_fees": collections.defaultdict(float),
        "liquidity_cost": collections.defaultdict(float),
        "side_shares": collections.defaultdict(float),
        "side_cost": collections.defaultdict(float),
        "quotes": 0,
        "orders": 0,
        "rejections": collections.Counter(),
        "exposures": [],
        "settlements": [],
        "first_ts": None,
        "last_ts": None,
    }


def process(path: Path) -> tuple[dict[str, Any], int, int]:
    markets: dict[str, dict[str, Any]] = {}
    events = collections.Counter()
    lines = 0
    malformed = 0
    with path.open("r", encoding="utf-8", errors="replace") as stream:
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
            events[name] += 1
            key = market_key(event)
            state = markets.setdefault(key, new_state())
            ts = num(event.get("recv_ts", event.get("timestamp", event.get("engine_ts"))), 0.0)
            if ts:
                state["first_ts"] = ts if state["first_ts"] is None else min(state["first_ts"], ts)
                state["last_ts"] = ts if state["last_ts"] is None else max(state["last_ts"], ts)
            if name in {"quote", "quote_submit", "order_submit"}:
                state["quotes"] += int(name.startswith("quote"))
                state["orders"] += int(name == "order_submit")
            if name in {"fill", "trade", "simulated_fill", "maker_fill", "taker_fill"}:
                add_fill(state, event)
            if name in {"order_rejected", "quote_rejected", "reject", "decision_rejected"}:
                reason = str(event.get("reason") or event.get("reject_reason") or event.get("code") or "unknown")
                state["rejections"][reason] += 1
            if name == "inventory_exposure":
                state["exposures"].append({
                    "ts": ts,
                    "up_shares": num(event.get("upShares", event.get("up_shares"))),
                    "down_shares": num(event.get("downShares", event.get("down_shares"))),
                    "residual_shares": num(event.get("residualShares", event.get("residual_shares"))),
                    "cost_usdc": num(event.get("cost", event.get("total_cost_usdc"))),
                    "fees_usdc": num(event.get("fees", event.get("fee_usdc"))),
                    "worst_case_loss_usdc": num(event.get("worstCaseLoss", event.get("worst_case_loss_usdc"))),
                    "state": event.get("state"),
                    "reason": event.get("reason"),
                })
            if name in {"settlement", "market_settled", "resolved", "pnl"}:
                state["settlements"].append({
                    "ts": ts,
                    "pnl_usdc": num(event.get("pnl", event.get("pnl_usdc", event.get("settlement_pnl_usdc"))), float("nan")),
                    "winner": event.get("winner", event.get("result")),
                })
    return {"markets": markets, "events": events}, lines, malformed


def serialise(data: dict[str, Any]) -> dict[str, Any]:
    markets = {}
    totals = collections.Counter()
    total_numeric = collections.defaultdict(float)
    for key, state in data["markets"].items():
        fills = state["fills"]
        up = state["side_shares"].get("UP", 0.0)
        down = state["side_shares"].get("DOWN", 0.0)
        paired = min(up, down)
        residual = abs(up - down)
        pair_cost = 0.0
        if paired > 0:
            up_cost = state["side_cost"].get("UP", 0.0)
            down_cost = state["side_cost"].get("DOWN", 0.0)
            pair_cost = paired * (up_cost / up + down_cost / down)
        exposure_peak = max((num(row.get("residual_shares")) for row in state["exposures"]), default=residual)
        exposure_peak_loss = max((num(row.get("worst_case_loss_usdc")) for row in state["exposures"]), default=0.0)
        settlement_pnl = sum(num(row.get("pnl_usdc"), 0.0) for row in state["settlements"] if math.isfinite(num(row.get("pnl_usdc"), float("nan"))))
        row = {
            "fill_count": state["fill_count"],
            "fill_shares": round(state["fill_shares"], 8),
            "fill_notional_usdc": round(state["fill_notional_usdc"], 8),
            "fees_usdc": round(state["fees_usdc"], 8),
            "maker_fills": state["liquidity_counts"].get("maker", 0),
            "taker_fills": state["liquidity_counts"].get("taker", 0),
            "unknown_liquidity_fills": sum(v for k, v in state["liquidity_counts"].items() if k not in {"maker", "taker"}),
            "maker_fees_usdc": round(state["liquidity_fees"].get("maker", 0.0), 8),
            "taker_fees_usdc": round(state["liquidity_fees"].get("taker", 0.0), 8),
            "maker_notional_usdc": round(state["liquidity_cost"].get("maker", 0.0), 8),
            "taker_notional_usdc": round(state["liquidity_cost"].get("taker", 0.0), 8),
            "up_shares": round(up, 8),
            "down_shares": round(down, 8),
            "paired_shares": round(paired, 8),
            "residual_shares": round(residual, 8),
            "pair_cost_usdc": round(pair_cost, 8),
            "pair_cost_per_share": round(pair_cost / paired, 8) if paired else None,
            "peak_residual_shares": round(exposure_peak, 8),
            "peak_worst_case_loss_usdc": round(exposure_peak_loss, 8),
            "settlement_pnl_usdc": round(settlement_pnl, 8),
            "quotes": state["quotes"],
            "orders": state["orders"],
            "rejections": dict(state["rejections"]),
            "first_ts": state["first_ts"],
            "last_ts": state["last_ts"],
            "last_exposure": state["exposures"][-1] if state["exposures"] else None,
            "settlements": state["settlements"],
        }
        markets[key] = row
        totals.update({"markets": 1, "fills": state["fill_count"], "maker_fills": row["maker_fills"], "taker_fills": row["taker_fills"]})
        for name in ("fill_shares", "fill_notional_usdc", "fees_usdc", "paired_shares", "residual_shares", "pair_cost_usdc", "settlement_pnl_usdc"):
            total_numeric[name] += row[name]
    return {
        "schema_version": 1,
        "markets": markets,
        "totals": {**dict(totals), **{key: round(value, 8) for key, value in total_numeric.items()}},
        "event_counts": dict(data["events"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    data, lines, malformed = process(args.path)
    report = serialise(data)
    report["input"] = {"path": str(args.path), "lines": lines, "malformed_lines": malformed}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "lines": lines, "malformed_lines": malformed, "totals": report["totals"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
