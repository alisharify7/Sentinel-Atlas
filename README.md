<p align="center">
  <img src="docs/assets/cover.svg" alt="Sentinel Atlas — Every node. One clear view. An owl watches over standalone Redis, replication, and Sentinel." width="100%">
</p>

<h1 align="center">Sentinel Atlas</h1>

<p align="center">
  A self-hosted, read-only dashboard for Redis and Redis Sentinel.<br>
  See the master. Follow replication. Keep an eye on every node.
</p>

<p align="center">
  <strong>Python 3.12–3.14</strong> &nbsp;·&nbsp; Flask &nbsp;·&nbsp; Redis &nbsp;·&nbsp; SQLite / PostgreSQL
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &nbsp;·&nbsp;
  <a href="#connect-your-redis">Connect Redis</a> &nbsp;·&nbsp;
  <a href="docs/configuration.md">Configuration guide</a> &nbsp;·&nbsp;
  <a href="#development">Contributing</a> &nbsp;·&nbsp;
  <a href="LICENSE">License</a>
</p>

---

## Your Redis, in view

Sentinel Atlas turns Redis roles and Sentinel observations into a visual topology.
A gold crown follows the observed master, replication links show connection
health, and an activity feed records outages, recoveries, and promotions.

Use it for a single cache, a primary/replica group, or a Sentinel deployment.
Connect directly from Windows, macOS, or Linux, or add optional server probes
for Linux hardware, storage, and live service logs.

<p align="center">
  <img src="docs/assets/topology.svg" alt="Topology illustration showing a crowned Redis master, two replicas, health cards, and an instance inspector." width="100%">
  <br><sub>Topology illustration · sample data</sub>
</p>

| Feature | What you can see |
| --- | --- |
| **Live topology** | Current master, replicas, upstream links, synchronization, and role changes |
| **Sentinel health** | Master agreement, configured quorum, and Sentinel availability |
| **Instance details** | Redis version, clients, operations per second, memory, and persistence status |
| **Multiple groups** | Switch between independent caches and replication/Sentinel groups |
| **Live log console** | Redis/Sentinel tails with filtering, pause/resume, and follow-scrolling via server probes |
| **Workspace accounts** | Required login, admin/viewer accounts, password changes, and revocable sessions |

The app observes Redis. It does not trigger failovers, restart services, change
Redis configuration, or manage Redis Cluster hash slots.

## Quick start

### 1. Install

Use Python 3.12–3.14.

```bash
git clone https://github.com/alisharify7/Sentinel-Atlas.git
cd Sentinel-Atlas
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

<details>
<summary><strong>Windows PowerShell</strong></summary>

```powershell
git clone https://github.com/alisharify7/Sentinel-Atlas.git
cd Sentinel-Atlas
py -3.13 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

</details>

### 2. Create your first account

Edit `.env` and choose your own password:

```dotenv
DEFAULT_ACCOUNT=admin
DEFAULT_PASSWORD=replace-with-your-own-long-password
```

The first start creates an administrator in the account database. Existing
accounts are preserved across restarts; changing these environment values does
not reset their passwords. SQLite is ready to use by default.

### 3. Take a look around

```bash
python app.py --demo
```

