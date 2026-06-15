# Requirements Specification: https2wss

**Date:** 2026-06-15  
**Project name:** `https2wss`  
**Audience:** Claude Code / Anthropic Opus / engineering implementation agent  
**Language requirement:** All code, comments, documentation, examples, commit messages, package names, API names, and public-facing text must be written in English.  
**Intended quality level:** Open-source-ready, clean, maintainable, well-tested, security-conscious.

---

## 1. Executive Summary

`https2wss` is a protocol-level HTTPS-to-WebSocket bridge.

It allows clients that cannot, should not, or do not want to open native WebSocket connections to communicate with real WebSocket services through ordinary HTTPS-compatible mechanisms such as:

- `POST` requests for client-to-bridge messages
- long-polling for bridge-to-client messages
- Server-Sent Events for bridge-to-client streaming
- future HTTP/2 or HTTP/3 streaming transports

The bridge server keeps the real upstream WebSocket connection open. The client speaks only the explicit `https2wss` bridge protocol over HTTPS.

This is not intended to be a magical transparent replacement for WebSockets. It is a controlled, well-defined protocol translation layer with clear semantics, limits, security policies, and adapter support.

---

## 2. Core Vision

The project should explore whether modern WebSocket-like communication can be abstracted into a transport-independent session protocol that works over older, restricted, or HTTPS-only environments.

The idea is technically interesting because WebSockets are long-lived bidirectional sockets, while plain HTTP request/response is naturally asymmetric and short-lived. Bridging these two worlds requires explicit handling of:

- sessions
- message ordering
- buffering
- reconnection
- heartbeats
- close semantics
- binary data
- backpressure
- security boundaries

The project should be built as if it may become a serious open-source infrastructure component. Even the MVP should be clean, understandable, documented, and safe by default.

---

## 3. Primary Goal

Build a working MVP that demonstrates a generic protocol-level bridge:

```text
Client without native WebSocket usage
        |
        | HTTPS only
        | POST /send
        | GET /poll or GET /events
        v
https2wss Bridge Server
        |
        | native ws:// or wss:// upstream
        v
Target WebSocket Service
```

The MVP must prove that a client can send and receive text and binary messages through HTTPS-only mechanisms while the bridge server maintains a real upstream WebSocket connection.

---

## 4. Non-Goals

The first version must not attempt to solve everything.

Explicit non-goals:

1. No fully transparent replacement for WebSockets on arbitrary third-party websites.
2. No universal browser monkey-patching as the primary architecture.
3. No reverse-proxy HTML/JavaScript rewriting in the MVP.
4. No open public proxy for arbitrary upstream targets.
5. No attempt to perfectly reproduce native WebSocket timing, latency, or backpressure behavior.
6. No Spotify-specific or Home-Assistant-specific logic inside the core protocol.
7. No hidden tunneling semantics. The bridge protocol must be explicit and documented.

---

## 5. Design Principles

### 5.1 Protocol First

The core artifact is the protocol, not the implementation language.

The TypeScript implementation is the MVP reference implementation, but the protocol should be documented well enough that future implementations in Go, Rust, Python, or other languages are possible.

### 5.2 Explicit Semantics

Every behavior should be intentional and documented:

- session lifecycle
- frame format
- sequence numbers
- acknowledgement behavior
- delivery guarantees
- buffering limits
- close behavior
- errors
- retries

### 5.3 Secure by Default

The bridge must not become an SSRF tool or open WebSocket relay.

Default behavior:

- deny arbitrary upstreams
- require authentication
- use allowlisted upstream profiles
- restrict headers
- block private networks unless explicitly allowed
- redact secrets from logs

### 5.4 Clean Open-Source Code

The codebase must be suitable for public release.

Requirements:

- English-only code and documentation
- clear package boundaries
- strict TypeScript
- readable naming
- no quick hacks in core paths
- meaningful tests
- clear README
- examples that work
- Docker support
- documented limitations

### 5.5 Small, Correct MVP

Prefer a small implementation that is easy to understand and test over a large feature set.

---

## 6. Conceptual Architecture

The system consists of five logical layers:

