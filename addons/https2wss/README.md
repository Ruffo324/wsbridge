# https2wss — HTTPS-to-WebSocket Bridge

Lets HTTPS-only clients (browsers behind strict TLS proxies, SSE consumers) talk to
WebSocket upstreams — including the Home Assistant WebSocket API — without opening a
raw WebSocket connection themselves.

## Quick start

1. Add this repository in **Settings → Add-ons → Add-on Store → (menu) → Repositories**.
2. Install **https2wss**, open its **Configuration** tab, and paste a long-lived HA access
   token (from your profile) into the `token` field.  Leave it empty to have the add-on
   generate a random token on first start (check the add-on log for it).
3. Start the add-on.  Clients connect to `http://<ha-host>:8080` and pass the bridge
   token in `Authorization: Bearer <token>`.

See the **Documentation** tab for full configuration reference, security notes, and
client usage examples.

> **Icon / logo:** `icon.png` and `logo.png` are 1×1 transparent placeholders.
> Final artwork is TODO before submitting to the community store.
