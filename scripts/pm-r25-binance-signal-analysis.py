from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import random
import re
import time
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ADDRESS = "0x3048d65321be3497164cdfc2996f94f98a2e7537"
MARKET_RE = re.compile(r"^btc-updown-5m-(\d+)$")
HORIZONS = (1, 3, 5, 15, 30)
IMBALANCE_BOUNDS = (0, 20, 50, 100, 200, 500, float("inf"))
ARCHIVE = "https://data.binance.vision/data/spot/daily/klines/BTCUSDT/1s/BTCUSDT-1s-{date}.zip"
USER_AGENT = "pm-r25-binance-history-read-only/1.0"


def quantile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.floor((len(ordered) - 1) * fraction))]


def interval_label(value: float, bounds: tuple[float, ...]) -> str:
    for low, high in zip(bounds, bounds[1:]):
        if low <= value < high:
            return f"{low:g}-{high:g}" if math.isfinite(high) else f"{low:g}+"
    return f"{bounds[-2]:g}+"


def validate_history_index(history_dir: Path, expected_days: int = 30, address: str = ADDRESS) -> dict:
    index_path = history_dir / "index.json"
    if not index_path.exists():
        return {"complete": False, "error": "index.json missing"}
    index = json.loads(index_path.read_text(encoding="utf-8"))
    request = index.get("request") or {}
    windows = sorted(index.get("windows") or [], key=lambda row: row["start_epoch"])
    missing_files = [row["file"] for row in windows if not (history_dir / row["file"]).exists()]
    gaps = []
    for left, right in zip(windows, windows[1:]):
        if int(right["start_epoch"]) != int(left["end_epoch"]) + 1:
            gaps.append({"after": left["file"], "before": right["file"]})
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
        "windows": len(windows), "missing_files": missing_files, "gaps": gaps,
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


def history_batches(history_dir: Path, address: str, indexed_files: list[str] | None = None) -> list[dict]:
    seen: set[tuple] = set()
    grouped: dict[tuple[str, int], dict] = {}
    paths = [history_dir / name for name in indexed_files] if indexed_files is not None else sorted(history_dir.glob("*.json.gz"))
    for path in paths:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
        for row in payload.get("records", []):
            if str(row.get("address") or "").lower() != address.lower():
                continue
            if str(row.get("type") or "").upper() != "TRADE" or str(row.get("side") or "").upper() != "BUY":
                continue
            slug = str(row.get("slug") or "")
            outcome = str(row.get("outcome") or "").lower()
            match = MARKET_RE.match(slug)
            if not match or outcome not in {"up", "down"}:
                continue
            key = (
                slug, row.get("transactionHash"), row.get("asset"), row.get("timestamp"),
                row.get("size"), row.get("price"), row.get("usdcSize"),
            )
            if key in seen:
                continue
            seen.add(key)
            timestamp = int(float(row.get("timestamp") or 0))
            batch = grouped.setdefault((slug, timestamp), {
                "slug": slug, "market_start": int(match.group(1)), "timestamp": timestamp,
                "up_shares": 0.0, "down_shares": 0.0, "up_cost": 0.0, "down_cost": 0.0,
            })
            shares = float(row.get("size") or 0)
            cost = float(row.get("usdcSize") or shares * float(row.get("price") or 0))
            batch[f"{outcome}_shares"] += shares
            batch[f"{outcome}_cost"] += cost
    return sorted(grouped.values(), key=lambda row: (row["timestamp"], row["slug"]))


def date_for_epoch(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).date().isoformat()


def required_seconds(batches: list[dict]) -> dict[str, set[int]]:
    output: dict[str, set[int]] = defaultdict(set)
    for row in batches:
        points = {row["timestamp"], row["timestamp"] - 1, row["timestamp"] - 2, row["market_start"], row["market_start"] + 299}
        for end_lag in (1, 2):
            safe_end = row["timestamp"] - end_lag
            for horizon in HORIZONS:
                points.add(safe_end - horizon)
                points.add(safe_end)
        for horizon in HORIZONS:
            points.add(row["timestamp"] + horizon)
        for epoch in points:
            output[date_for_epoch(epoch)].add(epoch)
    return output


