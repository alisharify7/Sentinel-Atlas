import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import redis

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sentinel_atlas import create_app
from sentinel_atlas.monitoring.demo import DemoMonitor
from sentinel_atlas.monitoring.monitor import LiveMonitor
from sentinel_atlas.probes.remote_probe import terminal
from sentinel_atlas.settings import Settings
from sentinel_atlas.terminal import direct_command, format_reply, parse_command


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.monitor = LiveMonitor(Settings(Path('/test/inventory.yml')))
        sample = DemoMonitor().sample()
        self.monitor.apply({node['name']: {'metadata': node['metadata'], 'telemetry': {
            key: node[key] for key in ('redis', 'sentinel', 'hardware', 'storage', 'container')}} for node in sample['nodes']})
        self.monitor.terminal_command = Mock(return_value={'ok': True, 'output': 'OK'})
        self.app = create_app(self.monitor, {'TESTING': True, 'DATABASE_URL': 'sqlite://',
            'SECRET_KEY': 'terminal-test-' * 4, 'DEFAULT_ACCOUNT': 'admin', 'DEFAULT_PASSWORD': 'test-password'})
        self.addCleanup(self.app.extensions['accounts'].engine.dispose)
        self.client = self.app.test_client()

    def login(self, username='admin'):
        self.client.get('/login')
        with self.client.session_transaction() as state:
            csrf = state['csrf']
        self.client.post('/login', data={'username': username, 'password': 'test-password', 'csrf_token': csrf})
        with self.client.session_transaction() as state:
            return state['csrf']

    def post(self, command='PING', database=0, path='/api/terminal/redis1/redis', **kwargs):
        with self.client.session_transaction() as state:
            csrf = state.get('csrf', '')
        return self.client.post(path, json={'command': command, 'database': database},
                                headers={'X-CSRF-Token': csrf}, **kwargs)

    def test_login_csrf_and_admin_are_required(self):
        self.assertEqual(self.post().status_code, 401)
        self.login()
        self.assertEqual(self.client.post('/api/terminal/redis1/redis', json={'command': 'PING'}).status_code, 400)
        self.app.extensions['accounts'].create_user('viewer', 'test-password', False)
        self.client = self.app.test_client()
        self.login('viewer')
        self.assertEqual(self.post().status_code, 403)
        self.assertIn('data-terminal="false"', self.client.get('/instances').text)
        self.monitor.terminal_command.assert_not_called()

    def test_select_changes_database_only_on_success(self):
        self.login()
        result = self.post('SELECT 3', database=1)
        self.assertEqual(result.json, {'ok': True, 'output': 'OK', 'database': 3})
        self.monitor.terminal_command.assert_called_once_with('redis1', 'redis', ['SELECT', '3'], 1)
        self.monitor.terminal_command.return_value = {'ok': False, 'output': '(error) ERR DB index is out of range'}
        self.assertEqual(self.post('SELECT 9999', database=3).json['database'], 3)
        self.assertEqual(self.post('GET "a key"', database=3).json['database'], 3)

    def test_unknown_nodes_and_services_do_not_execute(self):
        self.login()
        self.assertEqual(self.post(path='/api/terminal/missing/redis').status_code, 404)
        self.assertEqual(self.post(path='/api/terminal/redis1/shell').status_code, 400)
        self.monitor.nodes['redis1']['metadata']['sentinel_member'] = False
        self.assertEqual(self.post(path='/api/terminal/redis1/sentinel').status_code, 404)
        self.monitor.terminal_command.assert_not_called()

    def test_transport_failure_is_sanitized_and_not_retried(self):
        self.login()
        self.monitor.terminal_command.side_effect = RuntimeError('private-password /private/path')
        result = self.post('SET key value')
        self.assertEqual(result.status_code, 502)
        self.assertNotIn('private-', result.text)
        self.assertIn('may have executed', result.json['error'])
        self.monitor.terminal_command.assert_called_once()

    def test_quoting_empty_arguments_and_shell_characters_are_literal(self):
        args, db = parse_command('SET "a key" ""', 2, 'redis')
        self.assertEqual(args, ['SET', 'a key', ''])
        self.assertEqual(db, 2)
        self.assertEqual(parse_command("SET key '$(touch /tmp/file); {{ 7*7 }}'", 0, 'redis')[0][2], '$(touch /tmp/file); {{ 7*7 }}')
        for command in ('', 'GET "bad', 'PING\nFLUSHALL', '-r 100 PING', 'MULTI', 'MONITOR', 'CLIENT REPLY OFF', 'SELECT -1', 'SELECT 1 extra'):
            with self.subTest(command=command), self.assertRaises(ValueError):
                parse_command(command, 0, 'redis')
        for db in (True, -1, '2', 1.2):
            with self.assertRaises(ValueError):
                parse_command('PING', db, 'redis')
        with self.assertRaises(ValueError):
            parse_command('SELECT 1', 0, 'sentinel')

    def test_raw_connection_is_discarded_and_monitoring_pool_is_unchanged(self):
        connection = Mock()
        connection.read_response.return_value = [b'value', None, 9]
        factory = Mock(return_value=connection)
        pool = SimpleNamespace(connection_kwargs={'db': 4, 'password': 'private-password'}, connection_class=factory)
        client = SimpleNamespace(connection_pool=pool)
        result = direct_command(client, ['GET', 'key'], 2)
        self.assertTrue(result['ok'])
        self.assertEqual(result['output'], '1) "value"\n2) (nil)\n3) (integer) 9')
        self.assertEqual(factory.call_args.kwargs['db'], 2)
        self.assertEqual(pool.connection_kwargs['db'], 4)
        connection.disconnect.assert_called_once()
        connection.send_command.assert_called_once_with('GET', 'key')
        connection.read_response.side_effect = redis.ResponseError('private-password denied')
        result = direct_command(client, ['GET', 'key'], 0)
        self.assertFalse(result['ok'])
        self.assertNotIn('private-password', result['output'])
        connection.read_response.side_effect = redis.TimeoutError()
        self.assertIn('may have executed', direct_command(client, ['GET', 'key'], 0)['output'])

    def test_remote_command_uses_literal_argv_and_password_environment(self):
        payload = base64.b64encode(json.dumps({'args': ['SET', 'a key', '$(touch /tmp/file)'], 'database': 3}).encode()).decode()
        config = {'terminal': payload, 'deployment': 'host', 'port': 6379, 'password': 'private-password'}
        with patch('sentinel_atlas.probes.remote_probe.subprocess.run', return_value=SimpleNamespace(
                returncode=0, stdout='"private-password"', stderr='')) as run:
            result = terminal(config)
        self.assertTrue(result['ok'])
        self.assertNotIn('private-password', result['output'])
        args = run.call_args.args[0]
        self.assertEqual(args[-3:], ['SET', 'a key', '$(touch /tmp/file)'])
        self.assertNotIn('private-password', args)
        self.assertEqual(run.call_args.kwargs['env']['REDISCLI_AUTH'], 'private-password')
        self.assertEqual(args[args.index('-n') + 1], '3')
        config.update(deployment='nspawn', container='cache')
        with patch('sentinel_atlas.probes.remote_probe.subprocess.run', side_effect=subprocess.TimeoutExpired('private', 4)) as run:
            self.assertFalse(terminal(config)['ok'])
        self.assertIn('--machine=cache', run.call_args.args[0])
        self.assertIn('--setenv=REDISCLI_AUTH', run.call_args.args[0])

    def test_reply_types(self):
        self.assertEqual(format_reply(None), '(nil)')
        self.assertEqual(format_reply([]), '(empty array)')
        self.assertEqual(format_reply(b'\xff\x00'), '"\\\\xff\\u0000"')

    def test_real_ansible_routes_only_to_exact_node_and_preserves_user_text(self):
        ansible = Path(sys.executable).parent / 'ansible-playbook'
        if not ansible.exists():
            self.skipTest('Optional Ansible dependencies are not installed.')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cli = root / 'fake-redis-cli'
            cli.write_text('#!' + sys.executable + '\nimport json, sys\nprint(json.dumps(json.dumps(sys.argv[1:])))\n')
            cli.chmod(0o700)
            inventory = root / 'inventory.json'
            inventory.write_text(json.dumps({'redis_nodes': {'hosts': {
                name: {'ansible_connection': 'local', 'ansible_become': False, 'dashboard_deployment': 'host',
                       'dashboard_python': sys.executable, 'dashboard_redis_cli': str(cli),
                       'redis_password': 'private-password'} for name in ('one', 'two')}}}))
            config = root / 'ansible.cfg'
            config.write_text('[defaults]\n')
            monitor = LiveMonitor(Settings(inventory=inventory, ansible_config=config, ansible_playbook=str(ansible)))
            value = '{{ lookup("pipe", "echo BAD") }}; $(echo BAD)'
            result = monitor.terminal_command('one', 'redis', ['SET', 'a key', value], 3)
            self.assertTrue(result['ok'], result)
            args = json.loads(json.loads(result['output']))
            self.assertEqual(args[-3:], ['SET', 'a key', value])
            self.assertEqual(args[args.index('-n') + 1], '3')
            self.assertNotIn('private-password', result['output'])


