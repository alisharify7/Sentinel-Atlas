"""Paths shared by source checkouts and installed distributions."""
import os
from pathlib import Path
from dotenv import load_dotenv

PACKAGE_DIR = Path(__file__).resolve().parent
_checkout = PACKAGE_DIR.parent
ROOT_DIR = _checkout if (_checkout / 'pyproject.toml').is_file() else Path.cwd()
PROBE_DIR = PACKAGE_DIR / 'probes'


def load_environment():
    load_dotenv(Path(os.getenv('SENTINEL_ENV_FILE', str(ROOT_DIR / '.env'))).expanduser(), override=False)
