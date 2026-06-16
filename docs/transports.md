# Transports Reference

## Endpoint reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/sessions` | Bearer | Create session, connect upstream |
| `POST` | `/v1/sessions/:id/send` | Bearer | Send one or more frames to upstream |
| `GET` | `/v1/sessions/:id/poll` | Bearer | Receive frames (short-poll or long-poll) |
| `GET` | `/v1/sessions/:id/events` | Bearer | Receive frames via SSE stream |
| `POST` | `/v1/sessions/:id/close` | Bearer | Close session |
| `GET` | `/healthz` | None | Health check |

### POST /v1/sessions

Request body:

```json
{
  "protocol": "https2wss",
  "version": 1,
  "transport": { "mode": "sse", "fallbacks": ["long_poll", "poll"] },
  "upstream": { "adapter": "websocket", "profile": "echo" },
  "options": { "binary": "base64", "ordered": true }
}
```

`transport.mode` values: `"sse"`, `"long_poll"`, `"poll"`. Fallbacks are tried in order if the requested mode is not enabled.

Response (200):

```json
{
  "sessionId": "h2w_xK9mLqR4tN2vW8zY",
  "state": "connecting",
  "transport": {
    "selected": "sse",
    "sendUrl": "/v1/sessions/h2w_xK9mLqR4tN2vW8zY/send",
    "receiveUrl": "/v1/sessions/h2w_xK9mLqR4tN2vW8zY/events"
  },
  "limits": {
    "maxFrameBytes": 1048576,
    "maxBufferedFrames": 1000,
    "idleTimeoutMs": 120000
  }
}
```

`receiveUrl` is `.../events` for SSE and `.../poll` for poll/long_poll modes.

### POST /v1/sessions/:id/send

Request body: `{ "frames": [BridgeEnvelope, ...] }`.

Response (200): `{ "accepted": true, "ack": N, "state": "open" }`.

`ack` is the highest c2b seq the server has accepted. Frames are forwarded to the upstream adapter in the order received. A close frame in the array stops processing subsequent frames.

Errors: `SESSION_NOT_FOUND` (404), `SEQUENCE_OUT_OF_ORDER` (409), `POLICY_DENIED` (403).

### GET /v1/sessions/:id/poll

Query params:

| Param | Default | Max |
|-------|---------|-----|
| `after` | `0` | — |
| `timeoutMs` | `25000` | `longPoll.maxTimeoutMs` (default 30000) |

Response (200):

```json
{
  "frames": [...],
  "nextAfter": 3,
  "state": "open"
}
```

### GET /v1/sessions/:id/events

Query params: `after=N` (optional; overridden by `Last-Event-ID` header).

Response: `text/event-stream` with headers `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

### POST /v1/sessions/:id/close

Request body: `{ "code": 1000, "reason": "client requested close" }`. Both fields have defaults and are optional.

Response (200): `{ "closed": true, "state": "closed" }`.

### GET /healthz

No auth. Response: `{ "status": "ok", "sessions": N }` where `N` is the current active session count.

## Polling (short-poll)

Set `timeoutMs=0` in the query. The server calls `buffer.since(after)` immediately. If frames are available they are returned; if none, `frames: []` is returned immediately with `nextAfter` equal to `after`.

The client is responsible for backoff between polls. No server-side hold.

## Long-polling

Set `timeoutMs=N` (up to `longPoll.maxTimeoutMs`). The server holds the request open until either:

- one or more frames arrive (via `outbound_frame` event), or
- the session closes, or
- `timeoutMs` elapses → returns `frames: []`.

On client disconnect (HTTP connection closed before the timeout), the server resolves internally and discards the no-op response.

## SSE

The SSE stream uses `reply.hijack()` (Fastify raw stream mode). Fastify does not call `reply.send()` for SSE responses.

Wire format example:

```
:ok

id: 1
event: frame
data: {"v":1,"sid":"h2w_xK9mLqR4tN2vW8zY","seq":1,"kind":"control","ts":"2026-06-15T12:00:00.000Z","payload":{"event":"upstream_open"}}

id: 2
event: frame
data: {"v":1,"sid":"h2w_xK9mLqR4tN2vW8zY","seq":2,"kind":"data","ts":"2026-06-15T12:00:00.123Z","payload":{"opcode":"text","encoding":"utf8","data":"hello","fin":true}}

: heartbeat 2026-06-15T12:00:30.000Z

event: close
data: {}

```

Lines:
- `:ok\n\n` — initial comment to flush the response buffer immediately.
- `id: {seq}` — allows browser `EventSource` to populate `lastEventId` automatically.
- `event: frame` — distinguishes data frames from the terminal `close` event.
- `: heartbeat {ISO}` — SSE comment; no `id`, no `event`, no `data`. Sent every `heartbeatIntervalMs` (default 30 s).
- `event: close\ndata: {}\n\n` — sent when the session closes; signals the client to stop reconnecting.

**Nginx note for SSE:** when proxying, add `proxy_buffering off;`, `proxy_set_header Connection '';`, and `proxy_http_version 1.1;`. See [docs/deployment.md](./deployment.md).

### Reconnect and replay

On reconnect, the SSE client sends `Last-Event-ID: N`. The bridge replays all frames with `seq > N` from the FrameBuffer. The browser `EventSource` sets this header automatically; the `SseTransport` in the client package sets it explicitly.

Duplicate frames may appear after reconnect. The client must de-duplicate by `seq`.

## Future transports

HTTP/2 server push, HTTP/3 QUIC streams, and multipart binary endpoints are listed as non-goals for the MVP. The `BridgeEnvelope` abstraction is encoding-neutral (a CBOR seam exists in the design) but only JSON is implemented.
