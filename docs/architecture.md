# Architecture

## Overview

The system has five logical layers:

```
[Application / Compatibility API]   Https2WssSocket, BridgeClient
          |
[Client Runtime]                    BridgeSession, transports
          |
[https2wss Bridge Protocol]         Envelope, frames, seq, ack
          |
[Bridge Server Session Runtime]     Session, FrameBuffer, Sequencer, SessionManager
          |
[Upstream Adapter]                  WebSocketUpstreamAdapter
          |
[Target Service]                    any ws:// or wss:// endpoint
```

### Layer descriptions

| Layer | Responsibility |
|-------|---------------|
| Application / Compatibility API | Developer-facing surface: `Https2WssSocket` (WebSocket-like) and `BridgeClient` (low-level). |
| Client Runtime | Session creation, frame sending/receiving, transport selection, SSE/poll reconnect, dedup by seq. |
| Bridge Protocol | Envelope schema, frame kinds, session states, seq counters, ack, close semantics. |
| Bridge Server Session Runtime | Holds upstream connection state, FrameBuffer, per-session Sequencer, idle/duration timers, token quota. |
| Upstream Adapter | Translates bridge frames to/from a concrete upstream protocol. MVP: WebSocket via `ws`. |

## Package layout

| Package | Purpose | Depends on |
|---------|---------|------------|
| `@https2wss/protocol` | Types, Zod schemas, error codes, envelope build/parse helpers | zod |
| `@https2wss/proxy` | Fastify server, sessions, security, transports, upstream adapter | protocol, fastify, @fastify/cors, ws, zod, yaml |
| `@https2wss/client` | BridgeClient, BridgeSession, Https2WssSocket, SSE/poll transports | protocol |
| `@https2wss/adapters-home-assistant` | Scaffold (empty) | client |
| `@https2wss/echo-demo` | Standalone + Docker demo | proxy, client, ws |

Build order: `protocol` → `client`, `proxy` → `adapters` → `examples`.

Dependency graph:

```
protocol ──► client ──► adapters/home-assistant
         └──► proxy ──► examples/echo
```

## Request lifecycle — POST /v1/sessions

1. Fastify `onRequest` hook runs `auth.verifyAuthorizationHeader()`. On failure → `AUTH_REQUIRED` (401) or `AUTH_INVALID` (401) with `WWW-Authenticate: Bearer`.
2. Route handler parses body via Zod. Protocol/version mismatch → `PROTOCOL_VERSION_UNSUPPORTED` (400).
3. `upstreamPolicy.resolve()` maps profile name to `ResolvedUpstream` (URL, allowedHeaders, allowPrivateNetwork). Unknown profile → `UPSTREAM_NOT_ALLOWED` (403).
4. Transport selection: requested mode checked against `config.transports.enabled`; fallbacks tried in order. No match → `POLICY_DENIED` (403).
5. `sessionManager.create()` enforces token quota (`maxSessionsPerToken`). Over limit → `POLICY_DENIED` (403). Creates `Session` with `Sequencer` and `FrameBuffer`.
6. `upstreamAdapterFactory` builds a `WebSocketUpstreamAdapter`.
7. Outbound frame subscription wired: `session.on("outbound_frame")` → `FrameBuffer.store()`. On overflow → session closed with `BUFFER_OVERFLOW`.
8. `adapter.connect()` runs SSRF check (`ssrfGuard.assertAllowed(url)`) and header filter (`HeaderPolicy.filterOutbound()`). TCP connect to upstream via `ws`. Timeout default 10 s. On failure → `UPSTREAM_CONNECT_FAILED` (502), session closed.
9. On upstream `open` event: `session.markUpstreamOpen()` → state `connecting → open`. Emits `upstream_open` control frame into FrameBuffer.
10. Response returned: `sessionId`, `state`, transport URLs, limits.

Source files: `packages/proxy/src/transports/createSession.ts`, `packages/proxy/src/upstream/WebSocketUpstreamAdapter.ts`, `packages/proxy/src/sessions/SessionManager.ts`.

## Frame lifecycle — bridge-to-client

1. Upstream WebSocket fires `message` event → `WebSocketUpstreamAdapter.onMessage()`.
2. Adapter calls `session.sequencer.nextOut()` to mint b2c seq, builds `BridgeEnvelope`.
3. `session.emitOutbound(envelope)` fires `outbound_frame` event.
4. Subscriber stores envelope in `FrameBuffer` (bounded by `maxFrameBytes`, `maxBufferedFrames`, `maxBufferedBytes`).
5. SSE handler writes `id: {seq}\nevent: frame\ndata: {json}\n\n` directly to the open response stream.
6. Poll handler resolves the pending long-poll promise with `buffer.since(after)`.
7. Client receives frames, de-duplicates by `seq` (drops frames with `seq ≤ lastSeen`).
8. Client sends `ack` field in next outbound frame → `FrameBuffer.ack(n)` trims stored frames with `seq ≤ n`.

## Concurrency model

- Single-process Node.js. No cluster, no worker threads in the bridge core.
- One upstream WebSocket per session.
- Per-session `Sequencer`: two independent monotonic counters (c2b, b2c), starting at 1.
- Per-session `FrameBuffer`: bounded by frame count and byte total. Overflow closes the session.
- Idle/duration expiry via `SessionManager.tick()` polled on `tickIntervalMs` (default 5 s).

## Persistence

None. All session state is in-memory. Sessions are removed from the registry on close. A process restart loses all active sessions. Clients see `SESSION_NOT_FOUND` after restart.
