# Project layout and development

[← Project overview](../README.md)

```text
sentinel-atlas/
├── sentinel_atlas/               # Installable application package
│   ├── __init__.py               # Public create_app factory
│   ├── __main__.py               # python -m sentinel_atlas
│   ├── cli.py                    # Waitress server and CLI lifecycle
│   ├── web.py                    # Flask routes and application factory
│   ├── terminal.py               # Administrator command API and database isolation
│   ├── auth.py                   # Login, CSRF, profiles, account management
│   ├── sharing.py                # Revocable scoped public views
│   ├── database.py               # SQLite/PostgreSQL account models
│   ├── paths.py                  # Resource, .env, and instance paths
│   ├── settings.py               # External connection settings
│   ├── monitoring/               # Background workers and public telemetry
│   │   ├── monitor.py            # Cached cluster state and Ansible collector
│   │   ├── direct_monitor.py     # Redis protocol collector
│   │   ├── replication.py        # Sampled replication status and byte gaps
│   │   ├── demo.py               # Labelled sample scenarios
│   │   └── public_schema.py      # Data allowlists
│   ├── probes/                   # Remote resources shipped with the package
│   │   ├── probe.yml
│   │   ├── remote_probe.py       # Self-contained stdlib script for Linux hosts
│   │   └── callback_plugins/
│   ├── templates/               # Jinja pages
│   └── static/                  # CSS, JavaScript, owl artwork
├── tests/                       # Unit, service integration, and Docker checks
├── examples/                    # Target/inventory files and Compose overlays
├── docs/                        # Guides and README artwork
├── app.py                       # Compatibility entry point
├── pyproject.toml               # Package metadata and console command
├── requirements.txt             # Direct monitoring and HTTP dependencies
├── requirements-ansible.txt     # Optional SSH/controller dependencies
├── Dockerfile                   # runtime and optional ansible targets
└── compose.yaml                 # Persistent local deployment
```

## Local environment

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
# For Ansible/server probes:
python -m pip install -e '.[ansible]'
```

Copy `.env.example` to `.env`, set your initial administrator password, and run:

```bash
python -m sentinel_atlas --demo
# Installed console entry point:
sentinel-atlas --demo
# Existing scripts continue to work:
python app.py --demo
```

All three entry points use Waitress and the same CLI options. They start exactly
one background collector per application process. `create_app()` is also exposed
as a WSGI factory; pass an explicit monitor when embedding or testing the app.

A source checkout reads `.env` and writes `instance/` at the repository root,
regardless of the caller's working directory. Installed distributions default
to the current directory. `SENTINEL_ENV_FILE` selects another environment file;
`SENTINEL_INSTANCE_PATH` selects a writable directory for SQLite and the signing
key. An existing root `instance/` directory needs no migration after this layout
change. Environment variables continue to override `.env` values.

## Checks

```bash
python -m unittest discover -s tests -v
node --check sentinel_atlas/static/app.js
node --check sentinel_atlas/static/workspace.js
node --check sentinel_atlas/static/graph-export.js
node --check sentinel_atlas/static/log-export.js
node tests/test_ui.js
node tests/test_logs_ui.js
# Optional Docker-backed service checks:
python tests/integration.py
# Build and verify the packaged runtime container:
python tests/docker_smoke.py
```

Unit tests isolate account databases and use sample credentials. The callback
test also invokes a real Ansible process when optional dependencies are installed.
The integration scripts create only temporary test resources.

`remote_probe.py` is sent to a remote server as a standalone Python source string;
keep it stdlib-only. The Ansible callback is loaded outside normal package import
flow and must only emit whitelisted public data. Keep credentials out of task
arguments, HTTP responses, Docker layers, and committed configuration files.

Node terminals use a separate administrator-only POST endpoint with CSRF checks.
They never borrow monitoring connections. The SSH terminal sends command arguments
as a base64 JSON payload over stdin to avoid shell and Ansible template evaluation;
its dedicated callback emits only the sanitized command result. Keep viewers and
public sharing routes read-only. `tests/test_terminal.py` checks these boundaries,
and the Docker integration script exercises real Redis database isolation.
`monitoring/demo_terminal.py` supplies a bounded, account-private simulation for
demo commands. It must never open a network connection or start a subprocess;
the demo tests enforce that boundary.

Monitoring pages render through `workspace.html` and small panel templates. Keep
page-specific scripts tolerant of absent panels, and avoid fetching logs outside
the Logs page. Profiles and viewing links live in new tables so existing account
and login-session schemas do not require destructive changes. Public share routes
apply a separate response allowlist and check permissions and cluster membership
on every request. `tests/test_sharing.py` covers these boundaries.