```text
[Application / Compatibility API]
        |
[Client Runtime]
        |
[https2wss Bridge Protocol over HTTPS]
        |
[Bridge Server Session Runtime]
        |
[Upstream Adapter]
        |
[Target Service]
```

### 6.1 Application / Compatibility API

This layer exposes a developer-facing API. It may include:

- a low-level `BridgeClient`
- a WebSocket-like `Https2WssSocket`
- later application-specific adapters

### 6.2 Client Runtime

The client runtime handles:

- session creation
- sending frames via HTTPS POST
- receiving frames via SSE or long-poll
- reconnection/resume behavior
- message ordering
- event dispatching

### 6.3 Bridge Protocol

The explicit protocol that defines envelopes, frames, control events, errors, close semantics, sequencing, and transport behavior.

### 6.4 Bridge Server Session Runtime

The server-side runtime owns:

- session state
- upstream connection state
- frame buffers
- policy enforcement
- error mapping
- observability

### 6.5 Upstream Adapter

The adapter translates bridge frames to a concrete upstream protocol.

MVP adapter:

- generic WebSocket adapter

Future adapters:

- Home Assistant WebSocket API
- generic JSON-RPC
- custom service profiles

---

## 7. Repository Structure

Use a monorepo.

Recommended structure:

```text
https2wss/
  README.md
  LICENSE
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  Dockerfile
  docker-compose.yml
  .github/
    workflows/
      ci.yml

  packages/
    protocol/
      package.json
      src/
        envelope.ts
        errors.ts
        schema.ts
        types.ts
      tests/
        envelope.test.ts
        schema.test.ts

    client/
      package.json
      src/
        BridgeClient.ts
        Https2WssSocket.ts
        events.ts
        transports/
          PollTransport.ts
          LongPollTransport.ts
          SseTransport.ts
      tests/
        BridgeClient.test.ts
        Https2WssSocket.test.ts

    proxy/
      package.json
      src/
        index.ts
        config.ts
        httpServer.ts
        sessions/
          Session.ts
          SessionManager.ts
          FrameBuffer.ts
          Sequencer.ts
        upstream/
          UpstreamAdapter.ts
          WebSocketUpstreamAdapter.ts
        security/
          auth.ts
          cors.ts
          headerPolicy.ts
          ssrfGuard.ts
          upstreamPolicy.ts
        transports/
          createSession.ts
          send.ts
          poll.ts
          sse.ts
          close.ts
        observability/
          logger.ts
          metrics.ts
      tests/
        sessionLifecycle.test.ts
        websocketUpstream.test.ts
        transports.test.ts
        security.test.ts

    adapters/
      home-assistant/
        package.json
        src/
          HomeAssistantBridgeClient.ts
        tests/

  examples/
    echo/
      README.md
      docker-compose.yml
      src/
        echoServer.ts
        demoClient.ts
      public/
        index.html

    browser-sse/
      README.md
      index.html

    node-client/
      README.md
      src/
        index.ts

  docs/
    architecture.md
    protocol.md
    transports.md
    security.md
    limitations.md
    adapter-authoring.md
    deployment.md
```

---

## 8. Technology Requirements

Use TypeScript for the MVP.

Recommended stack:

- Runtime: Node.js LTS
- Package manager: `pnpm`
- Language: TypeScript with `strict: true`
- HTTP server: Fastify or Hono
- WebSocket client/server for tests: `ws`
- Schema validation: `zod`
- Test runner: Vitest
- Formatting/linting: Biome or ESLint + Prettier
- Containerization: Docker
- CI: GitHub Actions

All public names, internal identifiers, comments, docs, examples, and test descriptions must be English.

---

## 9. Bridge Protocol

### 9.1 Protocol Versioning

Every bridge message must include a protocol version.

```json
{
  "v": 1
}
```

Unsupported versions must produce a structured error:

```json
{
  "error": {
    "code": "PROTOCOL_VERSION_UNSUPPORTED",
    "message": "Protocol version is not supported",
    "retryable": false
  }
}
```

### 9.2 Session

A session is a logical bidirectional connection between one client runtime and one upstream connection.

Required session state:

```ts
type SessionState =
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "errored";
```

A session should contain:

