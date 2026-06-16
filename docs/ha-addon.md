# Home Assistant Add-on

## What

The https2wss add-on hosts the bridge proxy inside Home Assistant OS or Supervised
installations. It runs as a Supervisor-managed container with access to the internal HA
network, making the bridge reachable on host port 8080.

## Install

Full installation instructions are in [`addons/https2wss/DOCS.md`](../addons/https2wss/DOCS.md).
Short summary:

1. **Settings → Add-ons → Add-on Store → Repositories** — add the community repository URL.
2. Find **https2wss** in the store → **Install**.
3. Open the **Configuration** tab, fill in options (see table below), click **Save**.
4. **Start** the add-on. Check the **Log** tab for the startup message and any
   auto-generated token value.

## Configuration mapping

| Add-on option | `config.yml` field | Effect |
|---|---|---|
| `token` | `HTTPS2WSS_TOKEN` | Bearer token clients use for `Authorization: Bearer`. Leave empty to auto-generate on first start. |
| `upstream_profile_name` | profile name in proxy config | Internal label for the HA upstream profile. |
| `upstream_url` | `UPSTREAM_URL` | WebSocket URL of HA Core. Default `ws://homeassistant:8123/api/websocket`. |
| `upstream_allow_private_network` | adapter flag | Allow connections to private-network upstreams. Set `true` for internal HA URL. |
| `allowed_origins` | `ALLOWED_ORIGINS` | CORS origin allowlist. Empty means no restriction; add your dashboard origin for production. |
| `log_level` | `LOG_LEVEL` | Verbosity: `fatal` `error` `warn` `info` `debug` `trace`. |
| `idle_timeout_ms` | `IDLE_TIMEOUT_MS` | Session idle timeout in ms. Default 120000. |
| `max_frame_bytes` | `MAX_FRAME_BYTES` | Maximum bytes per forwarded WebSocket frame. Default 1048576. |

## Networking

The add-on listens on **host port 8080** by default. For local dashboard use this is
sufficient. For production or external access:

- Terminate TLS with the **NGINX Proxy Manager** add-on (or another reverse proxy).
  Map `https://homeassistant.local:8443` → `http://localhost:8080` and enable HTTPS.
- Set `allowed_origins` to your specific dashboard origin, e.g.
  `https://my-dashboard.example.com`. Leaving it empty allows all origins from the
  same port, which is acceptable for private-network deployments but not for internet-
  facing ones.
- Do not expose port 8080 directly to the internet.

## Token flows

There are two separate authentication tokens:

```
Browser client
    |
    |  Authorization: Bearer <BRIDGE_TOKEN>   (add-on option `token`)
    v
https2wss bridge (port 8080)
    |
    |  ws://homeassistant:8123/api/websocket
    |  (allowedHeaders forwards Authorization from client)
    v
HA Core WebSocket API
    ^
    |  Authorization: Bearer <HA_LONG_LIVED_TOKEN>
    |  (sent by the client as a message, not an HTTP header)
    |
    (HA auth flow: client sends { type:"auth", access_token: ... })
```

- **Bridge token** (`token` add-on option): authenticates a client to the *bridge*.
  Set it yourself or let the add-on generate it. Find the auto-generated value in the
  **Log** tab or at `/data/generated-token.txt` inside the container.
- **HA long-lived access token**: authenticates the WebSocket *session* to HA Core.
  This is sent by the client inside the WebSocket message stream (HA's own auth
  protocol), not as an HTTP header to the bridge.

## Connecting a resilient client

```ts
import { ResilientWebSocket } from "@https2wss/client";

const ws = new ResilientWebSocket(
  "wss://homeassistant.local/api/websocket",
  {
    bridge: {
      bridgeUrl: "http://homeassistant.local:8080",
      authToken: HA_ADDON_BRIDGE_TOKEN,
      upstreamProfile: "ha-core",
    },
    nativeConnectTimeoutMs: 5_000,
    heartbeatTimeoutMs: 30_000,
  }
);

ws.onopen = () => {
  // HA WebSocket auth flow
  ws.send(JSON.stringify({ type: "auth", access_token: HA_LONG_LIVED_TOKEN }));
};
```

See [docs/fallback.md](./fallback.md) for the full `ResilientWebSocket` API, decision
tree, and cookie-persistence details.

## Upgrade path

- In the Supervisor UI, the add-on shows an **Update** button when a new version is
  published to the repository.
- Add-on data (auto-generated token, any persistent state) lives in `/data` inside the
  container, which Supervisor preserves across updates and restarts.
- After an update, existing sessions are closed; clients reconnect automatically if they
  use `ResilientWebSocket` or implement their own reconnect logic.
- To rotate the bridge token after an upgrade: set an explicit value in the `token`
  field, save, and restart. Update the `authToken` in all clients.
