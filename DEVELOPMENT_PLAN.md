# https2wss — Development Plan

**Date:** 2026-06-15 · **Target:** clean, tested, OSS-ready MVP per `2026-06-15-https2wss-requirements-spec-en.md` · **Branch policy:** master only, no feature branches · **Lang:** English only.

This plan is the execution contract for the workflow: **Overview ✓ → Plan (this) → Implement → Test (Chrome) → Commit**, per phase, via subagents.

---

## 0. Decisions (open questions §26 → resolved)

| # | Question | Decision |
|---|---|---|
| 1 | Session secret? | No. Bearer token + unguessable `sid` (`h2w_` + 128-bit random). |
| 2 | Resume? | Partial. Replay via `after` / `Last-Event-ID` against bounded buffer. No full reconnect-resume of upstream. |
| 3 | `ack` cleans buffer? | Yes. Client `ack` trims b2c replay buffer ≤ ack. |
| 4 | Default receive transport? | SSE; fallback long_poll; then poll. |
| 5 | Direct upstream URLs? | Disabled by default. Named profiles only. Dev flag `allowDirectUrl` to enable. |
| 6 | Server own HTTPS? | No. Plain HTTP locally; HTTPS termination by reverse proxy (documented). |
| 7 | JSON-only? | Yes for MVP. Envelope stays encoding-neutral (codec seam for future CBOR). |

## 0b. Stack (pin in package.json)

| Tool | Version | Notes |
|---|---|---|
| Node | `24.x` LTS | base image `node:24-alpine` |
| pnpm | `11.x` | via corepack; all config in `pnpm-workspace.yaml` (`.npmrc` = auth only) |
| typescript | `~5.9` | `strict`, `composite`, `references`, `declarationMap` |
| fastify | `^5` | SSE via `reply.hijack()` + `reply.raw.write`; **do not** `reply.send()` for streams |
| @fastify/cors | `^11` | explicit origins, no wildcard+creds |
| ws | `^8` | upstream client + echo test server |
| zod | `^4` | v4 API: `z.email()`, `.extend()` (not `.merge()`), unified `error` param |
| vitest | `^4` | root `projects` array (workspace file deprecated) |
| @biomejs/biome | `^2` | lint+format, nested config |
| tsup | `^8` | client dual-ish: ESM primary (+ thin CJS shim) |
| tsx | `^4` | run TS for examples/e2e |
| yaml | `^2` | proxy config parse |

---

## 1. Architecture

**Package dep graph / build order:**
```
protocol  →  client      →  adapters/home-assistant (scaffold)
          →  proxy        →  examples/* (echo, node-client, browser-sse)
```
Build: `tsc -b` from root respects refs. Order: `protocol` → {`client`,`proxy`} → `adapters` → examples.

**Runtime deps per package:**
- `protocol`: zod
- `proxy`: protocol, fastify, @fastify/cors, ws, zod, yaml
- `client`: protocol  *(SSE via `fetch`+ReadableStream parsing — works browser **and** Node 24, no EventSource dep)*
- `adapters/home-assistant`: client *(scaffold only)*
- `examples/echo`: ws, proxy, client · `examples/node-client`: client

**Root dev deps:** typescript, vitest, @vitest/coverage-v8, @biomejs/biome, tsx, tsup, @types/node, @types/ws.

**Root scripts** (§23/§24): `lint` `format` `typecheck`(`tsc -b`) `test`(`vitest run`) `test:e2e` `build`(`tsc -b` + tsup client) `dev`.

---

## 2. Protocol — concrete rules

- **Envelope** §9.3 validated by zod at every boundary; unknown `v` → `PROTOCOL_VERSION_UNSUPPORTED`.
- **Seq:** two independent monotonic counters per session (c2b, b2c), start at 1.
  - in: `seq == lastClientSeq+1` → accept; `seq ≤ lastClientSeq` → duplicate, ignore + re-ack; gap → `SEQUENCE_OUT_OF_ORDER` (MVP: report+close).
  - out: each b2c frame stored in **FrameBuffer** keyed by seq.