```ts
interface SessionInfo {
  sessionId: string;
  state: SessionState;
  createdAt: string;
  lastActivityAt: string;
  transportMode: "poll" | "long_poll" | "sse";
  upstream: {
    adapter: string;
    state: SessionState;
  };
}
```

### 9.3 Envelope

All bridge messages use an envelope.

```ts
interface BridgeEnvelope {
  v: 1;
  sid: string;
  seq: number;
  ack?: number;
  kind: "data" | "control" | "error" | "close" | "heartbeat";
  ts: string;
  payload: unknown;
}
```

### 9.4 Data Frame

Text frame:

```json
{
  "v": 1,
  "sid": "h2w_abc",
  "seq": 1,
  "kind": "data",
  "ts": "2026-06-15T12:00:00.000Z",
  "payload": {
    "opcode": "text",
    "encoding": "utf8",
    "data": "hello",
    "fin": true
  }
}
```

Binary frame:

```json
{
  "v": 1,
  "sid": "h2w_abc",
  "seq": 2,
  "kind": "data",
  "ts": "2026-06-15T12:00:01.000Z",
  "payload": {
    "opcode": "binary",
    "encoding": "base64",
    "data": "AAECAwQ=",
    "fin": true
  }
}
```

### 9.5 Control Frame

```json
{
  "v": 1,
  "sid": "h2w_abc",
  "seq": 3,
  "kind": "control",
  "ts": "2026-06-15T12:00:02.000Z",
  "payload": {
    "event": "upstream_open",
    "details": {}
  }
}
```

Allowed control events for MVP:

- `upstream_open`
- `upstream_close`
- `client_ready`
- `transport_ready`
- `drain`

### 9.6 Close Frame

```json
{
  "v": 1,
  "sid": "h2w_abc",
  "seq": 4,
  "kind": "close",
  "ts": "2026-06-15T12:00:03.000Z",
  "payload": {
    "code": 1000,
    "reason": "normal closure",
    "source": "client"
  }
}
```

Allowed close sources:

- `client`
- `bridge`
- `upstream`
- `timeout`
- `policy`

### 9.7 Error Frame

```json
{
  "v": 1,
  "sid": "h2w_abc",
  "seq": 5,
  "kind": "error",
  "ts": "2026-06-15T12:00:04.000Z",
  "payload": {
    "code": "UPSTREAM_CONNECT_FAILED",
    "message": "Unable to connect to upstream WebSocket",
    "retryable": true,
    "details": {}
  }
}
```

---

## 10. HTTP API

### 10.1 Create Session

```http
POST /v1/sessions
Authorization: Bearer <token>
Content-Type: application/json
```

Request:

```json
{
  "protocol": "https2wss",
  "version": 1,
  "transport": {
    "mode": "sse",
    "fallbacks": ["long_poll", "poll"]
  },
  "upstream": {
    "adapter": "websocket",
    "profile": "echo"
  },
  "options": {
    "binary": "base64",
    "ordered": true,
    "resume": true,
    "heartbeatIntervalMs": 30000
  }
}
```

Response:

```json
{
  "sessionId": "h2w_abc",
  "state": "connecting",
  "transport": {
    "selected": "sse",
    "sendUrl": "/v1/sessions/h2w_abc/send",
    "receiveUrl": "/v1/sessions/h2w_abc/events"
  },
  "limits": {
    "maxFrameBytes": 1048576,
    "maxBufferedFrames": 1000,
    "idleTimeoutMs": 120000
  }
}
```

### 10.2 Send Frames

```http
POST /v1/sessions/{sessionId}/send
Authorization: Bearer <token>
Content-Type: application/json
```

Request:

```json
{
  "frames": [
    {
      "v": 1,
      "sid": "h2w_abc",
      "seq": 1,
      "ack": 0,
      "kind": "data",
      "ts": "2026-06-15T12:00:00.000Z",
      "payload": {
        "opcode": "text",
        "encoding": "utf8",
        "data": "hello",
        "fin": true
      }
    }
  ]
}
```

Response:

```json
{
  "accepted": true,
  "ack": 1,
  "state": "open"
}
```

### 10.3 Receive via Long-Poll

