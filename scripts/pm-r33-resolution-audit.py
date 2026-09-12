from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests


GAMMA_URL = "https://gamma-api.polymarket.com/events"
SLUG_RE = re.compile(r"^btc-updown-5m-([0-9]+)$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def json_array(value: Any) -> list[Any]:
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, list):
        raise ValueError("expected JSON array")
    return value


def event_markets(slug: str, response: Any) -> list[Any]:
    if not isinstance(response, list):
        raise ValueError("expected events array")
    matching = [row for row in response if isinstance(row, dict) and row.get("slug") == slug]
    if len(matching) != 1 or not isinstance(matching[0].get("markets"), list):
        raise ValueError("event identity ambiguous")
    return matching[0]["markets"]


def classify_resolution(metadata: dict[str, Any], rows: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "slug": metadata["slug"],
        "condition_id": metadata["condition_id"],
        "up_token": metadata["up_token"],
        "down_token": metadata["down_token"],
        "status": "unresolved",
        "winner": None,
        "reason": "official_resolution_not_final",
    }
    if not isinstance(rows, list):
        return {**result, "status": "invalid", "reason": "invalid_response_shape"}
    matching = [row for row in rows if isinstance(row, dict) and row.get("slug") == metadata["slug"]]
    if len(matching) != 1:
        return {**result, "status": "invalid", "reason": "market_identity_ambiguous"}
    row = matching[0]
    if str(row.get("conditionId", "")).lower() != metadata["condition_id"].lower():
        return {**result, "status": "invalid", "reason": "condition_id_mismatch"}
    try:
        outcomes = json_array(row.get("outcomes"))
        tokens = json_array(row.get("clobTokenIds"))
        prices = json_array(row.get("outcomePrices"))
        if len(outcomes) != 2 or set(outcomes) != {"Up", "Down"} or len(tokens) != 2 or len(prices) != 2:
            raise ValueError("invalid binary market")
        token_by_outcome = dict(zip(outcomes, map(str, tokens)))
        if token_by_outcome != {"Up": metadata["up_token"], "Down": metadata["down_token"]}:
            return {**result, "status": "invalid", "reason": "token_identity_mismatch"}
        if any(isinstance(value, bool) for value in prices):
            raise ValueError("boolean price")
        payout = {side: float(value) for side, value in zip(outcomes, prices)}
        if any(not math.isfinite(value) or not 0 <= value <= 1 for value in payout.values()):
            raise ValueError("invalid payout")
    except (ValueError, TypeError):
        return {**result, "status": "invalid", "reason": "invalid_outcomes_or_prices"}
    result.update({
        "official_closed": row.get("closed"),
        "official_resolution_status": row.get("umaResolutionStatus"),
        "reported_payouts": payout,
        "observed_constraints": {
            key: row.get(key) for key in (
                "orderMinSize", "orderPriceMinTickSize", "feesEnabled",
                "rewardsMinSize", "rewardsMaxSpread", "rewards", "feeSchedule",
                "feeType", "makerRebatesFeeShareBps", "resolutionSource", "cryptoMarketConfig",
            )
        },
        "constraints_semantics": "metadata_at_fetch_time; not historical fees or earned rewards",
    })
    if row.get("closed") is not True or row.get("umaResolutionStatus") != "resolved":
        return result
    if sorted(payout.values()) != [0.0, 1.0]:
        return {**result, "reason": "non_binary_final_payout"}
    return {
        **result, "status": "resolved", "reason": "official_closed_resolved_binary_payout",
        "winner": next(side for side, value in payout.items() if value == 1),
    }


