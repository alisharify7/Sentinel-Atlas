# Sentinel Atlas

A standalone Flask observatory for **standalone Redis, Redis replication, and
Redis Sentinel**. Watch roles, master promotions, replication links, memory,
activity, and service logs behind a required account login.

Connect directly to Redis on any platform, or use optional Ansible probes for
Linux server hardware, filesystem statistics, and log files. Ordinary Ubuntu
servers and systemd-nspawn containers are supported. Nothing imports the parent
Ansible project or requires its roles.

## Quick start: standalone Redis

Use Python 3.12–3.14. From this directory:

```bash
python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows PowerShell instead:
# .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
cp .env.example .env
```

Set these values in `.env`, choosing your own password:

```dotenv
DEFAULT_ACCOUNT=admin
DEFAULT_PASSWORD=your-own-long-password
SENTINEL_BACKEND=direct
REDIS_URL=redis://127.0.0.1:6379/0
```

For authenticated Redis, use `redis://username:password@host:port/0` (or
`redis://:password@host:port/0` for the default Redis user). URL-encode special
characters in credentials. Use `rediss://` for TLS with certificate verification.

```bash
python app.py
```

Open **http://127.0.0.1:5050** and sign in with the account from `.env`.
Windows users can copy `.env.example` with `Copy-Item` or their file manager.
Direct mode needs network access to Redis, with no SSH, Ansible, systemd,
`redis-cli`, or agents on the monitored server.

## Accounts and databases

All dashboard pages, metrics, logs, and refresh endpoints require login. The login
page and static assets are public. Passwords use Werkzeug's scrypt password hash;
raw passwords are never stored. Sessions are revocable, backed by the database,
and expire after eight hours. Forms and state-changing APIs require CSRF tokens.
Five failed sign-in attempts from an address block further attempts for five
minutes. IP addresses are taken from the server connection, not arbitrary
forwarded headers.

`DEFAULT_ACCOUNT` defaults to `admin`; `DEFAULT_PASSWORD` is required when the
account database is empty. Lowercase `default_account` and `default_password`
are also accepted. Bootstrap runs only for an empty database: changing these
environment settings does **not** reset existing passwords or recreate disabled
users. The initial account is an administrator.

Use **Accounts** to create viewers or other administrators and enable/disable
accounts. Disabling an account revokes its existing sessions. All active accounts
can view every configured cluster and its logs; administrators additionally
manage accounts. Use your account name in the header to change your password,
which signs out all your sessions. There is no public self-registration.

SQLite works without an external database server. Its default file is
`instance/atlas.sqlite` beside the app. To use a different SQLite file:

```dotenv
DATABASE_URL=sqlite:////absolute/path/to/atlas.sqlite
# Windows example: sqlite:///C:/atlas/atlas.sqlite
```

For PostgreSQL, create a dedicated database and configure:

```dotenv
DATABASE_URL=postgresql+psycopg://atlas:your-database-password@127.0.0.1:5432/atlas
```

Plain `postgresql://` and `postgres://` URLs are also accepted and use psycopg 3.
Initial tables are created automatically. The database stores **accounts, session
records, and login throttles**. Live metrics, log tails, and events remain bounded
in-memory observations; they are not a historical monitoring database. Switching
database URLs does not migrate accounts; an empty database bootstraps a new admin.

If `SECRET_KEY` is unset, the app generates and retains a private signing key in
`instance/session.key`. Keep the instance directory across restarts. For multiple
app instances, supply the same random `SECRET_KEY` (at least 32 characters) and
the same account database. SQLite files, instance keys, `.env`, inventories, and
credentials must stay out of Git. For HTTPS deployments set
`SESSION_COOKIE_SECURE=true`; use a production WSGI server and TLS reverse proxy.
Keep one monitor worker per process; each process collects its own observations.

## Redis Sentinel, replication, and multiple clusters

For one Redis node with an accompanying Sentinel:

```dotenv
SENTINEL_BACKEND=direct
REDIS_URL=redis://redis-host:6379/0
SENTINEL_URL=redis://sentinel-host:26379/0
REDIS_CLUSTER=redis-main
```

