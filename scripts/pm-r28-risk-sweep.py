from __future__ import annotations

import argparse
import importlib.util
import itertools
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pm_maker.shadow import MakerShadowEngine

_R26 = importlib.util.spec_from_file_location("pm_r26_replay", Path(__file__).with_name("pm-r26-historical-shadow-replay.py"))
if _R26 is None or _R26.loader is None:
    raise RuntimeError("cannot load replay helpers")
_MOD = importlib.util.module_from_spec(_R26)
_R26.loader.exec_module(_MOD)
load_metadata = _MOD.load_metadata
iter_clob = _MOD.iter_clob
levels_from_compact = _MOD.levels_from_compact
apply_changes = _MOD.apply_changes


def make_engine(p: dict[str, Any]) -> MakerShadowEngine:
    return MakerShadowEngine(
        order_size=p["order_size"], max_pair_cost=p["pair_cap"],
        max_inventory_per_side=p["max_inventory"], max_inventory_imbalance=p["max_imbalance"],
        min_order_live_ms=250, preserve_hedge_order=True,
        pause_heavy_side_when_unpaired=True, taker_hedge_after_ms=p["hedge_after_ms"],
        taker_fee_rate=0.07, max_taker_pair_cost=p["taker_pair_cap"],
        queue_ahead_factor=p["queue_factor"], quote_start_delay_ms=15000,
        align_after_ms=240000, stop_new_quotes_after_ms=270000,
        alignment_pair_cost=p["align_cap"], hedge_order_size=5,
        max_hedge_ask=p["hedge_max_ask"],
        require_safe_hedge_at_quote=p["safe_hedge"], strategy_name="risk_sweep",
    )


