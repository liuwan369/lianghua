from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sqlite3
import time
import zlib
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pm_maker.shadow import MakerShadowEngine
from pm_maker.shadow import EPSILON


MARKET_RE = re.compile(r"^btc-updown-5m-(\d+)$")
TARGET = "0x3048d65321be3497164cdfc2996f94f98a2e7537"


def load_json_gz(path: Path) -> dict[str, Any]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def load_activity(history_dir: Path, address: str) -> dict[str, dict[str, float]]:
    """Return target BUY size/count by market. Activity is comparison data only."""
    output: dict[str, dict[str, float]] = defaultdict(lambda: {"count": 0.0, "shares": 0.0, "usdc": 0.0})
    seen: set[tuple[Any, ...]] = set()
    for path in sorted(history_dir.glob("*.json.gz")):
        payload = load_json_gz(path)
        for row in payload.get("records", []):
            if str(row.get("address") or row.get("proxyWallet") or "").lower() != address.lower():
                continue
            if str(row.get("type") or "").upper() != "TRADE" or str(row.get("side") or "").upper() != "BUY":
                continue
            slug = str(row.get("slug") or "")
            if not MARKET_RE.match(slug) or str(row.get("outcome") or "").title() not in {"Up", "Down"}:
                continue
            activity_id = row.get("id") or row.get("activityId") or row.get("activity_id")
            if activity_id:
                key = ("activity", str(activity_id))
            else:
                # API pages do not always expose an activity id.  Hash the
                # complete normalized row so pagination duplicates collapse
                # without silently ignoring unrelated fields.
                canonical = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                key = ("row", hashlib.sha256(canonical.encode("utf-8")).hexdigest())
            if key in seen:
                continue
            seen.add(key)
            item = output[slug]
            item["count"] += 1
            item["shares"] += float(row.get("size") or 0)
            item["usdc"] += float(row.get("usdcSize") or float(row.get("size") or 0) * float(row.get("price") or 0))
    return output


def load_activity_hashes(history_dir: Path, address: str) -> set[str]:
    hashes: set[str] = set()
    for path in sorted(history_dir.glob("*.json.gz")):
        payload = load_json_gz(path)
        for row in payload.get("records", []):
            if str(row.get("address") or row.get("proxyWallet") or "").lower() != address.lower():
                continue
            if str(row.get("type") or "").upper() == "TRADE" and str(row.get("side") or "").upper() == "BUY":
                tx = str(row.get("transactionHash") or "")
                if tx:
                    hashes.add(tx.lower())
    return hashes


def load_metadata(paths: list[Path]) -> dict[str, dict[str, Any]]:
    metadata: dict[str, dict[str, Any]] = {}
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(path)
        with sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True) as conn:
            for row in conn.execute("SELECT payload_json FROM events WHERE source='gamma' AND event_type='market_metadata'"):
                market = json.loads(row[0])
                slug = str(market.get("slug") or "")
                if not MARKET_RE.match(slug):
                    continue
                metadata[slug] = {
                    "market_id": str(market.get("condition_id") or market.get("gamma_market_id") or slug),
                    "slug": slug,
                    "start_at": int(market["start_at"]),
                    "end_at": int(market["end_at"]),
                    "up_token": str(market["up_token"]),
                    "down_token": str(market["down_token"]),
                }
    return metadata


def iter_clob(paths: list[Path], windows: dict[str, tuple[int, int]]) -> Iterable[tuple[int, str, int, str, Any]]:
    """Yield events globally ordered by receive time across all capture DBs.

    The collector writes one SQLite file per capture period.  Iterating files
    one at a time can move events backwards in time when a replay spans files,
    which changes queue and hedge behavior.  The bounded source-time window
    keeps memory proportional to the selected markets; sort once here so all
    callers receive deterministic cross-file order.
    """
    pending: list[tuple[int, str, int, str, Any]] = []
    for path in sorted(paths):
        if not path.exists():
            raise FileNotFoundError(path)
        with sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True) as conn:
            query = "SELECT received_second,payload_blob FROM event_chunks WHERE source='clob' ORDER BY received_second"
            for received_second, blob in conn.execute(query):
                rows = json.loads(zlib.decompress(blob).decode("utf-8"))
                for event_type, received_ns, source_ms, _slug, token, payload in rows:
                    if not token or source_ms is None or token not in windows:
                        continue
                    start_ms, end_ms = windows[token]
                    if source_ms < start_ms - 30000 or source_ms > end_ms + 30000:
                        continue
                    pending.append((int(received_ns), str(event_type), int(source_ms), str(token), payload))
    pending.sort(key=lambda event: (event[0], event[2], event[1], event[3]))
    yield from pending


