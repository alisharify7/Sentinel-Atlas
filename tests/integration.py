"""Opt-in integration check: disposable official Redis and PostgreSQL containers.

Run: python tests/integration.py
Requires Docker. Creates only loopback port mappings and removes its containers.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import uuid
from unittest.mock import patch
import psycopg

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import create_app
from database import AccountStore
from demo import DemoMonitor
from direct_monitor import DirectMonitor
from settings import Settings


def docker(*args, stdin=None):
    result=subprocess.run(['docker',*args],input=stdin,capture_output=True,text=True,timeout=120)
    if result.returncode:
        raise RuntimeError('Docker integration command failed; check Docker and the official image downloads.')
    return result.stdout.strip()


def wait_ready(check):
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        try:
            if check(): return
        except Exception:
            pass
        time.sleep(.3)
    raise RuntimeError('Test service did not become ready.')


suffix=uuid.uuid4().hex[:10]
pg,cache='atlas-test-pg-'+suffix,'atlas-test-redis-'+suffix
replica,sentinel='atlas-test-replica-'+suffix,'atlas-test-sentinel-'+suffix
password=secrets.token_urlsafe(24)
created=[]
try:
    docker('run','--rm','-d','--name',pg,'-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_USER=atlas','-e','POSTGRES_DB=atlas',
        '-p','127.0.0.1::5432','postgres:17-alpine')
    created.append(pg)
    docker('run','--rm','-d','--name',cache,'-p','127.0.0.1::6379','redis:7-alpine','redis-server',
        '--requirepass',password,'--save','','--appendonly','no')
    created.append(cache)
    port_pg=docker('port',pg,'5432/tcp').rsplit(':',1)[1]
    port_redis=docker('port',cache,'6379/tcp').rsplit(':',1)[1]
    wait_ready(lambda:docker('exec',pg,'pg_isready','-U','atlas') and True)
    url=f'postgresql+psycopg://atlas:{password}@127.0.0.1:{port_pg}/atlas'
    def postgres_ready():
        with psycopg.connect(host='127.0.0.1',port=port_pg,dbname='atlas',user='atlas',password=password,connect_timeout=2):
            return True
    wait_ready(postgres_ready)
    store=AccountStore(url)
    try:
        store.bootstrap('integration-admin','integration-password')
        assert store.authenticate('integration-admin','integration-password','integration')[0]
    finally: store.engine.dispose()
    app=create_app(DemoMonitor(),{'TESTING':True,'DATABASE_URL':url,'SECRET_KEY':'integration-only-key-'*3,
                                 'DEFAULT_ACCOUNT':'ignored','DEFAULT_PASSWORD':None})
    try:
        client=app.test_client()
        assert client.get('/api/cluster').status_code==401
        client.get('/login')
        with client.session_transaction() as state: csrf=state['csrf']
        assert client.post('/login',data={'username':'integration-admin','password':'integration-password','csrf_token':csrf}).status_code==302
        assert client.get('/api/cluster').status_code==200
        with client.session_transaction() as state: csrf=state['csrf']
        assert client.post('/logout',data={'csrf_token':csrf}).status_code==302
        assert client.get('/api/cluster').status_code==401
    finally:app.extensions['accounts'].engine.dispose()
    print('PostgreSQL: account persistence, login, API protection, and logout passed.',flush=True)
    with patch.dict(os.environ,{'REDIS_URL':f'redis://:{password}@127.0.0.1:{port_redis}/0'},clear=True):
        monitor=DirectMonitor(Settings(backend='direct'))
        try:
            wait_ready(lambda: (monitor.poll_once() or monitor.snapshot()['status']=='healthy'))
            snapshot=monitor.snapshot()
            assert snapshot['summary']['redis_up']==1 and snapshot['summary']['sentinel_total']==0
            assert snapshot['nodes'][0]['redis']['role']=='master'
            assert password not in json.dumps(snapshot)
        finally:monitor.stop()
    print('Standalone Redis: authenticated direct monitoring, metrics, and credential filtering passed.',flush=True)
    master_ip=docker('inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',cache)
    docker('run','--rm','-d','--name',replica,'-p','127.0.0.1::6379','redis:7-alpine','redis-server',
        '--requirepass',password,'--masterauth',password,'--replicaof',master_ip,'6379','--save','','--appendonly','no')
    created.append(replica)
    replica_ip=docker('inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',replica)
    replica_port=docker('port',replica,'6379/tcp').rsplit(':',1)[1]
    docker('run','--rm','-d','--name',sentinel,'-p','127.0.0.1::26379','redis:7-alpine','sleep','300')
    created.append(sentinel)
    sentinel_port=docker('port',sentinel,'26379/tcp').rsplit(':',1)[1]
    config=f'port 26379\nbind 0.0.0.0\nprotected-mode no\nrequirepass {password}\nsentinel monitor redis-main {master_ip} 6379 1\nsentinel auth-pass redis-main {password}\n'
    docker('exec','-i',sentinel,'sh','-c','cat > /tmp/atlas-sentinel.conf',stdin=config)
    docker('exec','-d',sentinel,'redis-server','/tmp/atlas-sentinel.conf','--sentinel')
    with tempfile.TemporaryDirectory() as folder:
        path=Path(folder)/'targets.json'
        path.write_text(json.dumps({'nodes':[
            {'name':'primary','cluster':'redis-main','url_env':'PRIMARY_URL','sentinel_url_env':'SENTINEL_URL','advertise_address':master_ip,'advertise_port':6379},
            {'name':'replica','cluster':'redis-main','url_env':'REPLICA_URL','advertise_address':replica_ip,'advertise_port':6379}]}))
        connections={'PRIMARY_URL':f'redis://:{password}@127.0.0.1:{port_redis}/0',
            'REPLICA_URL':f'redis://:{password}@127.0.0.1:{replica_port}/0',
            'SENTINEL_URL':f'redis://:{password}@127.0.0.1:{sentinel_port}/0'}
        with patch.dict(os.environ,connections):
            monitor=DirectMonitor(Settings(backend='direct',targets=path))
            try:
                try:
                    wait_ready(lambda:(monitor.poll_once() or monitor.snapshot()['status']=='healthy'))
                except RuntimeError:
                    try:
                        monitor.collect()
                    except Exception as error:
                        print(type(error).__name__+': '+str(error).replace(password,'[REDACTED]'),flush=True)
                    print(json.dumps({'status':monitor.snapshot()['status'],'nodes':[
                        {'metadata':n['metadata'],'redis':n['redis'],'sentinel':n['sentinel']} for n in monitor.snapshot()['nodes']]}),flush=True)
                    raise
                snapshot=monitor.snapshot()
                assert snapshot['master']=='primary'
                assert snapshot['summary']['replicas']==1 and snapshot['summary']['consensus']
                assert password not in json.dumps(snapshot)
            finally:monitor.stop()
    print('Redis replication + Sentinel: live roles, quorum, authentication, and NAT endpoint matching passed.',flush=True)
finally:
    for name in reversed(created):
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
    print('Temporary integration containers removed.',flush=True)
