from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Any


DEFAULT_ADDRESS = "0x3048d65321be3497164cdfc2996f94f98a2e7537"
MARKET_RE = re.compile(r"^btc-updown-5m-(\d+)$")
PHASE_BOUNDS = (0, 30, 60, 120, 180, 240, 270, 301)
IMBALANCE_BOUNDS = (0, 20, 50, 100, 200, 500, float("inf"))


def validate_history_index(
    history_dir: Path, expected_days: int = 30, address: str = DEFAULT_ADDRESS,
) -> dict[str, Any]:
    index_path = history_dir / "index.json"
    if not index_path.exists():
        return {"complete": False, "error": "index.json missing", "missing_files": [], "gaps": []}
    index = json.loads(index_path.read_text(encoding="utf-8"))
    request = index.get("request") or {}
    windows = sorted(
        index.get("windows") or [],
        key=lambda row: int(row["start_epoch"]),
    )
    missing_files = [row["file"] for row in windows if not (history_dir / row["file"]).exists()]
    gaps = [
        {"after": left["file"], "before": right["file"]}
        for left, right in zip(windows, windows[1:])
        if int(right["start_epoch"]) != int(left["end_epoch"]) + 1
    ]
    pagination_incomplete = [row["file"] for row in windows if row.get("pagination_complete") is not True]
    checksum_mismatches = []
    for row in windows:
        path = history_dir / row["file"]
        if not path.exists() or not row.get("sha256"):
            checksum_mismatches.append(row["file"])
            continue
        if hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
            checksum_mismatches.append(row["file"])
    duration_seconds = 0 if not windows else int(windows[-1]["end_epoch"]) - int(windows[0]["start_epoch"])
    request_addresses = {str(item).lower() for item in request.get("addresses") or []}
    request_valid = (
        int(request.get("requested_days") or 0) >= expected_days
        and duration_seconds >= expected_days * 24 * 60 * 60
        and address.lower() in request_addresses
    )
    expected_start = int(request.get("requested_start_epoch") or -1)
    expected_end = int(request.get("requested_end_epoch") or -1)
    boundary_valid = bool(windows) and int(windows[0]["start_epoch"]) == expected_start and int(windows[-1]["end_epoch"]) == expected_end
    indexed_files = [row["file"] for row in windows]
    return {
        "complete": bool(windows) and not missing_files and not gaps and not pagination_incomplete
        and not checksum_mismatches and request_valid and boundary_valid,
        "windows": len(windows),
        "missing_files": missing_files,
        "gaps": gaps,
        "pagination_incomplete": pagination_incomplete,
        "checksum_mismatches": checksum_mismatches,
        "request_metadata_valid": request_valid,
        "boundary_valid": boundary_valid,
        "indexed_files": indexed_files,
        "covered_duration_seconds": duration_seconds,
        "expected_days": expected_days,
        "start_epoch": None if not windows else windows[0]["start_epoch"],
        "end_epoch": None if not windows else windows[-1]["end_epoch"],
    }


def quantile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.floor((len(ordered) - 1) * fraction))
    return ordered[index]


def quantiles(values: list[float]) -> dict[str, float | None]:
    return {
        name: None if (value := quantile(values, fraction)) is None else round(value, 6)
        for name, fraction in (("p05", .05), ("p25", .25), ("median", .5), ("p75", .75), ("p95", .95))
    }


def interval_label(value: float, bounds: tuple[float, ...]) -> str:
    for low, high in zip(bounds, bounds[1:]):
        if low <= value < high:
            return f"{low:g}-{high:g}" if math.isfinite(high) else f"{low:g}+"
    return f"{bounds[-2]:g}+"


def row_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        row.get("slug"), row.get("transactionHash"), row.get("asset"),
        row.get("timestamp"), row.get("size"), row.get("price"), row.get("side"),
    )


