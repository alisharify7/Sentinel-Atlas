<p align="center">
  <img src="docs/assets/cover.svg" alt="Sentinel Atlas — Every node. One clear view. An owl watches over standalone Redis, replication, and Sentinel." width="100%">
</p>

<h1 align="center">Sentinel Atlas 2.0.0</h1>

<p align="center">
  A self-hosted observatory with administrator terminals for Redis and Redis Sentinel.<br>
  Explore your cluster. Run commands. Share the right view.
</p>

<p align="center">
  <strong>Python 3.12–3.14</strong> &nbsp;·&nbsp; Flask &nbsp;·&nbsp; Redis &nbsp;·&nbsp; SQLite / PostgreSQL
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &nbsp;·&nbsp;
  <a href="#workspace-screenshots">Screenshots</a> &nbsp;·&nbsp;
  <a href="#connect-your-redis">Connect Redis</a> &nbsp;·&nbsp;
  <a href="#run-commands-on-a-node">Node terminals</a> &nbsp;·&nbsp;
  <a href="docs/docker.md">Docker</a> &nbsp;·&nbsp;
  <a href="docs/configuration.md">Configuration guide</a> &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Release notes</a> &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a> &nbsp;·&nbsp;
  <a href="#support-the-project">Donate</a> &nbsp;·&nbsp;
  <a href="LICENSE">License</a>
</p>

---

## Your Redis, in view

Sentinel Atlas brings cluster health, live replication, instance configuration,
service logs, and administrator terminals into a workspace with dedicated pages. Start with an automatically
arranged topology, zoom at the cursor, and move nodes while their links follow.
Lock a view for an incident, export the complete map, or share one cluster through
a revocable link with the permissions and lifetime you choose.

Use it for a single cache, a primary/replica group, or a Sentinel deployment.
Connect directly from Windows, macOS, or Linux, or add optional server probes
for Linux hardware, storage, and live service logs.

<p align="center">
  <img src="docs/assets/demo-dashboard.png" alt="Live cluster page with labeled navigation, Redis master and replicas, wheel zoom, layout lock, fullscreen and download controls, Sentinel monitors, and the instance inspector." width="100%">
  <br><sub>Live cluster · built-in demo data · interactive replication map, Sentinel agreement, and instance inspection</sub>
</p>

| Feature | What you can do |
| --- | --- |
| **Overview** | See cluster health, online instances, quorum, the current master, and signals that need attention |
| **Interactive live cluster** | Zoom with the mouse wheel, Ctrl+wheel, or trackpad; pan the canvas; drag nodes with links updating immediately |
| **View controls** | Fit every node, reset the layout, enter fullscreen, or lock the camera and positions while live status keeps updating |
| **Graph downloads** | Save the full current layout as standalone SVG, high-resolution PNG, or a single-page PDF, including nodes outside the visible area |
| **Replication & Sentinel** | Follow observed upstream links, sampled offset gaps, full-sync progress, role changes, quorum, and master agreement |
| **Instance explorer** | Search by name or address, filter by role or availability, and inspect configuration, memory, persistence, and optional server/storage details |
| **Live logs** | Watch Redis and Sentinel output with filtering, pause/resume, and follow-scrolling through server probes |
| **Node terminals** | Run live Redis or Sentinel commands as an administrator, switch databases with `SELECT` or the DB control, and recall commands with ↑/↓ |
| **Cluster activity** | Filter discovery, outages, recoveries, warnings, and master promotions for the selected cluster |
| **Multiple clusters** | Switch between caches and replication groups; keep the selected cluster and instance as you navigate |
| **Profiles & sessions** | Update your username, password, display name, contact information, team, biography, and timezone; sign out other sessions |
| **Scoped viewing links** | Share one cluster without requiring a recipient account; choose graph-only access or independently enable configuration, logs, server details, and activity |
| **Link management** | Edit a link's name, permissions, or expiry without changing its URL; renew expired links, revoke access, or delete links permanently |
| **Expiry & revocation** | Generate links for 15 minutes, 1 hour, 24 hours, 7 days, 30 days, or permanently; review when they were last viewed |
| **Workspace accounts** | Require login for the private workspace, manage admin/viewer accounts, and revoke sessions and links when disabling an account |
| **Open source** | Find creator credits, community acknowledgments, source, license, and contribution links inside the app |

