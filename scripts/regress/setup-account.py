"""scripts/setup_account.py: the operator types an account's values on the PC
(keys hidden), they go straight to the engine box's .env over ssh stdin:

- every value is checked before anything is sent (wallet = 0x + 40 hex, keys
  = 64 hex, builder creds all or none, relayer creds all or none, at least one
  of the two);
- the .env text holds exactly the engine's account fields, nothing echoed;
- the remote command writes it 600 through a temp file and never overwrites an
  existing account unless --replace is given;
- nothing secret reaches stdout, the ssh command line or an exception.

Run:  python scripts/regress/setup-account.py
"""
import importlib.util
import io
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("setup_account", SCRIPTS / "setup_account.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

WALLET = "0x" + "Ab" * 20
KEY = "0x" + "7f" * 32
GOOD = {"POLYMARKET_WALLET_ADDRESS": WALLET, "POLYMARKET_OWNER_PRIVATE_KEY": KEY,
        "POLY_BUILDER_API_KEY": "11111111-2222-3333-4444-555555555555", "POLY_BUILDER_SECRET": "c2VjcmV0LXZhbHVlLWJhc2U2NA==",
        "POLY_BUILDER_PASSPHRASE": "pass-phrase-value-0000000000000000000000000000000000000000000000",
        "RELAYER_API_KEY": "", "RELAYER_API_KEY_ADDRESS": ""}


class Validate(unittest.TestCase):
    def test_good(self):
        self.assertEqual(setup.validate(GOOD), [])

    def test_bad_values(self):
        cases = {"POLYMARKET_WALLET_ADDRESS": ["0x123", "ab" * 20, "0x" + "zz" * 20],
                 "POLYMARKET_OWNER_PRIVATE_KEY": ["0x1234", "g" * 64, ""]}
        for name, values in cases.items():
            for value in values:
                problems = setup.validate({**GOOD, name: value})
                self.assertTrue(any(name in p for p in problems), (name, value, problems))
                self.assertFalse(any(value and value in p for p in problems), "a problem never repeats the value")

    def test_credentials_all_or_none(self):
        half = {**GOOD, "POLY_BUILDER_SECRET": ""}
        self.assertTrue(any("builder" in p.lower() for p in setup.validate(half)))
        none = {**GOOD, "POLY_BUILDER_API_KEY": "", "POLY_BUILDER_SECRET": "", "POLY_BUILDER_PASSPHRASE": ""}
        self.assertTrue(any("relayer" in p.lower() or "builder" in p.lower() for p in setup.validate(none)),
                        "settlement needs builder or relayer credentials")
        relayer = {**none, "RELAYER_API_KEY": "rk-0123456789abcdef", "RELAYER_API_KEY_ADDRESS": "0x" + "cd" * 20}
        self.assertEqual(setup.validate(relayer), [])


class Render(unittest.TestCase):
    def test_env_text(self):
        text = setup.env_text(GOOD)
        lines = dict(line.split("=", 1) for line in text.splitlines() if line and not line.startswith("#"))
        self.assertEqual(lines["POLYMARKET_WALLET_ADDRESS"], WALLET)
        self.assertEqual(lines["POLY_FUNDER"], WALLET)
        self.assertEqual(lines["POLYMARKET_OWNER_PRIVATE_KEY"], KEY)
        self.assertEqual(set(lines) - set(setup.FIELDS), set(), "only the engine's account fields")

    def test_remote_command_carries_no_value(self):
        command = setup.remote_command(replace=False)
        for value in GOOD.values():
            if value:
                self.assertNotIn(value, command)
        self.assertIn("umask 077", command)
        self.assertIn("[ -e /root/pm-system/backend/engine/.env ]", command, "refuses to overwrite an account")
        self.assertNotIn("[ -e /root/pm-system/backend/engine/.env ]", setup.remote_command(replace=True))

    def test_summary_shows_no_secret(self):
        out = io.StringIO()
        with redirect_stdout(out):
            setup.print_summary(GOOD)
        printed = out.getvalue()
        self.assertIn(WALLET, printed, "the wallet address is public and shown for checking")
        for name in ("POLYMARKET_OWNER_PRIVATE_KEY", "POLY_BUILDER_SECRET", "POLY_BUILDER_PASSPHRASE", "POLY_BUILDER_API_KEY"):
            self.assertNotIn(GOOD[name], printed, name)


if __name__ == "__main__":
    unittest.main()
