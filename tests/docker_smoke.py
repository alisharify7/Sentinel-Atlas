"""Build/run the real image, verify access and persistence, then clean up."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image',default='sentinel-atlas:local')
parser.add_argument('--skip-build',action='store_true')
parser.add_argument('--postgres',action='store_true',help='Also start and check the Compose PostgreSQL stack.')
args=parser.parse_args()


def docker(*arguments,timeout=120):
    result=subprocess.run(['docker',*arguments],cwd=ROOT,capture_output=True,text=True,timeout=timeout)
    if result.returncode:
        raise RuntimeError('Docker check failed: '+result.stderr[-1500:])
    return result.stdout.strip()


def wait_for(check,seconds=45):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:
            if check():return
        except (OSError,ValueError,urllib.error.URLError):
            pass
        time.sleep(.3)
    raise RuntimeError('Timed out waiting for the runtime image.')


suffix=uuid.uuid4().hex[:10]
network,volume='atlas-smoke-net-'+suffix,'atlas-smoke-data-'+suffix
redis_name='atlas-smoke-redis-'+suffix
names=[]
password,redis_password=secrets.token_urlsafe(24),secrets.token_urlsafe(24)
network_created=volume_created=False
try:
    if not args.skip_build:
        subprocess.run(['docker','build','--target','runtime','-t',args.image,'.'],cwd=ROOT,check=True)
    docker('network','create',network);network_created=True
    docker('volume','create',volume);volume_created=True
    docker('run','--rm','-d','--name',redis_name,'--network',network,'--network-alias','redis',
           'redis:7-alpine','redis-server','--requirepass',redis_password,'--save','','--appendonly','no')
    names.append(redis_name)

    def start(name,bootstrap_password):
        docker('run','--rm','-d','--name',name,'--network',network,'-p','127.0.0.1::5050',
            '--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges:true',
            '-v',volume+':/var/lib/sentinel-atlas','-e','DEFAULT_ACCOUNT=admin','-e','DEFAULT_PASSWORD='+bootstrap_password,
            '-e','REDIS_URL=redis://:'+redis_password+'@redis:6379/0',args.image)
        names.append(name)
        port=docker('port',name,'5050/tcp').rsplit(':',1)[1]
        return 'http://127.0.0.1:'+port

    base=start('atlas-smoke-web-'+suffix,password)
    jar=http.cookiejar.CookieJar()
    client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def request(path,data=None,opener=client):
        payload=urllib.parse.urlencode(data).encode() if data is not None else None
        try:
            with opener.open(base+path,payload,timeout=5) as response:
                return response.status,response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code,error.read().decode()

    wait_for(lambda:request('/healthz')==(200,'{"status":"ok"}\n'))
    assert request('/api/cluster')[0]==401
    assert request('/api/logs/redis/redis')[0]==401
    _,page=request('/login')
    csrf=re.search(r'name="csrf_token" value="([^"]+)"',page).group(1)
    assert request('/login',{'username':'admin','password':password,'csrf_token':csrf})[0]==200
    for asset in ('app.css','app.js','owl.svg'):
        assert request('/static/'+asset)[0]==200
    def redis_ready():
        status,body=request('/api/cluster')
        return status==200 and json.loads(body)['status']=='healthy'
    wait_for(redis_ready)
    snapshot=json.loads(request('/api/cluster')[1])
    assert snapshot['summary']['redis_up']==1
    assert snapshot['summary']['sentinel_total']==0
    assert password not in json.dumps(snapshot) and redis_password not in json.dumps(snapshot)
    assert json.loads(request('/api/logs/redis/redis')[1])['status']=='unsupported'
    _,workspace=request('/')
    csrf=re.search(r'<meta name="csrf-token" content="([^"]+)"',workspace).group(1)
    assert request('/profile',{'action':'profile','username':'admin','display_name':'Docker QA',
        'timezone':'UTC','csrf_token':csrf})[0]==200
    _,sharing=request('/shares',{'action':'create','label':'Persistent Docker view',
        'cluster':snapshot['cluster'],'duration':'permanent','csrf_token':csrf})
    shared_path=re.search(r'data-share-path="([^"]+)"',sharing).group(1)
    public_client=urllib.request.build_opener()
    assert request(shared_path+'/api/cluster',opener=public_client)[0]==200
    assert docker('exec',names[-1],'id','-u')=='10001'
    docker('exec',names[-1],'python','-c',
        'import importlib.util,pathlib; assert importlib.util.find_spec("ansible") is None; '
        'assert not pathlib.Path("/app/.env").exists(); '
        'assert pathlib.Path("/var/lib/sentinel-atlas/atlas.sqlite").is_file(); '
        'assert pathlib.Path("/var/lib/sentinel-atlas/session.key").is_file()')
    print('Runtime image: non-root, read-only filesystem, login, assets, direct Redis, and health check passed.',flush=True)

    # Move the cookie to the replacement port; cookies do not use ports as a scope.
    docker('stop','--time','10',names[-1])
    base=start('atlas-smoke-restart-'+suffix,'different-bootstrap-password')
    wait_for(lambda:request('/healthz')[0]==200)
    assert request('/api/cluster')[0]==200, 'Session key or account database did not persist.'
    assert 'Docker QA' in request('/profile')[1], 'Profile did not persist.'
    assert request(shared_path+'/api/cluster',opener=public_client)[0]==200, 'Viewing link did not persist.'
    anonymous=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    _,page=request('/login',opener=anonymous)
    csrf=re.search(r'name="csrf_token" value="([^"]+)"',page).group(1)
    assert request('/login',{'username':'admin','password':password,'csrf_token':csrf},opener=anonymous)[0]==200
    print('Replacement container: accounts, profiles, viewing links, signing key, sessions, and bootstrap behavior persisted.',flush=True)

    with tempfile.TemporaryDirectory() as folder:
        env_file=Path(folder)/'compose.env'
        env_file.write_text('DEFAULT_ACCOUNT=admin\nDEFAULT_PASSWORD=compose-test-password\nREDIS_URL=redis://redis:6379/0\nATLAS_POSTGRES_PASSWORD=test-db-password\nDATABASE_URL=postgresql+psycopg://atlas:test-db-password@postgres:5432/atlas\n')
        environment=dict(os.environ,ATLAS_ENV_FILE=str(env_file),ATLAS_IMAGE=args.image)
        for files in (['compose.yaml'],['compose.yaml','examples/compose.postgres.yaml'],['compose.image.yaml']):
            command=['docker','compose','--env-file',str(env_file)]
            for path in files:command+=['-f',path]
            subprocess.run(command+['config','--quiet'],cwd=ROOT,env=environment,check=True)
    print('Compose: source-build, prebuilt-image, and PostgreSQL configurations validated.',flush=True)
    if args.postgres:
        with tempfile.TemporaryDirectory() as folder:
            env_file=Path(folder)/'compose.env'
            env_file.write_text('DEFAULT_ACCOUNT=admin\nDEFAULT_PASSWORD=compose-test-password\nREDIS_URL=redis://redis:6379/0\n')
            overlay=Path(folder)/'redis.json'
            overlay.write_text(json.dumps({'services':{'atlas':{'image':args.image},
                'redis':{'image':'redis:7-alpine','command':['redis-server','--save','','--appendonly','no']}}}))
            environment=dict(os.environ,ATLAS_ENV_FILE=str(env_file),ATLAS_PORT='0',ATLAS_BIND_ADDRESS='127.0.0.1',
                ATLAS_POSTGRES_PASSWORD='compose-db-password',DATABASE_URL='postgresql+psycopg://atlas:compose-db-password@postgres:5432/atlas')
            command=['docker','compose','--project-name','atlas-smoke-pg-'+suffix,'--env-file',str(env_file),
                '-f','compose.yaml','-f','examples/compose.postgres.yaml','-f',str(overlay)]
            try:
                subprocess.run(command+['up','-d','--no-build'],cwd=ROOT,env=environment,check=True,capture_output=True,text=True,timeout=120)
                result=subprocess.run(command+['port','atlas','5050'],cwd=ROOT,env=environment,check=True,capture_output=True,text=True)
                base='http://'+result.stdout.strip()
                pg_client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                wait_for(lambda:request('/healthz',opener=pg_client)[0]==200)
                _,page=request('/login',opener=pg_client)
                csrf=re.search(r'name="csrf_token" value="([^"]+)"',page).group(1)
                assert request('/login',{'username':'admin','password':'compose-test-password','csrf_token':csrf},opener=pg_client)[0]==200
                wait_for(lambda:json.loads(request('/api/cluster',opener=pg_client)[1])['status']=='healthy')
                result=subprocess.run(command+['exec','-T','postgres','psql','-U','atlas','-d','atlas','-tAc','select count(*) from users'],
                    cwd=ROOT,env=environment,check=True,capture_output=True,text=True)
                assert result.stdout.strip()=='1'
                print('Compose PostgreSQL stack: healthy services, persistent database account, login, and Redis monitoring passed.',flush=True)
            finally:
                subprocess.run(command+['down','--volumes','--remove-orphans'],cwd=ROOT,env=environment,
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=60)
finally:
    for name in reversed(names):
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
    if volume_created:
        subprocess.run(['docker','volume','rm',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
    if network_created:
        subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
    print('Docker test containers, network, and volume removed.',flush=True)