def download_day(cache_dir: Path, date: str) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"BTCUSDT-1s-{date}.zip"
    if path.exists() and path.stat().st_size > 1000:
        return path
    url = ARCHIVE.format(date=date)
    partial = path.with_suffix(".zip.partial")
    for attempt in range(6):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(request, timeout=60) as response, partial.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            with zipfile.ZipFile(partial) as archive:
                if archive.testzip() is not None:
                    raise RuntimeError("archive CRC failed")
            partial.replace(path)
            return path
        except (HTTPError, URLError, TimeoutError, OSError, zipfile.BadZipFile) as exc:
            partial.unlink(missing_ok=True)
            if attempt == 5:
                raise RuntimeError(f"failed to download {date}: {exc}") from exc
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def load_needed_prices(cache_dir: Path, needed: dict[str, set[int]]) -> tuple[dict[int, float], list[str], dict]:
    prices: dict[int, float] = {}
    missing_archives: list[str] = []
    missing_seconds_by_date: dict[str, int] = {}
    for index, (date, seconds) in enumerate(sorted(needed.items()), start=1):
        try:
            path = download_day(cache_dir, date)
        except RuntimeError:
            missing_archives.append(date)
            continue
        remaining = set(seconds)
        with zipfile.ZipFile(path) as archive:
            name = archive.namelist()[0]
            with archive.open(name) as raw:
                reader = csv.reader((line.decode("utf-8") for line in raw))
                for row in reader:
                    if not row or not row[0].isdigit():
                        continue
                    raw_time = int(row[0])
                    epoch = raw_time // (1_000_000 if raw_time > 10_000_000_000_000 else 1000)
                    if epoch in remaining:
                        prices[epoch] = float(row[4])
                        remaining.remove(epoch)
                        if not remaining:
                            break
        print(json.dumps({"archive": index, "date": date, "requested": len(seconds), "found": len(seconds) - len(remaining)}), flush=True)
        if remaining:
            missing_seconds_by_date[date] = len(remaining)
    requested = sum(len(seconds) for seconds in needed.values())
    found = requested - sum(missing_seconds_by_date.values()) - sum(len(needed[date]) for date in missing_archives)
    return prices, missing_archives, {
        "requested_price_seconds": requested,
        "found_price_seconds": found,
        "coverage_pct": round(100 * found / max(1, requested), 6),
        "missing_seconds_by_date": missing_seconds_by_date,
    }


def safe_return(prices: dict[int, float], start: int, end: int) -> float | None:
    if start not in prices or end not in prices or prices[start] == 0:
        return None
    return prices[end] / prices[start] - 1


def rate_summary(rows: list[dict], field: str) -> dict:
    samples = [(row[field], row["direction"]) for row in rows if row.get(field) is not None and row["direction"]]
    aligned = sum(value * direction > 0 for value, direction in samples)
    opposite = sum(value * direction < 0 for value, direction in samples)
    flat = len(samples) - aligned - opposite
    signed = [value * direction * 10_000 for value, direction in samples]
    return {
        "samples": len(samples),
        "aligned_with_buy_direction_pct": None if not samples else round(100 * aligned / len(samples), 4),
        "opposite_pct": None if not samples else round(100 * opposite / len(samples), 4),
        "flat_pct": None if not samples else round(100 * flat / len(samples), 4),
        "aligned_pct_excluding_flat": None if aligned + opposite == 0 else round(100 * aligned / (aligned + opposite), 4),
        "direction_signed_return_bps": {
            "median": None if not signed else round(quantile(signed, .5), 6),
            "p25": None if not signed else round(quantile(signed, .25), 6),
            "p75": None if not signed else round(quantile(signed, .75), 6),
        },
    }


