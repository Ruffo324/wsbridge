# https2wss — Browser SSE Demo

A standalone browser page demonstrating the https2wss bridge via SSE transport.

## Serving locally (via echo demo static server)

```bash
# From workspace root — build first
pnpm build

# Start echo + proxy
STANDALONE=1 HTTPS2WSS_TOKEN=dev-token-1234 pnpm --filter @https2wss/echo-demo proxy &
HTTPS2WSS_TOKEN=dev-token-1234 pnpm --filter @https2wss/echo-demo echo &

# Serve this page via the echo demo static server (which also serves /lib/client/)
pnpm --filter @https2wss/echo-demo static
```

Then open http://localhost:3000 — the static server serves `examples/echo/public/index.html`
which is functionally identical to this page.

To serve this file specifically, copy it over public/index.html or adjust the static server.

## Serving via Docker Compose

```bash
HTTPS2WSS_TOKEN=dev-token-1234 docker compose up --build
```

Open http://localhost:3000. The nginx demo service mounts this directory.

## Client library import

The page imports `Https2WssSocket` from `/lib/client/index.js`. This path is mapped:

- By `staticServer.ts`: to `packages/client/dist/index.js` in the workspace.
- By Docker nginx: via a bind mount of `packages/client/dist` to `/usr/share/nginx/html/lib/client`.

Run `pnpm build` before serving to ensure `packages/client/dist/index.js` exists.
