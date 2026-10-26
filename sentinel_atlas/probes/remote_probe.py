"""Executed on the VM by Ansible. Read-only; credentials arrive via stdin."""
import concurrent.futures
import json
import os
import platform
import re
import socket
import subprocess
import sys
import time


def run(args, password=None, timeout=3):
    environment = dict(os.environ)
    environment.pop("REDISCLI_AUTH", None)
    if password:
        environment["REDISCLI_AUTH"] = password
    try:
        result = subprocess.run(args, env=environment, capture_output=True, text=True,
                                timeout=timeout)
        if result.returncode:
            output = result.stdout + result.stderr
            error = "authentication_failed" if any(s in output for s in ("NOAUTH", "WRONGPASS", "AUTH failed")) else "unavailable"
            return None, error
        return result.stdout.strip(), None
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except (OSError, UnicodeError):
        return None, "command_unavailable"


def pairs(text):
    lines = (text or "").splitlines()
    return dict(zip(lines[::2], lines[1::2]))


def clean_configuration(value, secrets=()):
    """Bound runtime settings and remove credentials before transport."""
    if not isinstance(value, dict):
        return {}
    sensitive = re.compile(r'(?i)(requirepass|masterauth|masteruser|password|passphrase|secret|token|credential|(?:^|[._-])(?:auth|users?|private[-_.]?key)$|(?:^|[._-])key[-_.]file|^aclfile$)')
    hidden = {str(secret) for secret in secrets if secret}
    hidden.update(str(setting) for name, setting in value.items()
                  if isinstance(name, str) and sensitive.search(name) and setting)
    result = {}
    for name, setting in list(value.items())[:1024]:
        if not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,128}', name):
            continue
        if not isinstance(setting, (str, int, float, bool)):
            continue
        text = str(setting)
        if sensitive.search(name):
            text = '[REDACTED]' if text else ''
        else:
            text = redact_log(text, hidden)
        result[name] = text[:4096]
    return result


def number(value, default=0):
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def replication_offset(value):
    try:
        result = int(value)
        return result if result >= 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def read_file(path):
    try:
        with open(path) as stream:
            return stream.read()
    except OSError:
        return ""


def hardware():
    memory = {}
    for line in read_file('/proc/meminfo').splitlines():
        key, _, value = line.partition(':')
        memory[key] = number(value.split()[0]) * 1024
    cpu_line = read_file('/proc/stat').splitlines()[0].split()[1:]
    ticks = [int(value) for value in cpu_line]
    release = {}
    for line in read_file('/etc/os-release').splitlines():
        key, _, value = line.partition('=')
        release[key] = value.strip('"')
    return {
        "hostname": socket.gethostname(), "os": release.get('PRETTY_NAME', 'Linux'),
        "kernel": platform.release(), "architecture": platform.machine(),
        "cpu_cores": os.cpu_count() or 1, "load_1m": os.getloadavg()[0],
        "cpu_total": sum(ticks[:8]), "cpu_idle": ticks[3] + ticks[4],
        "memory_total": memory.get('MemTotal', 0),
        "memory_used": memory.get('MemTotal', 0) - memory.get('MemAvailable', 0),
        "uptime_seconds": number(read_file('/proc/uptime').split()[0]),
    }


def storage(public):
    raw, _ = run(['findmnt', '--json', '--output', 'TARGET,SOURCE,FSTYPE'], timeout=2)
    mounts = {}
    def walk(entries):
        for entry in entries:
            mounts[os.path.realpath(entry['target'])] = entry
            walk(entry.get('children', []))
    try:
        walk(json.loads(raw or '{}').get('filesystems', []))
    except (ValueError, KeyError, TypeError):
        pass
    result = []
    for definition in public.get('storage', []):
        path = os.path.realpath(definition['host_path'])
        item = dict(definition, mounted=path in mounts)
        try:
            stat = os.statvfs(path)
            item.update(total=stat.f_blocks * stat.f_frsize,
                        used=(stat.f_blocks - stat.f_bfree) * stat.f_frsize,
                        available=stat.f_bavail * stat.f_frsize,
                        source=mounts.get(path, {}).get('source'),
                        filesystem=mounts.get(path, {}).get('fstype'))
        except OSError:
            item['unavailable'] = True
        result.append(item)
    return result


