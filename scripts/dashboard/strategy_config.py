"""Durable configuration for one configurable BTC reversal strategy."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import tempfile

from .config import (ConfigStore, ConfigValidationError, ConfigConflictError,
                     ConfigStoreError, _unique_object)

STRATEGY_ID = "btc-reversal"


def default_config() -> dict:
    return {"triggerPrice": .67, "confirmationPrice": .70, "maxBuyPrice": .70,
            "stageShares": [5, 18, 54, 130], "maxStages": 4,
            "roundBudgetUsd": None, "totalBudgetUsd": None, "dailyLossUsd": None,
            "durationMinutes": 0, "mode": "live",
            "maxQuoteAgeSeconds": 2, "maxQuoteSkewSeconds": 1.5}


def validate_config(config: dict, *, allow_historical_paper: bool = False) -> dict:
    if not isinstance(config, dict) or set(config) != set(default_config()):
        raise ConfigValidationError("请提交完整策略参数，不接受未知字段")
    result = copy.deepcopy(config)

    def number(value, name, *, positive=True):
        if type(value) not in (int, float):
            raise ConfigValidationError(f"{name}必须填写数字")
        try:
            finite = math.isfinite(value)
        except OverflowError:
            finite = False
        if not finite or value < 0 or (positive and value == 0):
            raise ConfigValidationError(f"{name}必须是有效的{'正数' if positive else '非负数'}")
        return value

    for key in ("triggerPrice", "confirmationPrice", "maxBuyPrice"):
        if number(result[key], key) >= 1:
            raise ConfigValidationError("价格必须在0到100美分之间")
    if result["triggerPrice"] > result["maxBuyPrice"]:
        raise ConfigValidationError("触发价不能高于最高买价")
    if result["confirmationPrice"] < result["triggerPrice"]:
        raise ConfigValidationError("确认价不能低于触发价")
    shares = result["stageShares"]
    if not isinstance(shares, list) or not 1 <= len(shares) <= 100:
        raise ConfigValidationError("请设置1至100个阶段的份额")
    for value in shares:
        number(value, "阶段份额")
    stages = result["maxStages"]
    if type(stages) is not int or not 1 <= stages <= len(shares):
        raise ConfigValidationError("阶段上限不能超过已填写的阶段数")
    for key in ("roundBudgetUsd", "totalBudgetUsd", "dailyLossUsd"):
        if result[key] is not None:
            number(result[key], key)
    duration = number(result["durationMinutes"], "运行分钟数", positive=False)
    if duration * 60_000 > 2_147_483_647:
        raise ConfigValidationError("运行时长过大；持续运行请填0")
    for key in ("maxQuoteAgeSeconds", "maxQuoteSkewSeconds"):
        number(result[key], key)
    if result["mode"] != "live" and not (allow_historical_paper and result["mode"] == "paper"):
        raise ConfigValidationError("新版策略配置只支持live模式")
    return result


class StrategyConfigStore(ConfigStore):
    """Uses the existing path lock and atomic replacement, with no trading secrets."""

    def _read(self) -> dict:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            if self._seen_persisted:
                raise ConfigStoreError("策略配置文件丢失，请恢复已保存配置") from exc
            return {"schemaVersion": 1, "strategyId": STRATEGY_ID,
                    "savedRevision": 0, "savedAt": None, "config": default_config()}
        except (OSError, UnicodeError) as exc:
            raise ConfigStoreError("无法读取策略配置") from exc
        self._seen_persisted = True
        try:
            data = json.loads(raw, object_pairs_hook=_unique_object)
            if not isinstance(data, dict) or set(data) != {"schemaVersion", "strategyId", "savedRevision", "savedAt", "config"}:
                raise ValueError("invalid document")
            if type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1 or data["strategyId"] != STRATEGY_ID:
                raise ValueError("invalid schema")
            if type(data["savedRevision"]) is not int or data["savedRevision"] < 1:
                raise ValueError("invalid revision")
            if not isinstance(data["savedAt"], str) or not data["savedAt"].endswith("Z"):
                raise ValueError("invalid saved time")
            datetime.fromisoformat(data["savedAt"][:-1] + "+00:00")
            data["config"] = validate_config(data["config"], allow_historical_paper=True)
            return data
        except (ValueError, TypeError, OverflowError) as exc:
            raise ConfigStoreError("策略配置损坏，未替换成默认参数") from exc

    @staticmethod
    def _public(data: dict) -> dict:
        return copy.deepcopy(data)

    def save(self, config: dict, expected_revision: int) -> dict:
        if type(expected_revision) is not int or expected_revision < 0:
            raise ConfigValidationError("配置版本必须为非负整数")
        validated = validate_config(config)
        with self._lock:
            current = self._read()
            if current["savedRevision"] != expected_revision:
                raise ConfigConflictError(current["savedRevision"])
            data = {"schemaVersion": 1, "strategyId": STRATEGY_ID,
                    "savedRevision": expected_revision + 1,
                    "savedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "config": validated}
            temporary = None
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                                 prefix=f".{self.path.name}.", suffix=".tmp", delete=False) as out:
                    temporary = Path(out.name)
                    json.dump(data, out, ensure_ascii=False, allow_nan=False)
                    out.write("\n")
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temporary, self.path)
            except OSError as exc:
                raise ConfigStoreError("策略参数保存失败") from exc
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            self._seen_persisted = True
            return self._public(data)