Background monitoring observes Redis without changing it. Administrator terminals
execute commands immediately with the configured Redis account's permissions.
Viewer accounts and shared links remain read-only.

### Run commands on a node

On **Live cluster** or **Instances**, select a node and open **Terminal** while
signed in as an administrator. Choose Redis or Sentinel where both are configured.
Use commands such as `PING`, `INFO`, `SET "my key" "hello world"`, or
`GET "my key"`. Enter `SELECT 2`, or enter `2` in the DB control and click
**Switch**, to change the selected Redis database. Redis validates the database;
a failed switch leaves the previous selection intact. Sentinel uses database 0.

Each node and service retains its database, history, and output while you navigate
within the page. Use ↑/↓ for history, `HELP` for examples, and `clear` or Ctrl+L
to clear output. Reloading the page clears this browser memory.
Direct connections reuse configured authentication and TLS settings;
SSH probes execute through the existing inventory and `redis-cli` installation.

Click **Fullscreen** (or press **Alt+Enter** inside the terminal) for a dedicated
command workspace. **Escape** or **Exit fullscreen** returns to the inspector;
your database, history, draft, and running command are preserved. Use **−** / **+**
to change terminal text size, or click the percentage to reset it. While the terminal
is focused, **Ctrl/⌘ +**, **Ctrl/⌘ −**, and **Ctrl/⌘ 0** provide the same controls.
You can type your next command while one is executing; press Enter after it finishes
to run the draft. The fullscreen workspace fills the browser window and keeps
keyboard focus inside the terminal until you exit.

Each command uses a separate connection with a short execution timeout. Transactions,
subscriptions, `MONITOR`, and connection mode changes need a persistent Redis client
and are unavailable in this terminal. A timeout can leave a command's outcome
uncertain; check Redis before retrying a write.

## Workspace screenshots

These screenshots come from the built-in demo. Addresses, metrics, and profile
information are sample values; no live infrastructure or bearer URLs are shown.

<details>
<summary><strong>Overview — health and the signals that need attention</strong></summary>
<p align="center"><img src="docs/assets/demo-overview.png" alt="Overview page showing cluster summary cards, an All clear health panel, quick links, and recent cluster events." width="100%"></p>
</details>

<details open>
<summary><strong>Node terminal — commands, database switching, and simulated demo replies</strong></summary>
<p align="center"><img src="docs/assets/demo-terminal.png" alt="Instances page with the master node selected and an interactive demo terminal showing PING, SELECT 2, and GET demo:environment returning staging, alongside Redis service and database controls." width="100%"></p>
</details>

<details>
<summary><strong>Fullscreen terminal — more room to work, with text zoom and keyboard controls</strong></summary>
<p align="center"><img src="docs/assets/demo-terminal-fullscreen.png" alt="Fullscreen Redis terminal showing demo command replies in database 2, a focused command input, text zoom at 114 percent, and an Exit fullscreen control." width="100%"></p>
</details>

<details>
<summary><strong>Share links — one cluster, selected permissions, and an expiry</strong></summary>
<p align="center"><img src="docs/assets/demo-sharing.png" alt="Share links page with expiry and permission controls, plus Edit, Revoke link, and Delete actions for generated links." width="100%"></p>
</details>