```http
GET /v1/sessions/{sessionId}/poll?after=0&timeoutMs=25000
Authorization: Bearer <token>
```

Response:

```json
{
  "frames": [],
  "nextAfter": 0,
  "state": "open"
}
```

Behavior:

- Return immediately if frames are available.
- Otherwise wait up to `timeoutMs`.
- Return an empty frame array on timeout.
- `after` is used for resume and duplicate avoidance.

### 10.4 Receive via SSE

```http
GET /v1/sessions/{sessionId}/events?after=0
Authorization: Bearer <token>
```

Example SSE event:

```text
id: 1
event: frame
data: {"v":1,"sid":"h2w_abc","seq":1,"kind":"data","payload":{"opcode":"text","encoding":"utf8","data":"hello","fin":true}}

```

Heartbeat:

```text
: heartbeat 2026-06-15T12:00:30.000Z

```

### 10.5 Close Session

```http
POST /v1/sessions/{sessionId}/close
Authorization: Bearer <token>
Content-Type: application/json
```

Request:

```json
{
  "code": 1000,
  "reason": "client requested close"
}
```

Response:

```json
{
  "closed": true,
  "state": "closed"
}
```

---

## 11. Sequencing and Delivery Semantics

Each direction has its own monotonically increasing sequence numbers:

- client-to-bridge sequence
- bridge-to-client sequence

MVP requirements:

1. Frames must be delivered in order per direction.
2. Duplicate frames must be detectable.
3. The client must ignore duplicate received frames.
4. The server must reject or report out-of-order client frames.
5. The server must keep a bounded replay buffer for bridge-to-client frames.
6. Exact-once delivery is not required.

Documented guarantees:

- Normal active connection: at-most-once frame dispatch after successful delivery.
- Resume/poll replay: at-least-once may occur; client must de-duplicate by `seq`.
- No global exactly-once guarantee.

---

## 12. Buffering and Backpressure

The bridge server must enforce per-session limits.

Configurable limits:

```yaml
sessions:
  maxFrameBytes: 1048576
  maxBufferedFrames: 1000
  maxBufferedBytes: 16777216
  overflowPolicy: close
```

MVP policy:

- `overflowPolicy: close`

Reason: silently dropping frames would violate expected WebSocket-like behavior.

The client should expose an approximate `bufferedAmount` value.

---

## 13. Binary Handling

Binary data must not be treated as implicit UTF-8.

MVP binary transport:

- Encode binary payloads as base64 inside JSON envelopes.
- Decode back to `ArrayBuffer` or `Uint8Array` in the client runtime.

Future options:

- CBOR envelopes
- MessagePack envelopes
- multipart binary endpoints
- HTTP/2 binary streams

---

## 14. Heartbeats and Liveness

Keep these heartbeat layers separate:

1. Client-to-bridge transport heartbeat
2. Bridge-to-upstream WebSocket heartbeat
3. Application-level heartbeat

MVP requirements:

- SSE transport sends periodic heartbeat comments.
- Long-poll transport uses request timeout plus immediate reconnect.
- Server expires idle sessions.
- Upstream WebSocket close/error events are propagated to the client.

---

## 15. Security Requirements

### 15.1 No Open Proxy

The bridge must deny arbitrary upstreams by default.

Default mode:

- only named upstream profiles are allowed
- direct URLs are disabled unless development mode explicitly enables them

### 15.2 Authentication

All session and transport endpoints require authentication by default.

MVP method:

```http
Authorization: Bearer <token>
```

### 15.3 SSRF Protection

The server must protect against SSRF.

Requirements:

- block loopback by default
- block link-local by default
- block private networks by default
- block metadata IP ranges
- resolve DNS before connecting
- validate resolved IP against policy
- optionally re-check on reconnect

Private networks may only be enabled for explicit profiles.

### 15.4 Header Policy

Clients must not be able to forward arbitrary upstream headers.

Dangerous headers should be blocked unless explicitly allowed:

- `Host`
- `Authorization`
- `Cookie`
- `Origin`
- `Forwarded`
- `X-Forwarded-*`

### 15.5 CORS

CORS must be explicit.

Default:

- no wildcard with credentials
- allow only configured origins