def load_markets(
    history_dir: Path, address: str, indexed_files: list[str] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    markets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen: set[tuple[Any, ...]] = set()
    paths = [history_dir / name for name in indexed_files] if indexed_files is not None else sorted(history_dir.glob("*.json.gz"))
    for path in paths:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
        for row in payload.get("records", []):
            if str(row.get("address") or "").lower() != address.lower():
                continue
            if str(row.get("type") or "").upper() != "TRADE":
                continue
            if str(row.get("side") or "").upper() != "BUY":
                continue
            outcome = str(row.get("outcome") or "").lower()
            slug = str(row.get("slug") or "")
            if outcome not in {"up", "down"} or not MARKET_RE.match(slug):
                continue
            key = row_key(row)
            if key in seen:
                continue
            seen.add(key)
            markets[slug].append(row)
    for rows in markets.values():
        rows.sort(key=lambda row: (int(float(row.get("timestamp") or 0)), str(row.get("transactionHash") or "")))
    return markets


def group_timestamp_batches(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[int, dict[str, Any]] = {}
    for row in rows:
        timestamp = int(float(row.get("timestamp") or 0))
        batch = grouped.setdefault(timestamp, {
            "timestamp": timestamp,
            "up_shares": 0.0,
            "down_shares": 0.0,
            "up_cost": 0.0,
            "down_cost": 0.0,
            "records": 0,
            "transactions": set(),
        })
        outcome = str(row.get("outcome") or "").lower()
        shares = float(row.get("size") or 0)
        cost = float(row.get("usdcSize") or shares * float(row.get("price") or 0))
        batch[f"{outcome}_shares"] += shares
        batch[f"{outcome}_cost"] += cost
        batch["records"] += 1
        if row.get("transactionHash"):
            batch["transactions"].add(str(row["transactionHash"]))
    output = []
    for batch in sorted(grouped.values(), key=lambda item: item["timestamp"]):
        batch["transactions"] = len(batch["transactions"])
        output.append(batch)
    return output


def classify_action(pre_imbalance: float, up_shares: float, down_shares: float) -> str:
    if up_shares > 0 and down_shares > 0:
        return "both"
    if abs(pre_imbalance) < 1e-9:
        return "start_up" if up_shares > 0 else "start_down"
    repairs = (pre_imbalance > 0 and down_shares > 0) or (pre_imbalance < 0 and up_shares > 0)
    return "repair" if repairs else "expand"


def summarize_group(rows: list[dict[str, Any]]) -> dict[str, Any]:
    waits = [row["wait_seconds"] for row in rows if row.get("wait_seconds") is not None]
    sizes = [row["batch_shares"] for row in rows]
    actions: dict[str, int] = defaultdict(int)
    for row in rows:
        actions[row["action"]] += 1
    directional = actions["repair"] + actions["expand"]
    return {
        "observations": len(rows),
        "actions": dict(sorted(actions.items())),
        "repair_pct_when_one_side_heavier": None if not directional else round(100 * actions["repair"] / directional, 4),
        "batch_shares": quantiles(sizes),
        "wait_to_next_batch_seconds": quantiles(waits),
    }


def analyze(markets: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    observations: list[dict[str, Any]] = []
    market_details: list[dict[str, Any]] = []
    first_offsets: list[float] = []
    last_offsets: list[float] = []
    max_abs_imbalances: list[float] = []
    max_side_inventories: list[float] = []

    for slug, rows in sorted(markets.items()):
        start = int(MARKET_RE.match(slug).group(1))
        batches = group_timestamp_batches(rows)
        if not batches:
            continue
        up_shares = down_shares = up_cost = down_cost = 0.0
        market_max_imbalance = 0.0
        for index, batch in enumerate(batches):
            offset = batch["timestamp"] - start
            pre_imbalance = up_shares - down_shares
            action = classify_action(pre_imbalance, batch["up_shares"], batch["down_shares"])
            next_timestamp = batches[index + 1]["timestamp"] if index + 1 < len(batches) else None
            batch_shares = batch["up_shares"] + batch["down_shares"]
            observations.append({
                "slug": slug,
                "timestamp": batch["timestamp"],
                "offset_seconds": offset,
                "phase": interval_label(max(0, offset), PHASE_BOUNDS),
                "pre_up_shares": up_shares,
                "pre_down_shares": down_shares,
                "pre_imbalance": pre_imbalance,
                "imbalance_bucket": interval_label(abs(pre_imbalance), IMBALANCE_BOUNDS),
                "pre_up_avg": None if up_shares <= 0 else up_cost / up_shares,
                "pre_down_avg": None if down_shares <= 0 else down_cost / down_shares,
                "action": action,
                "batch_up_shares": batch["up_shares"],
                "batch_down_shares": batch["down_shares"],
                "batch_shares": batch_shares,
                "batch_up_avg": None if batch["up_shares"] <= 0 else batch["up_cost"] / batch["up_shares"],
                "batch_down_avg": None if batch["down_shares"] <= 0 else batch["down_cost"] / batch["down_shares"],
                "wait_seconds": None if next_timestamp is None else next_timestamp - batch["timestamp"],
                "records": batch["records"],
                "transactions": batch["transactions"],
            })
            up_shares += batch["up_shares"]
            down_shares += batch["down_shares"]
            up_cost += batch["up_cost"]
            down_cost += batch["down_cost"]
            market_max_imbalance = max(market_max_imbalance, abs(up_shares - down_shares))
        first_offsets.append(batches[0]["timestamp"] - start)
        last_offsets.append(batches[-1]["timestamp"] - start)
        max_abs_imbalances.append(market_max_imbalance)
        max_side_inventories.append(max(up_shares, down_shares))
        market_details.append({
            "slug": slug,
            "batches": len(batches),
            "records": len(rows),
            "first_offset_seconds": batches[0]["timestamp"] - start,
            "last_offset_seconds": batches[-1]["timestamp"] - start,
            "final_up_shares": round(up_shares, 6),
            "final_down_shares": round(down_shares, 6),
            "final_imbalance": round(up_shares - down_shares, 6),
            "max_abs_imbalance": round(market_max_imbalance, 6),
        })

    by_phase = {
        label: summarize_group([row for row in observations if row["phase"] == label])
        for label in [interval_label(low, PHASE_BOUNDS) for low in PHASE_BOUNDS[:-1]]
    }
    by_imbalance = {
        label: summarize_group([row for row in observations if row["imbalance_bucket"] == label])
        for label in [interval_label(low, IMBALANCE_BOUNDS) for low in IMBALANCE_BOUNDS[:-1]]
    }
    directional = [row for row in observations if row["action"] in {"repair", "expand"}]
    repair_threshold = None
    for low in IMBALANCE_BOUNDS[:-1]:
        sample = [row for row in directional if abs(row["pre_imbalance"]) >= low]
        if len(sample) >= 100 and sum(row["action"] == "repair" for row in sample) / len(sample) >= .60:
            repair_threshold = low
            break

    return {
        "markets": len(market_details),
        "raw_trade_records": sum(len(rows) for rows in markets.values()),
        "timestamp_decision_batches": len(observations),
        "first_trade_offset_seconds": quantiles(first_offsets),
        "last_trade_offset_seconds": quantiles(last_offsets),
        "max_abs_inventory_imbalance_shares": quantiles(max_abs_imbalances),
        "max_one_side_inventory_shares": quantiles(max_side_inventories),
        "overall": summarize_group(observations),
        "by_phase": by_phase,
        "by_pretrade_abs_imbalance": by_imbalance,
        "observed_fill_repair_tendency_threshold_shares": repair_threshold,
        "observed_fill_timing_and_size_targets": {
            "first_fill_p25_seconds": quantile(first_offsets, .25),
            "typical_same_second_fill_batch_shares": quantile([row["batch_shares"] for row in observations], .5),
            "typical_gap_between_fill_batches_seconds": quantile([row["wait_seconds"] for row in observations if row["wait_seconds"] is not None], .5),
            "repair_tendency_reaches_60pct_at_abs_shares": repair_threshold,
            "last_fill_p75_seconds": quantile(last_offsets, .75),
            "last_fill_p95_seconds": min(299, quantile(last_offsets, .95) or 299),
            "observed_one_side_inventory_p95_shares": quantile(max_side_inventories, .95),
        },
        "evidence_limits": {
            "confirmed_from_history": [
                "成交后的累计仓位、每次成交方向和份数、成交间隔、各阶段行为变化",
                "不同仓位差下，下一次成交更常补轻的一边还是继续加重的一边",
            ],
            "not_observable_historically": [
                "未成交挂单、撤单和重挂时间、真实排队位置、成交前完整盘口",
                "同一秒内多方向成交的准确下单先后顺序",
                "目标为maker时，成交时间由对手方触发；首次成交、成交间隔和末次成交不能直接当成下单时间参数",
            ],
            "method_note": "公开Activity只有秒级时间；同一秒全部成交合并成成交批次。这里描述成交状态分布，不声称恢复了机器人的真实下单决策。",
        },
        "markets_detail": market_details,
    }


def render_report(result: dict[str, Any], history_coverage: dict[str, Any]) -> str:
    if not history_coverage["complete"]:
        return "\n".join([
            "# 0x3048 历史状态机反推",
            "",
            "证据状态：不完整，禁止输出策略结论。",
            "",
            f"- 缺失文件：{len(history_coverage.get('missing_files') or [])}",
            f"- 连续窗口缺口：{len(history_coverage.get('gaps') or [])}",
            f"- 分页未确认完整：{len(history_coverage.get('pagination_incomplete') or [])}",
            f"- 文件校验失败：{len(history_coverage.get('checksum_mismatches') or [])}",
            f"- 30天请求元数据有效：{history_coverage.get('request_metadata_valid') is True}",
            f"- 索引首尾严格匹配请求：{history_coverage.get('boundary_valid') is True}",
            "",
        ])
    p = result["observed_fill_timing_and_size_targets"]
    lines = [
        "# 0x3048 历史状态机反推",
        "",
        "证据状态：完整。",
        "",
        f"- 市场：{result['markets']:,} 场",
        f"- 原始成交：{result['raw_trade_records']:,} 笔",
        f"- 合并后的决策批次：{result['timestamp_decision_batches']:,} 次",
        f"- 常见同秒成交批次：{p['typical_same_second_fill_batch_shares']} 份",
        f"- 常见两批成交间隔：{p['typical_gap_between_fill_batches_seconds']} 秒",
        f"- 首次成交P25：开盘后 {p['first_fill_p25_seconds']} 秒",
        f"- 补轻边倾向达到60%的仓位差：{p['repair_tendency_reaches_60pct_at_abs_shares']} 份",
        f"- 末次成交P75：{p['last_fill_p75_seconds']} 秒",
        f"- 末次成交P95：{p['last_fill_p95_seconds']} 秒",
        "",
        "## 仓位差与下一步动作",
        "",
        "| 成交前两边相差 | 样本 | 补轻边比例 | 常见下一次间隔 |",
        "|---:|---:|---:|---:|",
    ]
    for label, item in result["by_pretrade_abs_imbalance"].items():
        repair = item["repair_pct_when_one_side_heavier"]
        lines.append(f"| {label}份 | {item['observations']:,} | {'无' if repair is None else str(repair) + '%'} | {item['wait_to_next_batch_seconds']['median']}秒 |")
    lines.extend([
        "",
        "这些是成交状态分布，不是已确认的下单参数。目标地址为maker时，成交时间受对手方影响；精确挂单价格与撤单规则要靠东京实时盘口采集。",
    ])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Infer the 0x3048 BTC 5m inventory state machine from public Activity")
    parser.add_argument("--history-dir", default="data/pm-r25-history-30d-verified")
    parser.add_argument("--address", default=DEFAULT_ADDRESS)
    parser.add_argument("--out", default="data/pm-r25-state-machine-30d.json")
    parser.add_argument("--report", default="data/pm-r25-state-machine-30d.md")
    args = parser.parse_args()
    history_dir = Path(args.history_dir)
    history_coverage = validate_history_index(history_dir, expected_days=30, address=args.address)
    markets = load_markets(history_dir, args.address, history_coverage.get("indexed_files") if history_coverage["complete"] else None)
    analysis = analyze(markets)
    result = {
        "run_type": "pm_r25_historical_state_machine_inference",
        "trade_authorization": False,
        "address": args.address.lower(),
        "source": "Polymarket public Activity, BTC 5-minute BUY records",
        "history_coverage": history_coverage,
        "evidence_status": "complete" if history_coverage["complete"] else "incomplete_do_not_conclude",
        "result": analysis,
    }
    out = Path(args.out)
    report = Path(args.report)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    report.write_text(render_report(analysis, history_coverage), encoding="utf-8")
    console = (
        {key: analysis[key] for key in ("markets", "raw_trade_records", "timestamp_decision_batches", "observed_fill_timing_and_size_targets")}
        if history_coverage["complete"] else
        {"evidence_status": "incomplete_do_not_conclude", "history_coverage": history_coverage}
    )
    print(json.dumps(console, ensure_ascii=False))
    print("read_only=true trade_authorization=false")
    return 0 if history_coverage["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
