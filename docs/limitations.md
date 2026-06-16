# Limitations

## Not a universal WebSocket replacement

`https2wss` requires clients to speak the explicit bridge protocol. It cannot be dropped into an application that uses native `WebSocket` without code changes. `Https2WssSocket` provides a WebSocket-like surface but it is not a native `WebSocket` subclass and does not pass W3C WebSocket conformance tests.

Specifically, `Https2WssSocket` does not implement:
- `bufferedAmount` exactly (value is approximate — based on pending frame byte estimates in `BridgeSession`)
- `protocol` property
- `extensions` property
- `binaryType` setter (binary data is always returned as `ArrayBuffer`)
- full `CloseEvent` in environments without native `CloseEvent` (falls back to a plain `Event` with added properties)

## Higher latency than native WebSocket

Each direction involves at least one HTTP request/response cycle:
- c2b: client issues `POST /send`, waits for 200.
- b2c: SSE stream has low latency but requires an active connection; long-poll introduces up to `timeoutMs` (default 25 s) of latency per message if no frames are buffered.

For workloads sensitive to sub-100 ms round-trip times, native WebSocket is more appropriate.

## No exact backpressure equivalence

The native WebSocket `bufferedAmount` reflects bytes queued in the TCP send buffer. `Https2WssSocket.bufferedAmount` returns `BridgeSession.bufferedAmount`, which is an estimate based on pending outbound HTTP requests and frame byte counts — not TCP-level pressure.

The server enforces hard limits via `FrameBuffer`: when `maxBufferedFrames` or `maxBufferedBytes` is exceeded, the session is closed with `BUFFER_OVERFLOW`. There is no flow-control mechanism to pause the upstream — the upstream continues sending until the session closes.

## Binary overhead

Binary payloads are base64-encoded inside JSON envelopes. Base64 adds approximately 33% overhead to binary message size. For workloads with high binary throughput, this is significant.

Future: CBOR or multipart binary endpoints would eliminate this overhead. Not implemented in MVP.

## No multi-node session state

Sessions are stored in-memory in a single Node.js process. There is no shared session store (Redis, database, etc.). A load balancer with sticky sessions could work, but a process restart or failover loses all sessions. Clients see `SESSION_NOT_FOUND` after reconnecting to a new instance.

## No persistent session resume across restarts

`FrameBuffer` is in-memory. On process restart, all buffered frames and all session state are lost. Clients must create a new session. The `after` / `Last-Event-ID` replay mechanism only works within the same process lifetime.

## No browser monkey-patching

The bridge does not intercept or replace the native browser `WebSocket` constructor. Sites that use `new WebSocket(...)` directly are not affected. Integration requires explicit use of `Https2WssSocket` or `BridgeClient`.

## Single upstream adapter type in MVP

Only the `WebSocketUpstreamAdapter` (generic `ws://` / `wss://`) is functional. The Home Assistant adapter scaffold (`packages/adapters/home-assistant/`) exports an empty module. JSON-RPC and other protocol-specific adapters are not implemented.

## Approximate per-token quota only

Session limits are enforced per `tokenId` (a sha256 prefix of the raw token). Two tokens that hash to the same 8-character prefix would share a quota bucket. In practice, with secure random tokens, collisions are negligible but possible. The quota is not enforced across process restarts.

## No rate limiting at the bridge layer

The bridge does not implement request rate limiting. All rate limiting must be handled by the reverse proxy in front of the bridge. Exposing the bridge directly to the internet without a rate-limiting proxy will allow abuse (session creation storms, send floods).

## Single overflowPolicy: close

Only `overflowPolicy: close` is implemented. There is no `drop` or `backpressure` policy. If the client stops polling and the buffer fills, the session terminates. This is consistent with WebSocket-like behavior (no silent frame drops) but may be surprising for slow consumers.