`REDIS_CLUSTER` must match the Sentinel monitored master name. For a complete
fleet, copy [examples/targets.yml](examples/targets.yml), set the referenced
connection environment variables, then configure:

```dotenv
SENTINEL_BACKEND=direct
SENTINEL_TARGETS=/absolute/path/to/targets.yml
```

Or use `python app.py --targets /path/to/targets.yml`. YAML and JSON are supported:

```yaml
nodes:
  - name: primary
    cluster: redis-main
    url_env: PRIMARY_REDIS_URL
    sentinel_url_env: PRIMARY_SENTINEL_URL
  - name: replica
    cluster: redis-main
    url_env: REPLICA_REDIS_URL
    sentinel_url_env: REPLICA_SENTINEL_URL
  - name: independent-cache
    cluster: independent-cache
    url_env: CACHE_REDIS_URL
```

Sentinel-only nodes can omit `url_env`. Literal `url` and `sentinel_url` fields
are accepted, but environment references keep secrets out of configuration files.
For TLS, optional target fields `ssl_ca_certs`, `ssl_certfile`, and `ssl_keyfile`
identify certificate files on the dashboard machine. Certificate verification
remains enabled. Connection URLs cannot contain query parameters.

Give independent standalone servers different cluster names. Nodes in the same
replication/Sentinel group share a cluster name. The header selector switches
between configured clusters, each with its own health and master. Configure every
expected Redis/Sentinel member to monitor the complete group.

For DNS aliases or NAT, `advertise_address` and `advertise_port` describe the
master endpoint reported by replicas/Sentinels. The URL remains the dashboard's
connection endpoint. Replication health needs those reported endpoints to match.
The live master comes from Redis's current role, not a bootstrap designation.

A healthy standalone server reports one master and no required Sentinel. A
healthy replicated group additionally requires its configured replicas connected
to that master. Sentinel groups also require observed quorum and agreement.
Split masters, failed authentication, broken replication, and outages are shown.

## Optional Linux server probes: hardware and logs

Direct Redis connections can read Redis/Sentinel metrics, but the Redis protocol
does **not** expose operating-system hardware, disk mounts, or log file contents.
Use server probes for these details. Install the optional dependencies on a
Linux/macOS Ansible controller:

```bash
python -m pip install -r requirements-ansible.txt
```

Set the external inventory and optional configuration paths:

```dotenv
SENTINEL_BACKEND=ansible
SENTINEL_INVENTORY=/absolute/path/to/inventory.yml
SENTINEL_ANSIBLE_CONFIG=/absolute/path/to/ansible.cfg
# SENTINEL_VAULT_PASSWORD_FILE=/absolute/path/to/vault-password-file
```

Start from [examples/inventory-host.yml](examples/inventory-host.yml) for ordinary
Linux servers or [examples/inventory-nspawn.yml](examples/inventory-nspawn.yml).
These are external inventories; the app never edits server configuration. Ansible
handles SSH keys, ports, host-key checking, sudo, variables, and vault decryption.
Remote servers need Python 3, `redis-cli`, and read access to metrics and logs.
Probes use sudo by default; set `ansible_become: false` for a user with sufficient
permissions. nspawn additionally needs a registered container and `redis-cli`
inside that container. Packages are never installed by the dashboard.

By default, groups are `redis_nodes` and `sentinel_nodes`. Omit `sentinel_nodes`
for standalone Redis. Defaults to host execution unless `container_name` is set;
use explicit `dashboard_deployment: host` or `nspawn` to choose. Existing nspawn
inventory variables continue to work.

| Host/group variable | Purpose |
| --- | --- |
| `dashboard_deployment` | `host` or `nspawn` |
| `container_name` | nspawn machine name |
| `redis_listen_port`, `redis_sentinel_port` | Ports, default 6379 / 26379 |
| `redis_sentinel_master_name` | Cluster/master name; default `redis` |
| `redis_username`, `redis_password` | Redis ACL user and password; may be vaulted |
| `sentinel_username`, `sentinel_password` | Separate Sentinel credentials |
| `dashboard_redis_host`, `dashboard_sentinel_host` | Address queried from the server/container; default loopback |
| `dashboard_advertise_address` | Reported Redis endpoint address; defaults to `ansible_host` |
| `dashboard_tls`, `dashboard_tls_ca` | TLS and CA file path on the monitored machine |
| `dashboard_python`, `dashboard_redis_cli` | Executables; default `/usr/bin/python3`, `/usr/bin/redis-cli` |
| `dashboard_redis_service`, `dashboard_sentinel_service` | Systemd names without `.service`; defaults `redis-server`, `redis-sentinel` |
| `redis_dashboard_logfile`, `sentinel_dashboard_logfile` | Explicit log files; empty string selects journald |
| `dashboard_storage` | List of `{label, host_path, container_path?}` mappings to inspect |