def annotate_inventory_actions(batches: list[dict]) -> None:
    by_market: dict[str, list[dict]] = defaultdict(list)
    for batch in batches:
        by_market[batch["slug"]].append(batch)
    for rows in by_market.values():
        up = down = 0.0
        for row in sorted(rows, key=lambda item: item["timestamp"]):
            imbalance = up - down
            row["pre_imbalance_shares"] = imbalance
            has_up = row["up_shares"] > 0
            has_down = row["down_shares"] > 0
            if has_up and has_down:
                action = "both"
            elif abs(imbalance) < 1e-9:
                action = "start"
            elif (imbalance > 0 and has_down) or (imbalance < 0 and has_up):
                action = "repair"
            else:
                action = "expand"
            row["inventory_action"] = action
            up += row["up_shares"]
            down += row["down_shares"]


def clustered_alignment(rows: list[dict], field: str, group_field: str) -> dict:
    groups: dict[str, list[tuple[bool, float]]] = defaultdict(list)
    for row in rows:
        value = row.get(field)
        if value is None or value == 0 or not row.get("direction"):
            continue
        groups[str(row[group_field])].append((value * row["direction"] > 0, abs(row["net_direction_shares"])))
    rates = [sum(hit for hit, _ in samples) / len(samples) for samples in groups.values() if samples]
    weighted_num = sum(weight for samples in groups.values() for hit, weight in samples if hit)
    weighted_den = sum(weight for samples in groups.values() for _hit, weight in samples)
    rng = random.Random(3048)
    bootstrap: list[float] = []
    if rates:
        for _ in range(1000):
            bootstrap.append(sum(rng.choice(rates) for _ in rates) / len(rates))
    return {
        "clusters": len(rates),
        "equal_weight_alignment_pct": None if not rates else round(100 * sum(rates) / len(rates), 4),
        "equal_weight_cluster_bootstrap_95pct": None if not bootstrap else [
            round(100 * quantile(bootstrap, .025), 4), round(100 * quantile(bootstrap, .975), 4),
        ],
        "net_shares_weighted_alignment_pct": None if not weighted_den else round(100 * weighted_num / weighted_den, 4),
    }


def build_policy_table(rows: list[dict]) -> dict[str, dict]:
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        if row.get("inventory_action") not in {"repair", "expand"}:
            continue
        imbalance = float(row.get("pre_imbalance_shares") or 0)
        momentum = row.get("past_3s_return")
        if abs(imbalance) < 1e-9 or momentum is None:
            continue
        if momentum == 0:
            momentum_context = "flat"
        elif momentum * imbalance > 0:
            momentum_context = "toward_heavy_side"
        else:
            momentum_context = "toward_light_side"
        groups[(interval_label(abs(imbalance), IMBALANCE_BOUNDS), momentum_context)].append(row)
    output: dict[str, dict] = {}
    for (imbalance_bucket, momentum_context), sample in sorted(groups.items()):
        key = f"imbalance_{imbalance_bucket}__{momentum_context}"
        expands = sum(row["inventory_action"] == "expand" for row in sample)
        sizes = [abs(float(row["net_direction_shares"])) for row in sample]
        output[key] = {
            "pretrade_abs_inventory_difference": imbalance_bucket,
            "three_second_momentum_context": momentum_context,
            "observed_fill_batches": len(sample),
            "expand_heavy_side_pct": round(100 * expands / len(sample), 4),
            "repair_light_side_pct": round(100 * (len(sample) - expands) / len(sample), 4),
            "net_direction_shares_median": round(quantile(sizes, .5), 6),
            "net_direction_shares_p75": round(quantile(sizes, .75), 6),
        }
    return output