class DemoTerminalTests(unittest.TestCase):
    def setUp(self):
        self.monitor = DemoMonitor()
        self.monitor.sample()
        self.app = create_app(self.monitor, {'TESTING': True, 'DATABASE_URL': 'sqlite://',
            'SECRET_KEY': 'demo-terminal-test-' * 4, 'DEFAULT_ACCOUNT': 'admin', 'DEFAULT_PASSWORD': 'test-password'})
        self.addCleanup(self.app.extensions['accounts'].engine.dispose)
        self.client = self.login('admin')

    def login(self, username):
        client = self.app.test_client()
        client.get('/login')
        with client.session_transaction() as state:
            csrf = state['csrf']
        client.post('/login', data={'username': username, 'password': 'test-password', 'csrf_token': csrf})
        return client

    def command(self, text, database=0, node='redis2', service='redis', client=None):
        client = client or self.client
        with client.session_transaction() as state:
            csrf = state['csrf']
        result = client.post(f'/api/terminal/{node}/{service}', json={'command': text, 'database': database}, headers={'X-CSRF-Token': csrf})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertTrue(result.json['demo'])
        return result.json

    def test_demo_commands_and_database_selection_never_connect_to_redis_or_ssh(self):
        with patch('socket.create_connection', side_effect=AssertionError('No network in demo')), patch('subprocess.Popen', side_effect=AssertionError('No subprocesses in demo')):
            self.assertEqual(self.command('PING')['output'], '"PONG"')
            self.assertIn('simulated:1', self.command('INFO')['output'])
            self.assertEqual(self.command('GET demo:message')['output'], '"Hello from Sentinel Atlas"')
            self.assertEqual(self.command('SELECT 2')['database'], 2)
            self.assertTrue(self.command('SET "a key" "hello world"', 2)['ok'])
            self.assertEqual(self.command('GET "a key"', 2)['output'], '"hello world"')
            self.assertEqual(self.command('GET "a key"', 0)['output'], '(nil)')
            self.assertEqual(self.command('SELECT 16', 2)['database'], 2)
            self.assertFalse(self.command('SELECT 16', 2)['ok'])
            self.assertEqual(self.command('SELECT 0', 2)['database'], 0)

    def test_demo_replicas_share_data_and_reject_writes_and_scenarios_apply(self):
        self.assertTrue(self.command('SET hello world')['ok'])
        self.assertEqual(self.command('GET hello', node='redis1')['output'], '"world"')
        self.assertIn('READONLY', self.command('SET hello goodbye', node='redis1')['output'])
        self.monitor.sample('failover')
        self.assertTrue(self.command('SET promoted yes', node='redis3')['ok'])
        self.assertFalse(self.command('SET old-master no', node='redis2')['ok'])
        self.monitor.sample('down')
        self.assertFalse(self.command('PING', node='redis1')['ok'])
        self.assertTrue(self.command('PING', node='redis2')['ok'])

    def test_demo_data_is_private_and_bounded(self):
        self.app.extensions['accounts'].create_user('second-admin', 'test-password', True)
        other = self.login('second-admin')
        self.command('SET account-key private-value')
        self.assertEqual(self.command('GET account-key', client=other)['output'], '(nil)')
        self.assertFalse(self.command('EVAL "return 1" 0')['ok'])
        # More than 64 KiB is refused across all databases, without changing data.
        for database in range(4):
            self.assertTrue(self.command('SET full ' + 'x' * 15000, database)['ok'])
        self.assertFalse(self.command('SET overflow ' + 'x' * 15000, 5)['ok'])
        self.assertEqual(self.command('GET overflow', 5)['output'], '(nil)')

    def test_demo_sentinel_tracks_master_and_string_commands_return_typed_output(self):
        self.assertIn('192.168.10.11', self.command('SENTINEL GET-MASTER-ADDR-BY-NAME redis-main', service='sentinel')['output'])
        self.monitor.sample('failover')
        self.assertIn('192.168.10.12', self.command('SENTINEL MASTER redis-main', service='sentinel')['output'])
        self.assertIn('Quorum', self.command('SENTINEL CKQUORUM redis-main', service='sentinel')['output'])
        self.assertEqual(self.command('INCR demo:visits', node='redis3')['output'], '(integer) 43')
        self.assertEqual(self.command('DEL demo:visits', node='redis3')['output'], '(integer) 1')
        self.assertEqual(self.command('EXISTS demo:visits', node='redis3')['output'], '(integer) 0')


if __name__ == '__main__':
    unittest.main()
