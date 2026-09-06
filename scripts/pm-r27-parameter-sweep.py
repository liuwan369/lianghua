from __future__ import annotations

import argparse
import itertools
import importlib.util
import json
import sqlite3
import sys
import zlib
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pm_maker.shadow import MakerShadowEngine
_R26 = importlib.util.spec_from_file_location("pm_r26_replay", Path(__file__).with_name("pm-r26-historical-shadow-replay.py"))
if _R26 is None or _R26.loader is None:
    raise RuntimeError("cannot load pm-r26 replay helpers")
_MOD = importlib.util.module_from_spec(_R26)
_R26.loader.exec_module(_MOD)
load_metadata = _MOD.load_metadata
iter_clob = _MOD.iter_clob
levels_from_compact = _MOD.levels_from_compact
apply_changes = _MOD.apply_changes


def engine_for(p: dict[str, Any]) -> MakerShadowEngine:
    return MakerShadowEngine(
        order_size=p["order_size"], max_pair_cost=p["pair_cap"],
        max_inventory_per_side=p["max_inventory"], max_inventory_imbalance=p["max_imbalance"],
        min_order_live_ms=250, preserve_hedge_order=True,
        pause_heavy_side_when_unpaired=True, taker_hedge_after_ms=p["hedge_after_ms"],
        taker_fee_rate=0.07, max_taker_pair_cost=p["taker_pair_cap"],
        queue_ahead_factor=p["queue_factor"], quote_start_delay_ms=15000,
        align_after_ms=240000, stop_new_quotes_after_ms=270000,
        alignment_pair_cost=p["align_cap"], hedge_order_size=5,
        max_hedge_ask=0.30, strategy_name="sweep",
    )


def run_one(events: list[tuple[int, str, int, str, Any]], markets: dict[str, dict[str, Any]], params: dict[str, Any], selected_slugs: set[str]) -> dict[str, Any]:
    engines: dict[str, MakerShadowEngine] = {}
    books: dict[str, dict[str, Any]] = {}
    for slug in selected_slugs:
        engine = engine_for(params)
        engine.start_market(markets[slug])
        engines[slug] = engine
    token_to_slug = {token: slug for slug in selected_slugs for token in (markets[slug]["up_token"], markets[slug]["down_token"])}
    for received_ns, event_type, _source_ms, token, payload in events:
        slug = token_to_slug.get(token)
        if slug is None:
            continue
        received_ms = received_ns // 1_000_000
        engine = engines[slug]
        if event_type == "book":
            book = levels_from_compact(payload)
            books[token] = book
            engine.update_book(token, dict(book), received_ms)
        elif event_type == "price_change":
            book = books.setdefault(token, {"bids": [], "asks": [], "tick_size": "0.01", "timestamp": ""})
            apply_changes(book, payload)
            engine.update_book(token, dict(book), received_ms, refresh=False)
            engine.refresh_quotes(received_ms)
        elif event_type == "last_trade_price" and isinstance(payload, list) and len(payload) >= 4:
            tx = payload[5] if len(payload) > 5 else None
            engine.process_trade(token=token, price=float(payload[1] or 0), size=float(payload[2] or 0), taker_side=str(payload[3] or ""), timestamp_ms=received_ms, transaction_hash=tx)
    totals = defaultdict(float)
    market_count = one_sided = 0
    for engine in engines.values():
        snap = engine.snapshot()
        for key in ("fills", "fill_shares", "paired_shares", "guaranteed_paired_edge_usdc", "worst_case_settlement_pnl_usdc", "taker_fee_usdc", "total_cost_usdc"):
            totals[key] += float(snap.get(key) or 0)
        if snap.get("fills", 0): market_count += 1
        if snap.get("unpaired_shares", 0): one_sided += 1
    return {
        **{key: round(value, 6) for key, value in totals.items()},
        "markets_with_fills": market_count, "one_sided_markets": one_sided,
        "net_worst_case_after_taker_fee": round(totals["worst_case_settlement_pnl_usdc"], 6),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Historical Tokyo CLOB parameter sweep; read-only")
    parser.add_argument("--sqlite", nargs="+", required=True)
    parser.add_argument("--history-dir", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    dbs = [Path(x) for x in args.sqlite]
    metadata = load_metadata(dbs)
    selected = sorted(metadata.values(), key=lambda x: x["start_at"])
    token_windows = {token: (m["start_at"] * 1000, m["end_at"] * 1000) for m in selected for token in (m["up_token"], m["down_token"])}
    events = list(iter_clob(dbs, token_windows))
    events.sort(key=lambda x: x[0])
    by_day: dict[str, set[str]] = defaultdict(set)
    for m in selected:
        by_day.setdefault(str(m["start_at"] // 86400), set()).add(m["slug"])
    days = sorted(by_day)
    if len(days) < 2:
        raise SystemExit("need at least two UTC dates for train/holdout")
    train_slugs, holdout_slugs = by_day[days[-2]], by_day[days[-1]]
    all_params = []
    for values in itertools.product([10.0, 20.0], [1.00, 1.02], [0.10, 0.25, 0.50], [100.0, 300.0], [10000, 15000, 30000]):
        order_size, pair_cap, queue_factor, max_inventory, hedge_after = values
        all_params.append({"order_size": order_size, "pair_cap": pair_cap, "queue_factor": queue_factor, "max_inventory": max_inventory, "hedge_after_ms": hedge_after, "max_imbalance": min(100.0, max_inventory), "taker_pair_cap": 1.05 if hedge_after >= 15000 else 1.03, "align_cap": 0.98})
    results = []
    for index, params in enumerate(all_params, 1):
        train = run_one(events, metadata, params, train_slugs)
        holdout = run_one(events, metadata, params, holdout_slugs)
        results.append({"rank_input": index, "parameters": params, "train": train, "holdout": holdout})
        if index % 10 == 0:
            print(f"tested {index}/{len(all_params)}", flush=True)
    results.sort(key=lambda row: (row["holdout"]["net_worst_case_after_taker_fee"], row["holdout"]["paired_shares"]), reverse=True)
    for index, row in enumerate(results, 1): row["holdout_rank"] = index
    output = {
        "run_type": "pm-r27_historical_parameter_sweep",
        "trade_authorization": False, "account_connected": False,
        "source": {"sqlite": [str(x) for x in dbs], "history_dir": args.history_dir, "clock": "Tokyo received_at_ns"},
        "split": {"train_utc_day": days[-2], "holdout_utc_day": days[-1], "train_markets": len(train_slugs), "holdout_markets": len(holdout_slugs), "clob_events": len(events)},
        "assumptions": ["Activity只用于目标成交量对照，不用于假设目标订单已经成交。", "排队前置量为可见同价位数量乘参数queue_factor；这不是目标真实队列位置。", "maker返佣和流动性奖励按0，未计入收益。", "只统计盘口覆盖到的市场；RPC链上缺口不被补成完整。"],
        "top10": results[:10], "all_results": results,
    }
    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True); out.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"split": output["split"], "top3": results[:3]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
