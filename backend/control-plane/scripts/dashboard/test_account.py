"""Account bridge tests use only synthetic credentials and mocked child processes."""
from __future__ import annotations

import copy
import io
import json
import queue
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import dashboard_account as account
from dashboard.account_data import AccountData


WALLET = "0x" + "a" * 40
OTHER_WALLET = "0x" + "c" * 40
MOCK_OWNER = "0x" + "b" * 64
MOCK_SESSION = "0x" + "d" * 64


def account_values():
    return {"POLYMARKET_WALLET_ADDRESS": WALLET, "POLYMARKET_PRIVATE_KEY": MOCK_OWNER,
            "POLYMARKET_SESSION_PRIVATE_KEY": MOCK_SESSION, "POLY_FUNDER": WALLET,
            "POLY_SIGNATURE_TYPE": "3", "RELAYER_API_KEY": "synthetic-relayer-value",
            "RELAYER_API_KEY_ADDRESS": OTHER_WALLET, "POLY_BUILDER_API_KEY": "synthetic-builder-key",
            "POLY_BUILDER_SECRET": "synthetic-builder-secret", "POLY_BUILDER_PASSPHRASE": "synthetic-passphrase",
            account.CONTROL_FIELD: "synthetic-control-value"}


def check_report():
    return {"wallet": WALLET, "owner": OTHER_WALLET, "read_only": True,
            "account_ready": True, "signer_matches": True, "compromised": False,
            "approvals_ready": True, "settlement_credentials_ready": True,
            "balance": 14.5, "checked_at": datetime.now(timezone.utc).isoformat(),
            "checks": [{"name": "交易授权", "ok": True, "detail": "已确认"}]}


def data_report():
    stamp = datetime.now(timezone.utc).isoformat()
    result = {"schemaVersion": 1, "wallet": WALLET, "read_only": True, "checked_at": stamp}
    for section in ("collateral", "open_orders", "trades", "positions", "closed_positions", "activity"):
        result[section] = {"available": True, "complete": True, "items": [],
                           "checked_at": stamp, "source": "test-source"}
    result["collateral"]["value"] = 14.5
    result["open_orders"]["items"] = [{"id": "old-order", "status": "OPEN"}]
    return result


