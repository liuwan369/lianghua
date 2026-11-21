"""ISO-8601 timestamps written by the Node side ("2026-10-10T15:38:11.843Z")."""
from __future__ import annotations

import math
from datetime import datetime


def parse_iso(value: str) -> float:
    """Unix seconds of an ISO-8601 string. A trailing "Z" is accepted on every
    Python: datetime.fromisoformat only reads it from 3.11, and the server runs
    3.10 (Ubuntu 22.04). Raises ValueError/TypeError like fromisoformat."""
    if isinstance(value, str) and value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value).timestamp()


def epoch(value):
    """Unix seconds of a finite number or a timezone-aware ISO-8601 string; None otherwise."""
    if type(value) in (int, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return stamp.timestamp() if stamp.tzinfo else None
        except (ValueError, OverflowError, OSError):
            pass
    return None
