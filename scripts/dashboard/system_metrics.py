"""Cached host and process metrics for the read-only dashboard."""
from __future__ import annotations

import copy
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


class SystemMetrics:
    """Collect inexpensive OS counters outside HTTP request handlers."""

    def __init__(self, disk_path: Path, services: Callable[[], dict], collector_service: str | None = None):
        self.disk_path = Path(disk_path)
        self.services = services
        self._lock = threading.Lock()
        self._cache = self._empty()
        self._previous_cpu: tuple[int, int] | None = None
        self.collector_service = collector_service
        self._collector_checked = 0.
        self._collector = {"pid": None, "state": "unknown"}

    @staticmethod
    def _empty() -> dict:
        return {
            "schemaVersion": 1,
            "asOf": None,
            "cpu": {"percent": None, "cores": os.cpu_count()},
            "load": {"one": None, "five": None, "fifteen": None},
            "memory": {"used_bytes": None, "total_bytes": None, "percent": None},
            "disk": {"used_bytes": None, "total_bytes": None, "free_bytes": None, "percent": None},
            "services": {},
            "journal_backlog": None,
            "event_loop_lag_ms": None,
        }

    @staticmethod
    def _cpu_times() -> tuple[int, int] | None:
        try:
            values = [int(value) for value in Path("/proc/stat").read_text(encoding="ascii").splitlines()[0].split()[1:]]
        except (OSError, ValueError, IndexError):
            return None
        if len(values) < 4:
            return None
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        return sum(values), idle

    @staticmethod
    def _memory() -> dict:
        try:
            values = {}
            for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
                key, raw = line.split(":", 1)
                values[key] = int(raw.strip().split()[0]) * 1024
            total, available = values["MemTotal"], values["MemAvailable"]
            used = max(0, total - available)
            return {"used_bytes": used, "total_bytes": total, "percent": used * 100 / total if total else None}
        except (OSError, ValueError, KeyError):
            return {"used_bytes": None, "total_bytes": None, "percent": None}

    @staticmethod
    def _process(pid, state) -> dict:
        active = state == "active"
        result = {"state": state, "pid": pid if active and isinstance(pid, int) and pid > 0 else None,
                  "rss_bytes": None, "uptime_seconds": None}
        if result["pid"] is None:
            return result
        root = Path(f"/proc/{result['pid']}")
        try:
            status = root.joinpath("status").read_text(encoding="ascii")
            rss = next(line for line in status.splitlines() if line.startswith("VmRSS:"))
            result["rss_bytes"] = int(rss.split()[1]) * 1024
            stat = root.joinpath("stat").read_text(encoding="ascii").rsplit(") ", 1)[1].split()
            started = int(stat[19]) / os.sysconf("SC_CLK_TCK")
            uptime = float(Path("/proc/uptime").read_text(encoding="ascii").split()[0])
            result["uptime_seconds"] = max(0., uptime - started)
        except (OSError, ValueError, StopIteration, IndexError):
            pass
        return result

    def _collector_status(self) -> dict:
        if not self.collector_service or os.name == "nt":
            return self._collector
        if time.monotonic() - self._collector_checked < 10:
            return self._collector
        self._collector_checked = time.monotonic()
        try:
            process = subprocess.run(["systemctl", "show", self.collector_service, "--property=MainPID,ActiveState"],
                                     capture_output=True, text=True, timeout=2)
            if process.returncode != 0:
                raise OSError("service state unavailable")
            fields = dict(line.split("=", 1) for line in process.stdout.splitlines() if "=" in line)
            pid = int(fields.get("MainPID", "0"))
            self._collector = {"pid": pid if pid > 0 else None, "state": fields.get("ActiveState") or "unknown"}
        except (OSError, ValueError, subprocess.SubprocessError):
            self._collector = {"pid": None, "state": "unknown"}
        return self._collector

    def refresh(self) -> dict:
        value = self._empty()
        value["asOf"] = time.time()
        current = self._cpu_times()
        if current is not None and self._previous_cpu is not None:
            total = current[0] - self._previous_cpu[0]
            idle = current[1] - self._previous_cpu[1]
            value["cpu"]["percent"] = max(0., min(100., (total - idle) * 100 / total)) if total > 0 else None
        self._previous_cpu = current
        try:
            one, five, fifteen = os.getloadavg()
            value["load"] = {"one": one, "five": five, "fifteen": fifteen}
        except (AttributeError, OSError):
            pass
        value["memory"] = self._memory()
        try:
            disk = shutil.disk_usage(self.disk_path)
            value["disk"] = {"used_bytes": disk.used, "total_bytes": disk.total, "free_bytes": disk.free,
                             "percent": disk.used * 100 / disk.total if disk.total else None}
        except OSError:
            pass
        try:
            service_state = self.services()
        except Exception:
            service_state = {}
        if self.collector_service:
            service_state["collector"] = self._collector_status()
        value["journal_backlog"] = _number(service_state.pop("journal_backlog", None))
        value["event_loop_lag_ms"] = _number(service_state.pop("event_loop_lag_ms", None))
        value["services"] = {
            str(name): self._process(details.get("pid"), str(details.get("state") or "unknown"))
            for name, details in service_state.items() if isinstance(details, dict)
        }
        with self._lock:
            self._cache = value
        return copy.deepcopy(value)

    def snapshot(self) -> dict:
        with self._lock:
            return copy.deepcopy(self._cache)

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self.refresh()
            stop.wait(1)