def load_chain_links(paths: list[Path], address: str, activity_hashes: set[str]) -> dict[str, Any]:
    total = target_rows = maker_rows = taker_rows = 0
    matched_hashes: set[str] = set()
    fee_usdc = 0.0
    address = address.lower()
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(path)
        with sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True) as conn:
            for (raw,) in conn.execute("SELECT payload_json FROM events WHERE source='polygon' AND event_type='order_filled'"):
                row = json.loads(raw)
                maker = str(row.get("maker") or "").lower()
                taker = str(row.get("taker") or "").lower()
                if maker != address and taker != address:
                    continue
                total += 1
                role = str(row.get("role") or "").lower()
                maker_rows += role == "maker"
                taker_rows += role == "taker"
                tx = str(row.get("transactionHash") or "").lower()
                if tx in activity_hashes:
                    matched_hashes.add(tx)
                fee_usdc += float(row.get("feeUsdc") or 0)
                target_rows += 1
    return {"target_orderfilled_rows": total, "maker_rows": maker_rows, "taker_rows": taker_rows, "activity_hashes_matched": len(matched_hashes), "activity_hashes_seen": len(activity_hashes), "chain_fee_usdc": round(fee_usdc, 6), "note": "链上记录用于核对目标地址身份和 maker/taker；不把链上成交直接当成影子账户成交。"}


def levels_from_compact(payload: list[Any]) -> dict[str, Any]:
    return {
        "bids": [{"price": row[0], "size": row[1]} for row in (payload[1] or [])],
        "asks": [{"price": row[0], "size": row[1]} for row in (payload[2] or [])],
        "tick_size": payload[3] or "0.01",
        "timestamp": str(payload[0] or ""),
    }


def apply_changes(book: dict[str, Any], payload: list[Any]) -> dict[str, list[dict[str, Any]]]:
    by_side = {
        "bids": {str(row["price"]): str(row["size"]) for row in book.get("bids", [])},
        "asks": {str(row["price"]): str(row["size"]) for row in book.get("asks", [])},
    }
    for item in payload[1] or []:
        if len(item) < 4:
            continue
        price, size, side = str(item[1]), float(item[2] or 0), str(item[3]).upper()
        target = by_side["bids" if side == "BUY" else "asks"]
        if size <= 0:
            target.pop(price, None)
        else:
            target[price] = str(item[2])
    book["bids"] = [{"price": p, "size": s} for p, s in by_side["bids"].items()]
    book["asks"] = [{"price": p, "size": s} for p, s in by_side["asks"].items()]
    book["timestamp"] = str(payload[0] or "")
    return by_side


def apply_best_bid_ask(book: dict[str, Any], payload: list[Any]) -> dict[str, Any]:
    """Apply a top-of-book update while retaining known depth.

    The collector stores best_bid_ask separately from depth changes.  The
    message has no size, so carry the previous top level's size as a clearly
    approximate placeholder; this fixes stale quote prices without pretending
    to know the true queue size.
    """
    if not isinstance(payload, list) or len(payload) < 3:
        return book
    best_bid, best_ask = float(payload[1] or 0), float(payload[2] or 0)
    bids = [{"price": str(x["price"]), "size": str(x["size"])} for x in book.get("bids", [])]
    asks = [{"price": str(x["price"]), "size": str(x["size"])} for x in book.get("asks", [])]
    old_bid_size = max(bids, key=lambda x: float(x.get("price", 0)), default={}).get("size", 0.0)
    old_ask_size = min((x for x in asks if float(x.get("price", 0)) > 0), key=lambda x: float(x.get("price", 0)), default={}).get("size", 0.0)
    if best_bid > 0:
        old_best_bid = max((float(x.get("price", 0)) for x in bids), default=0.0)
        if old_best_bid and abs(old_best_bid - best_bid) > EPSILON:
            bids = [x for x in bids if abs(float(x["price"]) - old_best_bid) > EPSILON]
        bids = [{"price": str(best_bid), "size": str(old_bid_size)}] + [x for x in bids if float(x["price"]) != best_bid]
    if best_ask > 0:
        old_best_ask = min((float(x.get("price", 0)) for x in asks if float(x.get("price", 0)) > 0), default=0.0)
        if old_best_ask and abs(old_best_ask - best_ask) > EPSILON:
            asks = [x for x in asks if abs(float(x["price"]) - old_best_ask) > EPSILON]
        asks = [{"price": str(best_ask), "size": str(old_ask_size)}] + [x for x in asks if float(x["price"]) != best_ask]
    book["bids"], book["asks"], book["timestamp"] = bids, asks, str(payload[0] or "")
    return book


