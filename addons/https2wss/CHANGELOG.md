# Changelog

## 0.1.16 - 2026-07-02

- Revert 0.1.15 service-worker override. Live Windows/Chrome testing showed the
  aggressive unregister/cache-clear path made the Home Assistant frontend worse:
  the shim started creating bridge sessions, but `/v1/sessions/.../events` reads
  failed and HA surfaced numeric frontend error `1`. Keep the earlier proxy/shim
  fixes and continue debugging without forcing service-worker cleanup.

## 0.1.14 - 2026-06-23

- Suppress transient `error` events from `Https2WssSocket` while the socket is
  still in `CONNECTING`. Home Assistant treats any pre-auth socket `error` as
  `ERR_CANNOT_CONNECT (1)` and aborts bootstrap immediately, even if the bridge
  would have reached `open` moments later. Added a regression test for the
  sequence "pre-open error, then open".

## 0.1.13 - 2026-06-22

- Fix a race in `Https2WssSocket`: if the bridge session had already reached
  `open` before socket listeners were attached, the Home Assistant frontend shim
  could miss the only `open` transition and stay stuck in `CONNECTING` forever.
  The socket now synchronizes its current `session.state` immediately after
  wiring listeners, with a regression test covering already-open sessions.

## 0.1.12 - 2026-06-22

- Switch the Home Assistant frontend shim from `ResilientWebSocket` native-first
  probing to direct `Https2WssSocket` bridge mode for `/api/websocket`. This
  avoids Home Assistant's cold-reload `ERR_CANNOT_CONNECT` path when the initial
  socket attempt emits a pre-auth close/error before the bridge fallback can
  complete.

## 0.1.11 - 2026-06-22

- Pass the original native WebSocket constructor into `ResilientWebSocket` from
  the Home Assistant frontend shim. Without this, the shim could recurse back
  into its own wrapped `window.WebSocket` during the native-first probe and hang
  the HA bootstrap on `Loading data` / `Unable to connect`.

## 0.1.10 - 2026-06-22

- Expose WebSocket ready-state constants (`OPEN`, `CLOSED`, etc.) on wrapped
  Home Assistant frontend socket instances. HA checks `socket.readyState ==
  socket.OPEN` after authentication; without instance constants the bridge
  authenticated successfully but the UI still treated the connection as down.

## 0.1.9 - 2026-06-22

- Forward Home Assistant auth callback `multipart/form-data` bodies unchanged.
  The current HA frontend submits `/auth/token` as `FormData`; without a raw
  multipart parser the proxy returned `500` even though urlencoded curl probes
  worked.

## 0.1.8 - 2026-06-22

- Prevent Home Assistant's internal `Access-Control-*` response headers from leaking
  through the frontend proxy. The proxy now strips upstream CORS headers and
  reflects the browser request origin, so callback token fetches are not rejected
  when the upstream responds with `http://homeassistant:8123`.

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
