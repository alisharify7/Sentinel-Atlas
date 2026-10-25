"""All external-project connections are supplied by configuration."""
from dataclasses import dataclass
import os
from pathlib import Path
import shutil


@dataclass
class Settings:
    inventory: Path | None = None
    ansible_config: Path | None = None
    vault_password_file: Path | None = None
    ansible_playbook: str = 'ansible-playbook'
    redis_group: str = 'redis_nodes'
    sentinel_group: str = 'sentinel_nodes'
    interval: int = 5
    timeout: int = 20
    ssh_timeout: int = 3
    backend: str = 'ansible'
    targets: Path | None = None

    @classmethod
    def from_env(cls, inventory=None, targets=None):
        def path(value):
            return Path(value).expanduser().resolve() if value else None
        targets = targets or os.getenv('SENTINEL_TARGETS')
        backend = os.getenv('SENTINEL_BACKEND') or ('direct' if targets or os.getenv('REDIS_URL') else 'ansible')
        if backend not in ('ansible', 'direct'):
            raise ValueError('SENTINEL_BACKEND must be direct or ansible.')
        inventory = inventory or os.getenv('SENTINEL_INVENTORY') or os.getenv('SENTINEL_DEFAULT_INVENTORY')
        if backend == 'ansible' and not inventory:
            raise ValueError('Set REDIS_URL, SENTINEL_TARGETS, or an external SENTINEL_INVENTORY.')
        if backend == 'direct' and not targets and not os.getenv('REDIS_URL'):
            raise ValueError('Direct mode needs REDIS_URL or SENTINEL_TARGETS.')
        return cls(path(inventory),
            path(os.getenv('SENTINEL_ANSIBLE_CONFIG') or os.getenv('ANSIBLE_CONFIG') or os.getenv('SENTINEL_DEFAULT_ANSIBLE_CONFIG')),
            path(os.getenv('SENTINEL_VAULT_PASSWORD_FILE')),
            os.getenv('SENTINEL_ANSIBLE_PLAYBOOK') or shutil.which('ansible-playbook') or 'ansible-playbook',
            os.getenv('SENTINEL_REDIS_GROUP','redis_nodes'), os.getenv('SENTINEL_SENTINEL_GROUP','sentinel_nodes'),
            max(2,int(os.getenv('SENTINEL_POLL_INTERVAL','5'))),
            max(5,int(os.getenv('SENTINEL_COLLECT_TIMEOUT','20'))),
            max(1,int(os.getenv('SENTINEL_SSH_TIMEOUT','3'))), backend, path(targets))
