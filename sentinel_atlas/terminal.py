"""Authenticated, single-command Redis terminals with isolated database selection."""
import shlex
import threading

import redis
from flask import g, jsonify, request

from .probes.remote_probe import redact_log, terminal_reply as format_reply


MAX_COMMAND = 16384
MAX_OUTPUT = 65536
STATEFUL = {'AUTH', 'HELLO', 'RESET', 'QUIT', 'MULTI', 'EXEC', 'DISCARD', 'WATCH',
            'UNWATCH', 'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'UNSUBSCRIBE',
            'PUNSUBSCRIBE', 'SUNSUBSCRIBE', 'MONITOR', 'SYNC', 'PSYNC'}


def parse_command(command, database, service):
    if type(database) is not int or not 0 <= database <= 2147483647:
        raise ValueError('Database must be a non-negative integer.')
    if service == 'sentinel' and database != 0:
        raise ValueError('Sentinel only supports database 0.')
    if not isinstance(command, str) or not command.strip() or len(command.encode()) > MAX_COMMAND:
        raise ValueError('Enter a command of at most 16 KiB.')
    if any(char in command for char in ('\x00', '\r', '\n')):
        raise ValueError('Enter one command per line.')
    try:
        args = shlex.split(command, comments=False)
    except ValueError:
        raise ValueError('Unclosed quote or incomplete escape in command.') from None
    if not args or not args[0] or args[0].startswith('-'):
        raise ValueError('Enter a Redis command.')
    verb = args[0].upper()
    # Each command uses a new connection. These modes require a persistent stream.
    if verb in STATEFUL or (verb == 'CLIENT' and len(args) > 1 and args[1].upper() in
                           {'REPLY', 'TRACKING', 'CACHING', 'SETNAME', 'SETINFO', 'NO-EVICT', 'NO-TOUCH'}):
        raise ValueError('Connection modes, transactions, and subscriptions are not supported in this terminal.')
    selected = database
    if verb == 'SELECT':
        if len(args) != 2 or not args[1].isascii() or not args[1].isdigit() or int(args[1]) > 2147483647:
            raise ValueError('Usage: SELECT <non-negative database number>')
        selected = int(args[1])
        if service == 'sentinel' and selected != 0:
            raise ValueError('Sentinel only supports database 0.')
    return args, selected


def direct_command(client, args, database):
    pool = client.connection_pool
    options = dict(pool.connection_kwargs, db=database, decode_responses=False,
                   socket_timeout=3, socket_connect_timeout=3)
    # Never borrow the monitoring pool: SELECT and other commands must not alter it.
    connection = pool.connection_class(**options)
    secrets = [options.get('password')]
    try:
        connection.send_command(*args)
        value = connection.read_response()
        output, ok = format_reply(value), True
    except redis.AuthenticationError:
        output, ok = 'Redis authentication failed. Check the configured credentials.', False
    except redis.ResponseError as error:
        output, ok = '(error) ' + str(error), False
    except (redis.TimeoutError, TimeoutError):
        output, ok = 'Command timed out; it may have executed. Check Redis before retrying.', False
    except (redis.RedisError, OSError, ValueError):
        output, ok = 'Redis connection unavailable. Check the node and connection settings.', False
    finally:
        connection.disconnect()
    return {'ok': ok, 'output': redact_log(output, secrets)[:MAX_OUTPUT]}


def init_terminal(app, monitor):
    # Bound simultaneous command requests independently from background collection.
    slots = threading.BoundedSemaphore(4)

    @app.post('/api/terminal/<name>/<service>')
    def terminal_command(name, service):
        if not g.user.is_admin:
            return jsonify(error='Administrator access is required to execute commands.'), 403
        if service not in ('redis', 'sentinel'):
            return jsonify(error='Unknown service.'), 400
        if request.content_length is None or request.content_length > MAX_COMMAND * 6 + 1024:
            return jsonify(error='Command request is too large.'), 413
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(error='Supply a JSON command and database.'), 400
        database = data.get('database', 0)
        try:
            args, selected = parse_command(data.get('command'), database, service)
        except ValueError as error:
            return jsonify(error=str(error)), 400
        with monitor.lock:
            node = monitor.nodes.get(name)
            if not node or not node['metadata'].get(service + '_member'):
                return jsonify(error='Unknown node or unconfigured service.'), 404
        if not slots.acquire(blocking=False):
            return jsonify(error='All terminal connections are busy. Try again shortly.'), 429
        try:
            if monitor.mode == 'demo':
                result = monitor.demo_terminal_command(g.user.id, name, service, args, database)
            else:
                result = monitor.terminal_command(name, service, args, database)
        except RuntimeError:
            return jsonify(error='Command transport failed; it may have executed. Check the node before retrying.'), 502
        finally:
            slots.release()
        result['database'] = selected if result['ok'] else database
        result['output'] = result['output'][:MAX_OUTPUT]
        return jsonify(result)
