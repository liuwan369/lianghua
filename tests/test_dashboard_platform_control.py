from __future__ import annotations

from collections import deque
import importlib.util
import json
from pathlib import Path
import shlex

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("platform_control_test", ROOT / "scripts/system-dashboard-server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


@pytest.fixture
def control(monkeypatch, tmp_path):
    entry = tmp_path / "dist/cli/platform.js"
    entry.parent.mkdir(parents=True)
    entry.touch()
    monkeypatch.setattr(SERVER, "TRADING_ROOT", tmp_path)
    for name in ("_trading_process", "_trading_pid", "_trading_started_at", "_trading_mode", "_trading_params",
                 "_trading_log", "_trading_console_log", "_trading_exit_code", "_trading_stop_result",
                 "_trading_run_id", "_trading_config_revision", "_trading_account_id", "_trading_request_id",
                 "_trading_engine"):
        monkeypatch.setattr(SERVER, name, None)
    monkeypatch.setattr(SERVER, "_trading_state_loaded", True)
    monkeypatch.setattr(SERVER, "_projection_pending", deque())
    monkeypatch.setattr(SERVER, "_trading_environment", lambda: {"LIVE": "true"})
    monkeypatch.setenv("PM_TRADING_LIVE_UNLOCK", "1")
    monkeypatch.setattr(SERVER, "account_config_status", lambda: {
        "execution_credentials_ready": True, "wallet": "real-wallet-not-paper",
    })
    monkeypatch.setattr(SERVER, "account_action", lambda *_args, **_kwargs: {"account_ready": True})
    monkeypatch.setattr(SERVER, "_process_command", lambda _: "")
    return tmp_path


@pytest.mark.parametrize("duration", [0, 0.5])
def test_start_uses_only_live_platform_and_a_run_scoped_journal(control, monkeypatch, duration):
    calls = []

    class Child:
        pid = 123456

        def poll(self):
            return None

    def popen(args, **kwargs):
        calls.append((args, kwargs))
        return Child()

    monkeypatch.setattr(SERVER.subprocess, "Popen", popen)
    status = SERVER.start_trading({"mode": "live", "confirm_live": True, "duration_min": duration,
                                   "pair_cost_max": 0.99, "maker_life_sec": 12}, config_revision=7, request_id="start-once")
    args, kwargs = calls[0]
    assert args[:3] == ["node", "dist/cli/platform.js", "--live"]
    assert "--strategy-module" not in args and "--pair-cost-max" not in args
    assert "--order-usd" not in args and "--max-orders" not in args and "--maker-life-sec" not in args
    assert float(args[args.index("--duration-sec") + 1]) == duration * 60
    assert kwargs["env"]["LIVE"] == "true"
    journal = Path(args[args.index("--journal-file") + 1])
    state = Path(args[args.index("--state-file") + 1])
    assert Path(args[args.index("--stop-file") + 1]) == journal.with_suffix(".stop")
    assert journal.is_file() and journal.parent == state.parent
    assert status["run_id"] in journal.name and status["run_id"] in state.name
    assert status["engine"] == "platform" and status["execution"] == "observation"
    assert status["strategy_id"] is None and status["account_id"] == "real-wallet-not-paper"
    assert status["config_revision"] == 7 and status["running"] is True
    persisted = json.loads(SERVER._state_path().read_text(encoding="utf-8"))
    assert persisted["engine"] == "platform" and persisted["log"] == str(journal)
    with pytest.raises(RuntimeError, match="已有交易进程"):
        SERVER.start_trading({"mode": "live", "confirm_live": True})
    assert len(calls) == 1


def test_process_recovery_matches_exact_platform_run(monkeypatch, tmp_path):
    journal = tmp_path / "folder with spaces" / "run.jsonl"
    args = ["node", "dist/cli/platform.js", "--journal-file", str(journal)]
    monkeypatch.setattr(SERVER, "_process_command", lambda _: shlex.join(args))
    assert SERVER._process_matches(123, journal)
    assert not SERVER._process_matches(123, None)
    assert not SERVER._process_matches(123, journal.with_name("other.jsonl"))
    args[-1] = str(journal) + ".bak"
    assert not SERVER._process_matches(123, journal)
    args[:] = ["python", "other.py", "--note", f"dist/cli/platform.js --journal-file {journal}"]
    assert not SERVER._process_matches(123, journal)
    args[:] = ["node", "dist/cli/live.js", "--log-file", str(journal)]
    assert SERVER._process_matches(123, journal)
    args[-1] = str(journal.with_name("other.jsonl"))
    assert not SERVER._process_matches(123, journal)


def test_service_restart_recovers_platform_identity_without_spawning(control, monkeypatch):
    journal = control / "paper.jsonl"
    state = {"pid": 123, "mode": "paper", "engine": "platform", "log": str(journal),
             "run_id": "same-run", "config_revision": 7, "request_id": "same-request"}
    SERVER._state_path().parent.mkdir(parents=True)
    SERVER._state_path().write_text(json.dumps(state), encoding="utf-8")
    monkeypatch.setattr(SERVER, "_trading_state_loaded", False)
    monkeypatch.setattr(SERVER, "_process_command", lambda _: shlex.join([
        "node", "dist/cli/platform.js", "--journal-file", str(journal)]))
    monkeypatch.setattr(SERVER.subprocess, "Popen", lambda *_a, **_kw: pytest.fail("restoration must not spawn"))
    status = SERVER.trading_status(include_stats=False)
    assert status["running"] is True and status["run_id"] == "same-run"
    assert status["engine"] == "platform" and status["execution"] == "observation"
    assert status["config_revision"] == 7 and SERVER._trading_request_id == "same-request"


def test_stopped_historical_paper_run_is_not_current_status(control, monkeypatch):
    journal = control / "historical-paper.jsonl"
    journal.touch()
    monkeypatch.setattr(SERVER, "_trading_mode", "paper")
    monkeypatch.setattr(SERVER, "_trading_engine", "platform")
    monkeypatch.setattr(SERVER, "_trading_log", journal)
    monkeypatch.setattr(SERVER, "_trading_run_id", "historical-paper")
    monkeypatch.setattr(SERVER, "_trading_config_revision", 7)
    monkeypatch.setattr(SERVER, "_trading_params", {"mode": "paper", "order_usd": 5})
    monkeypatch.setattr(SERVER, "_trading_stop_result", {
        "confirmed": True, "process_stopped": True, "message": "模拟已停止，没有真实挂单。",
    })
    selections = []
    monkeypatch.setattr(SERVER, "trade_log_stats", lambda selection: selections.append(selection) or {})

    status = SERVER.trading_status()

    assert status["running"] is False
    assert status["mode"] is None and status["engine"] is None and status["execution"] is None
    assert status["run_id"] is None and status["config_revision"] is None
    assert status["params"] == {} and status["log"] is None
    assert status["stop_result"]["message"] == "当前没有正在运行的交易任务。"
    assert selections == [(None, None, None, None, None)]


def test_runtime_cannot_stay_fresh_after_source_or_projection_expires(monkeypatch):
    original = {"source_at": 100, "expires_at": 110, "stale": False}
    view = {"stats": {"runtime": original}, "stale": False}
    monkeypatch.setattr(SERVER, "_projection_snapshot", lambda _: view)
    monkeypatch.setattr(SERVER.time, "time", lambda: 111)
    runtime = SERVER.trade_log_stats()["runtime"]
    assert runtime["stale"] is True and runtime["age_seconds"] == 11
    assert original["stale"] is False
    view["stale"] = True
    monkeypatch.setattr(SERVER.time, "time", lambda: 101)
    assert SERVER.trade_log_stats()["runtime"]["stale"] is True


def test_hidden_windows_platform_stops_via_control_file(control, monkeypatch):
    journal = control / "run.jsonl"
    journal.touch()

    class Child:
        pid = 9876
        ended = False

        def poll(self):
            return 0 if self.ended else None

        def send_signal(self, _signal):
            pytest.fail("hidden processes do not receive console signals")

        def wait(self, timeout):
            assert journal.with_suffix(".stop").is_file()
            self.ended = True

        def kill(self):
            pytest.fail("normal platform stop must flush rather than kill")

    child = Child()
    monkeypatch.setattr(SERVER, "_trading_process", child)
    monkeypatch.setattr(SERVER, "_trading_pid", child.pid)
    monkeypatch.setattr(SERVER, "_trading_mode", "paper")
    monkeypatch.setattr(SERVER, "_trading_engine", "platform")
    monkeypatch.setattr(SERVER, "_trading_log", journal)
    # The CI host may be Linux; replacing only the server's module reference
    # avoids changing pathlib's platform selection for the test runner.
    from types import SimpleNamespace
    monkeypatch.setattr(SERVER, "os", SimpleNamespace(name="nt", environ=SERVER.os.environ))
    monkeypatch.setattr(SERVER, "_process_matches", lambda *_: not child.ended)
    result = SERVER.stop_trading()
    assert result["running"] is False and result["stop_result"]["confirmed"] is True


def test_platform_capabilities_preserve_legacy_values_without_applying_them(control):
    store = SERVER.ConfigStore(control / "config.json")
    saved = store.save({"duration_min": 0, "pair_cost_max": 0.97, "maker_life_sec": 13}, 0)
    capabilities = saved["capabilities"]
    assert capabilities["executionTarget"] == "platform"
    assert capabilities["executionMode"] == "observation"
    assert capabilities["runtimeAppliedFields"] == ["mode", "duration_min"]
    assert set(capabilities["preservedLegacyFields"]) == set(saved["params"]) - {"mode", "duration_min"}
    assert saved["params"]["pair_cost_max"] == 0.97 and saved["params"]["maker_life_sec"] == 13
