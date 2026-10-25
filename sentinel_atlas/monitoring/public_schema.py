"""Explicit allowlists for data permitted to leave the telemetry boundary."""
import math

META = ('name', 'address', 'container', 'cluster', 'deployment', 'redis_member', 'sentinel_member', 'redis_port', 'sentinel_port', 'sentinel_address', 'replication_address', 'replication_port')
STORAGE = ('label', 'host_path', 'container_path', 'mounted', 'total', 'used', 'available', 'source', 'filesystem', 'unavailable')
FIELDS = {
    'redis': ('up', 'error', 'role', 'version', 'uptime_seconds', 'clients', 'ops_per_second', 'memory_used', 'memory_rss', 'memory_max', 'connected_replicas', 'upstream', 'upstream_port', 'link', 'syncing', 'replication_offset', 'last_master_io', 'aof_enabled', 'rdb_status', 'aof_status', 'data_directory', 'logfile', 'config_file'),
    'sentinel': ('up', 'error', 'quorum_ok', 'master_ip', 'master_port', 'flags', 'known_replicas', 'other_sentinels', 'required_quorum'),
    'hardware': ('hostname', 'os', 'kernel', 'architecture', 'cpu_cores', 'load_1m', 'cpu_total', 'cpu_idle', 'memory_total', 'memory_used', 'uptime_seconds'),
    'container': ('state', 'memory_current', 'memory_limit', 'tasks'),
}


def pick(data, fields):
    if not isinstance(data, dict):
        return {}
    return {key: (value[:1024] if isinstance(value, str) else value)
            for key, value in data.items() if key in fields
            and (value is None or isinstance(value, (str, int, float, bool)))
            and (not isinstance(value, float) or math.isfinite(value))}


def storage_items(value):
    return value if isinstance(value, list) else []


def clean_logs(value):
    if not isinstance(value, dict):
        return {}
    result = {}
    for service in ('redis', 'sentinel'):
        entry = value.get(service)
        if not isinstance(entry, dict):
            continue
        result[service] = {
            'source': str(entry.get('source', ''))[:1024],
            'status': entry.get('status') if entry.get('status') in ('ok', 'unsupported') else 'unavailable',
            'lines': [''.join(c for c in line if c == '\t' or c.isprintable())[:1000]
                      for line in storage_items(entry.get('lines'))[-120:] if isinstance(line, str)]}
    return result


def clean_record(record):
    if not isinstance(record, dict):
        return {}
    metadata = record.get('metadata', {})
    result = {'metadata': pick(metadata, META)}
    result['metadata']['storage'] = [pick(item, STORAGE[:3]) for item in storage_items(metadata.get('storage')) if isinstance(item, dict)][:16] if isinstance(metadata, dict) else []
    if record.get('error') in ('ssh_unreachable', 'probe_failed', 'invalid_probe_response'):
        result['error'] = record['error']
    telemetry = record.get('telemetry')
    if isinstance(telemetry, dict):
        result['telemetry'] = {key: pick(telemetry.get(key), fields) for key, fields in FIELDS.items()}
        result['telemetry']['storage'] = [pick(item, STORAGE) for item in storage_items(telemetry.get('storage')) if isinstance(item, dict)][:16]
        result['telemetry']['logs'] = clean_logs(telemetry.get('logs'))
        if telemetry.get('probe_error'):
            result['error'] = 'probe_failed'
    return result
