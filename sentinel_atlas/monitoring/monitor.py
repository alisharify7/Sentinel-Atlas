import copy
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time

from .public_schema import clean_record
from .replication import replication_status
from ..settings import Settings

from ..paths import PROBE_DIR


class CollectionError(RuntimeError):
    def __init__(self, message, records=None):
        super().__init__(message)
        self.records = records or {}


def parse_records(stdout):
    records = {}
    for line in stdout.splitlines():
        try:
            data = json.loads(line)
            if isinstance(data, dict) and isinstance(data.get('nodes'), dict):
                records.update({name: clean_record(record) for name, record in data['nodes'].items()})
        except (ValueError, TypeError):
            continue
    return records


class ClusterState:
    def __init__(self, interval=5, mode='live'):
        self.interval = interval
        self.mode = mode
        self.nodes = {}
        self.logs = {}
        self.events = []
        self.last_master = None
        self.last_masters = {}
        self.updated_at = None
        self.error = None
        self.duration = 0
        self.lock = threading.RLock()

    def event(self, kind, message, now):
        self.events.insert(0, {'id': f'{now}-{len(self.events)}', 'kind': kind, 'message': message, 'time': now})
        self.events = self.events[:60]

    def apply(self, records, error=None, duration=0, now=None):
        now = time.time() if now is None else now
        with self.lock:
            if error and error != self.error:
                self.event('warning', error, now)
            self.error, self.duration, self.updated_at = error, duration, now
            if not error:
                self.nodes = {name: node for name, node in self.nodes.items() if name in records}
                self.logs = {name: logs for name, logs in self.logs.items() if name in records}
            for name in set(records) | set(self.nodes):
                record = clean_record(records.get(name, {}))
                old = self.nodes.get(name, {})
                metadata = record.get('metadata') or old.get('metadata', {})
                if not metadata.get('name'):
                    metadata = dict(old.get('metadata', {}), name=name)
                telemetry = record.get('telemetry')
                reachable = bool(telemetry and not record.get('error') and not error)
                if reachable:
                    self.logs[name] = {'services': copy.deepcopy(telemetry.get('logs', {})), 'updated_at': now}
                node = {'name': name, 'metadata': metadata, 'reachable': reachable,
                        'error': record.get('error') or ('collector_unavailable' if error else None),
                        'last_seen': now if reachable else old.get('last_seen'),
                        'stale': not reachable, 'history': list(old.get('history', []))}
                for field in ('hardware', 'container', 'storage'):
                    node[field] = copy.deepcopy((telemetry or {}).get(field) or old.get(field, [] if field == 'storage' else {}))
                node['storage'] = node['storage'] or metadata.get('storage', [])
                node['redis'] = (telemetry or {}).get('redis', {'up': False}) if reachable else {'up': False}
                node['sentinel'] = (telemetry or {}).get('sentinel', {'up': False, 'quorum_ok': False}) if reachable else {'up': False, 'quorum_ok': False}
                if not node['redis'].get('up'):
                    node['redis']['role'] = 'unknown'
                node['last_role'] = node['redis'].get('role') if node['redis'].get('up') else old.get('last_role')
                before, after = old.get('redis', {}).get('up'), node['redis'].get('up', False)
                if old and before != after:
                    self.event('recovery' if after else 'down', f'{name} Redis is {"reachable again" if after else "unavailable"}.', now)
                if not old:
                    self.event('info', f'{name} discovered · {"online" if after else "unreachable"}.', now)
                hw, previous = node['hardware'], old.get('hardware', {})
                delta = hw.get('cpu_total', 0) - previous.get('cpu_total', 0)
                hw['cpu_percent'] = round(max(0, min(100, 100 * (1 - (hw.get('cpu_idle', 0) - previous.get('cpu_idle', 0)) / delta))), 1) if reachable and delta > 0 and previous else None
                node['history'].append({'time': now, 'up': after,
                    'memory': node['redis'].get('memory_used', 0), 'ops': node['redis'].get('ops_per_second', 0)})
                node['history'] = node['history'][-60:]
                self.nodes[name] = node
            for cluster in {n['metadata'].get('cluster', 'redis') for n in self.nodes.values()}:
                masters = [n['name'] for n in self.nodes.values() if n['metadata'].get('cluster', 'redis') == cluster
                           and n['redis'].get('up') and n['redis'].get('role') == 'master']
                if len(masters) == 1:
                    previous = self.last_masters.get(cluster)
                    if previous and previous != masters[0]:
                        self.event('promotion', f'{masters[0]} is the new master · previously {previous}.', now)
                    self.last_masters[cluster] = self.last_master = masters[0]

    def log_snapshot(self, name, service):
        with self.lock:
            node = self.nodes.get(name)
            if not node:
                return None
            cached = self.logs.get(name, {})
            entry = copy.deepcopy(cached.get('services', {}).get(service, {}))
            if not node['metadata'].get(service + '_member'):
                entry = {'status': 'not_configured', 'lines': []}
            return dict(entry, node=name, service=service, lines=entry.get('lines', []),
                        status=entry.get('status', 'pending'),
                        updated_at=cached.get('updated_at'), stale=node['stale'],
                        poll_interval=self.interval)

    def snapshot(self, cluster=None):
        with self.lock:
            nodes = sorted(copy.deepcopy(list(self.nodes.values())), key=lambda node: node['name'])
            clusters = sorted({node['metadata'].get('cluster', 'redis') for node in nodes})
            selected_cluster = cluster if cluster in clusters else clusters[0] if clusters else None
            nodes = [node for node in nodes if node['metadata'].get('cluster', 'redis') == selected_cluster]
            for node in nodes:
                node['replication'] = replication_status(node, nodes)
            redis_nodes = [node for node in nodes if node['metadata'].get('redis_member')]
            sentinel_nodes = [node for node in nodes if node['metadata'].get('sentinel_member')]
            masters = [node for node in redis_nodes if node['redis'].get('up') and node['redis'].get('role') == 'master']
            master = masters[0] if len(masters) == 1 else None
            master_ip = (master['metadata'].get('replication_address') or master['metadata'].get('address')) if master else None
            master_port = (master['metadata'].get('replication_port') or master['metadata'].get('redis_port')) if master else None
            replicas = [node for node in redis_nodes if node['redis'].get('up') and node['redis'].get('role') == 'replica']
            redis_up = sum(bool(node['redis'].get('up')) for node in redis_nodes)
            sentinel_up = sum(bool(node['sentinel'].get('up')) for node in sentinel_nodes)
            quorum = sum(bool(node['sentinel'].get('quorum_ok')) for node in sentinel_nodes)
            in_sync = all(node['redis'].get('link') == 'up' and not node['redis'].get('syncing')
                          and node['redis'].get('upstream') == master_ip
                          and node['redis'].get('upstream_port') == master_port for node in replicas)
            consensus = bool(master and sentinel_nodes) and all(
                node['sentinel'].get('up') and node['sentinel'].get('quorum_ok')
                and node['sentinel'].get('master_ip') == master_ip
                and node['sentinel'].get('master_port') == master_port
                and node['sentinel'].get('flags') == 'master' for node in sentinel_nodes)
            healthy = bool(redis_nodes and master and redis_up == len(redis_nodes)
                           and len(replicas) == len(redis_nodes) - 1 and in_sync
                           and not any(node['redis'].get('loading') for node in redis_nodes)
                           and (consensus or not sentinel_nodes) and not self.error)
            status = 'loading' if self.updated_at is None else 'healthy' if healthy else 'offline' if not redis_up else 'degraded'
            return {'mode': self.mode, 'status': status, 'updated_at': self.updated_at,
                'poll_interval': self.interval, 'poll_duration': round(self.duration, 2), 'error': self.error,
                'cluster': selected_cluster or 'Redis', 'clusters': clusters,
                'master': master['name'] if master else None, 'master_count': len(masters),
                'summary': {'redis_total': len(redis_nodes), 'redis_up': redis_up, 'replicas': len(replicas),
                    'sentinel_total': len(sentinel_nodes), 'sentinel_up': sentinel_up, 'quorum_ready': quorum,
                    'consensus': consensus, 'clients': sum(n['redis'].get('clients', 0) for n in redis_nodes),
                    'ops': sum(n['redis'].get('ops_per_second', 0) for n in redis_nodes),
                    'memory': sum(n['redis'].get('memory_used', 0) for n in redis_nodes)},
                'nodes': nodes, 'events': copy.deepcopy(self.events)}


