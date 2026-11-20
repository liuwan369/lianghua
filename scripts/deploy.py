"""Deploy the committed HEAD: the console to Ireland (pm-ire2, 194.87.245.135), the lead relay to Tokyo (pm-tokyo).

  python scripts/deploy.py [ireland|tokyo|all] [--dry-run] [--wait-status]
  python scripts/deploy.py setup-ireland | setup-tokyo    # print the one-time operator commands

Runtime data is never written or deleted: results/, node_modules/ (npm ci only
when package-lock.json changed), .env files, data/. Every file a release
replaces or deletes is first copied to <release dir>/before/; a failed health
check restores it. The remote half is this same file, piped to the server's
python3 (3.11, stdlib only) as `python3 - apply <target> <release dir>`.
"""
import argparse, hashlib, io, json, os, shlex, shutil, subprocess, sys, tarfile, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent   # remote: __file__ is "<stdin>", ROOT unused
E = "backend/engine/"
SITE, IRELAND_IP, TOKYO_IP, NODE = "194-87-245-135.sslip.io", "194.87.245.135", "52.195.223.179", "v24.22.3"
# The retired AWS Lightsail Ireland box's private address (public 3.254.138.119): never deploy there.
RETIRED_IRELAND_PRIVATE = "172.26.1.100"
DEPLOYED_PATHS = ("backend/engine", "frontend/console", "scripts", "config")
TARGETS = {
    "ireland": {"host": "pm-ire2", "root": "/root/pm-system", "releases": "/root/pm-releases",
                "unit": "pm-console.service", "env": "/root/.config/pm-system/console.env",
                "lock": "/root/pm-system/data/dashboard/deployment.lock",   # the console's start lock too
                "sweep": (E + "dist/", E + "scripts/", "frontend/console/", "scripts/", "config/"),
                "system": {"/etc/systemd/system/pm-console.service": "config/pm-console.service",
                           "/etc/nginx/sites-available/pm-console": "config/pm-console-nginx.conf"}},
    "tokyo": {"host": "pm-tokyo", "root": "/root/pm-relay", "releases": "/root/pm-relay-releases",
              "unit": "pm-relay.service", "env": "/root/.config/pm-system/relay.env",
              "lock": "/root/pm-relay-releases/deploy.lock", "sweep": (E + "dist/",),
              "system": {"/etc/systemd/system/pm-relay.service": "config/pm-relay.service"}},
}
PROTECTED_DIRS = {"results", "node_modules", "data", "__pycache__"}
NGINX_SITE, NGINX_AUTH = "/etc/nginx/sites-available/pm-console", "/etc/nginx/pm-console.htpasswd"
NGINX_LINKS = ("/etc/nginx/sites-enabled/pm-console", "/etc/nginx/sites-enabled/default")
CERT = "/etc/letsencrypt/live/%s/fullchain.pem" % SITE
CONSOLE = "http://127.0.0.1:18766"
NODE_BIN = "/usr/local/bin/node"   # Node 24; Debian's /usr/bin/node is 18
HEALTH_PATHS = ("/api/runtime/status", "/api/diagnostics/health", "/console/auto-trade.html")


def ships(name, target):
    """Whether a file of the built tree goes to the target's program directory. Tests stay home."""
    parts = name.split("/")
    if "regress" in parts or "__pycache__" in parts:
        return False
    if name in (E + "package.json", E + "package-lock.json", E + ".release") or name.startswith(E + "dist/"):
        return True
    return target == "ireland" and (name == E + ".env.example" or name.startswith(
        (E + "scripts/", "frontend/console/", "scripts/", "config/")))


def protected(name):
    """Runtime data a sync never deletes or overwrites: results/, node_modules/, data/, .env files."""
    parts = name.split("/")
    base = parts[-1]
    return (bool(PROTECTED_DIRS & set(parts[:-1])) or base == ".env" or base.endswith(".env")
            or (base.startswith(".env.") and base != ".env.example"))


