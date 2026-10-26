# Changelog

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