Existing `redis_configs`, `redis_sentinel_logging_config`, `*_mount_point`,
`*_container_path`, and `container_rootfs_directory` variables supply defaults.
Redis's runtime logfile is used unless explicitly overridden. Permission-limited
accounts that cannot use `CONFIG GET` still receive permitted `INFO` metrics.
Monitoring access requires Redis INFO and, when configured, selected CONFIG GET
and Sentinel read commands. This app does not administer Redis Cluster hash slots.

## Live logs and collection

The console includes node/service selection, text filtering, pause/resume, and
follow-scrolling. Server probes read up to 32 KiB and retain the latest 120 lines,
limited to 1,000 characters per line. Configured files work even if Redis is down
but its server/container remains reachable; empty paths use journald. Known Redis
and Sentinel passwords and common credential patterns are redacted before
transport. Other application content may still occur in logs.

Unreachable probes retain their last observations with stale labels. A background
worker collects telemetry; browser polling reads a cached snapshot and does not
open additional SSH/Redis connections. Slow collections do not overlap. The app
keeps 60 history samples per node and 60 session events. Restarting clears these.
Credentials stay server-side, and commands/log output use public-field allowlists.

## Settings and launchers

Process environment overrides `.env`. CLI `--inventory`, `--targets`, `--host`,
`--port`, and `--interval` select paths and server/polling settings.

| Environment setting | Default |
| --- | --- |
| `SENTINEL_BACKEND` | Direct if `REDIS_URL`/targets is set, otherwise Ansible |
| `DEFAULT_ACCOUNT` / `DEFAULT_PASSWORD` | `admin` / required on empty DB |
| `DATABASE_URL` | App-local SQLite file |
| `SECRET_KEY` | Persisted private instance key |
| `SESSION_COOKIE_SECURE` | `false` for local HTTP |
| `SENTINEL_POLL_INTERVAL` | 5 seconds, minimum 2 |
| `SENTINEL_SSH_TIMEOUT` / `SENTINEL_COLLECT_TIMEOUT` | 3 / 20 seconds (Ansible) |
| `SENTINEL_REDIS_GROUP` / `SENTINEL_SENTINEL_GROUP` | `redis_nodes` / `sentinel_nodes` |
| `SENTINEL_HOST` / `SENTINEL_PORT` | `127.0.0.1` / `5050` |

Preview labelled sample data with `python app.py --demo`. Login is required in
demo mode too; it makes no monitoring connections.

An external Ansible project can keep `visualize.sh` to create the virtual
environment and supply inventory/config paths. Move this directory to its own
repository and run that launcher with
`VISUALIZE_APP_DIR=/path/to/sentinel-atlas ./visualize.sh`. It also installs the
optional Ansible requirements. The launcher is not required by this app.

## Tests

```bash
python -m unittest discover -s tests -v
# Optional real-service tests; requires Docker and downloads official images:
python tests/integration.py
```

Tests cover required login, password hashing/persistence, CSRF, role permissions,
session revocation/expiry, throttling, SQLite/PostgreSQL, standalone Redis,
independent clusters, server probes, stale data, promotions, logs, and secret
filtering. The Ansible callback test skips when optional dependencies are absent.
The Docker integration script creates temporary loopback-only Redis/PostgreSQL
containers and removes them when finished.

Database URL syntax follows [SQLAlchemy's engine documentation](https://docs.sqlalchemy.org/en/20/core/engines.html).
Cookie and CSRF handling follow [Flask's security guidance](https://flask.palletsprojects.com/en/stable/web-security/).
