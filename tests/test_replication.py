import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sentinel_atlas.monitoring.demo import DemoMonitor
from sentinel_atlas.monitoring.monitor import ClusterState
from sentinel_atlas.monitoring.public_schema import clean_record
from sentinel_atlas.probes.remote_probe import service_metrics


class ReplicationTests(unittest.TestCase):
    def setUp(self):
        self.nodes = DemoMonitor().sample()['nodes']
        self.replica = next(n for n in self.nodes if n['redis']['role'] == 'replica')
        self.master = next(n for n in self.nodes if n['redis']['role'] == 'master')

    def snapshot(self):
        records = {n['name']: {'metadata': n['metadata'], 'telemetry': {
            key: n[key] for key in ('redis', 'sentinel', 'hardware', 'container', 'storage')}} for n in self.nodes}
        state = ClusterState()
        state.apply(records)
        return state.snapshot()

    def status(self):
        return next(n['replication'] for n in self.snapshot()['nodes'] if n['name'] == self.replica['name'])

    def test_caught_up_replica_and_master_have_distinct_statuses(self):
        self.assertEqual(self.status()['state'], 'in_sync')
        self.assertEqual(self.status()['lag_bytes'], 0)
        self.assertEqual(self.status()['upstream_name'], self.master['name'])
        self.assertEqual(next(n['replication']['state'] for n in self.snapshot()['nodes'] if n['name'] == self.master['name']), 'master')

    def test_write_load_gap_and_catch_up_are_recomputed_each_observation(self):
        self.master['redis']['replication_offset'] += 65536
        self.assertEqual(self.status()['state'], 'catching_up')
        self.assertEqual(self.status()['lag_bytes'], 65536)
        self.replica['redis']['replication_offset'] += 65536
        self.assertEqual(self.status()['state'], 'in_sync')

    def test_later_replica_sample_never_produces_a_negative_gap(self):
        self.replica['redis']['replication_offset'] += 100
        self.assertEqual(self.status()['lag_bytes'], 0)

    def test_full_sync_progress_and_unknown_diskless_transfer_size(self):
        r = self.replica['redis']
        r.update(syncing=True, link='down', sync_total_bytes=1000, sync_read_bytes=450)
        self.assertEqual(self.status()['state'], 'syncing')
        self.assertEqual(self.status()['progress_percent'], 45)
        r.update(sync_total_bytes=0, sync_left_bytes=-450)
        self.assertIsNone(self.status()['progress_percent'])
        self.assertIsNone(self.status()['lag_bytes'])

    def test_progress_can_use_remaining_bytes_and_is_bounded(self):
        r = self.replica['redis']
        r.update(syncing=True, sync_total_bytes=1000, sync_left_bytes=250)
        self.assertEqual(self.status()['progress_percent'], 75)
        r['sync_read_bytes'] = 1200
        self.assertEqual(self.status()['progress_percent'], 100)

    def test_loading_and_link_down_are_not_synchronized(self):
        self.replica['redis'].update(loading=True, loading_percent=40)
        self.assertEqual(self.status()['state'], 'loading')
        self.assertEqual(self.status()['progress_percent'], 40)
        self.replica['redis'].update(loading=False, link='down')
        self.assertEqual(self.status()['state'], 'link_down')
        self.assertIsNone(self.status()['lag_bytes'])

    def test_failover_missing_offsets_and_unmonitored_upstreams_are_unknown(self):
        before = copy.deepcopy(self.replica['redis'])
        for change in ({'replication_id': 'new-history'}, {'replication_id': None},
                       {'replication_offset': None}, {'upstream': 'unmonitored'}):
            with self.subTest(change=change):
                self.replica['redis'] = dict(before, **change)
                self.assertEqual(self.status()['state'], 'unknown')
                self.assertIsNone(self.status()['lag_bytes'])

    def test_unavailable_upstream_cannot_establish_sync(self):
        self.master['redis']['up'] = False
        self.assertEqual(self.status()['state'], 'unknown')
        self.replica['redis']['up'] = False
        self.assertEqual(self.status()['state'], 'unavailable')
        self.replica['metadata']['redis_member'] = False
        self.assertEqual(self.status()['state'], 'not_applicable')

    def test_metrics_use_applied_replica_offset_and_preserve_sync_telemetry(self):
        info = ('redis_version:7.4.0\nrole:slave\nmaster_replid:stream-id\n'
                'master_repl_offset:9999\nslave_read_repl_offset:9500\nslave_repl_offset:9000\n'
                'master_sync_in_progress:1\nmaster_sync_total_bytes:1000\nmaster_sync_read_bytes:450\n'
                'master_sync_left_bytes:550\nmaster_last_io_seconds_ago:2\n'
                'master_link_down_since_seconds:3\nloading:1\nloading_loaded_perc:30.5')
        metrics, _, _ = service_metrics({'info': (info, None)})
        public = clean_record({'telemetry': {'redis': metrics}})['telemetry']['redis']
        self.assertEqual(public['replication_offset'], 9000)
        self.assertEqual(public['replication_id'], 'stream-id')
        self.assertEqual(public['sync_read_bytes'], 450)
        self.assertEqual(public['last_master_io'], 2)
        self.assertEqual(public['link_down_seconds'], 3)
        self.assertTrue(public['loading'])
        self.assertEqual(public['loading_percent'], 30.5)

    def test_missing_metrics_do_not_look_like_zero_offset_or_zero_lag(self):
        metrics, _, _ = service_metrics({'info': ('redis_version:7.4.0\nrole:slave\nmaster_repl_offset:1000', None)})
        self.assertIsNone(metrics['replication_offset'])
        self.assertIsNone(metrics['last_master_io'])
        self.assertIsNone(metrics['sync_total_bytes'])

    def test_large_offsets_keep_integer_precision(self):
        offset = 2**60+1
        metrics, _, _ = service_metrics({'info': (f'redis_version:7.4.0\nrole:master\nmaster_repl_offset:{offset}', None)})
        self.assertEqual(metrics['replication_offset'], offset)

    def test_loading_invalidates_cluster_health(self):
        self.master['redis']['loading'] = True
        self.assertEqual(self.snapshot()['status'], 'degraded')
