"""Explicitly labelled sample data; no connection to any Ansible project."""
import math
import time
from monitor import ClusterState


class DemoMonitor(ClusterState):
    def __init__(self, interval=5):
        super().__init__(interval, 'demo')

    def sample(self, scenario='healthy'):
        now = time.time()
        master = 'redis3' if scenario == 'failover' else 'redis2'
        master_ip = '192.168.10.' + str(9 + int(master[-1]))
        records = {}
        for i in range(1, 4):
            name, ip = f'redis{i}', f'192.168.10.{9 + i}'
            paths = [{'label': label, 'host_path': f'/{prefix}/{name}/{tail}', 'container_path': inside,
                'mounted': True, 'total': size * 1024**3, 'used': int(size * 1024**3 * used),
                'available': int(size * 1024**3 * (1-used)), 'source': f'/dev/vg_redis/{volume}', 'filesystem':'ext4'}
                for label,prefix,tail,inside,size,used,volume in [
                    ('Container OS','var/lib/machines','','/',2,.32,f'container_{name}'),
                    ('Redis data','data','redis/data','/var/lib/redis',5,.19,'redis_data'),
                    ('Redis logs','logs','redis-server/log','/var/log/redis',1,.08,'redis_log'),
                    ('Sentinel logs','logs','sentinel/log','/var/log/redis-sentinel',1,.03,'sentinel_log')]]
            record={'metadata': {'name':name,'address':ip,'container':name,'cluster':'redis-main',
                'redis_member':True,'sentinel_member':True,'redis_port':6379,'sentinel_port':26379,'storage':paths},
                'telemetry': {'redis': {'up':True,'role':'master' if name==master else 'replica','version':'8.0.2',
                    'uptime_seconds':93427,'clients':i*3+4,'ops_per_second':int(150+i*37+math.sin(now/9+i)*50),
                    'memory_used':int((38+i*5+math.sin(now/10+i)*2)*1024**2),'memory_rss':70*1024**2,
                    'memory_max':640*1024**2,'connected_replicas':2 if name==master else 0,
                    'upstream':None if name==master else master_ip,'upstream_port':6379,'link':'up',
                    'syncing':False,'replication_offset':12007482,'last_master_io':0,'aof_enabled':True,
                    'rdb_status':'ok','aof_status':'ok','data_directory':'/var/lib/redis',
                    'logfile':'/var/log/redis/redis-server.log','config_file':'/etc/redis/redis.conf'},
                'sentinel': {'up':True,'quorum_ok':True,'master_ip':master_ip,'master_port':6379,
                    'flags':'master','known_replicas':2,'other_sentinels':2,'required_quorum':2},
                'hardware': {'hostname':f'node{i}','os':'Ubuntu 24.04.3 LTS','kernel':'6.8.0-147-generic',
                    'architecture':'aarch64','cpu_cores':1,'load_1m':.15+i*.04,'cpu_total':int(now*100),
                    'cpu_idle':int(now*84),'memory_total':928*1024**2,'memory_used':(340+i*30)*1024**2,'uptime_seconds':103428},
                'container': {'state':'active','memory_current':(110+i*10)*1024**2,'memory_limit':768*1024**2,'tasks':23+i},'storage':paths,
                'logs': self.sample_logs(name, master, now, scenario)}}
            if scenario=='down' and i==1:
                record.pop('telemetry')
                record['error']='ssh_unreachable'
            records[name]=record
        self.apply(records, now=now, duration=.72)
        return self.snapshot()

    def refresh(self):
        pass

    @staticmethod
    def sample_logs(name, master, now, scenario):
        import datetime
        stamp=lambda seconds: datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime('%d %b %Y %H:%M:%S.000')
        redis=[f'1:{"M" if name==master else "S"} {stamp(now-offset)} * {message}' for offset,message in [
            (24,'Redis is starting in demo mode · sample log output'),
            (22,'Configuration loaded'),(21,'Server initialized'),(20,'Ready to accept connections tcp'),
            (15,'Background saving started'),(14,'DB saved on disk'),(10,'Background saving terminated with success'),
            (5,'Replication backlog is active'),(0,'Sample heartbeat · cluster observation refreshed')]]
        sentinel=[f'22:X {stamp(now-offset)} {message}' for offset,message in [
            (24,'* Sentinel started · sample log output'),
            (21,f'# +monitor master redis-main {"192.168.10.12" if master=="redis3" else "192.168.10.11"} 6379 quorum 2'),
            (18,'* +sentinel sentinel peer-1 192.168.10.10 26379'),
            (15,'* +sentinel sentinel peer-2 192.168.10.12 26379'),
            (0,'* Sample heartbeat · monitoring master redis-main')]]
        if scenario=='failover':
            sentinel.insert(-1,f'22:X {stamp(now-4)} # +switch-master redis-main 192.168.10.11 6379 192.168.10.12 6379')
        if scenario=='down':
            sentinel.insert(-1,f'22:X {stamp(now-4)} # +sdown slave 192.168.10.10:6379')
        return {'redis':{'status':'ok','source':'/var/log/redis/redis-server.log','lines':redis},
                'sentinel':{'status':'ok','source':'/var/log/redis-sentinel/redis-sentinel.log','lines':sentinel}}
