import copy
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from sentinel_atlas import create_app
from sentinel_atlas.monitoring.demo import DemoMonitor
from sentinel_atlas.monitoring.monitor import ClusterState, LiveMonitor, CollectionError, parse_records
from sentinel_atlas.settings import Settings
from sentinel_atlas.monitoring.public_schema import clean_record
from sentinel_atlas.probes.remote_probe import probe, read_logs, redact_log
from sentinel_atlas.paths import PROBE_DIR


def records():
    demo=DemoMonitor()
    snapshot=demo.sample()
    return {n['name']: {'metadata': n['metadata'], 'telemetry': {k:n[k] for k in ('redis','sentinel','hardware','container','storage')}} for n in snapshot['nodes']}


def logged_in_client(monitor):
    app=create_app(monitor, {'TESTING':True,'DATABASE_URL':'sqlite://','SECRET_KEY':'test-secret-'*4,
                           'DEFAULT_ACCOUNT':'admin','DEFAULT_PASSWORD':'test-password'})
    client=app.test_client()
    client.get('/login')
    with client.session_transaction() as session:
        token=session['csrf']
    client.post('/login',data={'username':'admin','password':'test-password','csrf_token':token})
    return client


class StateTests(unittest.TestCase):
    def test_master_follows_live_roles_and_promotion_is_recorded(self):
        demo=DemoMonitor()
        self.assertEqual(demo.sample()['master'],'redis2')
        promoted=demo.sample('failover')
        self.assertEqual(promoted['master'],'redis3')
        self.assertEqual(promoted['status'],'healthy')
        self.assertTrue(any(event['kind']=='promotion' for event in promoted['events']))

    def test_down_master_is_never_crowned_and_last_observation_is_retained(self):
        state=ClusterState()
        data=records()
        state.apply(data,now=100)
        data['redis2'].pop('telemetry')
        data['redis2']['error']='ssh_unreachable'
        state.apply(data,now=105)
        snapshot=state.snapshot()
        self.assertIsNone(snapshot['master'])
        self.assertEqual(snapshot['status'],'degraded')
        node=next(n for n in snapshot['nodes'] if n['name']=='redis2')
        self.assertEqual(node['redis']['role'],'unknown')
        self.assertEqual(node['last_seen'],100)
        self.assertTrue(node['hardware'])
        self.assertTrue(node['stale'])

    def test_collector_failure_invalidates_healthy_snapshot(self):
        state=ClusterState()
        state.apply(records())
        state.apply({},error='Collection timed out.')
        snapshot=state.snapshot()
        self.assertEqual(snapshot['status'],'offline')
        self.assertEqual(snapshot['summary']['redis_up'],0)
        self.assertIsNone(snapshot['master'])
        self.assertEqual(len(snapshot['nodes']),3)

    def test_disagreement_and_broken_replication_are_not_healthy(self):
        for change in ('sentinel','replication','split_brain'):
            with self.subTest(change=change):
                data=records()
                if change=='sentinel': data['redis1']['telemetry']['sentinel']['master_ip']='192.0.2.99'
                elif change=='replication': data['redis1']['telemetry']['redis']['link']='down'
                else: data['redis1']['telemetry']['redis']['role']='master'
                state=ClusterState()
                state.apply(data)
                self.assertEqual(state.snapshot()['status'],'degraded')

    def test_history_and_events_are_bounded(self):
        state=ClusterState()
        data=records()
        for i in range(80):
            data['redis1']['telemetry']['redis']['up']=bool(i%2)
            state.apply(data,now=i)
        self.assertLessEqual(len(state.events),60)
        self.assertEqual(len(state.nodes['redis1']['history']),60)