def new_engines(args: argparse.Namespace) -> dict[str, MakerShadowEngine]:
    common = {
        "max_inventory_per_side": args.max_inventory_per_side,
        "max_inventory_imbalance": args.max_inventory_imbalance,
        "min_order_live_ms": args.min_order_live_ms,
    }
    return {
        "strict_pair": MakerShadowEngine(order_size=args.order_size, max_pair_cost=0.98, strategy_name="strict_pair", **common),
        "calibrated_3048": MakerShadowEngine(
            order_size=20, max_pair_cost=1.02, preserve_hedge_order=True,
            pause_heavy_side_when_unpaired=True, taker_hedge_after_ms=10000,
            taker_fee_rate=args.taker_fee_rate, max_taker_pair_cost=1.03,
            queue_ahead_factor=0.25, strategy_name="calibrated_3048", **common,
        ),
        "candidate_r19": MakerShadowEngine(
            order_size=20, max_pair_cost=1.02, preserve_hedge_order=True,
            pause_heavy_side_when_unpaired=True, taker_hedge_after_ms=15000,
            taker_fee_rate=args.taker_fee_rate, max_taker_pair_cost=1.05,
            queue_ahead_factor=0.25, quote_start_delay_ms=15000,
            align_after_ms=240000, stop_new_quotes_after_ms=270000,
            alignment_pair_cost=0.98, hedge_order_size=5,
            max_hedge_ask=0.30, strategy_name="candidate_r19", **common,
        ),
    }


def summarize_market(engine: MakerShadowEngine, meta: dict[str, Any], first_ms: int | None, last_ms: int | None) -> dict[str, Any]:
    snap = engine.snapshot()
    snap["coverage"] = {
        "first_source_ms": first_ms,
        "last_source_ms": last_ms,
        "complete_5m_window": bool(first_ms is not None and last_ms is not None and first_ms <= meta["start_at"] * 1000 + 30000 and last_ms >= meta["end_at"] * 1000 - 30000),
    }
    return snap