### 15.6 Secret Redaction

Logs must redact:

- authorization headers
- cookies
- tokens
- session secrets
- configured secret values

---

## 16. Error Codes

Define stable machine-readable error codes.

Required MVP error codes:

```text
PROTOCOL_VERSION_UNSUPPORTED
AUTH_REQUIRED
AUTH_INVALID
POLICY_DENIED
UPSTREAM_NOT_ALLOWED
UPSTREAM_CONNECT_FAILED
UPSTREAM_CLOSED
SESSION_NOT_FOUND
SESSION_CLOSED
FRAME_TOO_LARGE
BUFFER_OVERFLOW
SEQUENCE_OUT_OF_ORDER
TRANSPORT_TIMEOUT
INTERNAL_ERROR
```

Standard error format:

```json
{
  "error": {
    "code": "UPSTREAM_CONNECT_FAILED",
    "message": "Unable to connect to upstream WebSocket",
    "retryable": true,
    "details": {}
  }
}
```

---

## 17. Client API Requirements

### 17.1 Low-Level API

```ts
const client = new BridgeClient({
  bridgeUrl: "https://bridge.example.com",
  authToken: "...",
  transport: "sse"
});

const session = await client.openSession({
  upstream: {
    adapter: "websocket",
    profile: "echo"
  }
});

session.on("frame", frame => {
  console.log(frame);
});

await session.sendText("hello");
await session.close(1000, "done");
```

### 17.2 WebSocket-Like API

```ts
import { Https2WssSocket } from "@https2wss/client";

const socket = new Https2WssSocket("wss://echo.example.com", {
  bridgeUrl: "https://bridge.example.com",
  authToken: "...",
  upstreamProfile: "echo"
});

socket.onopen = () => {
  socket.send("hello");
};

socket.onmessage = event => {
  console.log("received", event.data);
};

socket.onclose = event => {
  console.log("closed", event.code, event.reason);
};
```

MVP compatibility target:

- `readyState`
- `send()`
- `close()`
- `onopen`
- `onmessage`
- `onerror`
- `onclose`
- `addEventListener()`
- `removeEventListener()`
- approximate `bufferedAmount`

Do not claim full native WebSocket drop-in compatibility unless tests prove it.

---

## 18. Server Configuration

Example configuration:

```yaml
server:
  host: "0.0.0.0"
  port: 8080
  publicUrl: "https://bridge.example.com"

security:
  requireAuth: true
  tokens:
    - env: HTTPS2WSS_TOKEN
  cors:
    allowedOrigins:
      - "https://app.example.com"
  upstreamPolicy:
    default: deny
    allow:
      - name: echo
        adapter: websocket
        url: "ws://echo:9001"
        allowedHeaders: []
        allowPrivateNetwork: false
      - name: home-assistant-local
        adapter: websocket
        url: "ws://192.168.178.9:8123/api/websocket"
        allowedHeaders:
          - Authorization
        allowPrivateNetwork: true

sessions:
  idleTimeoutMs: 120000
  maxDurationMs: 3600000
  maxSessionsPerToken: 20
  maxFrameBytes: 1048576
  maxBufferedFrames: 1000
  maxBufferedBytes: 16777216
  overflowPolicy: close

transports:
  enabled:
    - sse
    - long_poll
    - poll
  sse:
    heartbeatIntervalMs: 30000
  longPoll:
    maxTimeoutMs: 30000

logging:
  level: info
  redactHeaders:
    - authorization
    - cookie
```

---

## 19. Docker and Deployment Requirements

The project must include Docker support.

### 19.1 Docker Image

Provide a production-ready Dockerfile for the bridge server.

Requirements:

- multi-stage build
- non-root runtime user
- minimal runtime image
- healthcheck
- environment-based configuration

Example usage:

```bash
docker run --rm \
  -p 8080:8080 \
  -e HTTPS2WSS_TOKEN=dev-token \
  -v ./config.yml:/app/config.yml:ro \
  ghcr.io/https2wss/https2wss-proxy:latest
```

### 19.2 Docker Compose Demo

Provide a compose setup with:

- bridge proxy
- local echo WebSocket server
- browser demo static server, if useful

Example:

