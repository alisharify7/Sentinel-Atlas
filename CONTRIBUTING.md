# Contributing to Sentinel Atlas

Thank you for helping improve this open source project, created and maintained by
[Ali Sharify (@alisharify7)](https://github.com/alisharify7) · [ali-sharify.ir](https://ali-sharify.ir).

Bug reports, documentation improvements, accessibility fixes, deployment feedback,
reviews, and focused code changes are welcome.

## Get started

Follow the [development guide](docs/development.md), create a virtual environment,
and install the project with `python -m pip install -e .`. Set your own initial
account password as described in the README. Use `python -m sentinel_atlas --demo`
to work with sample data without connecting to infrastructure.

## Report a problem or propose a change

Open an [issue](https://github.com/alisharify7/Sentinel-Atlas/issues) with the observed
behavior, expected result, relevant version/platform, and a minimal example.
Use sample addresses and values. Remove passwords, bearer viewing links, private
inventory, connection URLs, and identifying log content before sharing evidence.

For a pull request, explain the concrete behavior change and include relevant
validation. Keep changes focused and update documentation when behavior changes.

## Check your work

```bash
python -m unittest discover -s tests -v
node --check sentinel_atlas/static/app.js
node --check sentinel_atlas/static/workspace.js
node --check sentinel_atlas/static/graph-export.js
node --check sentinel_atlas/static/log-export.js
node --check sentinel_atlas/static/page-refresh.js
node tests/test_ui.js
node tests/test_logs_ui.js
node tests/test_page_refresh.js
```

For frontend changes, also inspect desktop and mobile layouts and keyboard access.
For authentication and sharing changes, test authorization through the API as well
as the UI, including expiry, revocation, and access to other clusters. Optional
Docker integration checks are documented in the development guide.

Keep background monitoring and viewer access read-only; live terminal commands
require administrator access. Keep the demo simulation separate from live Redis.
Keep credentials out of telemetry,
logs, exports, fixtures, and commits. Support both SQLite and PostgreSQL account
stores and keep upgrades compatible with existing account databases.

Contributions are distributed under the project's [GPL-2.0 license](LICENSE).
