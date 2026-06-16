# Deployment

## Local development

Requirements: Node 24 LTS, pnpm 11 (activate via `corepack enable`).

```bash
pnpm install
pnpm build
export HTTPS2WSS_TOKEN=dev-token-1234   # or $env:HTTPS2WSS_TOKEN on PowerShell
pnpm --filter @https2wss/echo-demo demo
```

The demo script starts the echo WebSocket server on port 9001, the bridge proxy on port 8080, and a demo client. All three are spawned as child processes and log to the same terminal with prefixes.

To run components individually:

```bash
# Terminal 1: echo server
pnpm --filter @https2wss/echo-demo echo

# Terminal 2: proxy
HTTPS2WSS_TOKEN=dev-token-1234 pnpm --filter @https2wss/echo-demo proxy

# Terminal 3: demo client
HTTPS2WSS_TOKEN=dev-token-1234 pnpm --filter @https2wss/echo-demo client
```

## Docker run — single container

The proxy image is built from the root `Dockerfile`. It uses a multi-stage build:

1. Builder stage: installs workspace deps, builds all packages via `tsc -b`, deploys the proxy to `/out` via `pnpm deploy --prod`.
2. Runtime stage: `node:24-alpine`, non-root `app` user, copies `/out`.

Run:

```bash
docker build -t https2wss-proxy .
docker run --rm \
  -p 8080:8080 \
  -e HTTPS2WSS_TOKEN=dev-token-1234 \
  -v ./examples/echo/config.yml:/app/config.yml:ro \
  https2wss-proxy
```

The config file is not baked into the image. Mount it at `/app/config.yml`. The entrypoint is `node dist/cli.js --config /app/config.yml`.

A custom config path can be passed as:

```bash
docker run ... https2wss-proxy --config /path/to/my-config.yml
```

## Docker Compose

The bundled `docker-compose.yml` defines three services:

| Service | Image | Ports | Network |
|---------|-------|-------|---------|
| `echo` | Built from `examples/echo/Dockerfile.echo` | none exposed | `internal` only |
| `proxy` | Built from root `Dockerfile` | `8080:8080` | `internal` + `public` |
| `demo` | `nginx:alpine` | `3000:80` | `public` only |

Two Docker networks:

- `internal`: used for proxy-to-echo communication. The `echo` service is not reachable from outside.
- `public`: used for proxy-to-host and demo-to-host traffic.

```bash
docker compose up --build
```

The `proxy` service depends on `echo` (service_started) and the `demo` service depends on `proxy` (service_healthy via `/healthz`).

Token is set via the `HTTPS2WSS_TOKEN` environment variable, defaulting to `dev-token-1234`:

```bash
HTTPS2WSS_TOKEN=my-secret docker compose up --build
```

The browser demo at `http://localhost:3000` connects to the proxy at `http://localhost:8080` using the token hardcoded in `examples/browser-sse/index.html`. Update that file if you change the token.

## Reverse proxy with HTTPS termination

The bridge serves plain HTTP. TLS must be terminated by a reverse proxy.

### nginx example

```nginx
server {
    listen 443 ssl;
    server_name bridge.example.com;

    ssl_certificate     /etc/ssl/certs/bridge.crt;
    ssl_certificate_key /etc/ssl/private/bridge.key;

    # Bridge API
    location /v1/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # Required for SSE: disable buffering and keep connection alive
        proxy_buffering    off;
        proxy_set_header   Connection '';
        proxy_read_timeout 60s;

        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    # Health check (no auth)
    location /healthz {
        proxy_pass http://127.0.0.1:8080;
    }
}
```

Critical nginx settings for SSE:

| Setting | Value | Reason |
|---------|-------|--------|
| `proxy_buffering` | `off` | Prevents nginx from buffering the SSE stream; frames would not reach the client until the buffer flushes. |
| `proxy_set_header Connection ''` | empty string | Clears the `Connection: close` header that nginx sets by default, required for HTTP/1.1 keepalive on the upstream side. |
| `proxy_http_version` | `1.1` | Required for keepalive connections with the upstream (nginx defaults to HTTP/1.0 for upstream). |
| `proxy_read_timeout` | `60s` or higher | Prevents nginx from closing the connection during long-poll wait or quiet SSE periods. Default is 60 s; raise if you use `timeoutMs > 55000`. |

The `X-Accel-Buffering: no` header is already sent by the bridge's SSE endpoint; nginx respects it to disable buffering on a per-response basis.

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `HTTPS2WSS_TOKEN` | Yes | — | Bearer token for API authentication; referenced in `config.yml` as `env: HTTPS2WSS_TOKEN` |
| `NODE_ENV` | No | — | Set to `production` by the Dockerfile; affects pino log format (no pretty-print) |
| Config path | No | `/app/config.yml` | Override via `--config /path/to/config.yml` CLI argument |

The config file itself controls all other settings (see `packages/proxy/src/config/serverConfig.ts` for the full schema with defaults).

## Production security checklist

See [docs/security.md](./security.md) for the full security model. Summary:

- HTTPS termination via reverse proxy — never expose plain HTTP publicly.
- Set a strong token (32+ random characters). Do not commit it to source control.
- Set `upstreamPolicy.allowDirectUrl: false` (the default).
- Set `allowPrivateNetwork: false` on all profiles that connect to public endpoints.
- Restrict `cors.allowedOrigins` to specific origins.
- Run the container as a non-root user (the Dockerfile does this by default).
- Place a rate-limiting proxy in front (nginx `limit_req_zone` or equivalent).

## Observability

### Health check

`GET /healthz` returns:

```json
{ "status": "ok", "sessions": 3 }
```

No authentication required. Use this as the Docker/k8s liveness probe.

### Structured JSON logs

The proxy uses pino for structured JSON logging. Example log line:

```json
{
  "level": 30,
  "time": 1718449200000,
  "pid": 1,
  "msg": "Server listening at http://0.0.0.0:8080"
}
```

Useful fields to extract for monitoring:

| Field | Meaning |
|-------|---------|
| `level` | pino level integer (30=info, 50=error) |
| `msg` | human-readable message |
| `sessionId` | present on session-scoped log lines |
| `tokenId` | 8-char sha256 prefix of the token; safe to log |
| `code` | BridgeErrorCode on error events |

Log level is set via `logging.level` in the config (default `info`). Set to `debug` during development.

Secrets (`authorization`, `cookie`, `token`, `tokens[*].value`) are redacted to `[Redacted]` by pino.
