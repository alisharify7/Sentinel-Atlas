# Run Sentinel Atlas with Docker

[← Project overview](../README.md)

The default image connects directly to Redis/Sentinel. It runs as UID/GID
`10001:10001` and serves HTTP with Waitress. The image contains no default
password, database, inventory, or `.env` file.

## Build and optionally publish an image

The executable Bash helper works from any directory and builds locally by default:

```bash
./script/make-docker.sh
# Local image: sentinel-atlas:local
./script/make-docker.sh --help
```

Configure it with environment variables, or edit the defaults at the top of the
script. There is no Docker Hub repository or account hard-coded into the helper.

| Variable | Default | Purpose |
| --- | --- | --- |
| `IMAGE_NAME` | `sentinel-atlas` | Local image name, or `your-user/sentinel-atlas` for Docker Hub |
| `IMAGE_TAG` | `local` | Image version/tag; publishing requires an explicit non-`local` tag |
| `BUILD_TARGET` | `runtime` | `runtime` for direct Redis monitoring, or `ansible` for SSH/server probes |
| `PLATFORMS` | Native locally; `linux/amd64,linux/arm64` when publishing | One platform for a local load, or multiple platforms for a publish |
| `PUSH` | `false` | Set `true` only when ready to publish |
| `TAG_LATEST` | `false` | Set `true` to also tag the image as `latest` |

Build a versioned image without publishing:

```bash
IMAGE_NAME=your-dockerhub-user/sentinel-atlas \
IMAGE_TAG=2.0.0 \
./script/make-docker.sh
```

When you decide to publish, log in yourself and enable publishing explicitly:

```bash
docker login
IMAGE_NAME=your-dockerhub-user/sentinel-atlas \
IMAGE_TAG=2.0.0 \
PUSH=true \
TAG_LATEST=true \
./script/make-docker.sh
```

Add `--dry-run` to print the command without contacting Docker, building, or
publishing. Equivalent flags include `--image`, `--tag`, `--target`, `--platforms`,
and `--push`. The helper does not read `.env`, perform a login, or pass runtime
credentials as build arguments. Configure application variables at container run time.

Docker and Buildx must be installed and Docker must be running. Multi-platform
publishing needs a builder that supports the requested platforms. If your current
builder does not support them, create one before publishing:

```bash
docker buildx create --name atlas-builder --driver docker-container --use
docker buildx inspect --bootstrap
```

The helper uses Buildx's `--load` for local builds and `--push` only for an explicit
publish. See the [Docker Buildx reference](https://docs.docker.com/reference/cli/docker/buildx/build/).

## Run a prebuilt or published image

Once you have published an image, users do not need to build the application.
They can use the same `--env-file` and volume options with its repository/tag:

```bash
# Replace this value with your published repository and tag.
ATLAS_IMAGE=your-dockerhub-user/sentinel-atlas:2.0.0
docker pull "$ATLAS_IMAGE"
docker volume create sentinel-atlas-data
docker run -d --name sentinel-atlas --restart unless-stopped \
  --env-file .env \
  --add-host host.docker.internal:host-gateway \
  -p 127.0.0.1:5050:5050 \
  -v sentinel-atlas-data:/var/lib/sentinel-atlas \
  "$ATLAS_IMAGE"
```

Use `sentinel-atlas:local` without `docker pull` to run a local helper build.
Prepare `.env` with your own `DEFAULT_PASSWORD` and Redis connection settings as
shown below. Appending `--demo` after the image name starts the sample workspace.

`compose.image.yaml` runs an existing image without a build section. Keep it
alongside your `.env` file and set `ATLAS_IMAGE` to a local or published image:

```bash
ATLAS_IMAGE=sentinel-atlas:local docker compose -f compose.image.yaml up -d
# For a published image, set ATLAS_IMAGE to that repository/tag and pull first:
ATLAS_IMAGE=your-dockerhub-user/sentinel-atlas:2.0.0 \
  docker compose -f compose.image.yaml pull
ATLAS_IMAGE=your-dockerhub-user/sentinel-atlas:2.0.0 \
  docker compose -f compose.image.yaml up -d
```

### Runtime variables and mounts

| Setting | How to supply it |
| --- | --- |
| First administrator | `DEFAULT_ACCOUNT` and `DEFAULT_PASSWORD` through `--env-file` or `-e`; only used for an empty account database |
| Redis/Sentinel connections | `REDIS_URL`, `SENTINEL_URL`, or `SENTINEL_TARGETS` and its referenced credential variables |
| Persistent application data | Named volume at `/var/lib/sentinel-atlas`; retains accounts, profiles, viewing links, sessions, and the signing key |
| Custom target definitions | Read-only bind mount at `/config/targets.yml` plus `SENTINEL_TARGETS=/config/targets.yml` |
| TLS files or SSH inventory | Read-only mounts, referenced by paths inside the container |
| PostgreSQL | `DATABASE_URL` pointing to a reachable PostgreSQL server; keep the Atlas data volume for its signing key too |
| HTTP listener | Container port `5050`; `ATLAS_PORT` controls the host mapping in Compose |
| HTTPS session cookies | `SESSION_COOKIE_SECURE=true` when serving through an HTTPS proxy |

The image runs as UID/GID `10001:10001`. Named volumes work with the prepared data
directory; host bind mounts must be writable by that user. Data belongs in the
volume, not in the image. Keep the same volume when replacing/upgrading a container.

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
SQLite account database, profiles, viewing links, and session signing key when the container is replaced.
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
  the private workspace requires login, while viewing links grant only their selected cluster and permissions. A Redis outage
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

This builds the runtime image, checks login and assets, verifies account, profile,
viewing-link, and session-key persistence after replacing the container, and checks direct monitoring against a
throwaway Redis container. Test containers, networks, and volumes are removed.

To verify an image you already built with the helper:

```bash
python tests/docker_smoke.py --skip-build --image sentinel-atlas:local
```