def main() -> int:
    parser = argparse.ArgumentParser(description="Collector SQLite CLOB historical read-only shadow replay")
    parser.add_argument("--sqlite", nargs="+", required=True)
    parser.add_argument("--history-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--address", default=TARGET)
    parser.add_argument("--max-markets", type=int, default=200)
    parser.add_argument("--order-size", type=float, default=20)
    parser.add_argument("--max-inventory-per-side", type=float, default=500)
    parser.add_argument("--max-inventory-imbalance", type=float, default=100)
    parser.add_argument("--min-order-live-ms", type=int, default=250)
    parser.add_argument("--taker-fee-rate", type=float, default=0.07)
    args = parser.parse_args()
    dbs = [Path(item) for item in args.sqlite]
    metadata = load_metadata(dbs)
    activity = load_activity(Path(args.history_dir), args.address)
    activity_hashes = load_activity_hashes(Path(args.history_dir), args.address)
    chain_links = load_chain_links(dbs, args.address, activity_hashes)
    selected = sorted(metadata.values(), key=lambda row: row["start_at"])[-args.max_markets:]
    by_token = {token: (meta["slug"], outcome) for meta in selected for token, outcome in ((meta["up_token"], "Up"), (meta["down_token"], "Down"))}
    states: dict[str, dict[str, Any]] = {}
    for meta in selected:
        states[meta["slug"]] = {"meta": meta, "engines": new_engines(args), "first_ms": None, "last_ms": None, "last_received_ns": None, "max_gap_ms": 0.0, "tokens_seen": set(), "books": {}}
        for engine in states[meta["slug"]]["engines"].values():
            engine.start_market(meta)
    windows = {token: (meta["start_at"] * 1000, meta["end_at"] * 1000) for meta in selected for token in (meta["up_token"], meta["down_token"])}
    replay_events = list(iter_clob(dbs, windows))
    replay_events.sort(key=lambda item: item[0])
    seen_events = 0
    for received_ns, event_type, source_ms, token, payload in replay_events:
        match = by_token.get(token)
        if match is None:
            continue
        slug, _outcome = match
        state = states[slug]
        meta = state["meta"]
        if source_ms < meta["start_at"] * 1000 - 30000 or source_ms > meta["end_at"] * 1000 + 30000:
            continue
        received_ms = received_ns // 1_000_000
        state["first_ms"] = source_ms if state["first_ms"] is None else min(state["first_ms"], source_ms)
        state["last_ms"] = source_ms if state["last_ms"] is None else max(state["last_ms"], source_ms)
        previous_received = state.get("last_received_ns")
        if previous_received is not None:
            state["max_gap_ms"] = max(state.get("max_gap_ms", 0), (received_ns - previous_received) / 1_000_000)
        state["last_received_ns"] = received_ns
        state["tokens_seen"].add(token)
        seen_events += 1
        if event_type == "book":
            book = levels_from_compact(payload)
            state["books"][token] = book
            for engine in state["engines"].values():
                engine.update_book(token, dict(book), received_ms)
        elif event_type == "price_change":
            book = state["books"].setdefault(token, {"bids": [], "asks": [], "tick_size": "0.01", "timestamp": ""})
            apply_changes(book, payload)
            for engine in state["engines"].values():
                engine.update_book(token, dict(book), received_ms, refresh=False)
                engine.refresh_quotes(received_ms)
        elif event_type == "last_trade_price":
            if not isinstance(payload, list) or len(payload) < 4:
                continue
            price, size, taker_side = float(payload[1] or 0), float(payload[2] or 0), str(payload[3] or "")
            tx = payload[5] if len(payload) > 5 else None
            for engine in state["engines"].values():
                engine.process_trade(token=token, price=price, size=size, taker_side=taker_side, timestamp_ms=received_ms, transaction_hash=tx)
    rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    complete_slugs: set[str] = set()
    for slug, state in states.items():
        meta = state["meta"]
        complete = bool(state["first_ms"] is not None and state["last_ms"] is not None and len(state["tokens_seen"]) == 2 and state["first_ms"] <= meta["start_at"] * 1000 + 30000 and state["last_ms"] >= meta["end_at"] * 1000 - 30000 and state.get("max_gap_ms", 0) <= 60000)
        if complete:
            complete_slugs.add(slug)
        for name, engine in state["engines"].items():
            rows[name].append({"slug": slug, "target": activity.get(slug, {"count": 0, "shares": 0, "usdc": 0}), "snapshot": summarize_market(engine, meta, state["first_ms"], state["last_ms"])})
    summary: dict[str, Any] = {}
    for name, items in rows.items():
        eligible = [item for item in items if item["slug"] in complete_slugs]
        def total(key: str) -> float:
            return sum(float(item["snapshot"].get(key) or 0) for item in eligible)
        summary[name] = {
            "markets_seen": len(items),
            "complete_markets": len(eligible),
            "simulated_fills": int(total("fills")),
            "simulated_fill_shares": round(total("fill_shares"), 4),
            "paired_shares": round(total("paired_shares"), 4),
            "one_sided_markets": sum(float(item["snapshot"].get("unpaired_shares") or 0) > 0 for item in eligible),
            "max_single_market_cash_required_usdc": round(max((float(item["snapshot"].get("total_cost_usdc") or 0) for item in eligible), default=0), 4),
            "maker_fees_usdc": round(total("maker_fee_usdc"), 4),
            "taker_fees_usdc": round(total("taker_fee_usdc"), 4),
            "maker_rebate_usdc": 0.0,
            "liquidity_reward_usdc": 0.0,
            "guaranteed_paired_edge_usdc": round(total("guaranteed_paired_edge_usdc"), 4),
            "worst_case_settlement_pnl_usdc": round(total("worst_case_settlement_pnl_usdc"), 4),
            "target_activity_shares_same_markets": round(sum(float(item["target"]["shares"]) for item in eligible), 4),
            "target_activity_trades_same_markets": int(sum(float(item["target"]["count"]) for item in eligible)),
            "settlement_note": "到期兑付按Up/Down最差结果计算；没有把平台返佣或奖励算进收益。",
        }
    output = {
        "run_type": "pm-r26_historical_clob_shadow_replay",
        "trade_authorization": False,
        "account_connected": False,
        "source": {"server": "configured evidence collector", "sqlite": [str(path) for path in dbs], "history_dir": str(Path(args.history_dir)), "chain_links": chain_links},
        "coverage": {"metadata_markets": len(metadata), "selected_markets": len(selected), "complete_markets": len(complete_slugs), "clob_events_replayed": seen_events, "activity_is_comparison_only": True, "replay_clock": "collector received_at_ns"},
        "assumptions": ["公开盘口只显示汇总数量，排队位置按可见同价位数量乘0.25/保守模型模拟。", "碰到价格不等于一定成交；只有公开last_trade且对手方为SELL才给影子挂单成交。", "maker返佣和流动性奖励暂记0，需逐笔结算数据核实后再加。", "历史Activity不能恢复未成交订单，所以不能证明历史下单参数。"],
        "summary": summary,
        "markets": {name: items for name, items in rows.items()},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"coverage": output["coverage"], "summary": summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