def plan(files, existing, sweep):
    """files, existing: name -> sha256. Returns (names to write, names to delete)."""
    bad = [name for name in files if protected(name)]
    if bad:
        raise ValueError("release would overwrite runtime data: " + ", ".join(bad))
    write = sorted(name for name, digest in files.items() if existing.get(name) != digest)
    delete = sorted(name for name in existing
                    if name not in files and name.startswith(tuple(sweep)) and not protected(name))
    return write, delete


def dirty(root):
    """Uncommitted or untracked changes under the deployed paths (git status lines)."""
    out = subprocess.run(["git", "status", "--porcelain", "--", *DEPLOYED_PATHS], cwd=root,
                         capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line.strip()]


def engine_running(units, pids, status):
    """Why an engine counts as running, or None. status: the console's runtime status, None if unreadable."""
    if units.strip():
        return "active unit " + units.split()[0]
    if pids.strip():
        return "dist/cli/platform.js pid " + " ".join(pids.split())
    if status is not None and status.get("processRunning") is not False:
        return "console says processRunning=%s" % status.get("processRunning")
    return None


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="deploy.py", description="Deploy the committed HEAD: console to Ireland, relay to Tokyo.")
    parser.add_argument("target", nargs="?", default="all", choices=["ireland", "tokyo", "all", "setup-ireland", "setup-tokyo"],
                        help="where to deploy (default all); setup-* only prints the one-time operator commands")
    parser.add_argument("--dry-run", action="store_true", help="build locally and print the remote steps; contact no server")
    parser.add_argument("--wait-status", action="store_true", help="tokyo: wait up to 70 s for a relay_status line with trades sent")
    return parser.parse_args(argv)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---- local: build HEAD, bundle, ship -------------------------------------------------------------

def remove_build(path):
    link = path / E / "node_modules"   # the checkout's real node_modules: drop the link, never walk into it
    if link.is_symlink() or os.path.isjunction(link):
        os.rmdir(link) if link.is_dir() else os.unlink(link)
    if path.exists():
        shutil.rmtree(path)


