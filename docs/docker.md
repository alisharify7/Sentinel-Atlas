# Run Sentinel Atlas with Docker

[← Project overview](../README.md)

The default image connects directly to Redis/Sentinel. It runs as UID/GID
`10001:10001` and serves HTTP with Waitress. The image contains no default
password, database, inventory, or `.env` file.

## Docker Compose

From the repository root:

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
DEFAULT_ACCOUNT=admin
DEFAULT_PASSWORD=choose-your-own-long-password
SENTINEL_BACKEND=direct
REDIS_URL=redis://host.docker.internal:6379/0
```

`host.docker.internal` reaches Redis on the Docker host. Compose adds a
host-gateway mapping for Linux. Redis must listen on an interface reachable from
Docker; a service bound only to the host's loopback may not be reachable on Linux.
For remote Redis, use its normal hostname/IP. For a service in the same Docker
network, use its service name. `localhost` inside Atlas refers to Atlas's container.

```bash
docker compose up -d --build
docker compose logs -f atlas
```

Open **http://127.0.0.1:5050** and sign in. Configure `ATLAS_PORT` in `.env` if
5050 is already in use. `ATLAS_BIND_ADDRESS` defaults to `127.0.0.1`.

The Compose service has a read-only root filesystem, a writable `/tmp`, and a
named `atlas-data` volume mounted at `/var/lib/sentinel-atlas`. This retains the
SQLite account database and session signing key when the container is replaced.
Leave `DATABASE_URL` unset for the default SQLite file; an absolute host SQLite
path does not automatically become available inside the container.

Stop without deleting account data:

```bash
docker compose down
```

Using `docker compose down -v` deletes the named volumes, including account data.
Changing `DEFAULT_PASSWORD` does not reset an account already stored in a volume.

## Preview with sample data

After setting your admin password in `.env`:

```bash
docker compose build
docker compose run --rm --service-ports atlas --demo
```

Demo mode still requires login and uses the same persistent account volume. Stop
it with Ctrl+C before starting another container on the same published port.

## Docker without Compose

```bash
docker build -t sentinel-atlas:local .
docker volume create sentinel-atlas-data
docker run --rm --name sentinel-atlas \
  --env-file .env \
  --add-host host.docker.internal:host-gateway \
  -p 127.0.0.1:5050:5050 \
  -v sentinel-atlas-data:/var/lib/sentinel-atlas \
  sentinel-atlas:local
```

Append `--demo` to preview sample data. The image entry point accepts the same
`--inventory`, `--targets`, `--interval`, `--host`, and `--port` options as the
Python CLI. Prefer `SENTINEL_PORT` for container port changes so the built-in
health check follows the configured port; update the port mapping too.

For a host bind mount instead of a named volume, make the data directory writable
to UID/GID 10001. Do not mount an existing SQLite database into a writable directory
shared by unrelated services.

## Multiple targets

Keep connection secrets in environment variables. Mount the public target
definition read-only:

```bash
docker run --rm \
  --env-file .env \
  -p 127.0.0.1:5050:5050 \
  -v sentinel-atlas-data:/var/lib/sentinel-atlas \
  --mount type=bind,src="$(pwd)/targets.yml",dst=/config/targets.yml,readonly \
  -e SENTINEL_TARGETS=/config/targets.yml \
  sentinel-atlas:local
```

Use paths inside the container for target definitions and TLS certificate files.
For Compose, use an override that adds the read-only mounts and the
`SENTINEL_TARGETS` setting. The [targets example](../examples/targets.yml) describes
the connection format.

## PostgreSQL stack

Set these values in `.env`, using your own database password:

```dotenv
ATLAS_POSTGRES_PASSWORD=choose-your-own-database-password
DATABASE_URL=postgresql+psycopg://atlas:choose-your-own-database-password@postgres:5432/atlas
```

URL-encode special characters in the password portion of `DATABASE_URL`; keep
the unencoded password in `ATLAS_POSTGRES_PASSWORD`. Then start the overlay:

```bash
docker compose -f compose.yaml -f examples/compose.postgres.yaml up -d --build
```

PostgreSQL is reachable only through the Compose network; it has no published
host port. Atlas waits for its health check before starting. PostgreSQL data
uses `postgres-data`; the Atlas volume still retains the session signing key.
This starts a fresh account database and does not migrate existing SQLite users.

## Optional Ansible image

For Linux server/nspawn probes, build the optional target:

```bash
docker build --target ansible -t sentinel-atlas:ansible .
```

It includes Ansible and an SSH client. Supply configuration through the environment
and read-only mounts, for example:

```bash
docker run --rm \
  --env-file .env \
  -p 127.0.0.1:5050:5050 \
  -v sentinel-atlas-data:/var/lib/sentinel-atlas \
  --mount type=bind,src=/absolute/path/to/ansible-project,dst=/inventory,readonly \
  --mount type=bind,src=/absolute/path/to/ssh-directory,dst=/home/atlas/.ssh,readonly \
  -e SENTINEL_BACKEND=ansible \
  -e SENTINEL_INVENTORY=/inventory/inventory/main.yml \
  -e SENTINEL_ANSIBLE_CONFIG=/inventory/ansible.cfg \
  sentinel-atlas:ansible
```

SSH keys, known-host files, vault-password files, and configured paths must be
readable by the container's UID/GID and refer to mounted paths. If the external
`ansible.cfg` references a vault-password file on your host, mount that file and
set `SENTINEL_VAULT_PASSWORD_FILE` to its container path. Override any configured
Ansible log path to a writable container path (or `/dev/null`). The collector
already suppresses its Ansible log output. Do not bake these files into an image.

## Operations

- `/healthz` is a minimal public liveness endpoint. It returns only `{"status":"ok"}`;
  monitoring data, logs, and the dashboard still require login. A Redis outage
  does not make the HTTP server unhealthy.
- Docker sends SIGTERM to the Python process for graceful HTTP/collector shutdown.
- One process owns one background collector. Multiple replicas collect their own
  telemetry; use the same PostgreSQL database and explicit `SECRET_KEY` to share
  account sessions across replicas.
- Use HTTPS in front of Atlas for network deployment and set
  `SESSION_COOKIE_SECURE=true`. The default Compose listener remains loopback-only.

## Verify an image

```bash
python tests/docker_smoke.py
# Include the actual Compose PostgreSQL stack:
python tests/docker_smoke.py --postgres
```

This builds the runtime image, checks login and assets, verifies SQLite/session-key
persistence after replacing the container, and checks direct monitoring against a
throwaway Redis container. Test containers, networks, and volumes are removed.
