"""Command-line entry point shared by local installs and Docker."""
import argparse
import logging
import os
import signal

from waitress import serve

from .paths import load_environment
from .settings import Settings
from .web import build_monitor, create_app


def main(argv=None):
    load_environment()
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')
    parser = argparse.ArgumentParser(description='Sentinel Atlas · authenticated Redis and Sentinel observatory.')
    parser.add_argument('--inventory', help='External Ansible inventory; alternatively SENTINEL_INVENTORY.')
    parser.add_argument('--targets', help='External YAML/JSON direct Redis connection definitions.')
    parser.add_argument('--host', default=os.getenv('SENTINEL_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.getenv('SENTINEL_PORT', '5050')))
    parser.add_argument('--interval', type=int)
    parser.add_argument('--demo', action='store_true', help='Use labelled sample data without monitoring connections.')
    args = parser.parse_args(argv)
    try:
        if args.demo:
            from .monitoring.demo import DemoMonitor
            monitor = DemoMonitor(max(2, args.interval or 5))
        else:
            settings = Settings.from_env(args.inventory, args.targets)
            if args.interval:
                settings.interval = max(2, args.interval)
            monitor = build_monitor(settings)
        app = create_app(monitor)
    except (ValueError, OSError) as error:
        parser.error(str(error))

    def terminate(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    if monitor.mode != 'demo':
        monitor.start()
    try:
        serve(app, host=args.host, port=args.port, threads=4, expose_tracebacks=False)
    except KeyboardInterrupt:
        pass
    finally:
        if monitor.mode != 'demo':
            monitor.stop()
        app.extensions['accounts'].engine.dispose()
