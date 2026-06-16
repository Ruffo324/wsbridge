# https2wss — Echo Demo

A minimal end-to-end demo showing:

1. A local WebSocket echo server (`echoServer.ts`)
2. The https2wss bridge proxy connecting to that echo server (`proxyServer.ts`)
3. A Node.js client using `Https2WssSocket` to send and receive (`demoClient.ts`)
4. A browser page served locally (`staticServer.ts` + `public/index.html`)

---

## Quick start (pnpm — no Docker)

```bash
# From workspace root
pnpm install
pnpm build

# Run the full demo in one command (starts echo + proxy, runs client, then exits)
HTTPS2WSS_TOKEN=dev-token-1234 pnpm --filter @https2wss/echo-demo demo
```

Expected output:
```
[demo] starting echo server …
[demo] starting proxy (STANDALONE=1) …
[demo] waiting for proxy /healthz …
[demo] proxy ready — starting demo client …
[echoServer] echo on ws://0.0.0.0:9001
[proxyServer] proxy listening at http://127.0.0.1:8080
[demoClient] connecting to proxy at http://127.0.0.1:8080 with profile "echo"
[demoClient] socket open — sending hello
[demoClient] echo received: hello from node
[demo] client exited with code 0
[demo] shutting down proxy + echo …
```

---

## Run parts individually

```bash
# Terminal 1 — echo server
HTTPS2WSS_TOKEN=dev-token-1234 pnpm --filter @https2wss/echo-demo echo

# Terminal 2 — proxy (standalone mode: connects to 127.0.0.1:9001)
STANDALONE=1 HTTPS2WSS_TOKEN=dev-token-1234 pnpm --filter @https2wss/echo-demo proxy

# Terminal 3 — Node client
HTTPS2WSS_TOKEN=dev-token-1234 pnpm --filter @https2wss/echo-demo client

# Or: browser demo (after building packages/client)
HTTPS2WSS_TOKEN=dev-token-1234 pnpm --filter @https2wss/echo-demo static
# Open http://localhost:3000
```

### STANDALONE mode

`proxyServer.ts` reads `STANDALONE=1` and replaces the echo upstream URL from
`ws://echo:9001` (docker-compose hostname) to `ws://127.0.0.1:9001` in memory
before starting the server. The `config.yml` file is unchanged.

---

## Docker Compose

```bash
# From workspace root
HTTPS2WSS_TOKEN=dev-token-1234 docker compose up --build
```

Services:
- `proxy` — https2wss bridge on `http://localhost:8080`
- `echo` — WebSocket echo server (internal only, port 9001 not mapped to host)
- `demo` — nginx serving the browser demo on `http://localhost:3000`

Open http://localhost:3000, enter token `dev-token-1234`, click Connect.

---

## Token

Any string of 8+ characters set in `HTTPS2WSS_TOKEN`. The proxy reads it via
`{ env: "HTTPS2WSS_TOKEN" }` in `config.yml`.

---

## Browser demo and the client library

The browser page (`public/index.html`) imports the client as an ES module from
`/lib/client/index.js`. `staticServer.ts` maps this path to
`packages/client/dist/index.js` in the workspace. Run `pnpm build` first.

In the Docker compose setup, the browser page is served by nginx directly from
the `examples/browser-sse/` directory which also uses the same import path
(pointing to the built `packages/client/dist` via a bind mount or copy).
