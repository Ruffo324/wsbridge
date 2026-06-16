# Changelog

## 0.1.0 - 2026-06-16 - Initial release

- First Home Assistant add-on package for https2wss.
- Supports amd64 (verified), aarch64 and armv7 (build config only).
- s6-overlay service with bashio option rendering into `/data/config.yml`.
- Auto-generates a random bridge token when none is configured.
- Default upstream profile points to `ws://homeassistant:8123/api/websocket`.
