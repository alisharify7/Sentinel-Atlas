# syntax=docker/dockerfile:1
ARG PYTHON_IMAGE=python:3.13-slim
FROM ${PYTHON_IMAGE} AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SENTINEL_HOST=0.0.0.0 \
    SENTINEL_PORT=5050 \
    SENTINEL_INSTANCE_PATH=/var/lib/sentinel-atlas \
    HOME=/home/atlas
WORKDIR /app

RUN groupadd --gid 10001 atlas \
    && useradd --uid 10001 --gid atlas --create-home --no-log-init atlas \
    && mkdir -p /var/lib/sentinel-atlas \
    && chown atlas:atlas /var/lib/sentinel-atlas

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY sentinel_atlas/ /app/sentinel_atlas/
COPY pyproject.toml app.py LICENSE /app/

EXPOSE 5050
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('SENTINEL_PORT','5050')+'/healthz',timeout=3).close()"]
USER 10001:10001
ENTRYPOINT ["python", "-m", "sentinel_atlas"]

# Optional SSH/controller tooling; direct monitoring does not need this stage.
FROM base AS ansible
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY requirements-ansible.txt /tmp/requirements-ansible.txt
RUN pip install --no-cache-dir -r /tmp/requirements-ansible.txt
ENV ANSIBLE_LOCAL_TEMP=/tmp/ansible-local \
    ANSIBLE_SSH_CONTROL_PATH_DIR=/tmp/ansible-cp
USER 10001:10001

# The default image contains only the direct Redis monitor.
FROM base AS runtime