def analyze(batches: list[dict], prices: dict[int, float]) -> dict:
    annotate_inventory_actions(batches)
    rows: list[dict] = []
    for batch in batches:
        net = batch["up_shares"] - batch["down_shares"]
        direction = 1 if net > 1e-9 else -1 if net < -1e-9 else 0
        row = {**batch, "net_direction_shares": net, "direction": direction}
        safe_end = batch["timestamp"] - 1
        row["signal_end_timestamp"] = safe_end
        row["date"] = date_for_epoch(batch["timestamp"])
        row["return_since_market_open"] = safe_return(prices, batch["market_start"], safe_end)
        row["market_final_return"] = safe_return(prices, batch["market_start"], batch["market_start"] + 299)
        for horizon in HORIZONS:
            row[f"past_{horizon}s_return"] = safe_return(prices, safe_end - horizon, safe_end)
            row[f"past_{horizon}s_return_end_lag_2s"] = safe_return(
                prices, batch["timestamp"] - 2 - horizon, batch["timestamp"] - 2,
            )
            row[f"future_{horizon}s_return_diagnostic_only"] = safe_return(prices, batch["timestamp"], batch["timestamp"] + horizon)
        rows.append(row)
    one_sided = [row for row in rows if row["direction"]]
    past = {f"{horizon}s": rate_summary(one_sided, f"past_{horizon}s_return") for horizon in HORIZONS}
    past_lag_2s = {f"{horizon}s": rate_summary(one_sided, f"past_{horizon}s_return_end_lag_2s") for horizon in HORIZONS}
    future = {f"{horizon}s": rate_summary(one_sided, f"future_{horizon}s_return_diagnostic_only") for horizon in HORIZONS}
    open_signal = rate_summary(one_sided, "return_since_market_open")
    final_result = rate_summary(one_sided, "market_final_return")
    by_inventory_action = {
        action: {
            f"{horizon}s": rate_summary(
                [row for row in one_sided if row["inventory_action"] == action],
                f"past_{horizon}s_return",
            )
            for horizon in HORIZONS
        }
        for action in ("start", "repair", "expand", "both")
    }
    return {
        "decision_batches": len(rows),
        "one_sided_net_buy_batches": len(one_sided),
        "balanced_or_both_batches": len(rows) - len(one_sided),
        "price_points_loaded": len(prices),
        "past_momentum_alignment": past,
        "past_momentum_alignment_end_lag_2s_sensitivity": past_lag_2s,
        "five_second_clustered_evidence": {
            "by_market": clustered_alignment(one_sided, "past_5s_return", "slug"),
            "by_day": clustered_alignment(one_sided, "past_5s_return", "date"),
        },
        "market_open_direction_alignment": open_signal,
        "future_return_alignment_diagnostic_only": future,
        "final_market_result_alignment": final_result,
        "past_momentum_by_inventory_action": by_inventory_action,
        "observed_policy_table": build_policy_table(one_sided),
        "interpretation": {
            "strong_evidence_threshold": "方向一致率明显高于50%，并在多个向后看的窗口稳定；只能说明相关，不能证明对方使用Binance。",
            "no_future_leakage": "主结果最晚使用成交时间戳前1秒已经结束的K线；另以提前2秒复核。future_*仅用于事后诊断，不允许进入策略输入。",
            "timing_limit": "Polymarket Activity时间戳只有秒级，同一秒成交已合并，无法恢复毫秒级先后。",
            "maker_decision_limit": "目标地址以maker成交为主时，成交由对手方触发；这里是成交状态相关性，不能直接当成目标地址的挂单决策时刻或下单信号。",
        },
    }