def redact_log(text, secrets):
    for secret in sorted({str(s) for s in secrets if s}, key=len, reverse=True):
        text = text.replace(secret, '[REDACTED]')
    text = re.sub(r'(?i)(\b(?:requirepass|masterauth|password|REDISCLI_AUTH)\b\s*[=: ]\s*)("[^"]*"|\S+)', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)(\bAUTH\s+)(?:\S+\s+)?\S+', r'\1[REDACTED]', text)
    text = re.sub(r'(rediss?://)[^\s/@]+@', r'\1[REDACTED]@', text)
    # Log output is untrusted text, including terminal control sequences.
    return ''.join(char for char in text if char in '\n\t' or char.isprintable())


def read_logs(base, path, service, secrets):
    if path and (not isinstance(path, str) or not path.startswith('/') or '\x00' in path):
        return {'status': 'unavailable', 'source': 'Invalid configured log path', 'lines': []}
    if path:
        # Bound bytes before transport, even for very large or single-line log files.
        output, error = run(base + ['/usr/bin/tail', '-c', '32768', '--', path])
        source = path
    else:
        # The script is fixed; the service is a separate positional argument.
        script = 'journalctl --no-pager -n 120 -o short-iso -u "$1" | tail -c 32768'
        output, error = run(base + ['/bin/bash', '-o', 'pipefail', '-c', script,
                                   'dashboard-logs', service + '.service'])
        source = 'journal · ' + service + '.service'
    lines = redact_log(output or '', secrets).splitlines()[-120:]
    return {'status': 'unavailable' if error else 'ok', 'source': source,
            'lines': [line[:1000] for line in lines]}


def service_metrics(values, secrets=()):
    info = {}
    for line in (values.get('info', ('', None))[0] or '').splitlines():
        key, sep, value = line.partition(':')
        if sep and not key.startswith('#'):
            info[key] = value.strip()
    raw_config, config_error = values.get('config', (None, None))
    if isinstance(raw_config, str):
        try:
            raw_config = json.loads(raw_config)
        except ValueError:
            raw_config = pairs(raw_config)
    if isinstance(raw_config, list):
        raw_config = dict(zip(raw_config[::2], raw_config[1::2]))
    runtime = clean_configuration(raw_config, secrets)
    redis = {"up": bool(info.get('redis_version')), "error": values.get('info', (None, None))[1]}
    if redis['up']:
        redis.update(role='replica' if info.get('role') in ('slave', 'replica') else info.get('role', 'unknown'),
            version=info.get('redis_version'), uptime_seconds=number(info.get('uptime_in_seconds')),
            clients=number(info.get('connected_clients')), ops_per_second=number(info.get('instantaneous_ops_per_sec')),
            memory_used=number(info.get('used_memory')), memory_rss=number(info.get('used_memory_rss')),
            memory_max=number(info.get('maxmemory')), connected_replicas=number(info.get('connected_slaves')),
            upstream=info.get('master_host'), upstream_port=number(info.get('master_port')),
            link=info.get('master_link_status'), syncing=info.get('master_sync_in_progress') == '1',
            replication_offset=replication_offset(info.get('slave_repl_offset') if info.get('role') in ('slave', 'replica') else info.get('master_repl_offset')),
            replication_id=info.get('master_replid'),
            last_master_io=number(info.get('master_last_io_seconds_ago'), None),
            link_down_seconds=number(info.get('master_link_down_since_seconds'), None),
            sync_total_bytes=number(info.get('master_sync_total_bytes'), None),
            sync_read_bytes=number(info.get('master_sync_read_bytes'), None),
            sync_left_bytes=number(info.get('master_sync_left_bytes'), None),
            loading=info.get('loading') == '1',
            loading_percent=number(info.get('loading_loaded_perc'), None),
            aof_enabled=info.get('aof_enabled') == '1', rdb_status=info.get('rdb_last_bgsave_status'),
            aof_status=info.get('aof_last_write_status'), data_directory=runtime.get('dir'),
            logfile=runtime.get('logfile'), config_file=info.get('config_file'),
            configuration=runtime, config_status='ok' if isinstance(raw_config, dict) and not config_error else 'unavailable')
    master = pairs(values.get('sentinel', ('', None))[0])
    quorum = values.get('quorum', (None, None))
    sentinel = {"up": bool(master.get('ip')), "error": values.get('sentinel', (None, None))[1],
        "quorum_ok": bool(quorum[0] and quorum[0].startswith('OK ')),
        "master_ip": master.get('ip'), "master_port": number(master.get('port')),
        "flags": master.get('flags'), "known_replicas": number(master.get('num-slaves')),
        "other_sentinels": number(master.get('num-other-sentinels')),
        "required_quorum": number(master.get('quorum'))}
    return redis, sentinel, runtime


