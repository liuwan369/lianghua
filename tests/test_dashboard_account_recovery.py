"""Read-only retries must not retry writes or expose checker output."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

SPEC = importlib.util.spec_from_file_location('dashboard_recovery_test', Path(__file__).resolve().parents[1]/'scripts/system-dashboard-server.py')
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)
STORE = SERVER.account_store


@pytest.fixture
def endpoints(monkeypatch):
    monkeypatch.setenv('PM_ACCOUNT_RPC_URL', 'https://primary.example.test')
    monkeypatch.setenv('PM_ACCOUNT_RPC_FALLBACK_URL', 'https://secondary.example.test')


def test_timeout_uses_secondary_rpc_and_never_persists(monkeypatch, tmp_path, endpoints):
    calls = []
    def run(*args, **kw):
        calls.append((kw['env']['POLYGON_RPC'], kw['timeout']))
        if len(calls) == 1:
            raise STORE.subprocess.TimeoutExpired('node', kw['timeout'], output='sensitive output')
        return SimpleNamespace(returncode=0, stdout=json.dumps({'checks':[], 'read_only':True}))
    monkeypatch.setattr(STORE.subprocess, 'run', run)
    monkeypatch.setattr(STORE, 'save_profile', lambda *_: pytest.fail('checker must not save'))
    assert STORE.check_account(tmp_path, {})['read_only'] is True
    assert calls == [('https://primary.example.test',25),('https://secondary.example.test',20)]


@pytest.mark.parametrize('second_result',[False,None])
def test_unknown_approvals_retries_but_missing_approvals_are_valid(monkeypatch,tmp_path,endpoints,second_result):
    calls=[]
    def run(*args,**kw):
        calls.append(kw['env']['POLYGON_RPC'])
        return SimpleNamespace(returncode=0,stdout=json.dumps({'checks':[],'approvals_ready':None if len(calls)==1 else second_result}))
    monkeypatch.setattr(STORE.subprocess,'run',run)
    if second_result is None:
        with pytest.raises(STORE.AccountCheckError) as caught: STORE.check_account(tmp_path,{})
        assert caught.value.http_status==503
    else:
        assert STORE.check_account(tmp_path,{})['approvals_ready'] is False
    assert len(calls)==2


@pytest.mark.parametrize('code,status,attempts', [('invalid_account_config',400,1),('account_rpc_failed',503,2)])
def test_structured_failures_have_safe_messages(monkeypatch,tmp_path,endpoints,code,status,attempts):
    calls=[]
    def run(*args, **kw):
        calls.append(kw)
        return SimpleNamespace(returncode=1,stdout=json.dumps({'error_code':code,'error':'sensitive output'}))
    monkeypatch.setattr(STORE.subprocess,'run',run)
    with pytest.raises(STORE.AccountCheckError) as caught: STORE.check_account(tmp_path,{})
    assert caught.value.http_status == status
    assert 'sensitive' not in str(caught.value)
    assert len(calls)==attempts


def test_both_deadlines_expire_as_gateway_timeout(monkeypatch,tmp_path,endpoints):
    def run(*args,**kw): raise STORE.subprocess.TimeoutExpired('node',kw['timeout'],output='sensitive output')
    monkeypatch.setattr(STORE.subprocess,'run',run)
    with pytest.raises(STORE.AccountCheckError) as caught: STORE.check_account(tmp_path,{})
    assert caught.value.http_status==504
    assert caught.value.code=='account_rpc_timeout'
    assert caught.value.retryable
    assert 'sensitive' not in str(caught.value)


def test_concurrent_account_request_is_rejected_without_queueing():
    assert SERVER._account_check_lock.acquire(blocking=False)
    try:
        with pytest.raises(STORE.AccountCheckError) as caught: SERVER.account_action({})
        assert caught.value.http_status == 429
    finally: SERVER._account_check_lock.release()


def test_invalid_save_releases_busy_lock(monkeypatch):
    monkeypatch.setattr(SERVER,'trading_status',lambda **_: {'running':False})
    monkeypatch.setattr(SERVER,'_account_values',lambda:{})
    with pytest.raises(ValueError): SERVER.account_action({},save=True)
    assert SERVER._account_check_lock.acquire(blocking=False)
    SERVER._account_check_lock.release()