def render_report(result: dict, evidence_complete: bool, history_coverage: dict, missing_archives: list[str]) -> str:
    if not evidence_complete:
        return "\n".join([
            "# 0x3048 与币安BTC秒级走势关系",
            "",
            "证据状态：不完整，禁止输出策略结论。",
            "",
            f"- Activity历史缺失文件：{len(history_coverage.get('missing_files') or [])}",
            f"- Activity历史窗口缺口：{len(history_coverage.get('gaps') or [])}",
            f"- 分页未确认完整：{len(history_coverage.get('pagination_incomplete') or [])}",
            f"- 文件校验失败：{len(history_coverage.get('checksum_mismatches') or [])}",
            f"- 30天请求元数据有效：{history_coverage.get('request_metadata_valid') is True}",
            f"- Binance缺失日期：{', '.join(missing_archives) if missing_archives else '无'}",
            f"- 索引首尾严格匹配请求：{history_coverage.get('boundary_valid') is True}",
            "",
        ])
    lines = [
        "# 0x3048 与币安BTC秒级走势关系",
        "",
        "证据状态：完整。",
        "",
        f"- 决策批次：{result['decision_batches']:,}",
        f"- 有明确净买入方向：{result['one_sided_net_buy_batches']:,}",
        "",
        "| 成交前走势窗口 | 买入方向与BTC走势一致 | 样本 |",
        "|---:|---:|---:|",
    ]
    for horizon, item in result["past_momentum_alignment"].items():
        lines.append(f"| {horizon} | {item['aligned_pct_excluding_flat']}% | {item['samples']:,} |")
    lines.extend([
        "",
        f"相对本场开盘价的方向一致率：{result['market_open_direction_alignment']['aligned_with_buy_direction_pct']}%",
        "",
        "只有成交前窗口可以用于策略。成交后的future数据只用于验证，软件下单时禁止读取。",
        "目标地址以maker成交为主，成交时间不是挂单时间；上述一致率只能作为行为相关性，不能直接写成下单规则。",
    ])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Align 0x3048 public fills with official Binance BTCUSDT 1-second archives")
    parser.add_argument("--history-dir", default="data/pm-r25-history-30d-verified")
    parser.add_argument("--cache-dir", default="data/binance-btcusdt-1s")
    parser.add_argument("--address", default=ADDRESS)
    parser.add_argument("--out", default="data/pm-r25-binance-signal-30d.json")
    parser.add_argument("--report", default="data/pm-r25-binance-signal-30d.md")
    args = parser.parse_args()
    history_coverage = validate_history_index(Path(args.history_dir), expected_days=30, address=args.address)
    batches = history_batches(Path(args.history_dir), args.address, history_coverage.get("indexed_files") if history_coverage["complete"] else None)
    needed = required_seconds(batches)
    prices, missing_archives, binance_coverage = load_needed_prices(Path(args.cache_dir), needed)
    result = analyze(batches, prices)
    evidence_complete = history_coverage["complete"] and not missing_archives and binance_coverage["coverage_pct"] == 100
    output = {
        "run_type": "pm_r25_binance_signal_analysis",
        "trade_authorization": False,
        "address": args.address.lower(),
        "source": "Binance Vision official BTCUSDT spot 1-second klines + Polymarket public Activity",
        "archive_dates": sorted(needed),
        "missing_archive_dates": missing_archives,
        "history_coverage": history_coverage,
        "binance_coverage": binance_coverage,
        "evidence_status": "complete" if evidence_complete else "incomplete_do_not_conclude",
        "result": result,
    }
    out = Path(args.out)
    report = Path(args.report)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    report.write_text(render_report(result, evidence_complete, history_coverage, missing_archives), encoding="utf-8")
    print(json.dumps({
        "decision_batches": result["decision_batches"],
        "one_sided": result["one_sided_net_buy_batches"],
        "past_alignment": result["past_momentum_alignment"] if evidence_complete else "suppressed_incomplete_evidence",
        "missing_archive_dates": missing_archives,
        "evidence_status": output["evidence_status"],
    }, ensure_ascii=False))
    print("read_only=true trade_authorization=false")
    return 0 if evidence_complete else 2


if __name__ == "__main__":
    raise SystemExit(main())
