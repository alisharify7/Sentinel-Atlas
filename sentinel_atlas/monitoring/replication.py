"""Replication status derived from each collection's INFO observations."""
import math


def nonnegative(value):
    return (value if isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0 else None)


def replication_status(node, nodes):
    r = node['redis']
    result = {'state': 'unknown', 'lag_bytes': None, 'progress_percent': None,
              'upstream_name': None, 'upstream_offset': None}
    if not node['metadata'].get('redis_member'):
        return dict(result, state='not_applicable')
    if node.get('stale') or not r.get('up'):
        return dict(result, state='unavailable')
    if r.get('loading'):
        progress = nonnegative(r.get('loading_percent'))
        return dict(result, state='loading', progress_percent=min(100, progress) if progress is not None else None)
    if r.get('role') == 'master':
        return dict(result, state='master')
    if r.get('role') != 'replica':
        return result
    upstreams = [other for other in nodes if other['name'] != node['name']
                 and other['metadata'].get('redis_member')
                 and (other['metadata'].get('replication_address') or other['metadata'].get('address')) == r.get('upstream')
                 and (other['metadata'].get('replication_port') or other['metadata'].get('redis_port')) == r.get('upstream_port')]
    upstream = upstreams[0] if len(upstreams) == 1 else None
    if upstream:
        result['upstream_name'] = upstream['name']
    if r.get('syncing'):
        total, read, left = (nonnegative(r.get(key)) for key in ('sync_total_bytes', 'sync_read_bytes', 'sync_left_bytes'))
        if total and (read is not None or left is not None):
            received = read if read is not None else max(0, total-left)
            result['progress_percent'] = round(min(100, 100*received/total), 1)
        return dict(result, state='syncing')
    if r.get('link') == 'down':
        return dict(result, state='link_down')
    if (r.get('link') != 'up' or not upstream or upstream.get('stale')
            or not upstream['redis'].get('up') or upstream['redis'].get('loading')):
        return result
    source = upstream['redis']
    # Offsets from different replication histories cannot be compared after failover.
    if not r.get('replication_id') or r['replication_id'] != source.get('replication_id'):
        return result
    offset, source_offset = nonnegative(r.get('replication_offset')), nonnegative(source.get('replication_offset'))
    if offset is None or source_offset is None:
        return result
    # Nodes are polled independently; a later replica sample can exceed the source.
    lag = max(0, source_offset-offset)
    return dict(result, state='in_sync' if lag == 0 else 'catching_up', lag_bytes=lag,
                upstream_offset=source_offset)