```bash
docker compose up --build
```

Expected result:

- proxy available on `http://localhost:8080`
- echo WebSocket upstream available only inside compose network
- demo page available on `http://localhost:3000`

### 19.3 Deployment Documentation

Create `docs/deployment.md` covering:

- local development
- Docker run
- Docker Compose
- reverse proxy with HTTPS termination
- environment variables
- production security checklist

---

## 20. Documentation Requirements

Documentation must be written in English.

Required docs:

### 20.1 `README.md`

Must include:

- short project explanation
- what it is not
- quickstart
- architecture diagram
- minimal client example
- Docker example
- limitations
- security warning

### 20.2 `docs/protocol.md`

Must include:

- envelope format
- frame kinds
- session lifecycle
- sequence and ack rules
- transport behavior
- close/error semantics

### 20.3 `docs/security.md`

Must include:

- SSRF risks
- upstream allowlist model
- header policy
- authentication
- CORS
- safe deployment guidance

### 20.4 `docs/transports.md`

Must compare:

- polling
- long-polling
- SSE + POST
- future HTTP/2 / HTTP/3 options

### 20.5 `docs/limitations.md`

Must explicitly state:

- not a universal WebSocket replacement
- higher latency than native WebSockets
- no perfect backpressure equivalence
- binary overhead with base64
- not suitable for every realtime workload

### 20.6 `docs/adapter-authoring.md`

Must explain how to add new upstream adapters.

---

## 21. Examples

### 21.1 Echo Demo

A minimal end-to-end demo is mandatory.

It must show:

1. local WebSocket echo server
2. bridge proxy connected to that echo server
3. client sending via HTTPS POST
4. client receiving via SSE or long-poll
5. browser UI or Node script displaying the echoed message

### 21.2 Browser Example

Example code:

```html
<script type="module">
  import { Https2WssSocket } from "./client.js";

  const socket = new Https2WssSocket("wss://echo", {
    bridgeUrl: "http://localhost:8080",
    authToken: "dev-token",
    upstreamProfile: "echo"
  });

  socket.onopen = () => socket.send("hello from browser");
  socket.onmessage = event => console.log(event.data);
</script>
```

### 21.3 Node Example

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

---

## 22. Testing Requirements

### 22.1 Unit Tests

Required tests:

- valid envelope passes schema validation
- invalid protocol version fails
- text frame validation
- binary frame validation
- duplicate sequence detection
- out-of-order sequence detection
- buffer limit enforcement
- close frame validation
- error frame validation
- SSRF private IP denial
- header allowlist behavior

### 22.2 Integration Tests

Required tests:

- create session successfully
- deny session without auth
- deny disallowed upstream
- connect to local echo upstream
- send text frame and receive echo via poll
- send text frame and receive echo via SSE
- send binary frame and receive binary echo
- upstream close propagates to client
- client close propagates to upstream
- upstream connection failure creates structured error

### 22.3 End-to-End Test

Required command:

```bash
pnpm test:e2e
```

Expected behavior:

- starts echo server
- starts bridge proxy
- starts test client
- sends text message
- receives identical text message
- sends binary message
- receives identical binary message
- closes cleanly

---

## 23. CI Requirements

GitHub Actions should run:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

The CI should also build the Docker image, at least as a validation step.

---

## 24. MVP Acceptance Criteria

The MVP is complete when all of the following are true:

1. `pnpm install` succeeds.
2. `pnpm test` succeeds.
3. `pnpm test:e2e` succeeds.
4. `pnpm build` succeeds.
5. Docker image builds successfully.
6. Docker Compose demo starts successfully.
7. A client can send a text message through HTTPS POST to an upstream WebSocket echo server and receive the echo through SSE.
8. A client can send a binary message encoded as base64 and receive the same binary payload back.
9. A disallowed upstream is rejected.
10. An unauthenticated request is rejected.
11. Documentation explains the architecture, protocol, limitations, and security model.
12. No code comments, docs, examples, package metadata, or public names are in German.

---

## 25. Implementation Phases for Claude Code

### Phase 1: Bootstrap Repository

- Create monorepo.
- Configure TypeScript strict mode.
- Configure pnpm workspaces.
- Configure Vitest.
- Configure linting/formatting.
- Add CI workflow.

