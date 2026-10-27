import atexit
import os
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request, url_for

from .monitoring.monitor import LiveMonitor
from .settings import Settings
from .auth import init_auth
from .sharing import init_sharing
from .terminal import init_terminal

from .paths import ROOT_DIR, load_environment


def create_app(monitor=None, config=None):
    load_environment()
    instance = Path(os.getenv('SENTINEL_INSTANCE_PATH', str(ROOT_DIR / 'instance'))).expanduser().resolve()
    app = Flask(__name__, instance_path=str(instance))
    init_auth(app, config)
    if monitor is None:
        monitor = build_monitor(Settings.from_env())
        monitor.start()
        atexit.register(monitor.stop)
    app.extensions['cluster_monitor'] = monitor

    def snapshot_for(cluster=None, scenario='healthy'):
        if monitor.mode == 'demo':
            return monitor.sample(scenario if scenario in ('healthy', 'down', 'failover') else 'healthy')
        return monitor.snapshot(cluster)

    init_sharing(app, monitor, snapshot_for)
    init_terminal(app, monitor)

    @app.context_processor
    def workspace_context():
        return {'workspace_url': lambda endpoint: url_for(endpoint, **({'cluster': request.args['cluster']} if request.args.get('cluster') else {})),
                'user_profile': app.extensions['accounts'].profile(g.user.id) if getattr(g, 'user', None) else None}

    @app.after_request
    def headers(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        if request.endpoint in ('shared_view', 'shared_cluster', 'shared_logs', 'shares'):
            response.headers['X-Robots-Tag'] = 'noindex, nofollow'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"
        return response

    @app.get('/')
    def index():
        return render_template('index.html', page='overview', title='Your cluster, at a glance',
            description='Health, replication, and the signals that need your attention.', monitoring=True)

    @app.get('/live')
    def live():
        return render_template('live.html', page='live', title='Live cluster',
            description='Follow replication in real time. Scroll to zoom and drag to explore.', monitoring=True)

    @app.get('/instances')
    def instances():
        return render_template('instances.html', page='instances', title='Every instance, in detail',
            description='Find a node and inspect its configuration, replication, and storage.', monitoring=True)

    @app.get('/logs')
    def logs_page():
        return render_template('logs.html', page='logs', title='Live logs',
            description='Redis and Sentinel output, together in one console.', monitoring=True)

    @app.get('/activity')
    def activity():
        return render_template('activity.html', page='activity', title='Cluster activity',
            description='Track outages, recoveries, and master promotions.', monitoring=True)

    @app.get('/about')
    def about():
        return render_template('about.html', page='about', title='Built in the open',
            description='A community-minded observatory for Redis and Sentinel.')

    @app.get('/healthz')
    def health():
        return jsonify({'status': 'ok'})

    @app.get('/api/cluster')
    def cluster():
        return jsonify(snapshot_for(request.args.get('cluster'), request.args.get('scenario', 'healthy')))

    @app.post('/api/refresh')
    def refresh():
        monitor.refresh()
        return jsonify({'queued':True}), 202

    @app.get('/api/logs/<name>/<service>')
    def logs(name, service):
        if service not in ('redis', 'sentinel'):
            return jsonify({'error': 'Unknown service.'}), 400
        if monitor.mode == 'demo':
            scenario = request.args.get('scenario', 'healthy')
            monitor.sample(scenario if scenario in ('healthy', 'down', 'failover') else 'healthy')
        data = monitor.log_snapshot(name, service)
        if data is None:
            return jsonify({'error': 'Unknown instance.'}), 404
        return jsonify(data)

    return app


def build_monitor(settings):
    if settings.backend == 'direct':
        from .monitoring.direct_monitor import DirectMonitor
        return DirectMonitor(settings)
    return LiveMonitor(settings)