Open **[localhost:5050](http://127.0.0.1:5050)** and sign in. Demo mode uses clearly
labelled sample data and includes healthy, outage, and master-promotion scenarios.
It makes no Redis or SSH connections. Login is required in demo mode too.

## Connect your Redis

### Standalone Redis

Add these settings to `.env`, then run `python app.py` without `--demo`:

```dotenv
SENTINEL_BACKEND=direct
REDIS_URL=redis://127.0.0.1:6379/0
```

For authentication, use `redis://username:password@host:port/0`, or
`redis://:password@host:port/0` for the default Redis user. URL-encode special
characters in credentials. Use `rediss://` for TLS with certificate verification.

### Replication and Sentinel

For several instances, create an external targets file:

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
```

Set the referenced URL environment variables and add:

```dotenv
SENTINEL_BACKEND=direct
SENTINEL_TARGETS=/absolute/path/to/targets.yml
```

Nodes in the same group share a cluster name; with Sentinel, that name must
match its monitored master. Give independent standalone servers different names
in `cluster`. The header selector switches between groups.

See the [targets example](examples/targets.yml) and [full connection guide](docs/configuration.md#redis-sentinel-replication-and-multiple-clusters)
for Sentinel-only nodes, TLS certificates, ACL credentials, and NAT endpoints.

## Choose how you connect

![Architecture diagram: Sentinel Atlas connects directly to Redis or uses optional Ansible probes; accounts and sessions persist in SQLite or PostgreSQL.](docs/assets/architecture.svg)

| Capability | Direct Redis connection | Ansible server probe |
| --- | :---: | :---: |
| Redis metrics, roles, and replication | ✓ | ✓ |
| Sentinel master view and quorum | ✓ | ✓ |
| TLS and ACL authentication | ✓ | ✓ |
| Server CPU, memory, and storage | — | ✓ |
| Redis and Sentinel log files | — | ✓ |
| Dashboard runs on Windows/macOS/Linux | ✓ | Ansible controller on Linux/macOS |
| Server deployment | Any reachable Redis endpoint | Ordinary Linux hosts or systemd-nspawn |

The Redis protocol does not expose operating-system metrics or server log files.
Install `requirements-ansible.txt` and supply an external inventory to add those
features. Server probes read existing data and do not install packages.

- [Ordinary Linux server inventory](examples/inventory-host.yml)
- [systemd-nspawn inventory](examples/inventory-nspawn.yml)
- [Server probe configuration](docs/configuration.md#optional-linux-server-probes-hardware-and-logs)

## Accounts and storage

SQLite stores accounts, session records, and login throttles in
`instance/atlas.sqlite`. For PostgreSQL, create a dedicated database and set:

```dotenv
DATABASE_URL=postgresql+psycopg://atlas:your-password@localhost:5432/atlas
```

Administrators can create and disable accounts. All active accounts can view
configured groups and logs; viewers cannot manage other accounts. Passwords are
hashed, sessions can be revoked, and state-changing requests require CSRF tokens.

**Live telemetry stays in memory.** The database is for account access, rather
than a metrics archive. Recent history, events, and bounded log tails reset when
the app restarts.

Keep `.env`, signing keys, account databases, and inventories out of Git. For
network deployment, use a production WSGI server with HTTPS and set
`SESSION_COOKIE_SECURE=true`. Read the [account and database guide](docs/configuration.md#accounts-and-databases)
for bootstrap behavior, session signing keys, and database URLs.

## How observations work

A background worker collects data every five seconds by default. Browser tabs
read cached observations, so opening more tabs does not start more probes.

Health reflects the configured members: one observed master, connected replicas,
and Sentinel agreement where Sentinel is configured. Unreachable nodes lose
their current-role crown, while retained observations receive stale labels.
Log tails are bounded to the latest 120 lines, with known Redis/Sentinel
passwords and common credential patterns redacted before transport.

See [collection and log behavior](docs/configuration.md#live-logs-and-collection)
for limits and [environment settings](docs/configuration.md#settings-and-launchers)
for polling, ports, and backend selection.

## Development

```bash
python -m unittest discover -s tests -v
```

The suite covers authentication, CSRF, account persistence, session revocation,
standalone monitoring, independent groups, server probes, topology changes,
log limits, and credential filtering. The optional Ansible test skips when its
dependencies are absent.

To test against real PostgreSQL, Redis replication, and Sentinel using disposable
Docker containers:

```bash
python tests/integration.py
```

The script binds test ports to loopback and removes its containers when finished.

Contributions are welcome. Open an issue with a reproducible example, or submit
a focused pull request with a description of the behavior and relevant checks.
Use sample values in reports; remove passwords, connection secrets, and private
inventory details.

## License

See [LICENSE](LICENSE) for the GNU General Public License, version 2.
