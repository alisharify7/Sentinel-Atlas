import json
import os
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

import redis

from direct_monitor import DirectMonitor
from settings import Settings
from remote_probe import probe


class FakeRedis:
    def __init__(self,host='localhost',port=6379,**kwargs):
        self.host,self.port=host,port
    def info(self): return {'redis_version':'7.4.0','role':'master','used_memory':1234,'connected_clients':2}
    def config_get(self,*args): return {'dir':'/data','logfile':''}
    def close(self): pass


class DirectTests(unittest.TestCase):
    def test_sentinel_uses_raw_responses_instead_of_boolean_convenience_methods(self):
        class SentinelRedis(FakeRedis):
            def execute_command(self,*args):
                if args[1]=='MASTER':return ['ip','localhost','port','6379','flags','master','quorum','1','num-slaves','0','num-other-sentinels','0']
                return 'OK 1 usable Sentinels. Quorum can be reached'
        with patch.dict(os.environ,{'REDIS_URL':'redis://localhost:6379','SENTINEL_URL':'redis://localhost:26379'},clear=True),patch('direct_monitor.redis.Redis',SentinelRedis):
            monitor=DirectMonitor(Settings(backend='direct'))
            monitor.poll_once()
            self.assertEqual(monitor.snapshot()['status'],'healthy')
            self.assertTrue(monitor.snapshot()['summary']['consensus'])
            monitor.stop()

    def test_standalone_needs_no_ansible_and_keeps_credentials_private(self):
        with patch.dict(os.environ,{'REDIS_URL':'redis://user:secret-value@localhost:6381/0'},clear=True),patch('direct_monitor.redis.Redis',FakeRedis):
            settings=Settings.from_env()
            self.assertEqual(settings.backend,'direct')
            monitor=DirectMonitor(settings)
            monitor.poll_once()
            snapshot=monitor.snapshot()
            self.assertEqual(snapshot['status'],'healthy')
            self.assertEqual(snapshot['summary']['sentinel_total'],0)
            self.assertEqual(snapshot['nodes'][0]['metadata']['redis_port'],6381)
            self.assertEqual(monitor.log_snapshot('redis','redis')['status'],'unsupported')
            self.assertNotIn('secret-value',json.dumps(snapshot))
            monitor.stop()

    def test_independent_standalone_nodes_have_separate_cluster_health(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'targets.yml'
            path.write_text('nodes:\n  - {name: a, cluster: alpha, url: "redis://a:6379"}\n  - {name: b, cluster: beta, url: "redis://b:6379"}\n')
            with patch('direct_monitor.redis.Redis',FakeRedis):
                monitor=DirectMonitor(Settings(backend='direct',targets=path))
                monitor.poll_once()
                self.assertEqual(monitor.snapshot('alpha')['status'],'healthy')
                self.assertEqual(monitor.snapshot('beta')['status'],'healthy')
                self.assertEqual(monitor.snapshot('beta')['master'],'b')
                self.assertFalse(any(event['kind']=='promotion' for event in monitor.events))
                monitor.stop()

    def test_auth_errors_are_down_without_exposing_connection_details(self):
        with patch.dict(os.environ,{'REDIS_URL':'redis://user:private-secret@localhost:6379'},clear=True),patch('direct_monitor.redis.Redis',FakeRedis),patch.object(FakeRedis,'info',side_effect=redis.AuthenticationError('private-secret')):
            monitor=DirectMonitor(Settings(backend='direct'))
            monitor.poll_once()
            snapshot=monitor.snapshot()
            self.assertEqual(snapshot['status'],'offline')
            self.assertEqual(snapshot['nodes'][0]['redis']['error'],'authentication_failed')
            self.assertNotIn('private-secret',json.dumps(snapshot))
            monitor.stop()

    def test_native_host_probe_does_not_use_nspawn(self):
        calls=[]
        def run(args,password=None,timeout=3):
            calls.append(args)
            if 'INFO' in args:return 'redis_version:7.4.0\nrole:master',None
            if 'CONFIG' in args:return 'dir\n/var/lib/redis\nlogfile\n/var/log/redis/redis.log',None
            if 'tail' in ' '.join(args):return 'Ready to accept connections',None
            return '',None
        public={'name':'native','deployment':'host','container':'','cluster':'standalone','redis_member':True,'sentinel_member':False,'redis_port':6379,'storage':[]}
        with patch('remote_probe.run',side_effect=run),patch('remote_probe.hardware',return_value={}),patch('remote_probe.storage',return_value=[]):
            result=probe({'public':public,'redis_password':'private-secret'})
        self.assertTrue(result['redis']['up'])
        self.assertTrue(all('systemd-run' not in args for args in calls))
        self.assertTrue(all('private-secret' not in args for args in calls))
        self.assertEqual(result['logs']['redis']['status'],'ok')
