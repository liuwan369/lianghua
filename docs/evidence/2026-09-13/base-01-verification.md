# BASE-01 Verification Foundation

Date: 2026-09-13 (Asia/Shanghai). Status: REVIEW. The runner and dependency
foundation are implemented and locally checked; independent review is pending.
The latest full run correctly reports an engine build failure in concurrent
EXEC-01 work, so the current integrated checkout is not marked passed.

## Reproduce

Use Python 3.11+ and Node.js 24+. From the checkout root, install dependencies once:

```text
python -m pip install -r requirements-dev.lock
npm --prefix _external/btc-5m-market-trading-bot ci --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
```

Run every Python test, engine test/build, and frontend test/build with one command:

```text
python scripts/verify-project.py
```

The runner uses its own file location to find the checkout, including when invoked
from another directory. On Windows it explicitly resolves `npm.cmd`, avoiding the
PowerShell-only npm wrapper. It does not launch the trading CLI or services.
The test suites use their existing mock/fixture inputs; dependency installation
needs package-registry access, while CI provides no trading credentials.

Each run creates a unique directory under ignored `.planning/tmp/verification/`.
It contains a continuously updated `manifest.json` and one combined stdout/stderr
log for each command. The manifest includes UTC timestamps, command/cwd, status,
exit code, elapsed time, log hashes, Python/Node/npm versions, platform, Git SHA,
dependency/input hashes, and a separate Git working-tree status log. A dirty
checkout is recorded and is not represented as an exact commit-only build.

The default deadline is 600 seconds per test/build and 30 seconds per metadata
command. `--timeout 900` changes the command deadline (range: 1 to 3600 seconds).
`--evidence-dir PATH` changes the parent output directory. Failed checks do not
hide the other results. Timeouts and interrupts terminate the command process
tree; interruption or a cleanup failure leaves remaining checks `not_run`.
An unfinished run remains `running` in its manifest and is not a passed result.
Any failure, missing tool, interruption, or unsupported runtime exits nonzero.

## Dependency Scope

`pyproject.toml` declares the two Python runtime dependencies, a pytest development
extra, an exact setuptools build backend, and explicit discovery of `pm_maker`.
Dashboard and collector scripts still run from the source checkout because they
use repository-relative resources; they are not advertised as installed commands.

`requirements-dev.lock` pins the complete currently selected runtime, test, and
build dependency closure for Python 3.11+. The Windows-only pytest dependency uses
a platform marker. Install this file in a clean virtual environment to reproduce
Python dependencies. Installing `.[dev]` alone pins direct requirements but does
not pin transitive dependencies. Both JavaScript projects retain their existing
`package-lock.json` and use `npm ci`.

This Python lock is a version lock, not a wheel-hash or OS-image lock. It does not
pin pip, the Python patch release, Node patch release, operating-system libraries,
or packages already installed outside a clean environment. It does not promise
bit-for-bit builds. For an update, resolve `.[dev]` in a clean Python environment,
record the complete required package closure and platform markers in the lock,
compare it with project metadata, and rerun the Linux/Windows CI matrix. Record
the new versions and test result before updating a deployed environment.

## CI

`.github/workflows/verify.yml` runs the same command on Linux and Windows with
Python 3.11 and Node 24. It installs the Python lock and runs `npm ci` for each
JavaScript root, with a 25-minute job limit and evidence upload even on failure.
Remote CI is only verified after that workflow actually runs on the remote;
writing the workflow is not evidence of a successful remote run.

## Results

Source HEAD: `fa31afcd2e38245cb7af517132c693688ae0613f`; working tree dirty.
Runtime: Windows 10 build 19045, Python 3.14.2, Node v24.13.0, npm 11.6.2.
Existing user frontend changes were included and preserved. No server or trading
operation was executed by BASE-01, and no files were staged or committed.

| Check | First full run | Latest full run |
| --- | --- | --- |
| Python tests | 254 passed, 1 skipped | 272 passed, 1 skipped |
| Engine tests | 230 passed / 23 files | 230 passed / 23 files |
| Engine build | passed | failed, exit 2 |
| Frontend tests | 49 passed / 7 files | 49 passed / 7 files |
| Frontend build | passed | passed |
| Runner exit | 0 | 1 |

First run command: `python scripts/verify-project.py`.
Evidence: `.planning/tmp/verification/20260912T181715Z-20f34236/manifest.json`.
This ran before the new concurrent risk-store implementation entered the build.

Latest run command:
`.planning/tmp/base-01-venv/Scripts/python.exe scripts/verify-project.py`.
Evidence: `.planning/tmp/verification/20260912T182153Z-229208ba/manifest.json`.
It used a fresh Python virtual environment installed from `requirements-dev.lock`.
Concurrent work added Python regression tests between the two runs, accounting
for the higher latest count.

The latest failure is in `_external/btc-5m-market-trading-bot/src/risk-store.ts:152`:
`TS2322: Type 'number | undefined' is not assignable to type 'number'`.
That file belongs to concurrent execution work and was not edited by BASE-01.
That historical run continued the frontend checks, saved all logs, and exited
nonzero as intended. The failure was not waived; it was fixed before the
superseding integrated run below.

The Python skip is the existing `production persistence is Linux-only` marker
in `tests/test_dashboard_account.py`. Linux CI must cover that test; Windows
success is not evidence that Linux production persistence was verified.

Additional completed checks:

- A clean virtual environment was created with `python -m venv
  .planning/tmp/base-01-venv`; installing `-r requirements-dev.lock` succeeded.
  Its `python -m pip check` reported no broken requirements. Its standalone
  `python -m pytest -q` also returned 254 passed and 1 skipped.
- `python -m pip wheel --no-deps --no-build-isolation --wheel-dir
  .planning/tmp/base-01-wheels .planning/tmp/base-01-package-source` succeeded
  against a source copy containing only `pyproject.toml` and `pm_maker`.
  The resulting `pm_btc5m_system-0.1.0-py3-none-any.whl` contains only the four
  expected `pm_maker` modules and package metadata; metadata matches runtime
  dependencies and the development extra.
- `npm.cmd --prefix web ci --dry-run --ignore-scripts --no-audit --no-fund`
  and the same command for the engine root both passed. Existing shared
  `node_modules` were not reinstalled during concurrent work. Actual clean
  `npm ci` installation is configured in CI but has not run remotely yet.
- Direct runner checks exercised a successful command, exit code 7, a missing
  executable, and a one-second timeout with a spawned child process. Status,
  exit code, completion timestamp and log hash were checked. The delayed child
  did not create its sentinel after timeout, confirming Windows process-tree
  cleanup. Timeout values 0 and 3601 were rejected.
- `git diff --check` passed; existing Git CRLF conversion warnings remain.

Independent review of BASE-01 and DATA-01 found and the data helper fixes addressed
three evidence-transfer issues; the EXEC-01 review found and the Windows
checkpoint fix addressed one P1 portability issue. Linux execution, Python 3.11
execution, remote CI, clean npm installation, deployment, and live trading remain
unverified. The current
runner records dirty filenames and dependency/input hashes, not a full archived
source snapshot; reproducible release evidence should run on a frozen commit.

## Superseding integrated run

The execution owner fixed the type mismatch and the integrated runner was rerun
with `python scripts/verify-project.py --timeout 900`. That run completed with
Python 272 passed/1 skipped, engine tests and build passed, frontend tests and
build passed, and exit code 0. Evidence:
`.planning/tmp/verification/20260912T185804Z-a0da2d39/manifest.json`.