- **Replay:** poll `after=N` / SSE `Last-Event-ID`/`after=N` → return frames `seq > N`. Replay = at-least-once; client de-dups by seq (§11).
- **ack:** trims buffer to `seq ≤ ack`.
- **FrameBuffer:** bounded `maxBufferedFrames` ∧ `maxBufferedBytes`; overflow → `overflowPolicy: close` (`BUFFER_OVERFLOW`). `maxFrameBytes` per frame → `FRAME_TOO_LARGE`.
- **Lifecycle:** `connecting → open → closing → closed | errored`. upstream connect ok → control `upstream_open` + state `open`. idle>`idleTimeoutMs` → close `source:timeout`. duration>`maxDurationMs` → close.
- **Close sources:** client|bridge|upstream|timeout|policy. **Binary:** base64 in JSON ↔ `Uint8Array`/`ArrayBuffer` client-side; never implicit UTF-8.
- **Error codes:** all 13 of §16 as a stable enum in `protocol/errors.ts`.

---

## 3. Phases

Each phase = subagent(s) implement → subagent test → verify exit criteria → commit to master. Model column = default; escalate to Opus only if result better.

### P0 — Prerequisites *(blocker, human or setup agent)*
- Install Node 24 LTS, enable corepack (`corepack enable pnpm`), install Docker Desktop, start daemon.
- **Exit:** `node -v`, `pnpm -v`, `docker info` all succeed. *Implementation is blocked until this passes.*

