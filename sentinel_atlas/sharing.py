"""Revocable, cluster-scoped viewing links. Public responses use explicit allowlists."""
import copy
import re
import secrets
import time

from flask import abort, flash, g, jsonify, redirect, render_template, request, session, url_for
from sqlalchemy import or_, select

from .database import ShareLink, User, digest
from .monitoring.public_schema import FIELDS, META, pick


EXPIRATIONS = {'900': 900, '3600': 3600, '86400': 86400, '604800': 604800,
               '2592000': 2592000, 'permanent': None}
SCOPES = ('config', 'logs', 'details', 'events')


def shared_snapshot(snapshot, link):
    result = {key: copy.deepcopy(snapshot[key]) for key in (
        'mode', 'status', 'updated_at', 'poll_interval', 'poll_duration', 'cluster',
        'master', 'master_count', 'summary')}
    result.update(clusters=[link.cluster], error=None, nodes=[], events=[])
    for source in snapshot['nodes']:
        if source['metadata'].get('cluster', 'redis') != link.cluster:
            continue
        node = {key: copy.deepcopy(source.get(key)) for key in ('name', 'stale', 'last_seen', 'history')}
        node['metadata'] = pick(source['metadata'], META if link.allow_details else (
            'name', 'address', 'cluster', 'redis_member', 'sentinel_member', 'redis_port',
            'sentinel_port', 'sentinel_address', 'replication_address', 'replication_port'))
        node['redis'] = pick(source['redis'], tuple(key for key in FIELDS['redis'] if
            link.allow_details or key not in ('data_directory', 'logfile', 'config_file', 'config_status', 'error')))
        node['sentinel'] = pick(source['sentinel'], tuple(key for key in FIELDS['sentinel'] if key != 'error'))
        node['replication'] = pick(source.get('replication'), ('state', 'lag_bytes', 'progress_percent', 'upstream_name', 'upstream_offset'))
        if link.allow_config:
            # Monitoring's configuration allowlist/redaction still applies.
            from .probes.remote_probe import clean_configuration
            node['redis']['configuration'] = clean_configuration(source['redis'].get('configuration', {}))
            node['redis']['config_status'] = source['redis'].get('config_status')
        node['hardware'] = copy.deepcopy(source.get('hardware', {})) if link.allow_details else {}
        node['container'] = copy.deepcopy(source.get('container', {})) if link.allow_details else {}
        node['storage'] = copy.deepcopy(source.get('storage', [])) if link.allow_details else []
        result['nodes'].append(node)
    if link.allow_events:
        result['events'] = [pick(event, ('id', 'kind', 'message', 'time', 'cluster'))
                            for event in snapshot.get('events', []) if event.get('cluster') == link.cluster]
    return result