def run_one(event_factory, markets: dict[str, dict[str, Any]], params: dict[str, Any], slugs: set[str]) -> dict[str, Any]:
    engines: dict[str, MakerShadowEngine] = {}
    books: dict[str, dict[str, Any]] = {}
    for slug in slugs:
        engines[slug] = make_engine(params)
        engines[slug].start_market(markets[slug])
    token_to_slug = {token: slug for slug in slugs for token in (markets[slug]["up_token"], markets[slug]["down_token"])}
    # Completeness is tracked per token.  Aggregating Up/Down at market level
    # can hide a missing side (e.g. Up only at the beginning, Down only at the
    # end), which would make an apparently continuous market look complete.
    first_source: dict[str, int] = {}
    last_source: dict[str, int] = {}
    tokens_seen: dict[str, set[str]] = defaultdict(set)
    last_received: dict[str, int] = {}
    max_gap: dict[str, float] = defaultdict(float)
    # Stream/decompress one chunk at a time for every parameter run.  Keeping
    # the expanded CLOB payloads in a list made a 3-day sweep consume several
    # GB and could stall the host.
    for received_ns, event_type, _source_ms, token, payload in event_factory():
        slug = token_to_slug.get(token)
        if slug is None:
            continue
        received_ms = received_ns // 1_000_000
        first_source[token] = min(first_source.get(token, _source_ms), _source_ms)
        last_source[token] = max(last_source.get(token, _source_ms), _source_ms)
        tokens_seen[slug].add(token)
        if token in last_received:
            max_gap[token] = max(max_gap[token], (received_ns-last_received[token])/1_000_000)
        last_received[token] = received_ns
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
            engine.process_trade(
                token=token, price=float(payload[1] or 0), size=float(payload[2] or 0),
                taker_side=str(payload[3] or ""), timestamp_ms=received_ms,
                transaction_hash=payload[5] if len(payload) > 5 else None,
            )
    totals = defaultdict(float)
    markets_with_fills = one_sided = 0
    complete = set()
    for slug in slugs:
        market = markets[slug]
        tokens = (market["up_token"], market["down_token"])
        if all(
            token in tokens_seen[slug]
            and first_source.get(token, 0) <= market["start_at"] * 1000 + 30000
            and last_source.get(token, 0) >= market["end_at"] * 1000 - 30000
            and max_gap.get(token, 0) <= 60000
            for token in tokens
        ):
            complete.add(slug)
    for slug, engine in engines.items():
        if slug not in complete:
            continue
        snap = engine.snapshot()
        for key in ("fills", "fill_shares", "paired_shares", "guaranteed_paired_edge_usdc", "worst_case_settlement_pnl_usdc", "taker_fee_usdc", "total_cost_usdc"):
            totals[key] += float(snap.get(key) or 0)
        markets_with_fills += int(bool(snap.get("fills")))
        one_sided += int(float(snap.get("unpaired_shares") or 0) > 0)
    return {
        **{key: round(value, 6) for key, value in totals.items()},
        "markets_with_fills": markets_with_fills,
        "one_sided_markets": one_sided,
        "complete_markets": len(complete),
        "incomplete_markets": len(slugs) - len(complete),
        # A zero PnL here can mean that the strategy never entered any
        # complete market.  Keep this explicit so selection cannot mistake
        # an inactive run for a profitable one.
        "active_trade_run": bool(totals["fills"] > 0),
        "realized_settlement_pnl_usdc": None,
        "settlement_outcome_status": "unavailable_in_capture_metadata",
        "net_worst_case_after_taker_fee": round(totals["worst_case_settlement_pnl_usdc"], 6),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Risk-gated historical parameter sweep; read-only")
    parser.add_argument("--sqlite", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-combinations", type=int, default=64, help="limit combinations for a quicker, bounded sweep")
    parser.add_argument("--holdout-utc-day", help="UTC day key (epoch days) to reserve for holdout")
    parser.add_argument(
        "--max-markets-per-day",
        type=int,
        help="optional deterministic cap for a staged local run; newest markets per day are selected",
    )
    args = parser.parse_args()
    dbs = [Path(x) for x in args.sqlite]
    metadata = load_metadata(dbs)
    selected = sorted(metadata.values(), key=lambda x: x["start_at"])
    by_day: dict[str, set[str]] = defaultdict(set)
    for market in selected:
        by_day[str(market["start_at"] // 86400)].add(market["slug"])
    days = sorted(by_day)
    if len(days) < 2:
        raise SystemExit("need at least two UTC dates")
    # Use all earlier UTC days for training and reserve the newest day as a
    # completely untouched holdout.  This gives the parameter ranking more
    # history without leaking the holdout result into selection.
    holdout_day = args.holdout_utc_day or days[-1]
    if holdout_day not in by_day:
        raise SystemExit(f"holdout day {holdout_day!r} not found; available: {', '.join(days)}")
    train_days = [day for day in days if day < holdout_day]
    if not train_days:
        raise SystemExit("need at least one UTC day before holdout")
    def cap_day(day: str) -> set[str]:
        slugs = sorted(by_day[day], key=lambda slug: next(m["start_at"] for m in selected if m["slug"] == slug))
        if args.max_markets_per_day is None:
            return set(slugs)
        if args.max_markets_per_day < 1:
            raise SystemExit("--max-markets-per-day must be >= 1")
        return set(slugs[-args.max_markets_per_day:])

    train_slugs = set().union(*(cap_day(day) for day in train_days))
    holdout_slugs = cap_day(holdout_day)
    eligible_slugs = train_slugs | holdout_slugs
    windows = {token: (m["start_at"] * 1000, m["end_at"] * 1000) for m in selected if m["slug"] in eligible_slugs for token in (m["up_token"], m["down_token"])}
    event_factory = lambda: iter_clob(dbs, windows)
    params_list: list[dict[str, Any]] = []
    for order_size, pair_cap, queue_factor, max_inventory, max_imbalance, hedge_after, safe_hedge, hedge_max_ask in itertools.product(
        [10.0, 20.0], [0.97, 1.02], [0.10, 0.25], [50.0], [10.0, 30.0], [10000, 15000], [False, True], [0.30],
    ):
        params_list.append({
            "order_size": order_size, "pair_cap": pair_cap, "queue_factor": queue_factor,
            "max_inventory": max_inventory, "max_imbalance": max_imbalance,
            "hedge_after_ms": hedge_after, "safe_hedge": safe_hedge, "hedge_max_ask": hedge_max_ask,
            "taker_pair_cap": 1.03 if hedge_after <= 10000 else 1.05, "align_cap": 0.97,
        })
    if args.max_combinations < 1:
        raise SystemExit("--max-combinations must be >= 1")
    # Keep the most plausible low-risk region first when a bounded quick run
    # is requested, so a small limit still includes the prior best settings.
    focused = [p for p in params_list if p["pair_cap"] == 0.97 and p["queue_factor"] == 0.25 and p["safe_hedge"]]
    focused.sort(key=lambda p: (-p["order_size"], p["hedge_after_ms"], p["max_imbalance"]))
    remainder = [p for p in params_list if p not in focused]
    params_list = (focused + remainder)[:args.max_combinations]
    results = []
    for index, params in enumerate(params_list, 1):
        results.append({"parameters": params, "train": run_one(event_factory, metadata, params, train_slugs), "holdout": run_one(event_factory, metadata, params, holdout_slugs)})
        if index % 10 == 0:
            print(f"tested {index}/{len(params_list)}", flush=True)
    # Select parameters using train only. Holdout is strictly for one
    # out-of-sample check; ranking by it would leak the answer. Active runs
    # sort ahead of inactive runs: an inactive run has zero simulated PnL by
    # construction and must never win merely because it placed no orders.
    results.sort(key=lambda row: (
        int(row["train"].get("active_trade_run", False)),
        row["train"]["net_worst_case_after_taker_fee"],
        row["train"]["paired_shares"],
    ), reverse=True)
    for index, row in enumerate(results, 1):
        row["train_rank"] = index
    output = {
        "run_type": "pm-r28_risk_gated_parameter_sweep", "trade_authorization": False, "account_connected": False,
        "source": {"sqlite": [str(p) for p in dbs], "clock": "collector received_at_ns"},
        "split": {"train_utc_days": train_days, "holdout_utc_day": holdout_day, "train_markets": len(train_slugs), "holdout_markets": len(holdout_slugs), "max_markets_per_day": args.max_markets_per_day, "clob_events": sum(1 for _ in event_factory())},
        "assumptions": ["安全补仓门槛只表示盘口当时有可见对手方卖单，不等于真实一定成交。", "maker返佣和流动性奖励按0。", "目标地址Activity不用于假设影子账户成交。"],
        "selection_rule": "仅用训练日；有成交的运行优先于零成交运行，再按最坏结算盈亏和配对份数排序；留出日只做一次性检查，不参与选择",
        "top10": results[:10], "all_results": results,
    }
    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True); out.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"split": output["split"], "tested": len(results), "top3": results[:3]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
