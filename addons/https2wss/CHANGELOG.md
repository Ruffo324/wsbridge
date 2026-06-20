# Changelog

## 0.1.1 - 2026-06-20

- Serve the browser client + HA-adapter bundles and the frontend WebSocket
  shim directly from the bridge (`GET /_/lib/client/index.js`,
  `/_/lib/ha/index.js`, `/_/shim/wsbridge.js`) so Lovelace can auto-fall-back
  to the bridge. See `docs/ha-frontend-fallback.md`.
- Pre-exec diagnostics in the s6 run script + a build-time `cli.js --help`
  sanity check to catch a broken deploy before first start.
- CI: fix biome `check` formatting errors that were failing the pipeline.

## 0.1.0 - 2026-06-16 - Initial release

- First Home Assistant add-on package for https2wss.
- Architectures: `amd64` and `aarch64`. `armv7` is intentionally omitted —
  Node 24 dropped armv7 from all official Docker image variants.
- s6-overlay service with bashio option rendering into `/data/config.yml`.
- Auto-generates a random bridge token when none is configured.
- Default upstream profile points to `ws://homeassistant:8123/api/websocket`.
- English translations for all configuration options (`translations/en.yaml`).
- Multi-arch images published to GHCR via
  [`addon-build.yml`](../../.github/workflows/addon-build.yml) using
  `docker/build-push-action` with the repo root as build context.
