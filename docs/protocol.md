# Protocol Reference

## Envelope format

Every bridge message is wrapped in a `BridgeEnvelope`:

```ts
interface BridgeEnvelope {
  v: 1;                                               // protocol version
  sid: string;                                        // session ID — regex: /^h2w_[A-Za-z0-9_-]{16,}$/
  seq: number;                                        // integer >= 1
  ack?: number;                                       // integer >= 0 (optional)
  kind: "data" | "control" | "error" | "close" | "heartbeat";
  ts: string;                                         // ISO 8601 datetime (z.iso.datetime())
  payload: DataPayload | ControlPayload | ClosePayload | ErrorPayload | HeartbeatPayload;
}
```

JSON example:

```json
{
  "v": 1,
  "sid": "h2w_xK9mLqR4tN2vW8zY",
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

`sid` pattern: `h2w_` prefix followed by at least 16 base62-URL characters (`[A-Za-z0-9_-]`). Generated server-side from 128 bits of crypto random.

`seq` starts at 1 per direction. There are two independent counters per session: c2b (client to bridge) and b2c (bridge to client).

`ts` must parse as a valid ISO 8601 datetime. The server uses `new Date().toISOString()`.

`ack` carries the highest seq the sender has processed and buffered. Receiving side calls `FrameBuffer.ack(n)` to trim stored frames with `seq <= n`.

## Frame kinds

| `kind` | Payload type | Purpose |
|--------|-------------|---------|
| `data` | `DataPayload` | Application message (text or binary) |
| `control` | `ControlPayload` | Session lifecycle events |
| `error` | `ErrorPayload` | Structured error notification |
| `close` | `ClosePayload` | Session close with code/reason/source |
| `heartbeat` | `{}` (empty object, strict) | Keep-alive; no application data |

### DataPayload

```ts
interface DataPayload {
  opcode: "text" | "binary";
  encoding: "utf8" | "base64";
  data: string;
  fin: boolean;
}
```

Refinement enforced by Zod: `opcode === "text"` requires `encoding === "utf8"`; `opcode === "binary"` requires `encoding === "base64"`. Mismatches are rejected at validation.

Binary data is always base64-encoded inside JSON. The client decodes base64 to `ArrayBuffer`.

### ControlPayload

```ts
interface ControlPayload {
  event: "upstream_open" | "upstream_close" | "client_ready" | "transport_ready" | "drain";
  details?: Record<string, unknown>;
}
```

The bridge emits `upstream_open` when the upstream WebSocket handshake completes. Other events are defined but not actively used in MVP.

### ClosePayload

```ts
interface ClosePayload {
  code: number;   // 1000–4999 (WebSocket close code conventions)
  reason: string;
  source: "client" | "bridge" | "upstream" | "timeout" | "policy";
}
```

### ErrorPayload

```ts
interface ErrorPayload {
  code: string;       // one of the 14 BridgeErrorCode values
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

### HeartbeatPayload

`{}` — strict empty object. No application fields allowed.

## Session lifecycle

```
         create()
            |
            v
       [connecting]
            |
  markUpstreamOpen()  ──────  markErrored()
            |                       |
            v                       v
         [open]               [errored]
            |                       |
  markClosing()              markClosed()
            |                       |
            v                       v
        [closing]  ────────►  [closed]
            |
       markClosed()
            |
            v
         [closed]
```

State transitions:

| From | To | Trigger |
|------|----|---------|
| `connecting` | `open` | upstream WebSocket `open` event |
| `connecting` | `errored` | SSRF check failure, connect timeout, pre-open error |
| `connecting` | `closing` | `SessionManager.close()` called before upstream opens |
| `open` | `closing` | client close frame, `SessionManager.close()`, idle/duration timeout |
| `open` | `errored` | post-open upstream error |
| `closing` | `closed` | `markClosed()` |
| `errored` | `closed` | `markClosed()` |

Terminal state: `closed`. Sessions are removed from `SessionManager` registry on close.

## Sequence and ack rules

Two independent monotonic counters per session, each starting at 1.

### Inbound (c2b) classification — server side

| Condition | Classification | Server action |
|-----------|---------------|--------------|
| `seq === nextExpected` | `accept` | advance `nextExpected`; deliver frame |
| `seq < nextExpected` | `duplicate` | silently swallow; touch session; re-ack |
| `seq > nextExpected` | `out_of_order` | close session with `SEQUENCE_OUT_OF_ORDER`; return 409 |
| non-positive integer | `out_of_order` | same as above |

### Outbound (b2c) — client side

Client must de-duplicate received frames by seq: if `seq <= lastReceivedSeq`, discard. This handles SSE reconnect and poll replay.

Delivery guarantee: **at-least-once** during replay; **at-most-once** on an active uninterrupted connection. No global exactly-once guarantee.

## Replay semantics

On SSE reconnect or poll, the client provides a resume position:

- **SSE**: `Last-Event-ID` header (set automatically by the browser `EventSource`; the `SseTransport` parser passes it explicitly). Takes precedence over `after` query param.
- **Poll / SSE query param**: `?after=N`

The server returns all buffered frames with `seq > N` from `FrameBuffer.since(N)`.

Precedence: `Last-Event-ID` header wins over `after` query param (see `packages/proxy/src/transports/sse.ts`).

## Close semantics

Close frame sources:

| `source` | Meaning |
|---------|---------|
| `client` | Client sent a close frame or called `POST /close` |
| `bridge` | Bridge initiated close (policy violation, buffer overflow, shutdown) |
| `upstream` | Upstream WebSocket sent a close frame |
| `timeout` | Idle timeout or max duration exceeded |
| `policy` | Policy enforcement (SSRF, allowlist, quota) |

On upstream close, the adapter emits a close frame with `source: "upstream"` into the FrameBuffer and calls `session.markClosing()` + `session.markClosed()`.

On client close frame (received via `POST /send`), the adapter calls `adapter.close()` and `sessionManager.close()`.

On `POST /close`, the adapter and session are both closed.

## Error codes

14 stable error codes defined in `packages/protocol/src/errors.ts`:

| Code | HTTP status | Default retryable |
|------|-------------|-------------------|
| `PROTOCOL_VERSION_UNSUPPORTED` | 400 | false |
| `AUTH_REQUIRED` | 401 | false |
| `AUTH_INVALID` | 401 | false |
| `POLICY_DENIED` | 403 | false |
| `UPSTREAM_NOT_ALLOWED` | 403 | false |
| `UPSTREAM_CONNECT_FAILED` | 502 | true |
| `UPSTREAM_CLOSED` | 410 | false |
| `SESSION_NOT_FOUND` | 404 | false |
| `SESSION_CLOSED` | 410 | false |
| `FRAME_TOO_LARGE` | 413 | false |
| `BUFFER_OVERFLOW` | 507 | false |
| `SEQUENCE_OUT_OF_ORDER` | 409 | false |
| `TRANSPORT_TIMEOUT` | 504 | true |
| `INTERNAL_ERROR` | 500 | false |

Error response body (HTTP errors and error frames share the same shape):

```json
{
  "error": {
    "code": "UPSTREAM_CONNECT_FAILED",
    "message": "upstream connect timed out",
    "retryable": true
  }
}
```

## Heartbeats

Three independent heartbeat layers:

| Layer | Mechanism | Default interval |
|-------|-----------|-----------------|
| Client-to-bridge transport | SSE: browser reconnects on timeout; long-poll reconnects after `timeoutMs` | per-request |
| Bridge-to-client SSE | Comment line `": heartbeat <ISO timestamp>"` written to SSE stream | 30 s (`sse.heartbeatIntervalMs`) |
| Bridge-to-upstream WebSocket | `ws` library ping/pong; connection errors propagated as error frames | ws default |

The SSE heartbeat comment keeps the connection alive through intermediate proxies. It is not a bridge envelope — it has no `seq` or `kind`.

Long-poll transport re-issues requests immediately on return; the effective heartbeat interval equals the `timeoutMs` of the previous request.
