# https2wss

`https2wss` is a protocol-level HTTPS-to-WebSocket bridge. It lets HTTPS-only clients communicate with WebSocket services through an explicit session protocol using POST, long-polling, or Server-Sent Events. It is not a transparent universal WebSocket replacement; it is a controlled bridge with clear semantics, security policies, and adapter support.

## Status

MVP under construction. See [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md) for the implementation roadmap.

The following documentation files will be added in Phase 9:

- `docs/architecture.md`
- `docs/protocol.md`
- `docs/transports.md`
- `docs/security.md`
- `docs/limitations.md`
- `docs/adapter-authoring.md`
- `docs/deployment.md`

For the full requirements, see [2026-06-15-https2wss-requirements-spec-en.md](./2026-06-15-https2wss-requirements-spec-en.md).
