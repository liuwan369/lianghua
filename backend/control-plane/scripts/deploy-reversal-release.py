"""Synchronize a committed program release; never edit trading data or start trading."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import paramiko

if any(argument in {"-h", "--help"} for argument in sys.argv[1:]):
    print("Usage: python scripts/deploy-reversal-release.py\nBuild and deploy the current committed revision; accepts no options.")
    raise SystemExit(0)
if len(sys.argv) != 1:
    raise SystemExit("deploy-reversal-release.py accepts no options; use --help for usage")

ROOT = Path(__file__).resolve().parents[3]
REV = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
RELEASE = "reversal-" + REV[:7] + "-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
ENGINE_ROOT = "backend/engine/"
FRONTEND_ROOT = "frontend/console/"
CONTROL_SCRIPTS_ROOT = "scripts/"
CONTROL_CONFIG_ROOT = "config/"
PROGRAM_PREFIXES = (ENGINE_ROOT + "src/", FRONTEND_ROOT, "backend/control-plane/scripts/", "shared/contracts/")
ENGINE_METADATA = {ENGINE_ROOT + name for name in (".env.example", "README.md", "package.json", "package-lock.json")}
GENERATED_PREFIXES = (ENGINE_ROOT + "dist/",)


def target_name(source: str) -> str | None:
    if source.startswith("backend/control-plane/scripts/"):
        return CONTROL_SCRIPTS_ROOT + source.removeprefix("backend/control-plane/scripts/")
    if source.startswith("backend/control-plane/config/"):
        return CONTROL_CONFIG_ROOT + source.removeprefix("backend/control-plane/config/")
    if source.startswith(ENGINE_ROOT) or source.startswith(FRONTEND_ROOT) or source.startswith("shared/contracts/"):
        return source
    return None


def release_path(name: str) -> bool:
    return (name.startswith(PROGRAM_PREFIXES) or name.startswith(FRONTEND_ROOT)
            or name.startswith("shared/contracts/") or name in ENGINE_METADATA
            or name in {"README.md", "scripts/system-dashboard-server.py",
                        "scripts/dashboard_account.py", "scripts/deploy-reversal-release.py",
                        "config/pm-system-dashboard-dublin.service",
                        "config/pm-clob-market-snapshot.service"})


SOURCES = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines()
CONTENT = {}
for source in sorted(SOURCES):
    name = target_name(source)
    if name is None:
        continue
    CONTENT[name] = subprocess.check_output(["git", "show", REV + ":" + source], cwd=ROOT)
for source in ("README.md", "backend/control-plane/scripts/deploy-reversal-release.py"):
    target = source if source == "README.md" else "scripts/deploy-reversal-release.py"
    CONTENT[target] = subprocess.check_output(["git", "show", REV + ":" + source], cwd=ROOT)
for source in ("backend/control-plane/scripts/system-dashboard-server.py", "backend/control-plane/scripts/dashboard_account.py"):
    CONTENT["scripts/" + Path(source).name] = subprocess.check_output(["git", "show", REV + ":" + source], cwd=ROOT)
# Build the chosen commit in a separate directory: workers may keep editing and
# building their shared checkout while this immutable program is deployed.
BUILD = ROOT / ".deploy" / (RELEASE + "-build")
BUILD.mkdir()
sources = subprocess.check_output(["git", "archive", REV, "backend/engine", "frontend/console", "backend/control-plane", "shared/contracts"], cwd=ROOT)
with tarfile.open(fileobj=io.BytesIO(sources)) as source_archive:
    source_archive.extractall(BUILD, filter="data")
engine_project = BUILD / "backend/engine"
os.symlink(ROOT / "backend/engine" / "node_modules", engine_project / "node_modules", target_is_directory=True)
subprocess.run([shutil.which("npm.cmd") or "npm", "run", "build"], cwd=engine_project, check=True)
for path in (BUILD / "backend/engine/dist").rglob("*"):
    if path.is_file():
        CONTENT[path.relative_to(BUILD).as_posix()] = path.read_bytes()
deleted = subprocess.check_output(
    ["git", "diff", "--diff-filter=D", "--name-only", "1edb1e0", REV], cwd=ROOT, text=True
).splitlines()
REMOVED = sorted(name for source in deleted if (name := target_name(source)) and release_path(name) and name not in CONTENT)
MANIFEST = {"revision": REV, "release": RELEASE,
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in CONTENT.items()},
            "removed": REMOVED, "generatedPrefixes": list(GENERATED_PREFIXES)}
ARCHIVE = ROOT / ".deploy" / (RELEASE + ".tar.gz")
with tarfile.open(ARCHIVE, "w:gz") as bundle:
    for name, data in CONTENT.items():
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = 0o644
        bundle.addfile(info, io.BytesIO(data))

REMOTE_SCRIPT = r'''
from pathlib import Path
import hashlib, json, os, sys, tarfile, urllib.request, subprocess
root=Path('/root/pm-system').resolve()
release=Path(sys.argv[1]).resolve()
manifest=json.loads((release/'manifest.json').read_text())
allowed_prefixes=('backend/engine/','frontend/console/','scripts/','config/','shared/contracts/','docs/')
allowed_exact={'README.md','scripts/system-dashboard-server.py','scripts/dashboard_account.py',
               'scripts/deploy-reversal-release.py','config/pm-system-dashboard-dublin.service',
               'config/pm-clob-market-snapshot.service'}
def checked_target(name):
    if not isinstance(name,str) or name.startswith('/') or name.startswith('\\'):
        raise RuntimeError('Invalid release path')
    target=(root/name).resolve()
    if not target.is_relative_to(root) or not (name.startswith(allowed_prefixes) or name in allowed_exact):
        raise RuntimeError('Release path outside program allowlist: '+name)
    return target
def status():
    try:
        with urllib.request.urlopen('http://127.0.0.1:18766/api/v1/status',timeout=15) as response:
            return json.load(response)
    except urllib.error.URLError as error:
        # The first deployment may not have installed the dashboard unit yet.
        # Only a local connection refusal is treated as an absent service; all
        # other failures remain deployment errors.
        reason=str(getattr(error,'reason',error)).lower()
        if 'connection refused' in reason or '[errno 111]' in reason:
            return {'running':False,'live_unlocked':False,'bootstrap':True}
        raise
def unit_state(unit):
    def query(action):
        completed=subprocess.run(['systemctl', action, unit], capture_output=True, text=True, check=False)
        return completed.stdout.strip() or 'unknown'
    return {'active': query('is-active'), 'enabled': query('is-enabled')}
before=status()
if before.get('running') is not False or type(before.get('live_unlocked')) is not bool:
    raise RuntimeError('Program sync expects stopped trading and unchanged live lock')
changed=[]
unit_names={'config/pm-system-dashboard-dublin.service':'pm-system-dashboard-dublin.service',
            'config/pm-clob-market-snapshot.service':'pm-clob-market-snapshot.service'}
obsolete=set(manifest.get('removed',[]))
retired_units_from_manifest={unit_names[name] for name in obsolete if name in unit_names}
for prefix in manifest.get('generatedPrefixes',[]):
    generated=checked_target(prefix)
    if generated.is_dir():
        for path in generated.rglob('*'):
            if path.is_file():
                name=path.relative_to(root).as_posix()
                if name not in manifest['files']:
                    obsolete.add(name)
obsolete=sorted(name for name in obsolete if checked_target(name).is_file())
with tarfile.open(release/'program.tar.gz','r:gz') as bundle:
    members=bundle.getmembers()
    if {m.name for m in members} != set(manifest['files']) or len(members)!=len(manifest['files']):
        raise RuntimeError('Manifest mismatch')
    for m in members:
        target=checked_target(m.name)
        if not m.isfile():
            raise RuntimeError('Unexpected archive path')
        data=bundle.extractfile(m).read()
        if hashlib.sha256(data).hexdigest()!=manifest['files'][m.name]:
            raise RuntimeError('Upload hash mismatch')
        if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest()!=manifest['files'][m.name]:
            changed.append(m.name)
    missing=[name for name in changed if not (root/name).exists()]
    backup_names=sorted({name for name in changed if name not in missing}|set(obsolete))
    changed_units=[unit_names[name] for name in changed if name in unit_names]
    removed_units=sorted(retired_units_from_manifest | {unit_names[name] for name in obsolete if name in unit_names})
    collector_unit='pm-clob-market-snapshot.service'
    dashboard_unit='pm-system-dashboard-dublin.service'
    collector_changed=collector_unit in changed_units or any(
        name.startswith('backend/engine/dist/') for name in changed+obsolete)
    dashboard_changed=(dashboard_unit in changed_units
                       or any((name.startswith('scripts/') or name.startswith('frontend/console/'))
                              and name.endswith(('.py', '.js', '.html', '.css'))
                              for name in changed+obsolete))
    affected_units=set(changed_units)|set(removed_units)
    if collector_changed:
        affected_units.add(collector_unit)
    if dashboard_changed:
        affected_units.add(dashboard_unit)
    unit_before={unit:unit_state(unit) for unit in affected_units}
    (release/'unit-states-before.json').write_text(json.dumps(unit_before))
    installed_units={}
    for unit in set(changed_units)|set(removed_units):
        path=Path('/etc/systemd/system')/unit
        installed_units[unit]=(path.read_bytes(),path.stat().st_mode & 0o777) if path.is_file() else None
        if installed_units[unit]:
            saved=release/'units-before'/unit
            saved.parent.mkdir(exist_ok=True)
            saved.write_bytes(installed_units[unit][0])
    with tarfile.open(release/'before.tar.gz','w:gz') as backup:
        for name in backup_names:
            backup.add(root/name,arcname=name,recursive=False)
    (release/'missing-before.json').write_text(json.dumps(missing))
    written=[]
    try:
        for name in changed:
            target=checked_target(name)
            target.parent.mkdir(parents=True,exist_ok=True)
            data=bundle.extractfile(name).read()
            temporary=target.with_name(target.name+'.release-next')
            temporary.write_bytes(data)
            temporary.chmod(target.stat().st_mode & 0o777 if target.exists() else 0o644)
            os.replace(temporary,target)
            written.append(name)
        for name in obsolete:
            checked_target(name).unlink()
        for unit in removed_units:
            subprocess.run(['systemctl','stop',unit],check=False)
            subprocess.run(['systemctl','disable',unit],check=False)
            (Path('/etc/systemd/system')/unit).unlink(missing_ok=True)
        if changed_units:
            for unit in changed_units:
                source = root / "config" / unit
                subprocess.run(["install", "-m", "0644", str(source), "/etc/systemd/system/" + unit], check=True)
        if changed_units or removed_units:
            subprocess.run(["systemctl", "daemon-reload"], check=True)
        for unit in removed_units:
            retired=unit_state(unit)
            if ((Path('/etc/systemd/system')/unit).exists()
                    or retired['active'] not in {'inactive','failed','unknown'}
                    or retired['enabled'] in {'enabled','enabled-runtime','linked','linked-runtime'}):
                raise RuntimeError('Retired service remains installed or active: '+unit)
        if collector_changed and (Path('/etc/systemd/system')/collector_unit).is_file():
            if collector_unit in changed_units:
                subprocess.run(['systemctl','enable',collector_unit],check=True)
            if collector_unit in changed_units or unit_before[collector_unit]['active']=='active':
                subprocess.run(['systemctl','restart',collector_unit],check=True)
        mismatches=[name for name,digest in manifest['files'].items()
                    if hashlib.sha256(checked_target(name).read_bytes()).hexdigest()!=digest]
        if mismatches:
            raise RuntimeError('Installed hash mismatch')
        if any(checked_target(name).exists() for name in obsolete):
            raise RuntimeError('Obsolete release files remain')
        # Dashboard and the public collector have independent lifecycles.
        restarted=dashboard_changed or bool(changed_units)
        if restarted:
            subprocess.run(['systemctl','restart',dashboard_unit],check=True)
        import time
        for attempt in range(20):
            try:
                after=status()
                break
            except Exception:
                if attempt==19: raise
                time.sleep(1)
        if after.get('running') is not False or after.get('live_unlocked') is not before['live_unlocked']:
            raise RuntimeError('Unexpected trading state')
    except Exception:
        if collector_changed:
            subprocess.run(['systemctl','stop',collector_unit],check=False)
        for name in written:
            if name in missing:
                checked_target(name).unlink(missing_ok=True)
        with tarfile.open(release/'before.tar.gz') as backup:
            for member in backup.getmembers():
                target=checked_target(member.name)
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(backup.extractfile(member).read())
                target.chmod(member.mode & 0o777)
        for unit, saved in installed_units.items():
            path=Path('/etc/systemd/system')/unit
            if saved is None:
                subprocess.run(['systemctl','disable',unit],check=False)
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(saved[0])
                path.chmod(saved[1])
        if changed_units or removed_units:
            subprocess.run(['systemctl','daemon-reload'], check=False)
        for unit, previous in unit_before.items():
            if unit in installed_units and installed_units[unit] is not None:
                if previous['enabled'] in {'enabled', 'enabled-runtime', 'disabled'}:
                    # Remove both persistent and runtime links created during
                    # the failed release before restoring the exact prior mode.
                    subprocess.run(['systemctl','disable',unit],check=False)
                if previous['enabled']=='enabled-runtime':
                    subprocess.run(['systemctl','enable','--runtime',unit],check=False)
                elif previous['enabled']=='enabled':
                    subprocess.run(['systemctl','enable',unit],check=False)
            action='restart' if previous['active']=='active' else 'stop'
            subprocess.run(['systemctl',action,unit],check=False)
        if any(name.startswith('scripts/') for name in changed+obsolete) and dashboard_unit not in unit_before:
            subprocess.run(['systemctl','restart',dashboard_unit],check=True)
        raise
result={'revision':manifest['revision'],'release':str(release),'files_verified':len(manifest['files']),
        'files_changed':len(changed),'files_removed':len(obsolete),'dashboard_restarted':restarted,
        'status':{k:after.get(k) for k in ('running','mode','execution','strategy_id','live_unlocked')}}
(release/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
'''

client = paramiko.SSHClient()
client.load_system_host_keys()
client.connect("34.242.206.196", username="root", key_filename=str(Path.home()/".ssh/id_ed25519_dublin_pm"), timeout=20)
try:
    directory = "/root/.pm-releases/" + RELEASE
    with client.open_sftp() as sftp:
        sftp.mkdir(directory, mode=0o700)
        sftp.put(str(ARCHIVE), directory + "/program.tar.gz")
        with sftp.open(directory + "/manifest.json", "w") as out:
            out.write(json.dumps(MANIFEST))
        with sftp.open(directory + "/apply.py", "w") as out:
            out.write(REMOTE_SCRIPT)
    lock = "/root/pm-system/data/dashboard/deployment.lock"
    _, stdout, stderr = client.exec_command("mkdir -p /root/pm-system/data/dashboard; flock -n -x " + lock + " python3 " + directory + "/apply.py " + directory, timeout=120)
    output, error = stdout.read().decode(), stderr.read().decode()
    if stdout.channel.recv_exit_status():
        raise RuntimeError(error[:2500] + output[:2500])
    result = json.loads(output)
    result["archive_sha256"] = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    result["manifest"] = MANIFEST
    (ROOT/".deploy"/(RELEASE+"-result.json")).write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({k:v for k,v in result.items() if k!='manifest'}), flush=True)
finally:
    client.close()