def inventory(paths: list[Path], hash_files: bool = True) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    markets: dict[str, dict[str, Any]] = {}
    manifests: list[dict[str, Any]] = []
    for path in sorted(paths):
        path = path.resolve(strict=True)
        before = path.stat()
        manifest: dict[str, Any] = {"path": path.as_posix(), "bytes": before.st_size}
        # Historical input must be a completed snapshot, including its WAL state.
        wal = path.with_name(path.name + "-wal")
        if wal.exists() and wal.stat().st_size:
            raise ValueError(f"active WAL is not a frozen research snapshot: {path}")
        with sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True) as connection:
            rows = connection.execute(
                "SELECT payload_json FROM events WHERE source=? AND event_type=?",
                ("gamma", "market_metadata"),
            )
            count = 0
            for (payload,) in rows:
                row = json.loads(payload)
                slug = str(row.get("slug", ""))
                match = SLUG_RE.fullmatch(slug)
                if not match:
                    continue
                start = int(match[1])
                if row.get("start_at") != start or row.get("end_at") != start + 300:
                    raise ValueError(f"market window mismatch: {slug}")
                entry = {key: str(row.get(key) or "") for key in ("slug", "condition_id", "up_token", "down_token")}
                if not re.fullmatch(r"0x[0-9a-fA-F]{64}", entry["condition_id"]):
                    raise ValueError(f"invalid condition ID: {slug}")
                if not all(entry[key].isdigit() and int(entry[key]) > 0 for key in ("up_token", "down_token")):
                    raise ValueError(f"invalid outcome token: {slug}")
                if entry["up_token"] == entry["down_token"]:
                    raise ValueError(f"duplicate outcome token: {slug}")
                entry["start_at"] = start
                entry["end_at"] = start + 300
                if slug in markets and markets[slug] != entry:
                    raise ValueError(f"conflicting market identity: {slug}")
                markets[slug] = entry
                count += 1
            manifest["metadata_rows"] = count
        if hash_files:
            manifest["sha256"] = sha256_file(path)
        after = path.stat()
        if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or (wal.exists() and wal.stat().st_size):
            raise ValueError(f"research input changed during audit: {path}")
        manifests.append(manifest)
    return sorted(markets.values(), key=lambda row: row["start_at"]), manifests


def read_market(metadata: dict[str, Any], cache_dir: Path, refresh: bool = False) -> dict[str, Any]:
    cache_path = cache_dir / (metadata["slug"] + ".json")
    snapshot = None
    if cache_path.exists() and not refresh:
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if (isinstance(cached, dict) and cached.get("url") == GAMMA_URL
                    and cached.get("slug") == metadata["slug"] and isinstance(cached.get("fetched_at"), str)):
                datetime.fromisoformat(cached["fetched_at"])
                candidate = classify_resolution(metadata, event_markets(metadata["slug"], cached.get("response")))
                if candidate["status"] == "resolved":
                    snapshot = cached
        except ValueError:
            pass
    try:
        if snapshot is None:
            response = requests.get(
                GAMMA_URL, params={"slug": metadata["slug"]}, timeout=(10, 30),
                headers={"User-Agent": "pm-btc5m-resolution-audit/1.0"},
            )
            response.raise_for_status()
            snapshot = {
                "url": GAMMA_URL, "slug": metadata["slug"],
                "fetched_at": datetime.now(timezone.utc).isoformat(), "response": response.json(),
            }
            raw = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
            temporary = cache_path.with_suffix(".tmp")
            temporary.write_text(raw, encoding="utf-8")
            temporary.replace(cache_path)
        result = classify_resolution(metadata, event_markets(metadata["slug"], snapshot["response"]))
        return {
            **result, "fetched_at": snapshot["fetched_at"],
            "source_url": GAMMA_URL + "?slug=" + metadata["slug"],
            "snapshot_path": cache_path.as_posix(), "snapshot_sha256": sha256_file(cache_path),
        }
    except (requests.RequestException, ValueError) as error:
        return {
            "slug": metadata["slug"], "status": "fetch_failed", "winner": None,
            "reason": type(error).__name__,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit frozen BTC 5m inputs and fetch official resolution labels.")
    parser.add_argument("--db", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--max-markets", type=int, default=0)
    parser.add_argument("--workers", type=int, default=3, choices=range(1, 5))
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    if args.max_markets < 0:
        parser.error("--max-markets must be nonnegative")
    markets, manifests = inventory(args.db)
    selected = markets[:args.max_markets] if args.max_markets else markets
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        labels = list(executor.map(lambda row: read_market(row, args.cache_dir, args.refresh), selected))
    counts = {key: sum(row["status"] == key for row in labels) for key in ("resolved", "unresolved", "invalid", "fetch_failed")}
    report = {
        "schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
        "source": GAMMA_URL, "input_databases": manifests, "metadata_market_count": len(markets),
        "selected_market_count": len(selected), "counts": counts,
        "all_selected_resolved": bool(labels) and counts["resolved"] == len(labels),
        "coverage_semantics": "metadata identities and settlement labels; not event continuity or execution validation",
        "capital_budget_usd": 50, "daily_loss_budget_usd": 30, "risk_timezone": "Asia/Shanghai",
        "labels": labels,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps({"output": args.output.as_posix(), "markets": len(markets), "selected": len(selected), **counts}))
    return 1 if counts["invalid"] or counts["fetch_failed"] or not labels else 0


if __name__ == "__main__":
    sys.exit(main())
