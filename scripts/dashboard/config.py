"""Versioned, nonsecret configuration for the existing dashboard engine inputs.

This is a single-server-process store. Instances pointing at the same file share
a thread lock, and every operation re-reads disk before comparing revisions.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import tempfile
import threading


SCHEMA_VERSION = 1
_PATH_LOCKS: dict[str, threading.RLock] = {}
_PATH_LOCKS_LOCK = threading.Lock()
_FIELDS = {
    "order_usd": (2, 0.01, 1000, "USD"),
    "pair_cost_max": (0.99, 0.90, 1.0, "USD/pair"),
    "max_orders": (50, 1, 10000, "orders"),
    "max_total_usd": (100, 0.01, 100000, "USD submitted"),
    "duration_min": (5, 0, 1440, "minutes"),
    "maker_life_sec": (15, 1, 300, "seconds"),
    "decision_interval_ms": (0, 0, 60000, "milliseconds"),
    "defensive_cancel_bps": (0, 0, 1000, "basis points"),
}
_UNSUPPORTED = (
    "capital", "market", "target", "cap", "inventoryMode", "inventory",
    "hedgeWait", "stopOpen", "stopHedge", "layers", "spacing", "fallback",
    "slippage", "hedgeLoss", "dailyLoss", "concurrency", "disconnect", "stale",
    "stopPolicy", "effective",
)


class ConfigValidationError(ValueError):
    """Input is invalid; messages never include submitted values."""


class ConfigConflictError(ValueError):
    """The client tried to replace a revision that is no longer current."""

    def __init__(self, current_revision: int):
        self.current_revision = current_revision
        super().__init__("配置版本已变化，请重新读取后保存")


class ConfigStoreError(RuntimeError):
    """Persistence cannot be trusted; never fall back to runnable defaults."""


def default_params(mode: str = "paper") -> dict:
    if mode not in {"paper", "live"}:
        raise ConfigValidationError("mode must be paper or live")
    result = {name: spec[0] for name, spec in _FIELDS.items()}
    result["mode"] = mode
    if mode == "live":
        result.update(max_total_usd=10, duration_min=15)
    return result


def validate_params(params: dict) -> dict:
    """Validate a replacement; omitted keys use explicit mode-specific defaults.

    Strings and booleans are not JSON numbers. Values are not rounded or
    clamped: this adapter preserves the existing engine's numeric semantics.
    """
    if not isinstance(params, dict):
        raise ConfigValidationError("params must be an object")
    if set(params) - (set(_FIELDS) | {"mode"}):
        raise ConfigValidationError("配置包含未知、敏感或尚未支持的字段")
    mode = params.get("mode", "paper")
    if not isinstance(mode, str) or mode not in {"paper", "live"}:
        raise ConfigValidationError("mode must be paper or live")
    result = default_params(mode)
    for name, (_, minimum, maximum, _) in _FIELDS.items():
        value = params.get(name, result[name])
        if type(value) not in {int, float}:
            raise ConfigValidationError(f"{name} must be a finite JSON number")
        # Check bounds before isfinite: arbitrarily large JSON integers cannot
        # be converted to float safely, but can be compared with these limits.
        if value < minimum or value > maximum or not math.isfinite(value):
            raise ConfigValidationError(f"{name} must be between {minimum} and {maximum}")
        if name == "duration_min" and 0 < value < 0.1:
            raise ConfigValidationError("duration_min must be 0 or at least 0.1")
        if name == "max_orders":
            if value != int(value):
                raise ConfigValidationError("max_orders must be an integer")
            value = int(value)
        result[name] = value
    return result


def capabilities() -> dict:
    """Report adapter support without claiming unimplemented risk guarantees."""
    return {
        "supportedFields": ["mode", *_FIELDS],
        "unsupportedDemoFields": list(_UNSUPPORTED),
        "demoFieldMappings": {
            "order": "order_usd", "life": "maker_life_sec",
            "duration": "duration_min", "submitted": "max_total_usd",
            "maxOrders": "max_orders", "mode": "mode",
        },
        "effectivePolicy": "next_start",
        "versionedStartModes": ["paper"],
        "separatePairTargetAndHardCap": False,
        "pairCostMaxIsUniversalHardCap": False,
        "accountScoped": False,
        "fields": {
            name: {"minimum": spec[1], "maximum": spec[2], "unit": spec[3],
                   "integer": name == "max_orders"}
            for name, spec in _FIELDS.items()
        },
    }


def _unique_object(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


class ConfigStore:
    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        with _PATH_LOCKS_LOCK:
            key = os.path.normcase(str(self.path))
            self._lock = _PATH_LOCKS.setdefault(key, threading.RLock())
        self._seen_persisted = False

    def _read(self) -> dict:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            if self._seen_persisted:
                raise ConfigStoreError("已保存的配置文件丢失，禁止恢复默认运行") from exc
            return {"schemaVersion": SCHEMA_VERSION, "revision": 0,
                    "savedAt": None, "params": default_params()}
        except (OSError, UnicodeError) as exc:
            raise ConfigStoreError("无法读取配置文件") from exc
        self._seen_persisted = True
        try:
            data = json.loads(raw, object_pairs_hook=_unique_object)
            if not isinstance(data, dict) or set(data) != {"schemaVersion", "revision", "savedAt", "params"}:
                raise ValueError("invalid document")
            if type(data["schemaVersion"]) is not int or data["schemaVersion"] != SCHEMA_VERSION:
                raise ValueError("invalid schema")
            if type(data["revision"]) is not int or data["revision"] < 1:
                raise ValueError("invalid revision")
            stamp = data["savedAt"]
            if not isinstance(stamp, str) or not stamp.endswith("Z"):
                raise ValueError("invalid timestamp")
            datetime.fromisoformat(stamp[:-1] + "+00:00")
            if not isinstance(data["params"], dict) or set(data["params"]) != set(default_params()):
                raise ValueError("incomplete persisted params")
            data["params"] = validate_params(data["params"])
            return data
        except (ValueError, TypeError, OverflowError) as exc:
            raise ConfigStoreError("配置文件损坏或版本不受支持，禁止恢复默认运行") from exc

    def get(self) -> dict:
        with self._lock:
            return self._public(self._read())

    @staticmethod
    def _public(data: dict) -> dict:
        snapshot = copy.deepcopy(data)
        snapshot["capabilities"] = capabilities()
        return snapshot

    def save(self, params: dict, expected_revision: int) -> dict:
        if type(expected_revision) is not int or expected_revision < 0:
            raise ConfigValidationError("expected_revision must be a nonnegative integer")
        validated = validate_params(params)
        with self._lock:
            current = self._read()
            if expected_revision != current["revision"]:
                raise ConfigConflictError(current["revision"])
            data = {"schemaVersion": SCHEMA_VERSION, "revision": current["revision"] + 1,
                    "savedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "params": validated}
            temporary = None
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                                 prefix=f".{self.path.name}.", suffix=".tmp", delete=False) as out:
                    temporary = Path(out.name)
                    json.dump(data, out, ensure_ascii=False, allow_nan=False, sort_keys=True)
                    out.write("\n")
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temporary, self.path)
            except OSError as exc:
                raise ConfigStoreError("配置保存失败") from exc
            finally:
                if temporary is not None:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        pass  # Never hide the failed save behind cleanup errors.
            self._seen_persisted = True
            return self._public(data)
