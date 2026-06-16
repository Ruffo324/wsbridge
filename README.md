# https2wss

`https2wss` is a protocol-level HTTPS-to-WebSocket bridge. It lets HTTPS-only clients communicate with WebSocket services through an explicit session protocol using POST, long-polling, or Server-Sent Events. It is not a transparent universal WebSocket replacement; it is a controlled bridge with clear semantics, security policies, and adapter support.

## What it is not

- Not a transparent drop-in for native WebSockets on arbitrary third-party sites.
- Not a universal browser monkey-patching solution.
- Not a reverse-proxy that rewrites HTML or JavaScript.
- Not an open public relay — arbitrary upstream URLs are disabled by default.
- Not a perfect backpressure equivalent to native WebSocket.
- Not a hidden or opaque tunnel — the protocol is explicit and documented.

## Status

MVP. Single-node, single-process. Suitable for evaluation and small deployments. Not yet hardened for multi-tenant production load.

## How it works

```
Client (HTTPS only)
        |
        |  POST /v1/sessions/send
        |  GET  /v1/sessions/events  (SSE)
        |  GET  /v1/sessions/poll    (long-poll / poll)
        v
https2wss Bridge Server
        |
        |  native ws:// or wss://
        v
Target WebSocket Service
```

The client creates a session via `POST /v1/sessions`. The bridge opens a real upstream WebSocket connection and holds it open. The client sends frames via `POST /send` and receives frames via SSE or long-polling. Frames are sequenced, buffered, and replayable. The session expires on idle or max-duration timeout.

## Quickstart — standalone (no Docker)

Requires Node 24 LTS and pnpm 11 (`corepack enable` activates pnpm from `packageManager` in `package.json`).

```powershell
pnpm install
pnpm build
$env:HTTPS2WSS_TOKEN = "dev-token-1234"
pnpm --filter @https2wss/echo-demo demo
```

Expected output:

```
[demo] starting echo server ...
[demo] starting proxy ...
[demo] waiting for proxy /healthz ...
[demo] proxy ready — starting demo client ...
[echoServer] echo server listening on ws://127.0.0.1:9001
[demoClient] connecting to proxy at http://127.0.0.1:8080 with profile "echo"
[demoClient] socket open — sending hello
[demoClient] echo received: hello from node
[demo] client exited with code 0
[demo] shutting down proxy + echo ...
```

## Quickstart — Docker

Requires Docker Desktop (or Docker Engine) and Docker Compose v2.

```bash
docker compose up --build
```

The proxy listens on `http://localhost:8080`. The browser demo page is at `http://localhost:3000`. The echo WebSocket server is only reachable on the internal Docker network.

The default token is `dev-token-1234` (set via `HTTPS2WSS_TOKEN` env var in compose).

**Windows WSL2 note:** if you prefer running Docker inside WSL2, prepend `wsl -d Ubuntu --` to the compose command.

## Minimal client example

### Browser

```html
<script type="module">
  import { Https2WssSocket } from "./client.js";

  const socket = new Https2WssSocket("wss://echo", {
    bridgeUrl: "http://localhost:8080",
    authToken: "dev-token-1234",
    upstreamProfile: "echo"
  });

  socket.onopen = () => socket.send("hello from browser");
  socket.onmessage = event => console.log(event.data);
</script>
```

### Node

```ts
import { Https2WssSocket } from "@https2wss/client";

const socket = new Https2WssSocket("wss://echo", {
  bridgeUrl: "http://localhost:8080",
  authToken: process.env.HTTPS2WSS_TOKEN,
  upstreamProfile: "echo"
});

socket.addEventListener("open", () => {
  socket.send("hello from node");
});

socket.addEventListener("message", event => {
  console.log(event.data);
  socket.close();
});
```

`Https2WssSocket` constructor: `new Https2WssSocket(target: string, init: Https2WssSocketInit)`.

`Https2WssSocketInit` fields: `bridgeUrl`, `authToken?`, `upstreamProfile?`, `upstreamUrl?`, `transport?` (`"sse" | "long_poll" | "poll"`), `fetchImpl?`.