def probe(config):
    public = config['public']
    nspawn = public.get('deployment', 'nspawn') == 'nspawn'
    container = public.get('container', '')
    base = ['systemd-run', '--machine=' + container, '--wait', '--pipe', '--quiet',
            '--collect', '--property=Type=exec', '--property=RuntimeMaxSec=2s',
            '--expand-environment=no'] if nspawn else []
    def query(port, command, password, username=None, host='127.0.0.1'):
        args = base + (['--setenv=REDISCLI_AUTH'] if password and nspawn else [])
        args += [config.get('redis_cli', '/usr/bin/redis-cli'), '--json' if command[0] == 'CONFIG' else '--raw', '-e', '-h', host, '-p', str(port)]
        if username:
            args += ['--user', username]
        if config.get('tls'):
            args += ['--tls']
            if config.get('tls_ca'):
                args += ['--cacert', config['tls_ca']]
        args += command
        return run(args, password)
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = {}
        if public.get('redis_member'):
            futures['info'] = executor.submit(query, public['redis_port'], ['INFO'], config.get('redis_password'), config.get('redis_username'), config.get('redis_host', '127.0.0.1'))
            futures['config'] = executor.submit(query, public['redis_port'], ['CONFIG', 'GET', '*'], config.get('redis_password'), config.get('redis_username'), config.get('redis_host', '127.0.0.1'))
        if public.get('sentinel_member'):
            futures['sentinel'] = executor.submit(query, public['sentinel_port'], ['SENTINEL', 'MASTER', public['cluster']], config.get('sentinel_password'), config.get('sentinel_username'), config.get('sentinel_host', '127.0.0.1'))
            futures['quorum'] = executor.submit(query, public['sentinel_port'], ['SENTINEL', 'CKQUORUM', public['cluster']], config.get('sentinel_password'), config.get('sentinel_username'), config.get('sentinel_host', '127.0.0.1'))
        unit_name = 'systemd-nspawn@' + container + '.service' if nspawn else config.get('redis_service', 'redis-server') + '.service'
        futures['unit'] = executor.submit(run, ['systemctl', 'show', unit_name,
            '--property=ActiveState,MemoryCurrent,MemoryMax,CPUQuotaPerSecUSec,TasksCurrent'], None, 2)
        values = {name: future.result() for name, future in futures.items()}
    secrets = (config.get('redis_password'), config.get('sentinel_password'))
    redis, sentinel, runtime = service_metrics(values, secrets)
    unit = dict(line.split('=', 1) for line in (values['unit'][0] or '').splitlines() if '=' in line)
    logs = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        readers = {}
        if public.get('redis_member'):
            redis_logfile = config.get('redis_logfile_override')
            if redis_logfile is None:
                redis_logfile = runtime.get('logfile', config.get('redis_logfile'))
            readers['redis'] = executor.submit(read_logs, base,
                redis_logfile, config.get('redis_service', 'redis-server'), secrets)
        if public.get('sentinel_member'):
            readers['sentinel'] = executor.submit(read_logs, base,
                config.get('sentinel_logfile'), config.get('sentinel_service', 'redis-sentinel'), secrets)
        logs = {service: future.result() for service, future in readers.items()}
    return {"observed_at": time.time(), "redis": redis, "sentinel": sentinel,
        "hardware": hardware(), "storage": storage(public), "logs": logs,
        "container": {"state": unit.get('ActiveState', 'unknown'),
                      "memory_current": number(unit.get('MemoryCurrent')),
                      "memory_limit": number(unit.get('MemoryMax')),
                      "tasks": number(unit.get('TasksCurrent'))}}


if __name__ == '__main__':
    try:
        print(json.dumps(probe(json.load(sys.stdin)), separators=(',', ':')))
    except Exception:
        # Never serialize the input, subprocess arguments, or credential-bearing exceptions.
        print(json.dumps({"probe_error": "telemetry_unavailable"}))
