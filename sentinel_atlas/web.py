import atexit
import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from .monitoring.monitor import LiveMonitor
from .settings import Settings
from .auth import init_auth

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

    @app.after_request
    def headers(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"
        return response

    @app.get('/')
    def index():
        return render_template('index.html')

    @app.get('/healthz')
    def health():
        return jsonify({'status': 'ok'})

    @app.get('/api/cluster')
    def cluster():
        if monitor.mode == 'demo':
            scenario = request.args.get('scenario', 'healthy')
            return jsonify(monitor.sample(scenario if scenario in ('healthy','down','failover') else 'healthy'))
        return jsonify(monitor.snapshot(request.args.get('cluster')))

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
