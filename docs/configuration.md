# Configuration guide

[← Project overview](../README.md)

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
python -m sentinel_atlas
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
accounts. Disabling an account revokes its existing sessions and viewing links. All active accounts
can view every configured cluster and its logs; administrators additionally
manage accounts. **Your profile** supports display name, contact email, team,
biography, timezone, username changes (with current-password verification), password
changes, and signing out other sessions. Password changes sign out all your sessions.
Profile email is contact information, not an email-based recovery mechanism.
There is no public self-registration.

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
Initial tables are created automatically, including additive profile and viewing-link
tables for existing installations. The database stores **accounts, profiles, session
records, login throttles, and viewing links**. Live metrics, log tails, and events remain bounded
in-memory observations; they are not a historical monitoring database. Switching
database URLs does not migrate accounts; an empty database bootstraps a new admin.

If `SECRET_KEY` is unset, the app generates and retains a private signing key in
`instance/session.key`. Keep the instance directory across restarts. For multiple
app instances, supply the same random `SECRET_KEY` (at least 32 characters) and
the same account database. SQLite files, instance keys, `.env`, inventories, and
credentials must stay out of Git. For HTTPS deployments set
`SESSION_COOKIE_SECURE=true`; use a production WSGI server and TLS reverse proxy.
Keep one monitor worker per process; each process collects its own observations.

### Viewing links

Signed-in accounts can create links at `/shares`. Each link is fixed to one
monitored cluster, with topology and health included. Configuration, logs,
server/storage details, and activity are separate optional permissions. Restricted
fields are removed from public API responses. Shared log reads validate that the
instance still belongs to the link's cluster; a removed cluster never falls back
to another cluster.

Expiry choices are 15 minutes, 1 hour (default), 24 hours, 7 days, 30 days, and
permanent. Owners can revoke their own links. Disabling an owner revokes their
links permanently, including after the account is re-enabled. Password changes
revoke account sessions; viewing links remain separately managed on the sharing page.

Owners can **Edit** a generated link's name, optional permissions, and expiration
without changing its URL or cluster. **Keep current expiry** preserves the exact
deadline; choosing a new duration starts it from the save time, and **Never** makes
the link permanent. Expired links can be renewed explicitly. Revoked links cannot
be reactivated or edited. **Delete** asks for confirmation, removes the database
record permanently, and disables that URL. Active, expired, and revoked links can
all be deleted. Every edit, revoke, and delete operation requires login, ownership,
and a CSRF token. Open viewers reload access changes on their next poll, even when
the underlying Redis observation has not changed.

The 64-character random bearer token is generated from 48 random bytes. Only its
SHA-256 digest is stored in the database. The full URL appears once after creation;
copy it then, or create a replacement. Every shared request checks owner status,
expiry, revocation, permissions, and cluster membership. Viewers cannot trigger
collection, manage accounts, or create links. The read-only viewer still supports
local graph movement and SVG/PNG/PDF downloads of its permitted graph data.

Treat viewing URLs as credentials. Deploy behind HTTPS, avoid recording `/s/…`
tokens in reverse-proxy access logs, and share URLs only with the intended audience.
Shared responses disable caching and indexing and set `Referrer-Policy: no-referrer`.
The browser clears an open shared view when a subsequent poll loses access;
revocation cannot erase data someone already downloaded.

## Redis Sentinel, replication, and multiple clusters

For one Redis node with an accompanying Sentinel:

```dotenv
SENTINEL_BACKEND=direct
REDIS_URL=redis://redis-host:6379/0
SENTINEL_URL=redis://sentinel-host:26379/0
REDIS_CLUSTER=redis-main
```

`REDIS_CLUSTER` must match the Sentinel monitored master name. For a complete
fleet, copy [examples/targets.yml](../examples/targets.yml), set the referenced
connection environment variables, then configure:

```dotenv
SENTINEL_BACKEND=direct
SENTINEL_TARGETS=/absolute/path/to/targets.yml
```

Or use `python -m sentinel_atlas --targets /path/to/targets.yml`. YAML and JSON are supported:

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

### Watching replication during a load test

