"""The account check now reports Polymarket Protocol V2 approvals as their own
line (engine cli/account-check.ts, 2026-11-25). The control plane's strict
whitelist (_public_check_report) must accept them, and they must never change
account_ready: BTC trades CTF (V1) markets today.
- v2_approvals_ready (bool or null) and v2_approvals_missing (a list of the
  three known keys) pass; anything else is rejected;
- a check row may carry `informational: true` (the V2 line);
- an otherwise ready report stays ready with V2 missing.

Run:  python scripts/regress/account-check-v2.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard_account import AccountCheckError, _public_check_report  # noqa: E402

WALLET = "0x" + "a1" * 20
VALUES = {"POLYMARKET_WALLET_ADDRESS": WALLET}


def report(**extra):
    base = {"wallet": WALLET, "owner": None, "signer_matches": True, "compromised": False, "balance": 50.0,
            "approvals_ready": True, "account_ready": True, "settlement_credentials_ready": True,
            "checks": [{"name": "交易授权", "ok": True, "detail": "齐全"}],
            "checked_at": "2026-11-25T00:00:00Z", "read_only": True}
    return {**base, **extra}


class V2Approvals(unittest.TestCase):
    def test_v2_fields_pass(self):
        out = _public_check_report(report(v2_approvals_ready=False, v2_approvals_missing=["positions_router"],
                                          checks=[{"name": "V2 市场授权", "ok": False, "informational": True, "detail": "缺赎回"}]), VALUES)
        self.assertIs(out["v2_approvals_ready"], False)
        self.assertTrue(out["account_ready"], "V2 never changes the V1 verdict")

    def test_unknown_is_null(self):
        self.assertIsNone(_public_check_report(report(v2_approvals_ready=None, v2_approvals_missing=[]), VALUES)["v2_approvals_ready"])

    def test_bad_values_rejected(self):
        for bad in ({"v2_approvals_ready": "yes"}, {"v2_approvals_missing": ["something_else"]}, {"v2_approvals_missing": "positions_router"},
                    {"checks": [{"name": "x", "ok": True, "detail": "y", "informational": "yes"}]}):
            with self.assertRaises(AccountCheckError, msg=bad):
                _public_check_report(report(**bad), VALUES)


if __name__ == "__main__":
    unittest.main()