### P1 — Bootstrap *(Sonnet)*
- Monorepo: `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, per-pkg `tsconfig.json` (composite+refs), `biome.json`, root `vitest.config.ts` (`projects`), `.github/workflows/ci.yml`, `LICENSE` (MIT), `.gitignore`, `.dockerignore`.
- **Exit:** `pnpm install` ✓, `pnpm typecheck` ✓ (empty), `pnpm lint` ✓, `pnpm test` ✓ (0 tests ok).

### P2 — protocol *(Sonnet)*
- `types.ts` (Envelope, SessionState, SessionInfo, payloads), `errors.ts` (codes + `BridgeError` + format), `schema.ts` (zod, encoding-neutral), `envelope.ts` (build/parse/validate helpers).
- Tests §22.1: valid envelope ✓, bad version ✗, text/binary frame, close/error frame validation.
- **Exit:** typecheck + unit tests green; 100% of listed protocol tests present.

### P3 — Session core (proxy) *(Sonnet)*
- `sessions/Sequencer.ts`, `FrameBuffer.ts`, `Session.ts`, `SessionManager.ts` (create/get/close, per-token limits, idle+duration timers, sid gen).
- Tests: lifecycle states, dup detect, out-of-order, buffer-limit/overflow-close, ack trim, idle expiry.
- **Exit:** unit tests green incl. §22.1 buffer/sequence items.

### P4 — Security *(Sonnet; ssrfGuard → consider Opus)*
- `auth.ts` (Bearer, env tokens → `AUTH_REQUIRED`/`AUTH_INVALID`), `upstreamPolicy.ts` (default deny, profile lookup, direct-url gate → `UPSTREAM_NOT_ALLOWED`/`POLICY_DENIED`), `ssrfGuard.ts` (DNS resolve → block loopback/link-local 169.254/private 10·172.16-31·192.168/ULA fc00::/7/metadata 169.254.169.254 unless `allowPrivateNetwork`), `headerPolicy.ts` (allowlist; block Host/Authorization/Cookie/Origin/Forwarded/X-Forwarded-*), `cors.ts`, `observability/logger.ts` (redact authorization/cookie/token).
- Tests §22.1: SSRF private-IP denial, header allowlist, auth reject.
- **Exit:** security tests green; no secret leaks in log snapshot test.

### P5 — WebSocket upstream adapter *(Sonnet)*
- `upstream/UpstreamAdapter.ts` (iface), `WebSocketUpstreamAdapter.ts` (ws): map open→`upstream_open`, message(text/bin)→data frame, error→error frame, close→close `source:upstream`. Apply ssrf+header policy at connect.
- Tests §22.2: connect echo, text echo, binary echo, upstream-close propagation, connect-failure → `UPSTREAM_CONNECT_FAILED`.
- **Exit:** integration tests green against in-test `ws` echo.

### P6 — HTTP transports (proxy server) *(Sonnet; SSE care)*
- `config.ts` (yaml+zod+env), `httpServer.ts` (Fastify, cors, auth hook, error mapper, `/healthz`), `transports/createSession.ts send.ts poll.ts sse.ts close.ts`, `index.ts` (boot).
- Routes §10: `POST /v1/sessions`, `POST …/send`, `GET …/poll`, `GET …/events` (SSE: hijack + heartbeat comments), `POST …/close`.
- Tests §22.2: create ok, no-auth 401, disallowed upstream, echo via poll, echo via SSE.
- **Exit:** integration tests green; manual `curl` SSE smoke shows heartbeat + frame.

### P7 — client *(Sonnet)*
- `transports/PollTransport.ts LongPollTransport.ts SseTransport.ts` (fetch+ReadableStream SSE parser), `BridgeClient.ts` (openSession, send frames, ordering, de-dup, ack), `events.ts`, `Https2WssSocket.ts` (WS-like: readyState/send/close/onopen/onmessage/onerror/onclose/add+removeEventListener/approx bufferedAmount).
- Tests §22.1/§22.2 client side; base64 binary round-trip.
- **Exit:** client tests green; WS-like surface matches §17.2 list (documented, not over-claimed).

### P8 — Echo demo + Docker *(Sonnet/Haiku)*
- `examples/echo` (`echoServer.ts` ws, `demoClient.ts`, `public/index.html`), `examples/node-client`, `examples/browser-sse`.
- `Dockerfile` (multi-stage, `pnpm deploy`, non-root, healthcheck, env config), `docker-compose.yml` (proxy 8080 + echo internal + demo 3000), `config.yml` echo profile.
- **Exit:** `docker compose up --build` → proxy:8080, demo:3000 reachable, echo internal-only.

### P9 — Docs *(Haiku/Sonnet)*
- `README.md` (+positioning §27), `docs/`: `architecture.md protocol.md transports.md security.md limitations.md adapter-authoring.md deployment.md`.
- **Exit:** all required docs present, English, examples runnable; §24.11–12 satisfied.

### P10 — Final verify *(Sonnet + Chrome Connector)*
- Run §23 chain: `pnpm install --frozen-lockfile · lint · typecheck · test · test:e2e · build`; `docker build`; `docker compose up --build`.
- `test:e2e` (§22.3): start echo+proxy+client, text round-trip, binary round-trip, clean close.
- **Chrome QA (real, DAU/edge-case):** open `examples/browser-sse` page via Chrome connector → send text → assert echo in DOM → check console (no errors) + network (SSE stream, POST 200). Edge cases: large frame → `FRAME_TOO_LARGE`, bad token → 401, disallowed upstream → reject, idle timeout close, reconnect/replay no dup.
- **Exit:** all §24 acceptance criteria ✓; remaining limits documented.

---

## 4. Test matrix → acceptance (§24)

| Acceptance §24 | Covered by |
|---|---|
| 1 install / 2 test / 4 build | P1,P10 |
| 3 test:e2e | P10 |
| 5 docker build / 6 compose | P8,P10 |
| 7 text via POST→SSE | P6,P7,P10 + Chrome |
| 8 binary base64 round-trip | P5,P7,P10 |
| 9 disallowed upstream reject | P4,P6 |
| 10 unauth reject | P4,P6 |
| 11 docs | P9 |
| 12 no German | P9, lint/review all phases |

---

## 5. Risks

- **R1 toolchain absent** (P0) — hard blocker; resolve first.
- **R2 SSE on Fastify** — must `reply.hijack()` + manual `reply.raw` lifecycle; reuse known pattern, don't reinvent. Heartbeat keep-alive vs proxy buffering.
- **R3 zod v4 API drift** — use v4 idioms; pin `^4`, override transitive v3.
- **R4 SSRF correctness** — IPv4+IPv6 ranges, DNS rebinding (validate resolved IP, re-check on reconnect). High-value to get right.
- **R5 client SSE parser** — fetch/ReadableStream chunk-splitting of `\n\n` events; test partial chunks.
- **R6 Docker on Windows** — compose demo verified only after Docker Desktop installed (P0).

## 6. Conventions

- Commit per phase to **master** after its tests pass. Conventional Commits (`feat(proxy): …`). No `--no-verify`.
- Each phase: implement-subagent → test-subagent → I verify exit criteria before commit.
- Symbols/short prose in code comments; strict TS; no quick hacks in core paths.