### Phase 2: Implement Protocol Package

- Define TypeScript types.
- Define Zod schemas.
- Define error codes.
- Add validation helpers.
- Add unit tests.

### Phase 3: Implement Session Core

- Implement `Session`.
- Implement `SessionManager`.
- Implement `Sequencer`.
- Implement `FrameBuffer`.
- Add unit tests for lifecycle, sequencing, and buffering.

### Phase 4: Implement Security Layer

- Implement bearer auth.
- Implement upstream profile policy.
- Implement SSRF guard.
- Implement header allowlist.
- Implement CORS config.
- Add security tests.

### Phase 5: Implement WebSocket Upstream Adapter

- Define `UpstreamAdapter` interface.
- Implement `WebSocketUpstreamAdapter` using `ws`.
- Map upstream open/message/error/close to bridge frames.
- Support text and binary frames.
- Add integration tests.

### Phase 6: Implement HTTP Transports

- `POST /v1/sessions`
- `POST /v1/sessions/:id/send`
- `GET /v1/sessions/:id/poll`
- `GET /v1/sessions/:id/events`
- `POST /v1/sessions/:id/close`
- Add integration tests.

### Phase 7: Implement Client Package

- Implement `BridgeClient`.
- Implement `PollTransport`.
- Implement `LongPollTransport`.
- Implement `SseTransport`.
- Implement `Https2WssSocket`.
- Add client tests.

### Phase 8: Implement Echo Demo

- Add local WebSocket echo server.
- Add bridge config for echo profile.
- Add browser demo.
- Add Node demo.
- Add Docker Compose demo.

### Phase 9: Documentation

- Write README.
- Write protocol docs.
- Write security docs.
- Write transport docs.
- Write limitations docs.
- Write deployment docs.

### Phase 10: Final Verification

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
docker compose up --build
```

Document any remaining limitations.

---

## 26. Open Design Questions

The implementation agent should make pragmatic MVP decisions and document them.

Questions:

1. Should a session require a separate session secret in addition to bearer auth?
2. Should resume be fully implemented in MVP or only partially supported?
3. Should acknowledgement values actively clean buffers in MVP?
4. Should SSE be the default receive transport?
5. Should direct upstream URLs be disabled by default?
6. Should the production server require HTTPS itself, or assume HTTPS termination by a reverse proxy?
7. Should the protocol remain JSON-only for MVP?

Recommended MVP decisions:

1. Use bearer auth plus unguessable session IDs. Add session secrets later if needed.
2. Support basic resume through `after`, but keep it simple.
3. Store `ack` and use it for buffer cleanup where straightforward.
4. Use SSE as default and long-poll as fallback.
5. Disable direct upstream URLs by default. Use named profiles.
6. Allow HTTP locally, document production HTTPS termination.
7. Use JSON-only for MVP, but keep the envelope abstraction encoding-neutral.

---

## 27. Suggested README Positioning

Use this wording or similar:

> `https2wss` is a protocol-level HTTPS-to-WebSocket bridge. It lets HTTPS-only clients communicate with WebSocket services through an explicit session protocol using POST, long-polling, or Server-Sent Events. It is not a transparent universal WebSocket replacement; it is a controlled bridge with clear semantics, security policies, and adapter support.

---

## 28. Final Instruction to the Implementation Agent

Implement a clean, tested, open-source-ready MVP of `https2wss` according to this specification.

Prioritize:

1. protocol correctness
2. clean architecture
3. security defaults
4. working echo demo
5. English documentation
6. maintainable code
7. reproducible tests
8. Docker-based local deployment

Do not prioritize:

- browser extension support
- reverse-proxy rewriting
- Spotify integration
- Home Assistant adapter beyond optional future scaffolding
- cluster deployment
- perfect native WebSocket compatibility

The final deliverable should be a repository that a developer can clone and run with:

```bash
pnpm install
pnpm test
pnpm test:e2e
pnpm build
docker compose up --build
```

A successful demo must prove that a client without native WebSocket usage can communicate with a real WebSocket echo upstream through HTTPS/SSE/POST via the bridge.