Implemented surface: `readyState`, `send()`, `close()`, `onopen`, `onmessage`, `onerror`, `onclose`, `addEventListener()`, `removeEventListener()`, `bufferedAmount` (approximate). Not a full native WebSocket drop-in.

## Architecture

See [docs/architecture.md](./docs/architecture.md) for the five-layer architecture, package dependency graph, request lifecycle, and concurrency model.

## Security warning

Do not expose the bridge to the public Internet without HTTPS termination, an upstream allowlist, authentication, and CORS configured. See [docs/security.md](./docs/security.md) before deploying.

## Limitations summary

- Higher latency than native WebSocket (HTTP overhead per direction).
- Binary data has 33% overhead due to base64 encoding.
- No multi-node session state — all sessions are in-memory, single-process.
- Sessions are lost on process restart.
- No rate limiting at the bridge — delegate to a reverse proxy.
- `bufferedAmount` is approximate only.

See [docs/limitations.md](./docs/limitations.md) for the full list.

## Home Assistant

The https2wss add-on hosts the bridge inside Home Assistant OS or Supervised
installations, giving HTTPS-only dashboards access to the HA WebSocket API.

- **Add-on guide**: [docs/ha-addon.md](./docs/ha-addon.md) — install, configure, token
  flows, NGINX reverse-proxy setup, and upgrade path.
- **Resilient client**: [docs/fallback.md](./docs/fallback.md) — `ResilientWebSocket`
  API, decision tree, cookie persistence, and `isAlive` override.

Quick example:

```ts
import { ResilientWebSocket } from "@https2wss/client";

const ws = new ResilientWebSocket("wss://homeassistant.local/api/websocket", {
  bridge: {
    bridgeUrl: "http://homeassistant.local:8080",
    authToken: HA_ADDON_BRIDGE_TOKEN,
    upstreamProfile: "ha-core",
  },
});
```

## Documentation index

| File | Contents |
|------|----------|
| [docs/architecture.md](./docs/architecture.md) | Layers, package graph, request/frame lifecycle, concurrency model |
| [docs/protocol.md](./docs/protocol.md) | Envelope format, frame kinds, session state machine, seq/ack rules |
| [docs/transports.md](./docs/transports.md) | Endpoint reference, poll/long-poll/SSE behavior, wire format |
| [docs/security.md](./docs/security.md) | Threat model, auth, SSRF guard, header policy, CORS, deployment checklist |
| [docs/limitations.md](./docs/limitations.md) | Known constraints and non-goals |
| [docs/adapter-authoring.md](./docs/adapter-authoring.md) | How to implement a new upstream adapter |
| [docs/deployment.md](./docs/deployment.md) | Local dev, Docker, reverse proxy, env vars, observability |
| [docs/fallback.md](./docs/fallback.md) | `ResilientWebSocket` API, decision tree, cookie persistence |
| [docs/ha-addon.md](./docs/ha-addon.md) | Home Assistant add-on: install, config, token flows, upgrade |

## Development

```bash
pnpm install       # install all workspace deps
pnpm typecheck     # tsc -b (strict, composite, project references)
pnpm lint          # biome check
pnpm test          # vitest run (277 tests)
pnpm build         # tsc -b + tsup client bundle
```

Node 24 LTS required. pnpm 11 is activated via corepack from the `packageManager` field in `package.json`.

Monorepo layout:

```
packages/
  protocol/     core types, zod schemas, error codes
  proxy/        Fastify server, sessions, security, transports
  client/       BridgeClient, BridgeSession, Https2WssSocket
  adapters/
    home-assistant/  scaffold (empty)
examples/
  echo/         standalone demo + Docker Compose demo
  node-client/  minimal Node usage example
  browser-sse/  browser page served by the demo nginx container
  ha-fallback/  interactive browser demo for ResilientWebSocket fallback paths
```

## License

MIT. See [LICENSE](./LICENSE).
