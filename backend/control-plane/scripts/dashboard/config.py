"""Shared file locking and errors for the active BTC reversal configuration."""
from __future__ import annotations

import os
from pathlib import Path
import threading


_PATH_LOCKS: dict[str, threading.RLock] = {}
_PATH_LOCKS_LOCK = threading.Lock()


class ConfigValidationError(ValueError):
    """Input is invalid; messages never include submitted values."""


class ConfigConflictError(ValueError):
    """The client tried to replace a revision that is no longer current."""

    def __init__(self, current_revision: int):
        self.current_revision = current_revision
        super().__init__("配置版本已变化，请重新读取后保存")


class ConfigStoreError(RuntimeError):
    """Persistence cannot be trusted; never fall back to runnable defaults."""


def _unique_object(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


class ConfigStore:
    """Base store for strategy-specific JSON persistence.

    The active strategy owns schema validation and atomic writes. This class
    only supplies a process-wide path lock shared by store instances.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        with _PATH_LOCKS_LOCK:
            key = os.path.normcase(str(self.path))
            self._lock = _PATH_LOCKS.setdefault(key, threading.RLock())
        self._seen_persisted = False
