import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "latency_audit", Path(__file__).parents[1] / "scripts/audit-latency-evidence.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_mode_separation_missing_and_invalid_samples(tmp_path):
    rows = [
        {"event": "latency", "metric": "order_ack", "duration_ms": 148, "live": True},
        {"event": "latency", "metric": "order_ack", "duration_ms": 0, "live": False},
        {"event": "latency", "metric": "order_ack", "duration_ms": 9},
        {"event": "latency", "metric": "order_ack", "duration_ms": True, "live": True},
        {"event": "latency", "metric": "order_ack", "duration_ms": -1, "live": True},
        {"event": "latency", "metric": "order_ack", "duration_ms": 3, "live": True, "mode": "paper"},
    ]
    (tmp_path / "live.jsonl").write_text("\n".join(map(json.dumps, rows)), encoding="utf-8")
    report = mod.audit(tmp_path)
    assert report["metrics"]["live"]["order_ack"]["samples"] == 1
    assert report["metrics"]["live"]["order_ack"]["p50_ms"] == 148
    assert report["metrics"]["paper"]["order_ack"]["p50_ms"] == 0
    assert report["metrics"]["unknown"]["order_ack"]["samples"] == 1
    assert report["metrics"]["live"]["cancel_ack"]["p50_ms"] is None
    assert report["rejected_rows"] == {"invalid_duration": 2, "mode_conflict": 1}


def test_nearest_rank_quantiles():
    assert mod.summary(range(1, 101))["p95_ms"] == 95
    assert mod.summary([])["p99_ms"] is None


def test_corrupt_encoding_does_not_hide_remaining_measurements(tmp_path):
    valid = json.dumps({"event": "latency", "metric": "order_ack",
                        "duration_ms": 10, "live": True}).encode()
    (tmp_path / "corrupt.jsonl").write_bytes(b"\xff\n" + valid + b"\n")
    report = mod.audit(tmp_path)
    assert report["rejected_rows"]["invalid_json"] == 1
    assert report["metrics"]["live"]["order_ack"]["samples"] == 1