def init_sharing(app, monitor, snapshot_for):
    store = app.extensions['accounts']

    def authenticate_share():
        token = request.view_args.get('token', '')
        link = None
        if re.fullmatch(r'[A-Za-z0-9_-]{64}', token):
            now = time.time()
            with store.session.begin() as db:
                link = db.scalar(select(ShareLink).join(User, ShareLink.owner_id == User.id).where(
                    ShareLink.token_hash == digest(token), ShareLink.revoked_at.is_(None),
                    or_(ShareLink.expires_at.is_(None), ShareLink.expires_at > now), User.active.is_(True)))
                if link and (not link.last_used_at or now - link.last_used_at > 60):
                    link.last_used_at = now
        if not link:
            if request.endpoint != 'shared_view':
                return jsonify(error='This viewing link has expired or is no longer available.'), 404
            return render_template('share_unavailable.html'), 404
        g.share = link

    app.extensions['shared_auth'] = authenticate_share

    def scoped_snapshot():
        data = snapshot_for(g.share.cluster)
        # The collector falls back to its first cluster for unknown selectors. A
        # public link must never inherit that fallback when its cluster disappears.
        if data['cluster'] != g.share.cluster or g.share.cluster not in data['clusters']:
            abort(404)
        return data

    @app.route('/shares', methods=['GET', 'POST'])
    def shares():
        data = snapshot_for(request.args.get('cluster'))
        if request.method == 'POST':
            try:
                action = request.form.get('action', 'create')
                if action == 'revoke':
                    link_id = int(request.form.get('link_id', '0'))
                    with store.session.begin() as db:
                        link = db.get(ShareLink, link_id)
                        if not link or link.owner_id != g.user.id:
                            abort(404)
                        link.revoked_at = time.time()
                    flash('Viewing link revoked. Existing viewers lose access on their next request.', 'success')
                elif action == 'create':
                    cluster = request.form.get('cluster', '')
                    label = request.form.get('label', '').strip()
                    duration = request.form.get('duration', '3600')
                    if cluster not in data['clusters']:
                        raise ValueError('Choose a monitored cluster.')
                    if not label or len(label) > 100:
                        raise ValueError('Give your link a name of 1–100 characters.')
                    if duration not in EXPIRATIONS:
                        raise ValueError('Choose a supported expiration time.')
                    now = time.time()
                    token = secrets.token_urlsafe(48)
                    with store.session.begin() as db:
                        link = ShareLink(owner_id=g.user.id, token_hash=digest(token), cluster=cluster,
                            label=label, expires_at=now+EXPIRATIONS[duration] if EXPIRATIONS[duration] else None,
                            **{f'allow_{scope}': request.form.get(scope) == 'on' for scope in SCOPES})
                        db.add(link)
                        db.flush()
                        session['new_share'] = {'id': link.id, 'token': token}
                else:
                    raise ValueError('Unknown sharing action.')
            except ValueError as error:
                flash(str(error), 'error')
            return redirect(url_for('shares', cluster=data['cluster']))
        new_share = session.pop('new_share', None)
        created_path = None
        if new_share:
            with store.session() as db:
                link = db.get(ShareLink, new_share['id'])
                if link and link.owner_id == g.user.id and not link.revoked_at:
                    created_path = url_for('shared_view', token=new_share['token'])
        with store.session() as db:
            links = list(db.scalars(select(ShareLink).where(ShareLink.owner_id == g.user.id).order_by(ShareLink.created_at.desc())))
        return render_template('shares.html', page='shares', title='Share a clear view',
            description='Give someone a focused, read-only window into one cluster.',
            clusters=data['clusters'], selected_cluster=data['cluster'], links=links,
            created_path=created_path, now=time.time())

    @app.get('/s/<token>')
    @app.get('/s/<token>/<view>')
    def shared_view(token, view='live'):
        permissions = {scope: getattr(g.share, f'allow_{scope}') for scope in SCOPES}
        if view not in ('live', 'logs', 'activity'):
            abort(404)
        if view == 'logs' and not permissions['logs'] or view == 'activity' and not permissions['events']:
            abort(403)
        scoped_snapshot()
        titles = {'live': 'Live cluster', 'logs': 'Live logs', 'activity': 'Cluster activity'}
        return render_template(f'{view}.html', page=view, title=titles[view],
            description=g.share.label, monitoring=True, shared=True, permissions=permissions,
            share=g.share, api_base=url_for('shared_cluster', token=token).rsplit('/cluster', 1)[0])

    @app.get('/s/<token>/api/cluster')
    def shared_cluster(token):
        return jsonify(shared_snapshot(scoped_snapshot(), g.share))

    @app.get('/s/<token>/api/logs/<name>/<service>')
    def shared_logs(token, name, service):
        if not g.share.allow_logs:
            abort(403)
        data = scoped_snapshot()
        if service not in ('redis', 'sentinel') or not any(node['name'] == name for node in data['nodes']):
            abort(404)
        logs = monitor.log_snapshot(name, service)
        if logs is None:
            abort(404)
        return jsonify(logs)