<details>
<summary><strong>Your profile — identity, preferences, and session security</strong></summary>
<p align="center"><img src="docs/assets/demo-profile.png" alt="Profile page with sample display name, contact email, team, timezone, biography, password controls, and active sessions." width="100%"></p>
</details>

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
python -m sentinel_atlas --demo
```

Open **[localhost:5050](http://127.0.0.1:5050)** and sign in. Demo mode uses clearly
labelled sample data and includes healthy, outage, and master-promotion scenarios.
It makes no Redis or SSH connections. Login is required in demo mode too.

### Try the demo terminal

Open **Instances**, select **redis2** (the master in the Healthy scenario), and
choose **Terminal**. The **DEMO TERMINAL · SIMULATED** label distinguishes sample
commands from a live connection. Try:

```text
PING
GET demo:message
SET "my key" "hello world"
GET "my key"
SELECT 2
GET demo:environment
GET "my key"
SELECT 0
GET "my key"
```

The last `GET` returns `"hello world"`; database 2 has its own sample keys. The DB
control also switches databases 0–15. Try ↑/↓ to recall commands and Ctrl+L to
clear output. Demo replicas reflect the master's sample writes and reject writes
themselves. Master-promotion and outage scenarios also apply to terminal commands.
Choose **Sentinel** to try `SENTINEL MASTER redis-main` or
`SENTINEL GET-MASTER-ADDR-BY-NAME redis-main`.

The simulation supports string reads/writes, counters, key discovery, `PING`,
`INFO`, `ECHO`, and a few Sentinel inspection commands. Unsupported commands return
an explanation. Demo datasets are private to each administrator, limited to 128
keys / 64 KiB across 16 databases, and discarded when the server restarts; only the
32 most recently active demo datasets are retained. They never reach live Redis.

### Explore the topology

Open **Live cluster** from the navigation menu. Select a Redis node to inspect
its configuration, replication status, and storage.
Drag the canvas with the hand cursor to pan, or drag individual nodes to rearrange
them; replication links follow immediately. Scroll the mouse wheel, hold **Ctrl**
and scroll, or pinch a trackpad to zoom at the cursor. Use **+** and **−** to zoom, **Fit** to
see every node, and **Reset** to restore the automatic layout. The fullscreen icon
expands the graph; use it again or press **Escape** to exit.

Open the download icon to save the complete map as **SVG**, **PNG**, or **PDF**.
Downloads preserve the current node positions and include nodes outside the visible
area, replication links, status, and a timestamp. SVG is a standalone vector image;
PNG is a high-resolution image, and PDF fits the snapshot onto one page.

The lock icon holds the current camera and node positions while metrics, roles,
and links keep updating. Unlock it to pan, zoom, or move nodes again. Polling
preserves custom positions for each cluster while you navigate in the current tab.
With the graph focused, arrow keys pan; **Alt + arrow keys** move a focused node.
Without a custom layout or lock, topology changes fit the new layout automatically.

### A workspace with focused pages

**Overview** highlights health and the signals that need attention. **Instances**
lets you filter by name, address, role, or availability. **Live logs** keeps your
selected instance in focus, and **Activity** filters discovery, outages, recoveries,
warnings, and promotions for the selected cluster. Navigation preserves the selected
cluster and instance.

Use **Your profile** to update your display name, username, email, team, biography,
and timezone. Changing your username requires your current password. Changing your
password signs out all sessions; you can also sign out just your other sessions.

### Share one cluster

Open **Share links**, name the link, choose a cluster, and set an expiry: 15 minutes,
1 hour, 24 hours, 7 days, 30 days, or never. The default is one hour with topology
and health only. Enable configuration, logs, server/storage details, and activity
independently. Copy the generated URL when it appears; it is displayed only once.

Recipients do not need an account. The server checks the link, its expiry, its
permissions, and its cluster on every page and data request. Revocation stops new
reads and clears an open shared view on its next poll. Permanent links stay active
until revoked or the owner's account is disabled. Every shared view is read only.
Anyone with the URL can use it within its permissions, so share it with the intended
audience. See the [configuration guide](docs/configuration.md#viewing-links) for
deployment details.

Use **Edit** next to a generated link to change its name, permissions, or expiration.
**Keep current expiry** preserves its existing deadline; choosing a duration starts
that period from the time you save. An expired link can be renewed, while a revoked
link stays revoked. The URL and cluster remain unchanged. **Delete** opens a
confirmation and permanently removes the link and its access.

<p align="center">
  <img src="docs/assets/topology.svg" alt="Radial topology illustration with one master at the center and six replicas arranged around it, with fit and zoom controls." width="100%">
  <br><sub>Radial topology illustration · one master and six replicas · the built-in demo contains three Redis instances</sub>
</p>

Use the **Sample data** selector to compare a healthy cluster, a node outage, and
a master promotion. During promotion, `redis3` moves to the center and the
replication arrows follow the newly observed upstream relationships.

## Run with Docker

Build an image locally with the helper in the `script` directory:

```bash
./script/make-docker.sh
```

It produces `sentinel-atlas:local` by default. Configure `IMAGE_NAME`, `IMAGE_TAG`,
`BUILD_TARGET`, and `PLATFORMS` through environment variables or command-line options.
Publishing is disabled unless you explicitly set `PUSH=true` or use `--push`.
Use `--dry-run` to inspect the command. The [Docker guide](docs/docker.md#build-and-optionally-publish-an-image)
covers Docker Hub publishing, prebuilt-image Compose, runtime variables, and volumes.

Copy `.env.example` to `.env`, choose your administrator password, and set
`REDIS_URL` to an endpoint reachable from Docker. Then:

```bash
docker compose up -d --build
```

Open **http://127.0.0.1:5050**. The container runs as a non-root user with
Waitress; a named volume preserves its SQLite accounts and signing key.
For Redis on the Docker host, use `host.docker.internal` instead of `localhost`.

The [Docker guide](docs/docker.md) includes demo mode, a PostgreSQL stack,
read-only target mounts, an optional Ansible image, and image verification.

## Connect your Redis

### Standalone Redis

Add these settings to `.env`, then run `python -m sentinel_atlas` without `--demo`:

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
| Dashboard runs on Windows/macOS/Linux | ✓ | Docker, or a Linux/macOS controller |
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

Application code lives in `sentinel_atlas/`, with monitoring workers, remote
probes, templates, and static assets grouped inside the package. See the
[layout and development guide](docs/development.md) for package installation
and entry points. Existing `python app.py` commands continue to work.

```bash
python -m unittest discover -s tests -v
node --check sentinel_atlas/static/app.js
node --check sentinel_atlas/static/workspace.js
node --check sentinel_atlas/static/graph-export.js
node tests/test_ui.js
```

The suite covers authentication, CSRF, profiles, account persistence, session
revocation, share-link expiry and permissions, cluster isolation, standalone
monitoring, server probes, topology changes, log limits, and credential filtering.
UI checks cover radial layouts from 1 to 100 nodes, cursor-anchored wheel/Ctrl zoom,
dragging with live links, view locking, fullscreen, exports, failover, and view
preservation during polling.
The optional Ansible test skips when its
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

## Creator & community

Created and maintained by **Ali Sharify** — [@alisharify7](https://github.com/alisharify7)
on GitHub and [ali-sharify.ir](https://ali-sharify.ir) on the web.

Thank you to the open source community and the maintainers of Python, Redis,
Flask, SQLAlchemy, redis-py, Waitress, Psycopg, PyYAML, python-dotenv, and tzdata.
Bug reports, documentation, reviews, and focused code contributions are welcome.
See [CONTRIBUTING.md](CONTRIBUTING.md), or visit **About & open source** in the app.

## Support the project

If Sentinel Atlas is useful to you, you can support its development by
[buying Ali a coffee on Coffeete](https://www.coffeete.ir/alisharify7).
Bug reports, documentation, and code contributions are also appreciated.
