"""Run the repository's offline checks and retain evidence for every command."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "_external" / "btc-5m-market-trading-bot"


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_report(path: Path, report: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def stop_process_tree(process: subprocess.Popen, log) -> None:
    # npm launches child workers: terminating only the wrapper leaves tests alive.
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=log, stderr=subprocess.STDOUT, timeout=15, check=False,
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_step(step: dict, evidence: Path, timeout: int) -> dict:
    started = time.monotonic()
    result = {**step, "started_at": timestamp(), "exit_code": None}
    log_path = evidence / step["log"]
    print(f"[{step['id']}] running", flush=True)
    process = None
    with log_path.open("wb") as log:
        try:
            process = subprocess.Popen(
                step["command"], cwd=step["cwd"], stdout=log,
                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                env={**os.environ, "CI": "true", "NO_COLOR": "1", "PYTHONUTF8": "1"},
            )
            result["exit_code"] = process.wait(timeout=timeout)
            result["status"] = "passed" if result["exit_code"] == 0 else "failed"
        except subprocess.TimeoutExpired:
            result["status"] = "timed_out"
            result["error"] = f"Command exceeded {timeout} seconds."
        except KeyboardInterrupt:
            result["status"] = "interrupted"
            result["error"] = "Verification was interrupted."
        except OSError as error:
            result["status"] = "error"
            result["error"] = str(error)
        finally:
            if process is not None and result.get("status") in {"timed_out", "interrupted"}:
                try:
                    stop_process_tree(process, log)
                    result["exit_code"] = process.returncode
                except (OSError, subprocess.TimeoutExpired) as error:
                    result["cleanup_error"] = str(error)
            if "error" in result:
                log.write(("\n" + result["error"] + "\n").encode("utf-8"))
    result["finished_at"] = timestamp()
    result["duration_seconds"] = round(time.monotonic() - started, 3)
    result["log_sha256"] = file_sha256(log_path)
    print(f"[{step['id']}] {result['status']} (exit={result['exit_code']}, {result['duration_seconds']}s)", flush=True)
    if result["status"] != "passed":
        with log_path.open("rb") as stream:
            stream.seek(max(0, log_path.stat().st_size - 3000))
            print(stream.read().decode("utf-8", errors="replace"), flush=True)
    return result


def bounded_timeout(value: str) -> int:
    seconds = int(value)
    if not 1 <= seconds <= 3600:
        raise argparse.ArgumentTypeError("timeout must be between 1 and 3600 seconds")
    return seconds


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=bounded_timeout, default=600, help="seconds per check (default: 600)")
    parser.add_argument("--evidence-dir", type=Path, default=ROOT / ".planning" / "tmp" / "verification",
                        help="parent directory for a unique run folder")
    args = parser.parse_args()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    evidence = args.evidence_dir.resolve() / run_id
    evidence.mkdir(parents=True)
    report_path = evidence / "manifest.json"
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    node = shutil.which("node")
    git = shutil.which("git")
    steps = []
    for name, command, cwd in [
        ("git-revision", [git or "git", "rev-parse", "HEAD"], ROOT),
        ("git-status", [git or "git", "status", "--porcelain=v1", "--untracked-files=normal"], ROOT),
        ("node-version", [node or "node", "--version"], ROOT),
        ("npm-version", [npm or "npm", "--version"], ROOT),
        ("python-packages", [sys.executable, "-m", "pip", "list", "--format=json", "--disable-pip-version-check"], ROOT),
        ("python-tests", [sys.executable, "-m", "pytest", "-q"], ROOT),
        ("engine-tests", [npm or "npm", "test"], ENGINE),
        ("engine-build", [npm or "npm", "run", "build"], ENGINE),
        ("frontend-tests", [npm or "npm", "test"], ROOT / "web"),
        ("frontend-build", [npm or "npm", "run", "build"], ROOT / "web"),
    ]:
        steps.append({"id": name, "command": command, "cwd": str(cwd), "log": name + ".log", "status": "pending"})
    inputs = ["pyproject.toml", "requirements-dev.lock", "scripts/verify-project.py",
              "_external/btc-5m-market-trading-bot/package-lock.json", "web/package-lock.json"]
    report = {
        "schema_version": 1, "run_id": run_id, "status": "running", "started_at": timestamp(),
        "root": str(ROOT), "python": sys.version, "python_executable": sys.executable,
        "platform": platform.platform(), "timeout_seconds": args.timeout,
        "git_sha": None, "node_version": None, "npm_version": None,
        "input_sha256": {name: file_sha256(ROOT / name) for name in inputs},
        "steps": steps,
    }
    write_report(report_path, report)
    print(f"Evidence: {evidence}", flush=True)
    for index, step in enumerate(steps):
        step["status"] = "running"
        write_report(report_path, report)
        result = run_step(step, evidence, min(args.timeout, 30) if index < 5 else args.timeout)
        steps[index] = result
        if result["status"] == "passed":
            value = (evidence / result["log"]).read_text(encoding="utf-8", errors="replace").strip()
            if result["id"] == "git-revision":
                report["git_sha"] = value
            elif result["id"] == "node-version":
                report["node_version"] = value
                try:
                    supported = int(value.removeprefix("v").split(".")[0]) >= 24
                except ValueError:
                    supported = False
                if not supported:
                    result.update(status="failed", error="Node.js 24 or newer is required.")
            elif result["id"] == "npm-version":
                report["npm_version"] = value
        write_report(report_path, report)
        if result["status"] == "interrupted" or "cleanup_error" in result:
            for pending in steps[index + 1:]:
                pending["status"] = "not_run"
            break
    if sys.version_info < (3, 11):
        report["environment_error"] = "Python 3.11 or newer is required."
    passed = all(step["status"] == "passed" for step in steps) and "environment_error" not in report
    report.update(status="passed" if passed else "failed", finished_at=timestamp())
    write_report(report_path, report)
    print(f"Verification {report['status']}. Report: {report_path}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
