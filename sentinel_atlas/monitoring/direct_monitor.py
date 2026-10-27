"""Redis protocol monitoring, without SSH, systemd, or Ansible."""
import concurrent.futures
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

import redis
from redis.backoff import NoBackoff
from redis.retry import Retry
import yaml

from .monitor import LiveMonitor
from ..probes.remote_probe import service_metrics


def resolve_url(node, prefix):
    key = prefix + '_env'
    if node.get(key):
        value = os.getenv(node[key])
        if not value:
            raise ValueError(f'Missing connection environment variable: {node[key]}')
        return value
    return node.get(prefix)


def connection(value, tls=None):
    try:
        url = urlsplit(value)
        if url.scheme not in ('redis', 'rediss') or not url.hostname or url.query or url.fragment:
            raise ValueError()
        port = url.port or 6379
        db = int(url.path.strip('/') or 0)
        client = redis.Redis(host=url.hostname, port=port, db=db,
            username=unquote(url.username) if url.username else None,
            password=unquote(url.password) if url.password else None,
            ssl=url.scheme == 'rediss', decode_responses=True,
            socket_timeout=2, socket_connect_timeout=2, retry_on_timeout=False,
            retry=Retry(NoBackoff(),0), **((tls or {}) if url.scheme == 'rediss' else {}))
        return client, url.hostname, port
    except (ValueError, TypeError):
        raise ValueError('Connections need a redis:// or rediss:// URL without query parameters.') from None


def flatten(values):
    return '\n'.join(str(part) for pair in values.items() for part in pair)


def safe_call(function):
    try:
        return function(), None
    except redis.AuthenticationError:
        return None, 'authentication_failed'
    except redis.TimeoutError:
        return None, 'timeout'
    except (redis.RedisError, OSError, ValueError):
        return None, 'unavailable'


class DirectMonitor(LiveMonitor):
    def __init__(self, settings):
        super().__init__(settings)
        if settings.targets:
            try:
                definition = yaml.safe_load(Path(settings.targets).read_text())
                nodes = definition['nodes']
            except (OSError, ValueError, KeyError, TypeError, yaml.YAMLError):
                raise ValueError('Cannot read targets. Supply a YAML/JSON object with a nodes list.') from None
        else:
            nodes = [{'name': os.getenv('REDIS_NAME', 'redis'), 'cluster': os.getenv('REDIS_CLUSTER', 'standalone'),
                      'url_env': 'REDIS_URL', 'sentinel_url_env': 'SENTINEL_URL' if os.getenv('SENTINEL_URL') else None}]
        if not isinstance(nodes, list) or not 1 <= len(nodes) <= 100:
            raise ValueError('Configure between 1 and 100 direct Redis targets.')
        self.targets = []
        names = set()
        for node in nodes:
            if not isinstance(node, dict):
                raise ValueError('Every target must be an object.')
            name = node.get('name')
            cluster = node.get('cluster', 'redis')
            if not isinstance(name, str) or not 1 <= len(name) <= 80 or name in names or not isinstance(cluster, str) or not cluster:
                raise ValueError('Targets need unique names (1–80 characters) and a cluster name.')
            names.add(name)
            clients, address, port, sentinel_address, sentinel_port = {}, None, None, None, None
            tls = {key: node[key] for key in ('ssl_ca_certs', 'ssl_certfile', 'ssl_keyfile') if node.get(key)}
            for service, prefix in (('redis', 'url'), ('sentinel', 'sentinel_url')):
                value = resolve_url(node, prefix)
                if value:
                    client, host, target_port = connection(value, tls)
                    clients[service] = client
                    if service == 'redis':
                        address, port = host, target_port
                    else:
                        sentinel_address, sentinel_port = host, target_port
            if not clients:
                raise ValueError(f'Target {name} needs a Redis or Sentinel connection.')
            metadata = {'name': name, 'cluster': cluster, 'deployment': 'direct',
                'address': address or sentinel_address,
                'replication_address': node.get('advertise_address') or address,
                'replication_port': node.get('advertise_port') or port,
                'redis_port': port, 'sentinel_address': sentinel_address, 'sentinel_port': sentinel_port,
                'redis_member': 'redis' in clients, 'sentinel_member': 'sentinel' in clients, 'storage': []}
            self.targets.append((metadata, clients))

    def collect_target(self, target):
        metadata, clients = target
        values = {}
        if 'redis' in clients:
            client = clients['redis']
            info, error = safe_call(client.info)
            values['info'] = ('\n'.join(f'{key}:{value}' for key, value in (info or {}).items()), error)
            runtime, error = safe_call(lambda: client.config_get('*'))
            values['config'] = (runtime, error)
        if 'sentinel' in clients:
            client = clients['sentinel']
            # Separate command arguments avoid redis-py's convenience callback,
            # which returns a boolean by default in newer releases.
            master, error = safe_call(lambda: client.execute_command('SENTINEL', 'MASTER', metadata['cluster']))
            values['sentinel'] = (flatten(master) if isinstance(master, dict) else '\n'.join(map(str, master or [])), error)
            quorum, error = safe_call(lambda: client.execute_command('SENTINEL', 'CKQUORUM', metadata['cluster']))
            values['quorum'] = (str(quorum) if quorum else None, error)
        secrets = [client.connection_pool.connection_kwargs.get('password') for client in clients.values()
                   if hasattr(client, 'connection_pool')]
        redis_info, sentinel_info, _ = service_metrics(values, secrets)
        logs = {service: {'status': 'unsupported', 'source': 'Server probe required', 'lines': []} for service in clients}
        return metadata['name'], {'metadata': metadata, 'telemetry': {
            'redis': redis_info, 'sentinel': sentinel_info, 'logs': logs, 'hardware': {}, 'container': {}, 'storage': []}}

    def collect(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            return dict(pool.map(self.collect_target, self.targets))

    def terminal_command(self, name, service, args, database):
        from ..terminal import direct_command
        for metadata, clients in self.targets:
            if metadata['name'] == name and service in clients:
                return direct_command(clients[service], args, database)
        raise RuntimeError('Unknown terminal target.')

    def stop(self):
        super().stop()
        # The worker may still be finishing a bounded read; redis-py pools can reconnect.
        for _, clients in self.targets:
            for client in clients.values():
                client.close()
