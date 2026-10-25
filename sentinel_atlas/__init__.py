"""Sentinel Atlas application package."""

def create_app(monitor=None, config=None):
    """Create the WSGI app without importing web dependencies in probe callbacks."""
    from .web import create_app as factory
    return factory(monitor, config)
