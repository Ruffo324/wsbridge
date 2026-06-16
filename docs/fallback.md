# ResilientWebSocket — Fallback Reference

## Purpose

Use `ResilientWebSocket` when your client should prefer a native WebSocket connection
but needs to fall back to the https2wss bridge if native fails. The class exposes the
same surface as a native `WebSocket` (same event names, `send`, `close`, `readyState`)
so minimal changes are required in calling code. Once constructed, the wrapper handles
the transport decision automatically and emits a `transport-change` event whenever it
switches.

## Decision tree

```
construct
    |
    v
  sticky-fallback cookie present and not expired?
    |
    +-- yes --> bridge  (reason: sticky-cookie)
    |
    +-- no
          |
          v
        native WebSocket constructor available?
          |
          +-- no --> bridge  (reason: no-native-support)
          |
          +-- yes
                |
                v
              attempt native WebSocket (with nativeConnectTimeoutMs)
                |
                +-- opens OK --> native; clear cookie; start heartbeat watchdog
                |                     |
                |                     +-- heartbeat miss --> bridge  (reason: heartbeat-timeout)
                |
                +-- error / close before open, or timeout -->
                        write sticky cookie; bridge  (reason: connect-failure)
```

Once on bridge, the instance stays on bridge. Create a new `ResilientWebSocket` to
re-evaluate (cookie permitting).

## API

### `ResilientWebSocketInit`

```ts
interface ResilientWebSocketInit {
  /** Bridge fallback configuration. Required. */
  bridge: Https2WssSocketInit;

  /** Max ms to wait for native `open` before declaring failure. Default 4000. */
  nativeConnectTimeoutMs?: number;

  /** Max ms with no inbound traffic before a mid-session connection is dead. Default 15000. */
  heartbeatTimeoutMs?: number;

  /**
   * Optional alive callback for custom liveness logic.
   * When provided, OVERRIDES the default lastMsgAgeMs > heartbeatTimeoutMs rule.
   */
  isAlive?: (lastMsgAgeMs: number) => boolean;

  /** Cookie name for the sticky fallback decision. Default "h2w-fallback". */
  cookieName?: string;

  /** TTL for the sticky-fallback cookie in ms. Default 86400000 (24 hours).
   *  Set to 0 to disable cookie persistence entirely. */
  cookieTtlMs?: number;

  /** Inject a cookie jar for tests or non-browser environments. */
  cookies?: CookieJar;

  /** Inject a clock for tests. Default Date.now. */
  clock?: () => number;

  /** Override WebSocket constructor for tests or to force the fallback path. */
  webSocketCtor?: typeof WebSocket;
}
```

### `ResilientWebSocket`

```ts
class ResilientWebSocket extends EventTarget {
  constructor(target: string, init: ResilientWebSocketInit);

  readonly url: string;
  readonly readyState: 0 | 1 | 2 | 3;  // CONNECTING / OPEN / CLOSING / CLOSED
  readonly transport: "native" | "bridge";
  readonly bufferedAmount: number;

  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;

  onopen:    ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror:   ((ev: Event) => void) | null;
  onclose:   ((ev: CloseEvent | Event) => void) | null;
}
```

Default values summary:

| Field | Default |
|-------|---------|
| `nativeConnectTimeoutMs` | `4000` |
| `heartbeatTimeoutMs` | `15000` |
| `cookieName` | `"h2w-fallback"` |
| `cookieTtlMs` | `86400000` (24 h) |

## Events

| Name | Payload type | When fired |
|------|-------------|------------|
| `open` | `Event` | The active transport (native or bridge) is open and ready for `send`. |
| `message` | `MessageEvent` | A message frame is received from the upstream. |
| `error` | `Event` | A transport error occurs. On native, a mid-session error is forwarded; a pre-open error triggers fallback instead. |
| `close` | `CloseEvent` (or `Event` with `.code` / `.reason`) | The connection closed (caller-initiated or remote). |
| `transport-change` | `CustomEvent<{ from: Transport, to: Transport, reason: FallbackReason }>` | The wrapper switched transports. Always fires before `open` on the new transport. |

`FallbackReason` values: `"sticky-cookie"` | `"no-native-support"` | `"connect-failure"` | `"heartbeat-timeout"`.

## Cookie persistence

**Cookie name:** `h2w-fallback` (configurable via `cookieName`).

**Value format:** a decimal epoch-ms string representing the expiry of the fallback
decision, e.g. `"1750123456789"`. Only the bridge decision is persisted; a missing or
unreadable cookie means "try native optimistically".

**TTL:** 24 hours by default (`cookieTtlMs`). Cleared automatically when native opens
successfully.

**Security attributes:** `SameSite=Lax`, `Path=/`. `Secure` is added automatically when
the page is served over HTTPS.

**Threat model:** the cookie contains no secret — only a routing hint (expiry timestamp).
If an attacker forges the cookie, the worst outcome is that the victim's client routes
through the bridge instead of native for up to one TTL period. The bridge still requires
a valid bearer token; no elevated access is granted by the forged cookie.

## `isAlive` override

By default, the heartbeat watchdog fires if no inbound message arrives within
`heartbeatTimeoutMs`. For Home Assistant or other protocols that have their own ping/pong
at the application layer, supply `isAlive` to use the application-level signal:

```ts
const ws = new ResilientWebSocket(target, {
  bridge: { ... },
  heartbeatTimeoutMs: 30_000,
  isAlive(lastMsgAgeMs) {
    // Consider alive as long as any message arrived within the last 30 s,
    // or if a ping/pong is pending (tracked externally).
    return lastMsgAgeMs < 30_000 || hasPongPending;
  },
});
```

When `isAlive` returns `false`, the watchdog closes the native socket (code 1006) and
triggers fallback with reason `heartbeat-timeout`.

## Limitations

- **No automatic native re-evaluation while online.** Once on bridge, the instance stays
  on bridge until it is closed and a new `ResilientWebSocket` is constructed (with the
  cookie expired or cleared).
- **Pending sends during handoff are best-effort.** Messages sent between transport
  failure and bridge open are buffered internally; if the buffer is drained after bridge
  open but before the bridge is ready, they are retried once. No guarantee of delivery.
- **Cookie scope is per-origin.** The fallback cookie applies to the full origin
  (`scheme://host:port`). If your app runs on multiple paths with different bridge needs,
  use distinct `cookieName` values.
- **No `binaryType` setter.** Binary data is always delivered as `ArrayBuffer`.
- **`bufferedAmount` is approximate** — delegates to the inner socket's own
  `bufferedAmount` value.

## Example — Home Assistant

```ts
import { ResilientWebSocket } from "@https2wss/client";

const ws = new ResilientWebSocket(
  "wss://homeassistant.local/api/websocket",
  {
    bridge: {
      bridgeUrl: "http://homeassistant.local:8080",
      authToken: HA_ADDON_BRIDGE_TOKEN,   // from add-on config
      upstreamProfile: "ha-core",
    },
    nativeConnectTimeoutMs: 5_000,
    heartbeatTimeoutMs: 30_000,
  }
);

ws.addEventListener("transport-change", (ev) => {
  console.log(`transport: ${ev.detail.to} (${ev.detail.reason})`);
});

ws.onopen = () => {
  // HA auth flow: send auth message with long-lived access token
  ws.send(JSON.stringify({ type: "auth", access_token: HA_LONG_LIVED_TOKEN }));
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "auth_ok") console.log("authenticated");
};
```