class BoundaryTests(unittest.TestCase):
    def test_log_api_is_bounded_separate_from_metrics_and_handles_outages(self):
        demo=DemoMonitor()
        client=logged_in_client(demo)
        self.addCleanup(client.application.extensions['accounts'].engine.dispose)
        cluster=client.get('/api/cluster').json
        self.assertTrue(all('logs' not in node for node in cluster['nodes']))
        self.assertNotIn('sample log output',json.dumps(cluster))
        for service in ('redis','sentinel'):
            result=client.get(f'/api/logs/redis2/{service}')
            self.assertEqual(result.status_code,200)
            self.assertEqual(result.json['status'],'ok')
            self.assertTrue(result.json['lines'])
        before=demo.log_snapshot('redis1','redis')
        demo.sample('down')
        after=demo.log_snapshot('redis1','redis')
        self.assertTrue(after['stale'])
        self.assertEqual(after['updated_at'],before['updated_at'])
        self.assertEqual(client.get('/api/logs/redis2/shell').status_code,400)
        self.assertEqual(client.get('/api/logs/unknown/redis').status_code,404)
        data=records()
        data['redis1']['metadata']['sentinel_member']=False
        state=ClusterState()
        state.apply(data)
        self.assertEqual(state.log_snapshot('redis1','sentinel')['status'],'not_configured')

    def test_log_reader_limits_output_redacts_credentials_and_uses_argv(self):
        path='/var/log/redis/log; this-is-not-a-command.log'
        lines='\n'.join(f'{index} Ready to accept connections' for index in range(150))
        lines+='\nAUTH admin secret-one\nmasterauth secret-two\nredis://user:secret-three@localhost:6379\nsecret-four\x1b'
        calls=[]
        def fake(args,password=None,timeout=3):
            calls.append(args)
            return lines,None
        with patch('sentinel_atlas.probes.remote_probe.run',side_effect=fake):
            data=read_logs(['systemd-run'],path,'redis-server',['secret-four'])
        self.assertEqual(calls[0][-5:],['/usr/bin/tail','-c','32768','--',path])
        self.assertEqual(len(data['lines']),120)
        serialized=json.dumps(data)
        for secret in ('secret-one','secret-two','secret-three','secret-four'):
            self.assertNotIn(secret,serialized)
        self.assertNotIn('\x1b',''.join(data['lines']))
        self.assertEqual(read_logs([], '../private-key','redis-server',[])['status'],'unavailable')
        with patch('sentinel_atlas.probes.remote_probe.run',return_value=('journal entry',None)) as journal:
            self.assertEqual(read_logs([], '', 'redis-sentinel',[])['lines'],['journal entry'])
            self.assertEqual(journal.call_args.args[0][-1],'redis-sentinel.service')

    def test_public_log_boundary_discards_extra_fields_and_oversized_lines(self):
        value={'telemetry':{'logs':{'redis':{'status':'ok','source':'file','lines':['x'*2000]*200,'password':'HIDDEN'},
            'shell':{'lines':['HIDDEN']}}}}
        cleaned=clean_record(value)['telemetry']['logs']
        self.assertEqual(list(cleaned),['redis'])
        self.assertEqual(len(cleaned['redis']['lines']),120)
        self.assertEqual(len(cleaned['redis']['lines'][0]),1000)
        self.assertNotIn('HIDDEN',json.dumps(cleaned))

    def test_partial_collection_retains_inventory_on_timeout(self):
        state=LiveMonitor(Settings(Path('/external/inventory.yml')))
        partial={'redis1':records()['redis1']}
        with patch.object(state,'collect',side_effect=CollectionError('Collection timed out.',partial)):
            state.poll_once()
        snapshot=state.snapshot()
        self.assertEqual(snapshot['nodes'][0]['metadata']['address'],'192.168.10.10')
        self.assertEqual(snapshot['status'],'offline')
        self.assertIsNone(snapshot['master'])

    def test_callback_with_real_ansible_retains_public_metadata_and_telemetry(self):
        import os
        if not (Path(sys.executable).parent/'ansible-playbook').exists():
            self.skipTest('Optional Ansible dependencies are not installed.')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'ansible.cfg').write_text('[defaults]\n')
            (root/'inventory.yml').write_text('all:\n  hosts:\n    fixture:\n      ansible_connection: local\n')
            # The intermediate secret result is censored by recent Ansible versions.
            (root/'probe.yml').write_text('''- hosts: all
  gather_facts: false
  tasks:
    - name: Dashboard public metadata
      debug:
        msg:
          dashboard_metadata: {name: fixture, address: 192.0.2.1, redis_password: HIDDEN}
    - name: Dashboard read-only probe
      debug:
        msg: HIDDEN
      no_log: true
    - name: Dashboard public telemetry
      debug:
        msg:
          dashboard_telemetry:
            redis: {up: true, role: master, requirepass: HIDDEN}
''')
            env=dict(os.environ,ANSIBLE_CONFIG=str(root/'ansible.cfg'),ANSIBLE_STDOUT_CALLBACK='dashboard_json',
                ANSIBLE_CALLBACK_PLUGINS=str(PROBE_DIR/'callback_plugins'),ANSIBLE_CALLBACKS_ENABLED='dashboard_json',ANSIBLE_LOG_PATH=os.devnull)
            result=subprocess.run([str(Path(sys.executable).parent/'ansible-playbook'),'-i',str(root/'inventory.yml'),str(root/'probe.yml')],
                env=env,cwd=root,capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0)
            self.assertNotIn('HIDDEN',result.stdout)
            parsed=parse_records(result.stdout)
            self.assertEqual(parsed['fixture']['metadata']['address'],'192.0.2.1')
            self.assertEqual(parsed['fixture']['telemetry']['redis']['role'],'master')

    def test_inventory_credentials_and_extra_fields_are_discarded(self):
        value=records()['redis1']
        for target in (value, value['metadata'], value['telemetry'], value['telemetry']['redis'], value['telemetry']['hardware']):
            target['redis_password']='NEVER-RETURN-THIS'
        clean=clean_record(value)
        self.assertNotIn('NEVER-RETURN-THIS',json.dumps(clean))

    def test_configuration_api_preserves_node_settings_and_redacts_at_public_boundary(self):
        data=records()
        data['redis1']['telemetry']['redis']['configuration'].update({
            'requirepass':'NEVER-RETURN-THIS','masterauth':'REPLICA-SECRET',
            'module.password':'MODULE-SECRET','invalid key':'UNSAFE',
            'nested':{'password':'NESTED-SECRET'},'maxclients':'123'})
        state=ClusterState()
        state.apply(data)
        client=logged_in_client(state)
        self.addCleanup(client.application.extensions['accounts'].engine.dispose)
        snapshot=client.get('/api/cluster').json
        node=next(node for node in snapshot['nodes'] if node['name']=='redis1')
        self.assertEqual(node['redis']['configuration']['maxclients'],'123')
        self.assertEqual(node['redis']['configuration']['requirepass'],'[REDACTED]')
        for secret in ('NEVER-RETURN-THIS','REPLICA-SECRET','MODULE-SECRET','UNSAFE','NESTED-SECRET'):
            self.assertNotIn(secret,json.dumps(snapshot))

    def test_api_and_assets_work_without_external_project(self):
        client=logged_in_client(DemoMonitor())
        self.addCleanup(client.application.extensions['accounts'].engine.dispose)
        for path in ('/','/static/app.css','/static/app.js','/static/observatory.css','/api/cluster'):
            with self.subTest(path=path):
                response=client.get(path)
                self.assertEqual(response.status_code,200)
                self.assertEqual(response.headers['Cache-Control'],'no-store')
                response.close()
        self.assertEqual(client.get('/api/cluster?scenario=failover').json['master'],'redis3')
        with client.session_transaction() as session:
            csrf=session['csrf']
        self.assertEqual(client.post('/api/refresh',headers={'X-CSRF-Token':csrf}).status_code,202)

    def test_probe_does_not_emit_passwords_or_unrequested_config(self):
        public=records()['redis1']['metadata']
        calls=[]
        def fake_run(args,password=None,timeout=3):
            calls.append((args,password))
            if 'INFO' in args:
                return 'redis_version:8.0.2\nrole:master\nused_memory:123\nrequirepass:NEVER-RETURN-THIS',None
            if 'CONFIG' in args:
                return 'dir\n/var/lib/redis\nlogfile\n/var/log/redis/redis-server.log\nrequirepass\nNEVER-RETURN-THIS',None
            if 'CKQUORUM' in args: return 'OK 3 usable Sentinels.',None
            if 'MASTER' in args: return 'ip\n192.168.10.10\nport\n6379\nflags\nmaster',None
            if args[0]=='systemctl': return 'ActiveState=active\nMemoryCurrent=100',None
            return '{}',None
        with patch('sentinel_atlas.probes.remote_probe.run',side_effect=fake_run),patch('sentinel_atlas.probes.remote_probe.hardware',return_value={}),patch('sentinel_atlas.probes.remote_probe.storage',return_value=[]):
            result=probe({'public':public,'redis_password':'NEVER-RETURN-THIS','sentinel_password':'NEVER-RETURN-THIS'})
        self.assertTrue(result['redis']['up'])
        self.assertNotIn('NEVER-RETURN-THIS',json.dumps(result))
        self.assertTrue(any(password=='NEVER-RETURN-THIS' for _,password in calls))
        self.assertTrue(all('NEVER-RETURN-THIS' not in args for args,_ in calls))


if __name__=='__main__':
    unittest.main()
