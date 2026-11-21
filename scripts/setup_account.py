"""Put one account on its engine box, from this PC, without the values ever
being shown, stored here, or put on a command line.

  python scripts/setup_account.py pm-b            # asks for each value
  python scripts/setup_account.py pm-b --replace  # only to overwrite an account

The keys are typed hidden (getpass). Every value is checked first; then the
.env text goes to the box over ssh stdin and is written 600 through a temp
file. The account check runs on the box afterwards (the console shows it).
"""
from __future__ import annotations

import argparse
import getpass
import re
import subprocess
import sys

ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
KEY = re.compile(r"(?:0x)?[0-9a-fA-F]{64}\Z")
ENV = "/root/pm-system/backend/engine/.env"
BOXES = ("pm-a", "pm-b")
# The engine's account fields (dashboard_account.ACCOUNT_ENV_FIELDS), in this order.
FIELDS = ("POLYMARKET_WALLET_ADDRESS", "POLY_FUNDER", "POLY_SIGNATURE_TYPE", "POLYMARKET_OWNER_PRIVATE_KEY",
          "RELAYER_API_KEY", "RELAYER_API_KEY_ADDRESS", "POLY_BUILDER_API_KEY", "POLY_BUILDER_SECRET",
          "POLY_BUILDER_PASSPHRASE")
PROMPTS = (("POLYMARKET_WALLET_ADDRESS", "钱包地址（Polymarket 资金钱包，0x 开头）", False),
           ("POLYMARKET_OWNER_PRIVATE_KEY", "签名私钥（输入时不显示）", True),
           ("POLY_BUILDER_API_KEY", "Builder API key（没有就直接回车）", True),
           ("POLY_BUILDER_SECRET", "Builder secret（没有就直接回车）", True),
           ("POLY_BUILDER_PASSPHRASE", "Builder passphrase（没有就直接回车）", True),
           ("RELAYER_API_KEY", "Relayer API key（有 Builder 就直接回车）", True),
           ("RELAYER_API_KEY_ADDRESS", "Relayer API key 地址（有 Builder 就直接回车）", False))


def validate(values: dict) -> list[str]:
    """Problems, by field name only: a message never repeats a value."""
    problems = []
    if not ADDRESS.fullmatch(values.get("POLYMARKET_WALLET_ADDRESS", "")):
        problems.append("POLYMARKET_WALLET_ADDRESS 要是 0x 加 40 位十六进制")
    if not KEY.fullmatch(values.get("POLYMARKET_OWNER_PRIVATE_KEY", "")):
        problems.append("POLYMARKET_OWNER_PRIVATE_KEY 要是 64 位十六进制（可带 0x）")
    builder = [values.get(name, "") for name in ("POLY_BUILDER_API_KEY", "POLY_BUILDER_SECRET", "POLY_BUILDER_PASSPHRASE")]
    relayer = [values.get(name, "") for name in ("RELAYER_API_KEY", "RELAYER_API_KEY_ADDRESS")]
    if any(builder) and not all(builder):
        problems.append("Builder 三项要么都填，要么都不填")
    if any(relayer) and not all(relayer):
        problems.append("Relayer 两项要么都填，要么都不填")
    if relayer[1] and not ADDRESS.fullmatch(relayer[1]):
        problems.append("RELAYER_API_KEY_ADDRESS 要是 0x 加 40 位十六进制")
    if not all(builder) and not all(relayer):
        problems.append("结算要 Builder 或 Relayer 凭据，至少一套")
    return problems


def env_text(values: dict) -> str:
    wallet = values["POLYMARKET_WALLET_ADDRESS"]
    full = {**{name: "" for name in FIELDS}, **values, "POLY_FUNDER": wallet,
            "POLY_SIGNATURE_TYPE": values.get("POLY_SIGNATURE_TYPE", "")}
    lines = ["# Account for this engine box. Written by scripts/setup_account.py; mode 600."]
    lines += [f"{name}={full[name]}" for name in FIELDS]
    return "\n".join(lines) + "\n"


def remote_command(replace: bool) -> str:
    """The box writes stdin to .env (600, temp file, then rename). No value here."""
    guard = "" if replace else f"[ -e {ENV} ] && {{ echo 'an account is already on this box; use --replace' >&2; exit 3; }}; "
    return (f"umask 077; {guard}cat > {ENV}.part && chmod 600 {ENV}.part && mv {ENV}.part {ENV} && "
            f"stat -c '%a %s' {ENV}")


def print_summary(values: dict) -> None:
    print("钱包地址:", values["POLYMARKET_WALLET_ADDRESS"])
    print("签名私钥: 已填（不显示）")
    print("Builder 凭据:", "已填" if values.get("POLY_BUILDER_API_KEY") else "没填")
    print("Relayer 凭据:", "已填" if values.get("RELAYER_API_KEY") else "没填")


def main() -> int:
    parser = argparse.ArgumentParser(description="Put one account on its engine box (values typed hidden).")
    parser.add_argument("box", choices=BOXES)
    parser.add_argument("--replace", action="store_true", help="overwrite the account already on the box")
    args = parser.parse_args()
    values = {}
    for name, prompt, hidden in PROMPTS:
        values[name] = (getpass.getpass(prompt + ": ") if hidden else input(prompt + ": ")).strip()
    problems = validate(values)
    if problems:
        print("没有写入，下面这些要改：\n  " + "\n  ".join(problems))
        return 2
    print_summary(values)
    if input(f"写到 {args.box}？输入 yes 确认: ").strip() != "yes":
        print("没有写入")
        return 1
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", args.box, remote_command(args.replace)],
                          input=env_text(values), capture_output=True, text=True)
    if done.returncode:
        print("写入失败:", (done.stderr or "").strip()[-200:])
        return 1
    print("已写入", args.box, "（权限、大小）", done.stdout.strip())
    print("下一步：重启这台的代理（systemctl restart pm-agent），控制台里看账户检查是否通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
