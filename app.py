"""Compatibility entry point. Prefer python -m sentinel_atlas for new setups."""
from sentinel_atlas import create_app
from sentinel_atlas.cli import main

if __name__ == '__main__':
    main()
