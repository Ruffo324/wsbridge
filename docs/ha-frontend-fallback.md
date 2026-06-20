# HA Frontend WebSocket Shim — Auto-Fallback for Lovelace

## What this does

This guide configures the Home Assistant Lovelace frontend to use the https2wss
bridge as a transparent WebSocket fallback. A small JavaScript shim replaces
`window.WebSocket` for connections to `/api/websocket` only. When the native
WebSocket succeeds the shim is invisible; when it fails (network restriction,
timeout, mid-session silence) the shim silently routes traffic through the
https2wss bridge instead. All other WebSocket connections in HA are unaffected.

## Prerequisites

- The https2wss add-on is installed, started, and accessible from the browser
  (use an HTTP or HTTPS URL, not a raw `ws://` URL — the bridge runs HTTP/SSE).
- You have the bridge bearer token (from the add-on log or `token` config option).
- Your browser origin (e.g. `http://homeassistant.local:8123`) is added to the
  add-on's `allowed_origins` list so the bridge accepts cross-origin requests.

---

## Step 1 — Add your HA origin to `allowed_origins`

In the add-on options UI, add the exact origin your browser uses to reach HA:

```
http://homeassistant.local:8123
http://192.168.x.x:8123
https://my-ha.example.com
```

Each entry must include the scheme, hostname, and port (if non-standard).
Without this, the browser's CORS policy blocks the bridge requests.

---

## Step 2 — Download the shim

**Option A — from the repository:**

```
packages/proxy/src/transports/staticAssets/wsbridge-shim.js
```

[Direct link on GitHub](https://github.com/Ruffo324/wsbridge/blob/master/packages/proxy/src/transports/staticAssets/wsbridge-shim.js)

**Option B — from the running bridge:**

```bash
curl http://your-bridge-host:8080/_/shim/wsbridge.js -o wsbridge-shim.js
```

Replace `your-bridge-host:8080` with the actual host and port of your https2wss
add-on (visible on the add-on info page as the port mapping for 8080).

---

## Step 3 — Edit the shim

Open `wsbridge-shim.js` in a text editor. Replace the three placeholders:

| Placeholder | Replace with |
|---|---|
| `BRIDGE_URL_PLACEHOLDER` | Your bridge URL, e.g. `http://192.168.1.10:8080` |
| `BRIDGE_TOKEN_PLACEHOLDER` | Your bridge bearer token |

`BRIDGE_URL_PLACEHOLDER` appears **twice** — once in the `import` statement at
the top and once in the `const BRIDGE_URL` line. Replace both.

If you named your upstream profile something other than `ha-core`, also update
the `UPSTREAM_PROFILE` constant.

---

## Step 4 — Place the shim in HA

Copy `wsbridge-shim.js` to `/config/www/wsbridge-shim.js` on your HA host.

Using the **Samba** or **SSH** add-on:

```bash
scp wsbridge-shim.js root@homeassistant.local:/config/www/wsbridge-shim.js
```

Using the **File Editor** add-on: upload via the file editor UI directly to
`/config/www/`.

The `/config/www/` directory is served by HA at `/local/` — that is how the
frontend can load the file as a module.

---

## Step 5 — Configure HA

Add the following to `configuration.yaml`:

```yaml
frontend:
  extra_module_url:
    - /local/wsbridge-shim.js
```

Then restart Home Assistant (Settings → System → Restart).

---

## Step 6 — Verify

Open the HA UI in a browser, then open DevTools (F12) → Network tab → filter
by "websocket" or "fetch".

**On a normal network:** you should see a 101 Switching Protocols to
`wss://…/api/websocket` — native succeeded, shim is inactive.

**On a restricted network (no WebSocket):** you should see the native 101
attempt fail (or time out after ~3 seconds), then:

1. A `POST` to `http://your-bridge:8080/v1/sessions` — session creation.
2. A long-lived `GET` to `/v1/sessions/<id>/events` carrying SSE frame traffic
   — this is the bridge channel.

The HA UI should load and operate normally through the bridge.

---

## Caveats

- **Token in cleartext.** The bridge token is stored as plaintext inside
  `/config/www/wsbridge-shim.js`. This directory is served behind HA's own
  authentication wall, but the token grants access to the bridge, so treat it
  as a long-lived secret. If you suspect compromise, rotate the token via the
  add-on options UI and update the shim file.
- **Monkey-patch scope.** The shim patches `window.WebSocket` globally but only
  intercepts URLs ending in `/api/websocket`. Other WebSocket connections
  (integrations, add-ons, custom cards) are passed through to the native
  constructor unchanged.
- **Fallback is reactive, not pre-emptive.** `ResilientWebSocket` triggers
  fallback when the native connection fails to open (timeout 3 s) or goes
  silent (heartbeat 30 s). If HA loads on a working network and the network
  later breaks, fallback fires on the next timeout — there is a short gap
  during which messages are buffered.
- **One shim per HA instance.** The shim is intended for your own HA instance;
  it is not designed to be loaded by arbitrary third-party browsers.

---

## Reverting

Remove the `extra_module_url` entry from `configuration.yaml` and restart HA.
The shim stops loading and `window.WebSocket` reverts to the browser default.
The file in `/config/www/wsbridge-shim.js` can be left in place or deleted
manually.

---

## Related documentation

- [ResilientWebSocket fallback reference](fallback.md)
- [https2wss add-on documentation](../addons/https2wss/DOCS.md)
