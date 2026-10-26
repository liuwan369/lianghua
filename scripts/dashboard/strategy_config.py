"""Durable configuration for the binance-lead strategy and its selected asset."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import tempfile
import uuid
import re

from .config import (ConfigStore, ConfigValidationError, ConfigConflictError,
                     ConfigStoreError, _unique_object)

STRATEGY_ID = "binance-lead"
ASSET_ID_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z")
# Polymarket runs 5m up/down markets for these seven. Verified live: every
# "<asset>-updown-5m-<round>" slug resolves with 2 CLOB tokens and tick 0.01.
# binance-lead is only researched on btc (STRATEGY.md); the others stay
# selectable for the run pool and collector.
SUPPORTED_ASSET_IDS = frozenset({"btc", "eth", "sol", "xrp", "doge", "hype", "bnb"})


def default_config() -> dict:
    # BINANCE_LEAD_DEFAULTS (backend/engine/src/strategies/binance-lead.ts) plus
    # the control plane's run settings, which reach the engine as flags.
    return {"assetId": "btc", "shares": 5, "thresholdBp": 2, "windowMs": 250, "limitPremium": 0.03,
            "fromSec": 15, "toSec": 265, "maxAsk": 0.8, "maxQuoteAgeSeconds": 2, "maxQuoteSkewSeconds": 1.5,
            "roundBudgetUsd": None, "totalBudgetUsd": None, "dailyLossUsd": None,
            "durationMinutes": 0, "maxRounds": 0, "mode": "live"}


# Fields added after a binance-lead revision was published (the server's
# revision 1 has no maxAsk): a config missing only these gets their defaults,
# any other key mismatch is still rejected.
ADDED_FIELDS = ("maxAsk",)


def validate_config(config: dict) -> dict:
    """The same ranges as the engine's normalizeBinanceLeadConfig."""
    if not isinstance(config, dict):
        raise ConfigValidationError("请提交完整策略参数，不接受未知字段")
    result = copy.deepcopy(config)
    defaults = default_config()
    if not set(result) - set(defaults):
        for added in ADDED_FIELDS:
            result.setdefault(added, defaults[added])
    if set(result) != set(defaults):
        raise ConfigValidationError("请提交完整策略参数，不接受未知字段")

    asset_id = result.get("assetId")
    if not isinstance(asset_id, str):
        raise ConfigValidationError("assetId必须是文本")
    asset_id = asset_id.strip().lower()
    if not ASSET_ID_RE.fullmatch(asset_id):
        raise ConfigValidationError("assetId格式无效")
    if asset_id not in SUPPORTED_ASSET_IDS:
        raise ConfigValidationError("当前运行时不支持该资产")
    result["assetId"] = asset_id

    def number(name, label):
        value = result[name]
        try:
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ConfigValidationError(f"{label}必须填写数字")
        except OverflowError:
            raise ConfigValidationError(f"{label}必须填写数字") from None
        return value

    def within(name, label, low, high, *, low_open=True, high_open=False):
        value = number(name, label)
        if (value <= low if low_open else value < low) or (value >= high if high_open else value > high):
            raise ConfigValidationError(f"{label}必须在{'(' if low_open else '['}{low}, {high}{')' if high_open else ']'}之内")
        return value

    within("shares", "份额", 0, 10_000)
    within("thresholdBp", "阈值bp", 0, 1000)
    within("windowMs", "窗口毫秒", 0, 60_000)
    within("limitPremium", "限价加价", 0, 1, low_open=False, high_open=True)
    start, end = number("fromSec", "起始秒"), number("toSec", "截止秒")
    if not 0 <= start < end <= 300:
        raise ConfigValidationError("起止秒必须满足 0 ≤ 起始秒 < 截止秒 ≤ 300")
    within("maxAsk", "卖价上限", 0, 1, high_open=True)
    for key, label in (("maxQuoteAgeSeconds", "盘口最大年龄"), ("maxQuoteSkewSeconds", "盘口两边时间差")):
        if number(key, label) <= 0:
            raise ConfigValidationError(f"{label}必须是正数")
    for key, label in (("roundBudgetUsd", "单场预算"), ("totalBudgetUsd", "总预算"), ("dailyLossUsd", "每日亏损上限")):
        if result[key] is not None and number(key, label) <= 0:
            raise ConfigValidationError(f"{label}必须为空或正数")
    duration = number("durationMinutes", "运行分钟数")
    if duration < 0 or duration * 60_000 > 2_147_483_647:
        raise ConfigValidationError("运行分钟数必须是非负数；持续运行请填0")
    # Rounds are the natural unit: they are five minutes wide, so a minute count
    # can stop mid round and abandon a position it just opened.
    rounds = number("maxRounds", "运行场次数")
    if rounds != int(rounds) or rounds < 0 or rounds > 10_000:
        raise ConfigValidationError("运行场次数必须是0到10000之间的整数；持续运行请填0")
    result["maxRounds"] = int(rounds)
    if result["mode"] != "live":
        raise ConfigValidationError("策略配置只支持live模式")
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
            data["config"] = validate_config(data["config"])
            return data
        except (ValueError, TypeError, OverflowError) as exc:
            raise ConfigStoreError("策略配置损坏，未替换成默认参数") from exc

    @staticmethod
    def _public(data: dict) -> dict:
        return copy.deepcopy(data)

    def get(self) -> dict:
        with self._lock:
            return self._public(self._read())

    @property
    def draft_path(self) -> Path:
        return self.path.with_name(f"{self.path.stem}.draft{self.path.suffix}")

    def get_draft(self) -> dict | None:
        with self._lock:
            try:
                raw = self.draft_path.read_text(encoding="utf-8")
            except FileNotFoundError:
                return None
            except (OSError, UnicodeError) as exc:
                raise ConfigStoreError("无法读取策略草稿") from exc
            try:
                data = json.loads(raw, object_pairs_hook=_unique_object)
                if not isinstance(data, dict) or set(data) != {
                    "schemaVersion", "strategyId", "draftId", "expectedRevision", "savedAt", "config",
                }:
                    raise ValueError("invalid draft")
                if type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1 or data["strategyId"] != STRATEGY_ID:
                    raise ValueError("invalid schema")
                if not isinstance(data["draftId"], str) or str(uuid.UUID(data["draftId"])) != data["draftId"]:
                    raise ValueError("invalid draft identity")
                if type(data["expectedRevision"]) is not int or data["expectedRevision"] < 0:
                    raise ValueError("invalid revision")
                if not isinstance(data["savedAt"], str) or not data["savedAt"].endswith("Z"):
                    raise ValueError("invalid saved time")
                datetime.fromisoformat(data["savedAt"][:-1] + "+00:00")
                data["config"] = validate_config(data["config"])
                return self._public(data)
            except (ValueError, TypeError, OverflowError) as exc:
                raise ConfigStoreError("策略草稿损坏，未替换成默认参数") from exc

    def save_draft(self, config: dict, expected_revision: int) -> dict:
        if type(expected_revision) is not int or expected_revision < 0:
            raise ConfigValidationError("配置版本必须为非负整数")
        with self._lock:
            current = self._read()
            validated = validate_config({"assetId": current["config"]["assetId"], **config}
                                        if isinstance(config, dict) else config)
            if current["savedRevision"] != expected_revision:
                raise ConfigConflictError(current["savedRevision"])
            data = {"schemaVersion": 1, "strategyId": STRATEGY_ID,
                    "draftId": str(uuid.uuid4()), "expectedRevision": expected_revision,
                    "savedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "config": validated}
            self._write(self.draft_path, data, "策略草稿保存失败")
            return self._public(data)

    def activate_draft(self, expected_revision: int, draft_id: str) -> dict:
        if type(expected_revision) is not int or expected_revision < 0:
            raise ConfigValidationError("配置版本必须为非负整数")
        if not isinstance(draft_id, str) or not draft_id:
            raise ConfigValidationError("激活需要策略草稿编号")
        with self._lock:
            current = self._read()
            if current["savedRevision"] != expected_revision:
                raise ConfigConflictError(current["savedRevision"])
            draft = self.get_draft()
            if draft is None:
                raise ConfigValidationError("请先保存策略草稿")
            if draft["draftId"] != draft_id:
                raise ConfigValidationError("策略草稿已变化，请重新读取后激活")
            if draft["expectedRevision"] != expected_revision:
                raise ConfigConflictError(current["savedRevision"])
            # Publish through the same atomic file the running engine already watches.
            return self.save(draft["config"], expected_revision)

    def save(self, config: dict, expected_revision: int) -> dict:
        if type(expected_revision) is not int or expected_revision < 0:
            raise ConfigValidationError("配置版本必须为非负整数")
        with self._lock:
            current = self._read()
            validated = validate_config({"assetId": current["config"]["assetId"], **config}
                                        if isinstance(config, dict) else config)
            if current["savedRevision"] != expected_revision:
                raise ConfigConflictError(current["savedRevision"])
            data = {"schemaVersion": 1, "strategyId": STRATEGY_ID,
                    "savedRevision": expected_revision + 1,
                    "savedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "config": validated}
            self._write(self.path, data, "策略参数保存失败")
            self._seen_persisted = True
            return self._public(data)

    @staticmethod
    def _write(path: Path, data: dict, failure: str) -> None:
        temporary = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                             prefix=f".{path.name}.", suffix=".tmp", delete=False) as out:
                temporary = Path(out.name)
                json.dump(data, out, ensure_ascii=False, allow_nan=False)
                out.write("\n")
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, path)
        except OSError as exc:
            raise ConfigStoreError(failure) from exc
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