class AccountConfigTests(unittest.TestCase):
    def test_same_wallet_save_migrates_legacy_and_keeps_optional_fields(self):
        old = account_values()
        saved = account.candidate_profile({"wallet": WALLET}, old)
        self.assertEqual(saved["POLYMARKET_OWNER_PRIVATE_KEY"], MOCK_OWNER)
        self.assertNotIn("POLYMARKET_PRIVATE_KEY", saved)
        for name in ("POLYMARKET_SESSION_PRIVATE_KEY", "POLY_FUNDER", "POLY_SIGNATURE_TYPE",
                     "RELAYER_API_KEY", "POLY_BUILDER_SECRET", account.CONTROL_FIELD):
            self.assertEqual(saved[name], old[name])

    def test_funder_only_legacy_identity_and_wallet_switch(self):
        values = account_values()
        values.pop("POLYMARKET_WALLET_ADDRESS")
        saved = account.candidate_profile({"wallet": WALLET}, values)
        self.assertEqual(saved["POLYMARKET_OWNER_PRIVATE_KEY"], MOCK_OWNER)
        switched = account.candidate_profile({"wallet": OTHER_WALLET}, values)
        self.assertEqual(switched["POLYMARKET_OWNER_PRIVATE_KEY"], "")
        self.assertEqual(switched["POLYMARKET_SESSION_PRIVATE_KEY"], "")
        self.assertEqual(switched[account.CONTROL_FIELD], values[account.CONTROL_FIELD])

    def test_optional_profile_fields_are_validated_without_echo(self):
        for field in ("session_private_key", "funder", "signature_type"):
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as error:
                    account.candidate_profile({"wallet": WALLET, field: "synthetic-invalid-secret"}, {})
                self.assertNotIn("synthetic-invalid-secret", str(error.exception))

    def test_child_environment_preserves_account_fields_and_removes_control(self):
        values = account_values()
        with patch.dict(account.os.environ, {"PM_DASHBOARD_CONTROL_TOKEN": "old-control",
                         "PM_TRADING_LIVE_UNLOCK": "true", "RELAYER_API_KEY": "old-relayer",
                         "PM_ACCOUNT_RPC_URL": "https://read-only.invalid"}, clear=True):
            env = account.child_environment(values)
        self.assertEqual(env["POLYMARKET_OWNER_PRIVATE_KEY"], MOCK_OWNER)
        for name in account.ACCOUNT_ENV_FIELDS:
            if name in values:
                self.assertEqual(env[name], values[name])
        self.assertNotIn(account.CONTROL_FIELD, env)
        self.assertNotIn("PM_TRADING_LIVE_UNLOCK", env)
        self.assertEqual(env["POLYGON_RPC"], "https://read-only.invalid")
        env = account.child_environment({"POLY_FUNDER": WALLET})
        self.assertEqual(env["POLYMARKET_WALLET_ADDRESS"], WALLET)

    def test_check_accepts_public_report_and_uses_same_injection(self):
        values, report = account_values(), check_report()
        with tempfile.TemporaryDirectory() as directory:
            engine = Path(directory)
            (engine / "dist" / "cli").mkdir(parents=True)
            (engine / "dist" / "cli" / "account-check.js").write_text("", encoding="utf-8")
            with patch.dict(account.os.environ, {}, clear=True), patch.object(account.shutil, "which", return_value="node"), patch.object(account.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess([], 0, json.dumps(report), "")
                self.assertEqual(account.check_account(engine, values), report)
        child_env = run.call_args.kwargs["env"]
        self.assertEqual(child_env["POLYMARKET_OWNER_PRIVATE_KEY"], MOCK_OWNER)
        self.assertEqual(child_env["POLYMARKET_SESSION_PRIVATE_KEY"], MOCK_SESSION)
        self.assertEqual(child_env["POLY_SIGNATURE_TYPE"], "3")
        self.assertNotIn(account.CONTROL_FIELD, child_env)

    def test_check_rejects_nested_secret_invalid_identity_and_credential_echo(self):
        mutations = [lambda report: report["checks"][0].update(secret="synthetic-hidden"),
                     lambda report: report["checks"][0].update(detail=MOCK_OWNER),
                     lambda report: report.update(balance={"secret": "synthetic-hidden"}),
                     lambda report: report.update(wallet=OTHER_WALLET),
                     lambda report: report.update(account_ready="true")]
        for mutate in mutations:
            report = check_report()
            mutate(report)
            with tempfile.TemporaryDirectory() as directory:
                engine = Path(directory)
                (engine / "dist" / "cli").mkdir(parents=True)
                (engine / "dist" / "cli" / "account-check.js").write_text("", encoding="utf-8")
                with patch.dict(account.os.environ, {}, clear=True), patch.object(account.shutil, "which", return_value="node"), patch.object(account.subprocess, "run") as run:
                    run.return_value = subprocess.CompletedProcess([], 0, json.dumps(report), "")
                    with self.assertRaises(account.AccountCheckError) as error:
                        account.check_account(engine, account_values())
            self.assertEqual(error.exception.code, "account_response_invalid")
            self.assertNotIn(MOCK_OWNER, str(error.exception))


class AccountReaderTests(unittest.TestCase):
    def _reader(self):
        reader = AccountData(Path("unused"), account_values)
        reader._account()
        self.addCleanup(reader.close)
        return reader

    def _queue_result(self, reader, result):
        process = Mock()
        process.poll.return_value = None
        process.stdin = io.StringIO()
        process.stdout = io.StringIO()
        messages = queue.Queue()
        messages.put(json.dumps(result) if result is not None else None)
        reader._process, reader._queue, reader._attempt = process, messages, float("-inf")

    def test_reader_spawn_uses_same_account_fields_as_check(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = Path(directory)
            entry = engine / "dist" / "cli" / "account-data.js"
            entry.parent.mkdir(parents=True)
            entry.touch()
            reader = AccountData(engine, account_values)
            with patch("dashboard.account_data.shutil.which", return_value="synthetic-node"), \
                    patch("dashboard.account_data.subprocess.Popen") as popen, \
                    patch("dashboard.account_data.threading.Thread.start"), \
                    patch.dict(account.os.environ, {}, clear=True):
                reader._spawn(account_values())
                child_env = popen.call_args.kwargs["env"]
                self.assertEqual(child_env, account.child_environment(account_values()))
                reader.close()

    def test_spawn_errors_are_safe_typed_and_preserve_last_good(self):
        cases = [(PermissionError("synthetic-hidden"), "account_reader_permission_denied"),
                 (FileNotFoundError("synthetic-hidden"), "account_reader_executable_missing"),
                 (OSError("synthetic-hidden"), "account_reader_io_failed")]
        for error, expected in cases:
            reader = self._reader()
            reader._cache, reader._checked = {**data_report(), "available": True}, time.monotonic()
            with patch.object(reader, "_spawn", side_effect=error):
                self.assertFalse(reader.refresh())
            snapshot = reader.snapshot()
            self.assertEqual(snapshot["error_code"], expected)
            self.assertTrue(snapshot["stale"])
            self.assertFalse(snapshot["available"])
            self.assertEqual(snapshot["collateral"]["value"], 14.5)
            self.assertNotIn("synthetic-hidden", json.dumps(snapshot))

    def test_missing_engine_build_and_node_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = Path(directory)
            for path, expected in ((engine / "missing", "account_engine_missing"), (engine, "account_reader_build_missing")):
                reader = AccountData(path, account_values)
                self.assertFalse(reader.refresh())
                self.assertEqual(reader.snapshot()["error_code"], expected)
            entry = engine / "dist" / "cli" / "account-data.js"
            entry.parent.mkdir(parents=True)
            entry.touch()
            with patch("dashboard.account_data.shutil.which", return_value=None):
                reader = AccountData(engine, account_values)
                self.assertFalse(reader.refresh())
                self.assertEqual(reader.snapshot()["error_code"], "account_node_missing")

    def test_failed_sections_keep_observed_balance_and_orders(self):
        reader = self._reader()
        good = data_report()
        self._queue_result(reader, good)
        self.assertTrue(reader.refresh())
        bad = copy.deepcopy(good)
        for key in ("collateral", "open_orders"):
            bad[key].update(available=False, complete=False, items=[], error_code="fetch_failed")
            bad[key].pop("value", None)
        # Pagination can return a partial page before a failure; it must not
        # replace the last complete observed order set with a shorter one.
        bad["open_orders"]["available"] = True
        self._queue_result(reader, bad)
        self.assertTrue(reader.refresh())
        snapshot = reader.snapshot()
        self.assertEqual(snapshot["collateral"]["value"], 14.5)
        self.assertEqual(snapshot["open_orders"]["items"][0]["id"], "old-order")
        self.assertEqual(snapshot["collateral"]["checked_at"], good["collateral"]["checked_at"])
        self.assertFalse(snapshot["collateral"]["available"])
        self.assertTrue(snapshot["collateral"]["stale"])
        self.assertFalse(snapshot["open_orders"]["available"])
        self._queue_result(reader, good)
        self.assertTrue(reader.refresh())
        self.assertTrue(reader.snapshot()["open_orders"]["available"])

    def test_reader_rejects_credential_echo_and_closed_process(self):
        reader = self._reader()
        report = data_report()
        report["positions"]["items"] = [{"secret": "synthetic-hidden"}]
        self._queue_result(reader, report)
        self.assertFalse(reader.refresh())
        self.assertEqual(reader.snapshot()["error_code"], "account_response_invalid")
        self.assertNotIn("synthetic-hidden", json.dumps(reader.snapshot()))
        self._queue_result(reader, None)
        self.assertFalse(reader.refresh())
        self.assertEqual(reader.snapshot()["error_code"], "account_reader_exited")

    def test_wallet_change_cannot_reuse_old_snapshot(self):
        values = account_values()
        reader = AccountData(Path("unused"), lambda: values)
        self.addCleanup(reader.close)
        self._queue_result(reader, data_report())
        reader._account()
        self._queue_result(reader, data_report())
        self.assertTrue(reader.refresh())
        values["POLYMARKET_WALLET_ADDRESS"] = OTHER_WALLET
        snapshot = reader.snapshot()
        self.assertEqual(snapshot["wallet"], OTHER_WALLET)
        self.assertFalse(snapshot["available"])
        self.assertNotIn("collateral", snapshot)


if __name__ == "__main__":
    unittest.main()
