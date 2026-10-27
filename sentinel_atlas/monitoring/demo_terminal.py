"""Small, bounded Redis simulation for the labelled demo workspace. No I/O."""
from collections import OrderedDict
from fnmatch import fnmatchcase

from ..probes.remote_probe import terminal_reply


class DemoTerminal:
    def __init__(self):
        self.users = OrderedDict()

    def execute(self, user_id, node, nodes, service, args, database):
        def reply(value=None, error=None):
            return {'ok': error is None, 'output': '(error) ' + error if error else terminal_reply(value), 'demo': True}

        if not node[service].get('up'):
            return reply(error='Demo node is unavailable in the selected outage scenario.')
        command, values = args[0].upper(), args[1:]
        if database >= 16:
            return reply(error='ERR DB index is out of range')
        if command == 'PING' and len(values) <= 1:
            return reply(values[0] if values else 'PONG')
        if command == 'ECHO' and len(values) == 1:
            return reply(values[0])
        if command == 'SELECT' and len(values) == 1:
            return reply('OK') if int(values[0]) < 16 else reply(error='ERR DB index is out of range')
        if command == 'INFO' and len(values) <= 1:
            return reply('# Server\r\nredis_version:8.0.2\r\nredis_mode:' + ('sentinel' if service == 'sentinel' else 'standalone') +
                         '\r\n# Replication\r\nrole:' + node['redis'].get('role', 'unknown') + '\r\n# Demo\r\nsimulated:1\r\n')
        if service == 'sentinel':
            master = next((n for n in nodes if n['redis'].get('role') == 'master' and n['redis'].get('up')), None)
            cluster = node['metadata'].get('cluster')
            if command == 'SENTINEL' and len(values) == 2 and values[1] == cluster:
                subcommand = values[0].upper()
                if subcommand == 'CKQUORUM':
                    return reply('OK 3 usable Sentinels. Quorum and failover authorization can be reached')
                if subcommand == 'GET-MASTER-ADDR-BY-NAME':
                    return reply([master['metadata']['address'], str(master['metadata']['redis_port'])] if master else None)
                if subcommand == 'MASTER' and master:
                    return reply(['name', cluster, 'ip', master['metadata']['address'], 'port',
                                  str(master['metadata']['redis_port']), 'flags', 'master', 'quorum', '2'])
            return reply(error='Demo Sentinel supports PING, INFO, ECHO, and SENTINEL MASTER / CKQUORUM / GET-MASTER-ADDR-BY-NAME redis-main.')

        # Each account has its own small dataset, shared by the simulated replicas.
        if user_id not in self.users:
            self.users[user_id] = {0: {'demo:message': 'Hello from Sentinel Atlas', 'demo:visits': '42'},
                                   2: {'demo:environment': 'staging'}}
        self.users.move_to_end(user_id)
        while len(self.users) > 32:
            self.users.popitem(last=False)
        databases = self.users[user_id]
        data = databases.setdefault(database, {})
        if command == 'GET' and len(values) == 1:
            return reply(data.get(values[0]))
        if command == 'MGET' and values:
            return reply([data.get(key) for key in values])
        if command == 'EXISTS' and values:
            return reply(sum(key in data for key in values))
        if command == 'TYPE' and len(values) == 1:
            return reply('string' if values[0] in data else 'none')
        if command == 'DBSIZE' and not values:
            return reply(len(data))
        if command == 'KEYS' and len(values) == 1:
            return reply(sorted(key for key in data if fnmatchcase(key, values[0])))
        if command == 'SCAN' and values == ['0']:
            return reply(['0', sorted(data)])
        if command == 'CONFIG' and [v.upper() for v in values] == ['GET', 'DATABASES']:
            return reply(['databases', '16'])
        if command in ('SET', 'DEL', 'INCR', 'DECR'):
            if node['redis'].get('role') != 'master':
                return reply(error="READONLY You can't write against a read only replica. Select the demo master to try writes.")
            if command == 'DEL' and values:
                count = 0
                for key in values:
                    count += key in data
                    data.pop(key, None)
                return reply(count)
            if (command == 'SET' and len(values) == 2) or (command in ('INCR', 'DECR') and len(values) == 1):
                key, value = values[0], values[-1]
                if command != 'SET':
                    try:
                        value = str(int(data.get(key, '0')) + (1 if command == 'INCR' else -1))
                        if not -(2**63) <= int(value) < 2**63:
                            raise ValueError()
                    except ValueError:
                        return reply(error='ERR value is not an integer or out of range')
                size = sum(len(k.encode()) + len(v.encode()) for db in databases.values() for k, v in db.items())
                previous = len(key.encode()) + len(data[key].encode()) if key in data else 0
                count = sum(len(db) for db in databases.values())
                if size - previous + len(key.encode()) + len(value.encode()) > 65536 or (key not in data and count >= 128):
                    return reply(error='Demo data limit reached (128 keys / 64 KiB). Use DEL to free space.')
                data[key] = value
                return reply('OK' if command == 'SET' else int(value))
        return reply(error='Demo supports PING, ECHO, INFO, SELECT, GET, MGET, SET, DEL, EXISTS, TYPE, DBSIZE, KEYS, SCAN 0, INCR, DECR, and CONFIG GET databases. Connect live Redis for other commands.')
