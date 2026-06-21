# Changelog

## 0.1.7 - 2026-06-21

- Strip incoming `Forwarded` and `X-Forwarded-*` headers before proxying HA
  requests upstream. Traefik adds `X-Forwarded-For` by default, and Home
  Assistant/aiohttp returns `400 Bad Request` if that header is passed through
  unchanged to the add-on's upstream path.

## 0.1.6 - 2026-06-21

- Fix the add-on's frontend proxy to accept `application/x-www-form-urlencoded`
  bodies and rewrite `Origin`/`Referer` to the upstream HA origin. This keeps
  `/auth/token` working during the HA login flow when the browser is talking to
  the proxy instead of HA directly.

## 0.1.5 - 2026-06-21

- Fix the add-on image build so browser bundles for `@https2wss/client` are
  generated before `pnpm deploy`. This makes the injected Home Assistant
  frontend WebSocket fallback module load correctly in browsers.

## 0.1.4 - 2026-06-21

- Add an optional Home Assistant frontend reverse proxy. When enabled, the add-on
  proxies HA Core's web UI and injects a module that wraps `window.WebSocket` so
  `/api/websocket` can fall back to the https2wss bridge when native WebSockets
  are blocked.
- Add add-on options for enabling/disabling the frontend proxy, choosing the
  proxy path/upstream URL, and tuning native WebSocket fallback timeouts.

## 0.1.3 - 2026-06-20

- Fix: promote `@https2wss/client` + `@https2wss/home-assistant-adapter`
  from `devDependencies` to `dependencies` in `@https2wss/proxy`. They were
  excluded by `pnpm deploy --prod` in 0.1.1/0.1.2, so the new P14 static
  routes (`/_/lib/client/index.js`, `/_/lib/ha/index.js`) returned 404 in
  the deployed image — the browser bundles never landed in the runtime
  `node_modules/`. Locally verified all three routes return 200 with the
  bundled JS + `cors: *`.

## 0.1.2 - 2026-06-20

- Dockerfile: `chmod +x` on the s6 init + service scripts so the container
  doesn't crashloop with `Permission denied` (exit 126) on first start
  when Docker COPY strips the +x bit on some hosts.

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