Every Redis graph card and the fleet's **Sync status** column show **In sync**,
**Catching up**, **Full sync**, **Loading dataset**, **Link down**, or **Unavailable**.
Masters are labeled **Master**. Leave the dashboard open while running your
`load.sh`; these values update automatically with each collection.

Replica cards show a sampled byte gap from the upstream's replication offset.
The **Overview → Live replication** section also shows processed/upstream offsets
and time since the last upstream I/O. Gaps compare independently collected samples
and are approximate during writes; zero means caught up at those observations.
If the upstream is unmonitored, offsets are missing, or replication IDs differ
after failover, the dashboard shows **Sync unknown** rather than claiming success.

Full sync transfers and dataset loading show progress when Redis reports enough
information. Diskless transfers with an unknown total size show received bytes
without inventing a percentage. These metrics come from Redis's read-only
[`INFO` replication and persistence fields](https://redis.io/docs/latest/commands/info/).
For more frequent observations, set `SENTINEL_POLL_INTERVAL=2` and restart the app;
the default collection interval is five seconds.

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

Start from [examples/inventory-host.yml](../examples/inventory-host.yml) for ordinary
Linux servers or [examples/inventory-nspawn.yml](../examples/inventory-nspawn.yml).
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
Monitoring access requires Redis INFO and, when configured, CONFIG GET
and Sentinel read commands. This app does not administer Redis Cluster hash slots.

Click a Redis node in the topology graph or fleet table to open its **Configuration**
tab. It lists that node's runtime settings from `CONFIG GET *`, with search by name
or value. The **Overview** and **Storage & paths** tabs provide its metrics and
environment details. Settings refresh with the normal background collection.
Credentials, authentication secrets, and private key paths are redacted before
transport. If `CONFIG GET` is denied or unavailable, the tab explains that the
configuration cannot be read; permitted `INFO` metrics continue to work.

The topology uses teal for masters, blue for replicas, and violet for Sentinel
monitors. The **Sentinel watch** row shows each monitor's quorum status, master
view, and peers. Select a monitor to open its **Sentinel** inspector. Warnings
identify missing quorum or disagreement; unavailable services are marked in red.

## Live logs and collection

Monitoring pages have an **Auto refresh** selector for 1, 5, 10, 15, or 30 seconds.
The default is 5 seconds. The browser stores the choice separately for each page
and account or shared view; changing one page does not change another. Logs follow
the selected page interval and retain their separate Pause control. Changing the
interval immediately checks for updates, replaces the previous timer, and avoids
overlapping slow requests. Browser storage restrictions do not prevent selecting
an interval for the current visit.

This setting controls how often the page checks the cached observations. Live
measurements still follow the server's `SENTINEL_POLL_INTERVAL`; the selector shows
the sampling interval. It does not change other viewers or start extra SSH probes.

The console includes node/service selection, text filtering, pause/resume, and
follow-scrolling. Server probes read up to 32 KiB and retain the latest 120 lines,
limited to 1,000 characters per line. Configured files work even if Redis is down
but its server/container remains reachable; empty paths use journald. Known Redis
and Sentinel passwords and common credential patterns are redacted before
transport. Other application content may still occur in logs.

**Download logs** saves the selected Redis or Sentinel console view as a UTF-8
`.log` file. Downloads contain the latest collected tail, apply the current text
filter, and preserve a paused observation. They include the node, service, source,
UTC observation/download times, and stale/demo labels. They do not fetch the full
server file or open another SSH connection. Clear the filter for all collected
lines. Downloads are available to anyone already permitted to view those logs;
shared links still require the logs permission. The control is disabled when no
collected lines match, or when log collection is unsupported or unavailable.

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

Preview labelled sample data with `python -m sentinel_atlas --demo`. Login is required in
demo mode too; it makes no monitoring connections.

Demo administrators can open a node's Terminal tab to try simulated Redis commands
and database switching. The demo never executes Redis commands or SSH processes.
Sample writes are private to each account, limited to 128 keys / 64 KiB, and lost
on server restart. Switch to a live configuration to run commands on real nodes;
live command execution requires an administrator and uses the configured Redis ACL.

An external Ansible repository can keep a `visualize.sh` launcher that points to
this checkout. It supplies inventory/config paths and installs the optional
Ansible requirements. Sentinel Atlas also runs independently with `python -m sentinel_atlas`.

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
