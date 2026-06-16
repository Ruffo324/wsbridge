# ha-fallback demo

Browser page that exercises every `ResilientWebSocket` fallback path interactively.

## Prerequisites

1. Build the workspace (produces the browser bundle at `packages/client/dist/index.js`):

   ```powershell
   pnpm build
   ```

2. Set the bridge token (must match the proxy):

   ```powershell
   $env:HTTPS2WSS_TOKEN = "dev-token-1234"
   ```

3. Start the echo server (ws://localhost:9001), bridge proxy (http://localhost:8080), and
   this static server (http://localhost:3001) in three separate terminals:

   ```powershell
   pnpm --filter @https2wss/echo-demo echo
   pnpm --filter @https2wss/echo-demo proxy
   pnpm --filter @https2wss/ha-fallback-demo static
   ```

4. Open `http://localhost:3001` in a browser.

> Port 3001 is intentional — keeps this demo separate from the echo demo on port 3000.

## What each button does

| Button | Path exercised |
|--------|----------------|
| Connect (auto) | Full decision flow: checks sticky cookie, then tries native WebSocket on the configured target URL; falls through to bridge only if native fails or times out. |
| Connect (force fallback) | Injects a fake WebSocket constructor that throws synchronously, so the `connect-failure` fallback fires immediately without waiting for a network timeout. |
| Clear sticky cookie | Removes the `h2w-fallback` cookie and logs a message. The next Connect (auto) will re-evaluate native from scratch. |
| Disconnect | Calls `socket.close(1000, ...)`. |
| Send text | Sends the text input as a UTF-8 string. The echo server reflects it back. |
| Send binary | Sends `Uint8Array.from([0,1,2,3,4]).buffer`. The echo server reflects the bytes; the log displays them as hex. |

## Status strip

The strip below the buttons updates live:

- **readyState** — numeric + symbolic (`CONNECTING / OPEN / CLOSING / CLOSED`).
- **transport** — `native` (green) or `bridge` (amber).
- **last reason** — most recent `transport-change` reason:
  `sticky-cookie`, `no-native-support`, `connect-failure`, or `heartbeat-timeout`.

## Testing the heartbeat-timeout path

The heartbeat timeout path is covered by unit tests in `packages/client/src/`. For
browser QA, shut down the echo server while a native connection is open and watch the
wrapper switch transports after `heartbeatTimeoutMs` (default 5000 ms in this demo):

```powershell
# In a separate terminal, with the Docker compose setup:
wsl -- docker compose stop echo
```

The status strip will change from `transport: native` to `transport: bridge` with
`reason: heartbeat-timeout` once the watchdog fires.

## Cookie-sticky path

1. Click **Connect (force fallback)** — the wrapper writes `h2w-fallback=<expiry>` to
   the browser cookie jar and opens the bridge.
2. Reload the page (the cookie persists across reloads).
3. Click **Connect (auto)** — the wrapper reads the cookie, skips native entirely, and
   goes straight to bridge with `reason: sticky-cookie`.
4. Click **Clear sticky cookie** then **Connect (auto)** — native is tried again.
