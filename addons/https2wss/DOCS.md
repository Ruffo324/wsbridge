# https2wss Add-on — Documentation

## Overview

**https2wss** is a bridge proxy that exposes the Home Assistant WebSocket API (and other
WebSocket upstreams) over plain HTTP using Server-Sent Events (SSE), long-polling, or
simple polling.  This lets HTTPS-only clients — browsers, IoT devices, or services that
cannot negotiate a WebSocket upgrade — reach the HA WebSocket API without special
networking.

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Click the menu (three dots, top right) → **Repositories**.
3. Add the community repository URL:
   ```
   https://github.com/<owner>/https2wss-addon
   ```
   (Replace `<owner>` with the actual GitHub user/org — the repository owner will fill
   this in after publishing.)
4. Find **https2wss** in the store and click **Install**.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `token` | string | `""` | Bridge bearer token.  Clients pass this in `Authorization: Bearer <token>`.  Leave empty to auto-generate. |
| `upstream_profile_name` | string | `"ha-core"` | Internal name for the HA WebSocket upstream profile. |
| `upstream_url` | URL | `ws://homeassistant:8123/api/websocket` | WebSocket URL of the upstream to connect to.  `homeassistant` resolves to HA Core inside the Supervisor network. |
| `upstream_allow_private_network` | bool | `true` | Allow the upstream to be on a private network.  Keep `true` for the default HA internal URL; set `false` for public upstreams. |
| `allowed_origins` | list | `[]` | CORS allowed origins.  Empty means no Origin header restriction (all same-port requests pass).  Add specific origins such as `https://my-dashboard.example.com` to restrict cross-origin access. |
| `log_level` | choice | `"info"` | Log verbosity: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `idle_timeout_ms` | int | `120000` | Milliseconds of inactivity before a session is closed. |
| `max_frame_bytes` | int | `1048576` | Maximum size (bytes) of a single WebSocket frame forwarded by the bridge. |

### Token auto-generation

If `token` is left empty (the default), the add-on generates a cryptographically random
48-character token on first start and writes it to `/data/generated-token.txt` (mode
0600, visible only to the add-on process).  The token is also printed in the add-on log
at startup:

```
[WARNING] No token configured — generated one at /data/generated-token.txt
[WARNING] Token: <token-value>
```

On subsequent restarts the same token is read from `/data/generated-token.txt` so
clients do not need to be reconfigured.  To rotate the token, set an explicit value in
the `token` field and restart the add-on.

## Tokens: bridge token vs. HA long-lived token

There are **two separate tokens**:

- **Bridge token** (`token` option): authenticates a client to the *bridge*.  Set this
  yourself or let the add-on generate it.
- **HA long-lived access token**: authenticates the *upstream connection* to HA Core.
  This token is passed by the **client** in an `Authorization` header on individual
  requests; the bridge forwards it to HA.  Obtain it from your HA user profile page
  (Profile → Long-Lived Access Tokens).

## Connecting a client

From outside the HA network (e.g. your laptop):

```
http://homeassistant.local:8080
```

From another add-on or a container in the Supervisor network:

```
http://https2wss.local.hass.io:8080
```

All API paths (`/session/open`, `/send`, `/recv/sse`, etc.) are relative to this base
URL.  See the https2wss protocol documentation for the full API reference.

## Security recommendations

- **Enable HTTPS termination**: HA's built-in NGINX Proxy Manager add-on (or an
  external reverse proxy) should terminate TLS before traffic reaches port 8080.  Do
  not expose port 8080 directly to the internet.
- **Set specific `allowed_origins`**: Instead of leaving the list empty, specify the
  exact origins of your client dashboards to prevent cross-site request issues.
- **Use a strong `token`**: The auto-generated token is 48 characters of
  `[A-Za-z0-9_-]` from `/dev/urandom`, which is sufficient for most deployments.  For
  higher-security environments, set an explicit token of at least 32 characters.
- **Rotate tokens periodically**: Update the `token` field and restart the add-on.
  Existing sessions will be closed.

## Connection resilience

The bridge client included in this repository (`ResilientWebSocket` in the
`@https2wss/client` package) automatically selects the best transport — native
WebSocket first, then falling back to the SSE/long-poll bridge if native fails or
goes silent. See [docs/fallback.md](https://github.com/REPLACE_ME/https2wss/blob/master/docs/fallback.md)
for the full decision tree, cookie persistence model, and `isAlive` override API.

When a transport flip occurs during an authenticated Home Assistant session, the
`HomeAssistantClient` adapter (in `@https2wss/adapters/home-assistant`) automatically
re-authenticates with the stored long-lived access token and re-establishes all active
event subscriptions. Events that fire during the brief gap are not delivered
(at-most-once semantics after reconnect). The caller receives a `"reauth"` CustomEvent
on the `HomeAssistantClient` instance when re-authentication succeeds, or a
`"reauth-failed"` event if the token was rejected.

## Troubleshooting

- **Add-on fails to start**: Check the log tab.  The most common cause is a malformed
  `upstream_url` (must start with `ws://` or `wss://`).
- **403 Forbidden from clients**: The bridge token does not match.  Check the `token`
  option or read the auto-generated token from the add-on log / `/data/generated-token.txt`.
- **Cannot reach HA WebSocket API**: Verify `upstream_url` is
  `ws://homeassistant:8123/api/websocket` and that the HA long-lived token your client
  sends is valid and not expired.
- **CORS errors in browser**: Add the browser origin to `allowed_origins`.
