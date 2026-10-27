# Changelog

## Unreleased

- Added per-page auto refresh at 1, 5, 10, 15, or 30 seconds, with browser-saved
  preferences and shared log polling that avoids overlapping requests.
- Added Redis and Sentinel log downloads with UTF-8 files, the current filter and
  paused observation, safe filenames, source/timestamp headers, and stale labels.
- Improved terminals with fullscreen, text zoom controls and shortcuts, a clearer
  command prompt and execution status, and support for drafting the next command.
- Added administrator terminals to each node's inspector, with Redis/Sentinel
  service selection, live command output, command history, and database switching.
- Supported terminal commands through both direct Redis connections and existing
  SSH/Ansible inventories, with isolated database selection and bounded requests.
- Added an interactive demo terminal with simulated Redis commands, separate
  databases, replica write protection, Sentinel replies, and private sample data.

## 2.0.0 — 2026-10-26

- Added dedicated Overview, Live cluster, Instances, Logs, Activity, Profile,
  Share links, and About pages.
- Added graph fullscreen, cursor-centered wheel and Ctrl+wheel zoom, canvas
  panning, draggable nodes, view locking, and live replication links.
- Added complete graph exports in SVG, PNG, and PDF.
- Added profile editing, password changes, and session management.
- Added cluster-scoped viewing links with independent permissions, temporary or
  permanent expiry, revocation, editing, and deletion. Edits preserve the URL;
  access changes reach existing viewers on their next request.
- Added a configurable Docker build/publish helper and a Compose configuration
  for prebuilt images, with documented runtime variables and persistent volumes.
  Docker Hub publishing remains opt-in.
- Refreshed the README, screenshots, deployment guides, creator credits,
  community acknowledgments, and donation links.

When updating a container, retain its application data volume to preserve
accounts, profiles, viewing links, and the session signing key. See the
[Docker guide](docs/docker.md) for deployment details.
