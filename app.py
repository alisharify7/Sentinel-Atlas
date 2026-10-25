import argparse
import atexit
import os
from pathlib import Path
import sys

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from monitor import LiveMonitor
from settings import Settings
from auth import init_auth

load_dotenv(Path(__file__).resolve().parent / '.env', override=False)


def create_app(monitor=None, config=None):
    app = Flask(__name__)
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
        from direct_monitor import DirectMonitor
        return DirectMonitor(settings)
    return LiveMonitor(settings)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Sentinel Atlas · authenticated Redis and Sentinel observatory.')
    parser.add_argument('--inventory', help='External Ansible inventory; alternatively set SENTINEL_INVENTORY.')
    parser.add_argument('--port', type=int, default=int(os.getenv('SENTINEL_PORT','5050')))
    parser.add_argument('--host', default=os.getenv('SENTINEL_HOST','127.0.0.1'))
    parser.add_argument('--interval', type=int)
    parser.add_argument('--demo', action='store_true', help='Use labelled sample data instead of SSH.')
    parser.add_argument('--targets', help='External YAML/JSON direct Redis connection definitions.')
    args = parser.parse_args()
    if args.demo:
        from demo import DemoMonitor
        monitor = DemoMonitor(args.interval or 5)
    else:
        try:
            settings = Settings.from_env(args.inventory, args.targets)
        except (ValueError, OSError) as error:
            parser.error(str(error))
        if args.interval:
            settings.interval = max(2,args.interval)
        try:
            monitor = build_monitor(settings)
        except (ValueError, OSError) as error:
            parser.error(str(error))
    try:
        app = create_app(monitor)
    except ValueError as error:
        parser.error(str(error))
    if monitor.mode != 'demo':
        monitor.start()
        atexit.register(monitor.stop)
    app.run(host=args.host,port=args.port,debug=False,use_reloader=False,threaded=True)