class LiveMonitor(ClusterState):
    def __init__(self, settings=None):
        self.settings = settings or Settings.from_env()
        super().__init__(self.settings.interval)
        self.timeout = self.settings.timeout
        self.wake, self.stop_event = threading.Event(), threading.Event()
        self.thread = None
        self.collector_lock = threading.Lock()

    def collect(self):
        executable = self.settings.ansible_playbook
        if not Path(executable).is_file():
            executable = shutil.which(executable)
        if not executable:
            raise RuntimeError('Ansible is unavailable. Set SENTINEL_ANSIBLE_PLAYBOOK to your ansible-playbook executable.')
        env = dict(os.environ,
            ANSIBLE_STDOUT_CALLBACK='dashboard_json', ANSIBLE_CALLBACK_PLUGINS=str(PROBE_DIR / 'callback_plugins'),
            ANSIBLE_CALLBACKS_ENABLED='dashboard_json', ANSIBLE_LOG_PATH=os.devnull, ANSIBLE_NOCOLOR='1',
            ANSIBLE_FORCE_COLOR='0', ANSIBLE_TIMEOUT=str(self.settings.ssh_timeout), ANSIBLE_RETRY_FILES_ENABLED='False')
        if self.settings.ansible_config:
            env['ANSIBLE_CONFIG'] = str(self.settings.ansible_config)
        if self.settings.vault_password_file:
            env['ANSIBLE_VAULT_PASSWORD_FILE'] = str(self.settings.vault_password_file)
        workdir = self.settings.ansible_config.parent if self.settings.ansible_config else self.settings.inventory.parent
        process = subprocess.Popen([executable, '-i', str(self.settings.inventory),
            str(PROBE_DIR / 'probe.yml'), '--forks', '10', '--extra-vars',
            json.dumps({'dashboard_redis_group': self.settings.redis_group,
                        'dashboard_sentinel_group': self.settings.sentinel_group})], cwd=workdir, env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True)
        try:
            stdout, _ = process.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                stdout, _ = process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                stdout, _ = process.communicate()
            raise CollectionError('Collection timed out. Last observations are marked stale.', parse_records(stdout)) from None
        records = parse_records(stdout)
        if not records:
            raise CollectionError('Cannot read inventory or probe results. Check Ansible, vault access, and inventory groups.')
        return records

    def poll_once(self):
        with self.collector_lock:
            started = time.monotonic()
            try:
                self.apply(self.collect(), duration=time.monotonic() - started)
            except CollectionError as error:
                self.apply(error.records, error=str(error), duration=time.monotonic() - started)
            except RuntimeError as error:
                self.apply({}, error=str(error), duration=time.monotonic() - started)
            except Exception:
                message = 'Collection failed. Check direct Redis targets.' if self.settings.backend == 'direct' else 'Collection failed. Check the local Ansible configuration.'
                self.apply({}, error=message, duration=time.monotonic() - started)

    def _loop(self):
        while not self.stop_event.is_set():
            started = time.monotonic()
            self.poll_once()
            self.wake.wait(max(2, self.interval - (time.monotonic() - started)))
            self.wake.clear()

    def start(self):
        if not self.thread or not self.thread.is_alive():
            self.thread = threading.Thread(target=self._loop, daemon=True, name='cluster-collector')
            self.thread.start()

    def refresh(self):
        self.wake.set()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
