# Security

## Threat model

### What the bridge protects against

- **SSRF** — clients cannot direct the bridge to connect to internal infrastructure (loopback, metadata endpoints, private networks) unless explicitly allowed per profile.
- **Open relay** — arbitrary upstream URLs are disabled by default. Only named profiles in configuration are reachable.
- **Header smuggling** — client-supplied headers are filtered through a per-profile allowlist before being forwarded to the upstream WebSocket handshake.
- **Unauthenticated access** — all session and transport endpoints require a valid Bearer token by default.
- **Secret leakage in logs** — pino redacts authorization headers, cookies, and token values.

### What the bridge does NOT protect against

- Application-layer abuse in upstream services (that is the upstream's responsibility).
- DDoS at the HTTP layer — delegate rate limiting to a reverse proxy (e.g. nginx `limit_req`).
- Compromised configuration files (tokens in config with `value:` field are in-process; protect the file).
- Multi-tenant isolation beyond per-token session quotas.

## Authentication

All endpoints except `/healthz` require:

```http
Authorization: Bearer <token>
```

Tokens are configured in `security.tokens` as either env references or inline values:

```yaml
security:
  requireAuth: true
  tokens:
    - env: HTTPS2WSS_TOKEN      # resolved from process.env at startup
    - value: another-token      # minimum 8 characters
```

At startup, each env var is read once. If the variable is unset or shorter than 8 characters, a warning is printed to stderr and the token is skipped (server still starts).

**tokenId**: logged and used for quota tracking. It is the first 8 hex characters of `sha256(rawToken)` — a stable opaque identifier. The raw token is never logged.

**Rotation**: update the env var and restart. There is no live reload. During the restart window, existing sessions are lost (in-memory state).

`AUTH_REQUIRED` responses include `WWW-Authenticate: Bearer`.

## Upstream allowlist

Default policy is `deny`. Only profiles listed under `security.upstreamPolicy.allow` are reachable.

```yaml
security:
  upstreamPolicy:
    default: deny
    allowDirectUrl: false       # set true only for development
    allow:
      - name: echo
        adapter: websocket
        url: "ws://echo:9001"
        allowedHeaders: []
        allowPrivateNetwork: false
      - name: internal-service
        adapter: websocket
        url: "ws://192.168.1.10:8000/ws"
        allowedHeaders:
          - authorization
        allowPrivateNetwork: true
```

URL scheme validation: only `ws:` and `wss:` are accepted. Any other scheme throws `POLICY_DENIED` at startup (fail-fast on bad config).

`allowDirectUrl: true` permits clients to pass a raw `url` in the session create request. This bypasses the named-profile requirement. **Do not enable in production.**

## SSRF guard

`SsrfGuard` resolves the hostname via DNS (`dns.lookup` with `all: true, verbatim: true`) and checks every returned address against a block list.

Blocked ranges (always, regardless of `allowPrivateNetwork`):

| Range | Reason |
|-------|--------|
| `127.0.0.0/8`, `::1` | loopback |
| `169.254.0.0/16`, `fe80::/10` | link-local |
| `169.254.169.254`, `fd00:ec2::254` | cloud metadata endpoints |
| `0.0.0.0`, `::` | unspecified |
| `255.255.255.255` | broadcast |
| `224.0.0.0/4`, `ff00::/8` | multicast |
| `240.0.0.0/4` | reserved (Class E) |
| `::ffff:0.0.0.0/96` | IPv4-mapped IPv6 |

Additional ranges blocked when `allowPrivateNetwork: false` (the default):

| Range | Reason |
|-------|--------|
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | private IPv4 (RFC 1918) |
| `fc00::/7` | unique local IPv6 (ULA) |

**DNS rebinding defense**: all resolved addresses are checked, not just the first. If any resolved address is blocked, the connection is rejected.

**IPv4-mapped IPv6 caveat**: `::ffff:x.x.x.x` addresses are always blocked via the `ipv4_mapped` group. When checking a native IPv4 address, the ipv4_mapped group is skipped to avoid false positives (Node's `BlockList` would otherwise match native IPv4 addresses against the `::ffff:0.0.0.0/96` subnet due to an implementation quirk).

Literal IP addresses in URLs bypass the DNS resolver and are checked directly.

## Header policy

`HeaderPolicy` uses an allowlist-only model. Only headers explicitly listed in the profile's `allowedHeaders` array are forwarded to the upstream WebSocket handshake. All other headers are silently dropped.

Default blocked (unless explicitly listed): `host`, `authorization`, `cookie`, `origin`, `forwarded`, `x-forwarded-*`, and any other header not in the allowlist.

Example: to forward `Authorization` to an upstream that requires it:

```yaml
- name: authenticated-service
  adapter: websocket
  url: "wss://api.example.com/ws"
  allowedHeaders:
    - authorization
  allowPrivateNetwork: false
```

Header names are normalized to lowercase.

## CORS

Configured via `security.cors.allowedOrigins`. Wildcard `*` combined with `credentials: true` is forbidden (rejected by `@fastify/cors`).

```yaml
security:
  cors:
    allowedOrigins:
      - "https://app.example.com"
    allowCredentials: false
```

If `allowedOrigins` is empty, CORS is disabled entirely (all cross-origin requests blocked).

Requests from unlisted origins receive a CORS rejection from the Fastify CORS plugin before reaching any route handler.

## Secret redaction

pino redacts the following paths with `[Redacted]`:

```
authorization
cookie
headers.authorization
headers.cookie
req.headers.authorization
req.headers.cookie
token
tokens[*].value
```

Additional paths can be added via `LoggerOptions.redactPaths`.

## Production deployment checklist

- Terminate TLS at a reverse proxy (nginx, Caddy). The bridge itself serves plain HTTP.
- Set a strong `HTTPS2WSS_TOKEN` (at least 32 random characters). Store it in a secrets manager, not in a config file.
- Restrict `upstreamPolicy.allow` to the minimum set of profiles needed.
- Set `allowDirectUrl: false` (the default). Never enable it in production.
- Set `allowPrivateNetwork: false` on profiles that do not require access to private networks.
- Configure `security.cors.allowedOrigins` to only the specific origins that need access.
- Run the proxy container as a non-root user (the `Dockerfile` creates and uses the `app` user).
- Monitor `/healthz`. Alert if the endpoint stops responding.
- Retain pino structured JSON logs. Filter by `tokenId` and `code` fields for security auditing.
- Place a rate-limiting reverse proxy in front of the bridge (e.g. nginx `limit_req_zone`).