def build_tree(rev):
    deploy_dir = ROOT / ".deploy"
    deploy_dir.mkdir(exist_ok=True)
    build = deploy_dir / (rev[:7] + "-build")
    for path in sorted(deploy_dir.glob("*-build"), key=lambda p: p.stat().st_mtime)[:-2] + [build]:
        remove_build(path)
    build.mkdir()
    archive = subprocess.run(["git", "archive", rev, *DEPLOYED_PATHS], cwd=ROOT, capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(build, filter="data")
    os.symlink(ROOT / E / "node_modules", build / E / "node_modules", target_is_directory=True)
    subprocess.run([shutil.which("npm.cmd") or "npm", "run", "build"], cwd=build / E, check=True)
    (build / E / ".release").write_text(rev[:7] + "\n")
    return build


def tree(build):
    for directory, dirs, names in os.walk(build):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        for name in names:
            yield Path(directory, name).relative_to(build).as_posix()


def bundle(build, rev, target, path):
    """Write the release tarball (shipped files, unit/nginx sources, manifest.json); return name -> sha256."""
    files = {name: sha(build / name) for name in sorted(tree(build)) if ships(name, target)}
    extra = sorted(set(TARGETS[target]["system"].values()) - set(files))
    missing = [name for name in extra if not (build / name).is_file()]
    if missing:
        raise SystemExit("HEAD has no " + ", ".join(missing) + ": commit it first")
    with tarfile.open(path, "w:gz") as tar:
        for name, data in [*((n, (build / n).read_bytes()) for n in [*files, *extra]),
                           ("manifest.json", json.dumps({"rev": rev, "target": target, "files": files}).encode())]:
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime, info.uname, info.gname = len(data), 0o644, int(time.time()), "root", "root"
            tar.addfile(info, io.BytesIO(data))
    return files



def main(argv):
    args = parse_args(argv)
    if args.target.startswith("setup-"):
        print(SETUP[args.target].strip())
        return 0
    changes = dirty(ROOT)
    if changes and not args.dry_run:
        raise SystemExit("refusing: uncommitted changes in deployed paths (only HEAD ships), commit first:\n  "
                         + "\n  ".join(changes[:20]))
    if changes:
        print("dry run: %d uncommitted change(s) in deployed paths are not shipped; a real deploy would refuse" % len(changes))
    rev = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    build = build_tree(rev)
    for target in (["ireland", "tokyo"] if args.target == "all" else [args.target]):
        t = TARGETS[target]
        release, tarball = "%s/%s-%s" % (t["releases"], rev[:7], stamp), ROOT / ".deploy" / ("%s-%s.tar.gz" % (rev[:7], target))
        files = bundle(build, rev, target, tarball)
        upload = ["ssh", "-o", "BatchMode=yes", t["host"], "mkdir -p -m 700 %s && tar xzf - -C %s" % ((shlex.quote(release),) * 2)]
        remote = ["ssh", "-o", "BatchMode=yes", t["host"], "python3 - apply %s %s%s" % (target, shlex.quote(release), " --wait-status" * args.wait_status)]
        print("%s (%s): HEAD %s, %d program files, .deploy/%s %d KB" % (target, t["host"], rev[:7], len(files), tarball.name, tarball.stat().st_size // 1024))
        if args.dry_run:
            print("  would run: %s < .deploy/%s" % (shlex.join(upload), tarball.name))
            print("  would run: %s < scripts/deploy.py" % shlex.join(remote))
            for step in STEPS[target]:
                print("    - " + step.format(**{**t, "release": release, "sweep": ", ".join(t["sweep"])}))
            continue
        with tarball.open("rb") as stream:
            subprocess.run(upload, stdin=stream, check=True)
        if subprocess.run(remote, input=Path(__file__).read_bytes()).returncode:
            raise SystemExit("%s: deploy failed (output above); release dir %s on %s" % (target, release, t["host"]))
    return 0


STEPS = {"ireland": [
    "need /usr/local/bin/node and {env}; take flock {lock}",
    "refuse if a pm-engine-* scope/service is active, a dist/cli/platform.js process exists, or the console's /api/runtime/status says processRunning != false",
    "diff {release} against {root}; copy replaced and deleted files to {release}/before/",
    "stop pm-console; write changed files; delete unshipped files under {sweep} (never results/, node_modules/, data/, .env)",
    "npm ci --omit=dev only if package-lock.json changed; install pm-console.service; nginx site + link, drop default link, nginx -t, reload (only when nginx, certificate and htpasswd exist)",
    "daemon-reload, enable + restart pm-console; expect 200 from " + ", ".join(HEALTH_PATHS) + " within 30 s, else restore before/ and exit 1"],
  "tokyo": [
    "need /usr/local/bin/node (Node 24) and {env}; take flock {lock}",
    "diff {release} against {root}; copy replaced and deleted files to {release}/before/",
    "stop pm-relay; write dist + package files; delete unshipped files under {sweep}; npm ci --omit=dev if the lock changed or node_modules is missing",
    "install pm-relay.service; daemon-reload, enable + restart; expect active and no relay_error (8 s; --wait-status: a relay_status with sent > 0 within 70 s), else restore before/ and exit 1"]}


# ---- remote half: runs on the server under python3 3.11 ----------------------------------------

def sh(*cmd, check=True, cwd=None):
    env = {**os.environ, "PATH": "/usr/local/bin:" + os.environ.get("PATH", "/usr/bin:/bin")}   # Node 24 before Debian's
    done = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, env=env)
    if check and done.returncode:
        raise RuntimeError("%s failed (%d): %s" % (" ".join(cmd), done.returncode, (done.stderr or done.stdout)[-800:].strip()))
    return done.stdout


def fetch(path):
    import urllib.request
    with urllib.request.urlopen(CONSOLE + path, timeout=5) as response:
        return response.status, response.read()


def console_status():
    try:
        return json.loads(fetch("/api/runtime/status")[1])
    except Exception as error:
        if isinstance(getattr(error, "reason", error), ConnectionRefusedError):
            return None   # console down (first deploy): the unit and process checks still apply
        return {"processRunning": "unreadable (%s)" % type(error).__name__}


def put(source, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_name(dest.name + ".deploy-tmp")
    shutil.copyfile(source, temporary)
    os.chmod(temporary, 0o644)
    os.replace(temporary, dest)


def installed(root, names, sweep):
    found = {name for name in names if (root / name).is_file()}
    for prefix in sweep:
        for directory, dirs, files in os.walk(root / prefix):
            dirs[:] = [d for d in dirs if d not in PROTECTED_DIRS]
            found.update(Path(directory, f).relative_to(root).as_posix() for f in files)
    return {name: sha(root / name) for name in found if (root / name).is_file() and not (root / name).is_symlink()}


def nginx_ready():
    missing = [what for what, ok in (("nginx", shutil.which("nginx")), (CERT, Path(CERT).is_file()),
                                     (NGINX_AUTH, Path(NGINX_AUTH).is_file())) if not ok]
    if missing:
        print("nginx: not touched, missing " + ", ".join(missing) + " (see python scripts/deploy.py setup-ireland)", flush=True)
    return not missing


def check_console():
    deadline, last = time.time() + 30, None
    while time.time() < deadline:
        time.sleep(1)
        try:
            codes = [fetch(path)[0] for path in HEALTH_PATHS]
            running = json.loads(fetch("/api/runtime/status")[1]).get("processRunning")
        except Exception as error:
            last = error
            continue
        if running is not False:
            raise RuntimeError("processRunning=%s after restart" % running)
        if codes == [200] * len(codes):
            return "console 200 on " + ", ".join(HEALTH_PATHS)
        last = codes
    raise RuntimeError("console not healthy within 30 s: %s" % last)


def check_relay(since, wait_status):
    limit = 70 if wait_status else 8
    while True:
        time.sleep(2)
        active = sh("systemctl", "is-active", "pm-relay.service", check=False).strip()
        lines = sh("journalctl", "-u", "pm-relay.service", "--since", "@%d" % since, "-o", "cat", "--no-pager", check=False).splitlines()
        errors = [line for line in lines if '"relay_error"' in line]
        if errors:
            raise RuntimeError("relay: " + errors[-1][:300])
        statuses = [json.loads(line) for line in lines if line.startswith('{"kind":"relay_status"')]
        sent = sum(statuses[-1]["sent"].values()) if statuses else 0
        over = time.time() - since >= limit
        if active == "active" and (sent > 0 if wait_status else over):
            return "pm-relay active, " + ("%d trades sent in the last status line" % sent if statuses else "no relay_error")
        if over:
            raise RuntimeError("relay %s, %s after %d s" % (active, "sent=%d" % sent if statuses else "no relay_status", limit))


def apply(target, release, wait_status):
    import fcntl
    t, release = TARGETS[target], Path(release)
    root, unit, before = Path(t["root"]), t["unit"], release / "before"
    manifest = json.loads((release / "manifest.json").read_text())
    for need in (NODE_BIN, t["env"]):
        if not Path(need).is_file():
            raise SystemExit("%s is missing: run the one-time steps of `python scripts/deploy.py setup-%s`" % (need, target))
    Path(t["lock"]).parent.mkdir(parents=True, exist_ok=True)
    lock = open(t["lock"], "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("refusing: another deploy or an engine start holds " + t["lock"])
    if target == "ireland":
        # The retired Lightsail box (3.254.138.119) must never get a release again (user 2026-11-20).
        here = sh("hostname", "-I", check=False).split() + [sh("hostname", check=False).strip()]
        if RETIRED_IRELAND_PRIVATE in " ".join(here) or not any(ip == IRELAND_IP for ip in here):
            raise SystemExit("refusing: this is not the Ireland box %s (got %s); the old Lightsail box is retired" % (IRELAND_IP, " ".join(here)))
        why = engine_running(sh("systemctl", "list-units", "--type=scope,service", "--state=active", "--no-legend", "pm-engine-*"),
                             sh("pgrep", "-f", "dist/cli/platform.js", check=False), console_status())
        if why:
            raise SystemExit("refusing: engine may be running (%s); stop trading in the console first "
                             "(a broken console with no engine: systemctl stop pm-console, then deploy)" % why)
    existing = installed(root, manifest["files"], t["sweep"])
    write, delete = plan(manifest["files"], existing, t["sweep"])
    lockfile = E + "package-lock.json"
    npm = existing.get(lockfile) != manifest["files"][lockfile] or not (root / E / "node_modules").is_dir()
    system = {dest: src for dest, src in t["system"].items() if dest != NGINX_SITE or nginx_ready()}
    links = list(NGINX_LINKS) if NGINX_SITE in system else []
    state = {"created": [n for n in write if n not in existing], "npm": npm,
             "was_active": sh("systemctl", "is-active", unit, check=False).strip() == "active",
             "system": {dest: Path(dest).is_file() for dest in system},
             "links": {link: os.readlink(link) if os.path.islink(link) else None for link in links}}
    for name in [n for n in write if n in existing] + delete:
        put(root / name, before / name)
    for dest, existed in state["system"].items():
        if existed:
            put(Path(dest), before / "_system" / Path(dest).name)
    (release / "before.json").write_text(json.dumps(state, indent=1))
    print("%s: %d to write, %d to delete, npm ci %s; previous files in %s" % (
        target, len(write), len(delete), "yes" if npm else "no", before), flush=True)
    try:
        sh("systemctl", "stop", unit, check=False)
        for name in write:
            put(release / name, root / name)
        for name in delete:
            (root / name).unlink()
        if npm:
            sh("npm", "ci", "--omit=dev", "--no-audit", "--no-fund", cwd=root / E)
        for dest, src in system.items():
            put(release / src, Path(dest))
        for link in links:
            Path(link).unlink(missing_ok=True)
        if links:
            Path(links[0]).symlink_to(NGINX_SITE)
            sh("nginx", "-t")
            sh("systemctl", "reload-or-restart", "nginx")
        sh("systemctl", "daemon-reload")
        sh("systemctl", "enable", unit)
        started = time.time()
        sh("systemctl", "restart", unit)
        result = check_console() if target == "ireland" else check_relay(started, wait_status)
    except Exception as error:
        print("FAILED: %s; rolling back" % error, flush=True)
        rollback(root, before, state, unit)
        raise SystemExit("%s: rolled back to the previous program files" % target)
    (release / "result.json").write_text(json.dumps({"rev": manifest["rev"], "written": write, "deleted": delete,
                                                      "npm": npm, "nginx": bool(links), "check": result}, indent=1))
    print("%s OK: HEAD %s live in %s; %d written, %d deleted, npm ci %s, nginx %s; %s" % (
        target, manifest["rev"][:7], root, len(write), len(delete), "ran" if npm else "skipped",
        "reloaded" if links else "untouched", result), flush=True)


def rollback(root, before, state, unit):
    sh("systemctl", "stop", unit, check=False)
    if not state["system"].get("/etc/systemd/system/" + unit):
        sh("systemctl", "disable", unit, check=False)   # first install: leave no enabled link behind
    for name in state["created"]:
        (root / name).unlink(missing_ok=True)
    for path in before.rglob("*"):
        if path.is_file() and path.relative_to(before).parts[0] != "_system":
            put(path, root / path.relative_to(before))
    if state["npm"]:
        sh("npm", "ci", "--omit=dev", "--no-audit", "--no-fund", cwd=root / E, check=False)
    for dest, existed in state["system"].items():
        put(before / "_system" / Path(dest).name, Path(dest)) if existed else Path(dest).unlink(missing_ok=True)
    for link, old in state["links"].items():
        Path(link).unlink(missing_ok=True)
        if old:
            Path(link).symlink_to(old)
    if state["links"] and not subprocess.run(["nginx", "-t"], capture_output=True).returncode:
        sh("systemctl", "reload-or-restart", "nginx", check=False)
    sh("systemctl", "daemon-reload", check=False)
    if state["was_active"]:
        sh("systemctl", "restart", unit, check=False)



SETUP = {"setup-ireland": """
# One-time Ireland setup (pm-ire2). Run these yourself; nothing below prints a secret.
# 1. Firewall on pm-ire2 (ufw; keep SSH 22 as it is):
#      HTTPS 443/tcp   any IP           console
#      HTTP   80/tcp   any IP           certificate issue/renewal, redirects to 443
#      Custom 47001/tcp + 47001/udp     restricted to %(tokyo)s/32 only (Tokyo relay)
# 2. Packages, nginx password, certificate (port 80 must already be open):
ssh pm-ire2 'apt-get update && apt-get install -y nginx certbot python3-certbot-nginx apache2-utils'
ssh -t pm-ire2 'htpasswd -B -c /etc/nginx/pm-console.htpasswd <user> && chown root:www-data /etc/nginx/pm-console.htpasswd && chmod 640 /etc/nginx/pm-console.htpasswd'
ssh -t pm-ire2 'certbot certonly --nginx -d %(site)s'
# 3. Relay key (32 random bytes as hex, mode 600; it never leaves the two servers):
ssh pm-ire2 'install -d -m 700 /root/.config/pm-system && (umask 077; openssl rand -hex 32 > /root/.config/pm-system/relay.key) && chmod 600 /root/.config/pm-system/relay.key'
# 4. Console environment: write /root/.config/pm-system/console.env (mode 600) with an editor:
ssh -t pm-ire2 'f=/root/.config/pm-system/console.env; [ -e $f ] || install -m 600 /dev/null $f; ${EDITOR:-nano} $f'
#      PM_TRADING_LIVE_UNLOCK=<1 to allow live starts, else 0>
#      PM_TRUST_ACCOUNT_PROXY=1
#      PM_ACCOUNT_PUBLIC_ORIGIN=https://%(site)s
#      PM_ACCOUNT_RPC_URL=<polygon rpc url>
#      PM_ACCOUNT_RPC_FALLBACK_URL=<second polygon rpc url>
#      PM_RELAY_KEY_FILE=/root/.config/pm-system/relay.key
#      PM_RELAY_PORT=47001
#      PM_RELAY_ALLOW_IP=%(tokyo)s
#    The account profile stays /root/.config/pm-system/account.json (mode 600).
# 5. Deploy: installs pm-console and the nginx site, removes the default site link.
python scripts/deploy.py ireland
""", "setup-tokyo": """
# One-time Tokyo setup (pm-tokyo). Needs setup-ireland step 3 (the relay key) first.
# 1. Node %(node)s into /usr/local (Debian's node 18 at /usr/bin/node stays unused):
ssh pm-tokyo 'set -e; cd /tmp; curl -fsSLO https://nodejs.org/dist/%(node)s/node-%(node)s-linux-x64.tar.xz; curl -fsSLO https://nodejs.org/dist/%(node)s/SHASUMS256.txt; grep " node-%(node)s-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -; tar -xJf node-%(node)s-linux-x64.tar.xz -C /usr/local --strip-components=1 --no-same-owner --exclude="*/CHANGELOG.md" --exclude="*/LICENSE" --exclude="*/README.md"; rm node-%(node)s-linux-x64.tar.xz SHASUMS256.txt; /usr/local/bin/node --version'
# 2. Relay key, copied Ireland -> Tokyo through this machine (never printed):
ssh pm-tokyo 'install -d -m 700 /root/.config/pm-system'
scp -3 pm-ire2:/root/.config/pm-system/relay.key pm-tokyo:/root/.config/pm-system/relay.key
ssh pm-tokyo 'chmod 600 /root/.config/pm-system/relay.key'
# 3. Relay environment (no secret in it: the key stays in its file):
ssh pm-tokyo 'umask 077; printf "%%s\\n" PM_RELAY_TARGET_HOST=%(ireland)s PM_RELAY_PORT=47001 PM_RELAY_KEY_FILE=/root/.config/pm-system/relay.key > /root/.config/pm-system/relay.env'
# 4. Tokyo needs no inbound port beyond SSH (the relay only sends).
# 5. Deploy and wait for the first status line with trades sent:
python scripts/deploy.py tokyo --wait-status
"""}
SETUP = {name: text % {"site": SITE, "tokyo": TOKYO_IP, "ireland": IRELAND_IP, "node": NODE} for name, text in SETUP.items()}


if __name__ == "__main__":
    if sys.argv[1:2] == ["apply"]:   # remote half: python3 - apply <target> <release> [--wait-status]
        apply(sys.argv[2], sys.argv[3], "--wait-status" in sys.argv[4:])
    else:
        sys.exit(main(sys.argv[1:]))
