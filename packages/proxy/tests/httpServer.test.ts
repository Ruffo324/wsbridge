/**
 * Integration tests for the Fastify HTTP server (P6).
 *
 * Uses a real WebSocket echo server on an ephemeral port.
 * The SsrfGuard is replaced with a no-op fake so loopback is allowed.
 */
import { createServer, type Server as HttpUpstreamServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BridgeEnvelope } from "@https2wss/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { ServerConfig } from "../src/config/serverConfig.js";
import type { HttpServer } from "../src/httpServer.js";
import { createHttpServer } from "../src/httpServer.js";
import { buildAuth } from "../src/security/auth.js";
import { SsrfGuard } from "../src/security/ssrfGuard.js";
import { UpstreamPolicy } from "../src/security/upstreamPolicy.js";
import { SessionManager } from "../src/sessions/SessionManager.js";

// ── Constants ──────────────────────────────────────────────────────────────

const VALID_TOKEN = "test-token-abcdef";
const AUTH = `Bearer ${VALID_TOKEN}`;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a no-op SsrfGuard that allows loopback (required for echo tests). */
function makeFakeSsrfGuard(): SsrfGuard {
  const fake = Object.create(SsrfGuard.prototype) as SsrfGuard;
  (fake as unknown as { assertAllowed: () => Promise<void> }).assertAllowed = () =>
    Promise.resolve();
  return fake;
}

/** Start an echo WebSocket server on a random port. Returns server + url. */
async function startEchoServer(): Promise<{ wss: WebSocketServer; url: string; port: number }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((res) => wss.on("listening", res));
  const { port } = wss.address() as AddressInfo;
  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      ws.send(data, { binary: isBinary });
    });
  });
  return { wss, url: `ws://127.0.0.1:${port}`, port };
}

async function startFrontendUpstream(): Promise<{ server: HttpUpstreamServer; url: string }> {
  const upstream = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head><title>HA</title></head><body>ok</body></html>");
      return;
    }
    if (req.url === "/api/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ location_name: "Home" }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as AddressInfo;
  return { server: upstream, url: `http://127.0.0.1:${port}` };
}

async function closeHttpServer(server: HttpUpstreamServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Build a minimal ServerConfig for tests. */
function makeConfig(echoWsUrl: string): ServerConfig {
  return {
    server: { host: "127.0.0.1", port: 0 },
    security: {
      requireAuth: true,
      tokens: [{ value: VALID_TOKEN }],
      cors: { allowedOrigins: [], allowCredentials: false },
      upstreamPolicy: {
        default: "deny",
        allowDirectUrl: false,
        allow: [
          {
            name: "echo",
            adapter: "websocket",
            url: echoWsUrl,
            allowedHeaders: [],
            allowPrivateNetwork: true,
          },
          {
            name: "unreachable",
            adapter: "websocket",
            url: "ws://127.0.0.1:1", // port 1 is always refused
            allowedHeaders: [],
            allowPrivateNetwork: true,
          },
        ],
      },
    },
    sessions: {
      idleTimeoutMs: 60_000,
      maxDurationMs: 3_600_000,
      maxSessionsPerToken: 20,
      maxFrameBytes: 1_048_576,
      maxBufferedFrames: 1_000,
      maxBufferedBytes: 16_777_216,
      overflowPolicy: "close",
      tickIntervalMs: 60_000, // disable automatic tick in tests
    },
    transports: {
      enabled: ["sse", "long_poll", "poll"],
      sse: { heartbeatIntervalMs: 50 }, // fast for tests
      longPoll: { maxTimeoutMs: 500 }, // short for tests
    },
    logging: { level: "error", redactHeaders: ["authorization", "cookie"] },
    frontendProxy: {
      enabled: false,
      pathPrefix: "/",
      upstreamUrl: "http://127.0.0.1:1",
      injectWebSocketShim: true,
      bridgeUrl: "",
      bridgeToken: VALID_TOKEN,
      upstreamProfile: "echo",
      nativeConnectTimeoutMs: 1500,
      heartbeatTimeoutMs: 30_000,
    },
  };
}

/** Build a server with the echo profile wired up. */
function makeServer(
  echoWsUrl: string,
  mutateConfig?: (config: ServerConfig) => ServerConfig,
): HttpServer {
  const config = mutateConfig ? mutateConfig(makeConfig(echoWsUrl)) : makeConfig(echoWsUrl);

  const sessionManager = new SessionManager({
    sessionDefaults: {
      idleTimeoutMs: config.sessions.idleTimeoutMs,
      maxDurationMs: config.sessions.maxDurationMs,
      frameBuffer: {
        maxFrameBytes: config.sessions.maxFrameBytes,
        maxBufferedFrames: config.sessions.maxBufferedFrames,
        maxBufferedBytes: config.sessions.maxBufferedBytes,
        overflowPolicy: "close",
      },
    },
    maxSessionsPerToken: config.sessions.maxSessionsPerToken,
  });

  const auth = buildAuth({
    requireAuth: config.security.requireAuth,
    tokens: config.security.tokens,
  });

  const upstreamPolicy = new UpstreamPolicy(config.security.upstreamPolicy);
  const ssrfGuard = makeFakeSsrfGuard();

  return createHttpServer({ config, sessionManager, upstreamPolicy, auth, ssrfGuard });
}

// ── Test context ───────────────────────────────────────────────────────────

let echo: { wss: WebSocketServer; url: string; port: number };
let server: HttpServer;
let baseUrl: string;

beforeEach(async () => {
  echo = await startEchoServer();
  server = makeServer(echo.url);
  await server.start();
  baseUrl = `http://127.0.0.1:${server.port()}`;
});

afterEach(async () => {
  await server.stop();
  // Terminate all clients before closing the WS server so it doesn't hang
  for (const client of echo.wss.clients) {
    client.terminate();
  }
  await new Promise<void>((res) => echo.wss.close(() => res()));
});

// ── Utility functions ──────────────────────────────────────────────────────

async function createSession(
  profile = "echo",
  token = AUTH,
  mode: "sse" | "long_poll" | "poll" = "sse",
): Promise<{
  sessionId: string;
  transport: { selected: string; sendUrl: string; receiveUrl: string };
}> {
  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "https2wss",
      version: 1,
      transport: { mode, fallbacks: ["long_poll", "poll"] },
      upstream: { adapter: "websocket", profile },
    }),
  });
  if (!res.ok) {
    const body = (await res.json()) as unknown;
    throw new Error(`createSession failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return res.json() as Promise<{
    sessionId: string;
    transport: { selected: string; sendUrl: string; receiveUrl: string };
  }>;
}

async function sendFrame(
  sessionId: string,
  payload: { opcode: string; encoding: string; data: string; fin: boolean },
  seq = 1,
  token = AUTH,
): Promise<void> {
  const envelope: BridgeEnvelope = {
    v: 1,
    sid: sessionId,
    seq,
    kind: "data",
    ts: new Date().toISOString(),
    payload,
  };
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/send`, {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ frames: [envelope] }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status}`);
}

async function pollOnce(
  sessionId: string,
  after = 0,
  timeoutMs = 300,
  token = AUTH,
): Promise<{ frames: BridgeEnvelope[]; nextAfter: number; state: string }> {
  const url = `${baseUrl}/v1/sessions/${sessionId}/poll?after=${after}&timeoutMs=${timeoutMs}`;
  const res = await fetch(url, { headers: { authorization: token } });
  return res.json() as Promise<{ frames: BridgeEnvelope[]; nextAfter: number; state: string }>;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /v1/sessions", () => {
  it("1 — returns 401 with AUTH_REQUIRED when no auth header", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "https2wss",
        version: 1,
        transport: { mode: "sse", fallbacks: [] },
        upstream: { adapter: "websocket", profile: "echo" },
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("2 — returns 401 with AUTH_INVALID when token is wrong", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token-xxxx",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "https2wss",
        version: 1,
        transport: { mode: "sse", fallbacks: [] },
        upstream: { adapter: "websocket", profile: "echo" },
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("3 — returns 403 with UPSTREAM_NOT_ALLOWED for disallowed profile", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "https2wss",
        version: 1,
        transport: { mode: "sse", fallbacks: [] },
        upstream: { adapter: "websocket", profile: "not-in-allow-list" },
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_NOT_ALLOWED");
  });

  it("4 — creates session for echo profile and returns sessionId + transport", async () => {
    const data = await createSession("echo");
    expect(typeof data.sessionId).toBe("string");
    expect(data.sessionId).toMatch(/^h2w_/);
    expect(["sse", "long_poll", "poll"]).toContain(data.transport.selected);
    expect(data.transport.sendUrl).toContain(data.sessionId);
    expect(data.transport.receiveUrl).toContain(data.sessionId);
  });
});

describe("echo via long-poll", () => {
  it("5 — send text 'hello' and poll returns the echo", async () => {
    const { sessionId } = await createSession("echo", AUTH, "long_poll");

    // Wait a little for the upstream_open frame to arrive in the buffer
    await new Promise<void>((res) => setTimeout(res, 50));

    // Drain control frames with after=0
    const initial = await pollOnce(sessionId, 0, 200);
    const afterSeq = initial.nextAfter;

    await sendFrame(sessionId, { opcode: "text", encoding: "utf8", data: "hello", fin: true }, 1);

    // Poll for the echo
    let echo: BridgeEnvelope | undefined;
    for (let attempt = 0; attempt < 10 && echo === undefined; attempt++) {
      const result = await pollOnce(sessionId, afterSeq, 300);
      echo = result.frames.find((f): boolean => f.kind === "data");
    }

    expect(echo).toBeDefined();
    const payload = echo?.payload as { opcode: string; data: string };
    expect(payload.opcode).toBe("text");
    expect(payload.data).toBe("hello");
  });
});

describe("echo via SSE", () => {
  it("6 — send text 'hello' and SSE stream returns the echo frame", async () => {
    const { sessionId, transport } = await createSession("echo", AUTH, "sse");

    // Wait a brief moment for the upstream to open
    await new Promise<void>((res) => setTimeout(res, 30));

    // Open SSE stream
    const eventsUrl = `${baseUrl}${transport.receiveUrl}?after=0`;
    const sseRes = await fetch(eventsUrl, {
      headers: { authorization: AUTH },
    });
    expect(sseRes.ok).toBe(true);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // Send text frame
    await sendFrame(sessionId, { opcode: "text", encoding: "utf8", data: "hello", fin: true }, 1);

    // Read SSE stream until we get the data frame
    if (sseRes.body === null) throw new Error("SSE response body is null");
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let dataFrame: BridgeEnvelope | null = null;

    const readWithTimeout = new Promise<BridgeEnvelope | null>((resolve) => {
      const timer = setTimeout(() => {
        reader.cancel().catch(() => {});
        resolve(null);
      }, 3000);

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const events = buf.split("\n\n");
            buf = events.pop() ?? "";
            for (const event of events) {
              const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
              if (dataLine !== undefined) {
                try {
                  const env = JSON.parse(dataLine.slice(6)) as BridgeEnvelope;
                  if (env.kind === "data") {
                    clearTimeout(timer);
                    reader.cancel().catch(() => {});
                    resolve(env);
                    return;
                  }
                } catch {
                  // skip parse errors
                }
              }
            }
          }
        } catch {
          // stream closed by cancel
        }
        resolve(null);
      })().catch(() => {});
    });

    dataFrame = await readWithTimeout;
    expect(dataFrame).not.toBeNull();
    const payload = dataFrame?.payload as { opcode: string; data: string };
    expect(payload.opcode).toBe("text");
    expect(payload.data).toBe("hello");
  });
});

describe("binary frame echo", () => {
  it("7 — send binary bytes [0,1,2,3,4] and receive base64-encoded echo", async () => {
    const { sessionId } = await createSession("echo", AUTH, "long_poll");

    // Drain initial control frames
    await new Promise<void>((res) => setTimeout(res, 50));
    const initial = await pollOnce(sessionId, 0, 200);
    const afterSeq = initial.nextAfter;

    const bytes = Uint8Array.from([0, 1, 2, 3, 4]);
    const b64 = Buffer.from(bytes).toString("base64");

    await sendFrame(sessionId, { opcode: "binary", encoding: "base64", data: b64, fin: true }, 1);

    let echoFrame: BridgeEnvelope | undefined;
    for (let attempt = 0; attempt < 10 && echoFrame === undefined; attempt++) {
      const result = await pollOnce(sessionId, afterSeq, 300);
      echoFrame = result.frames.find((f): boolean => f.kind === "data");
    }

    expect(echoFrame).toBeDefined();
    const payload = echoFrame?.payload as { opcode: string; encoding: string; data: string };
    expect(payload.opcode).toBe("binary");
    expect(payload.encoding).toBe("base64");
    expect(payload.data).toBe("AAECAwQ=");
  });
});

describe("upstream close propagation", () => {
  it("8 — upstream close appears as close frame in poll", async () => {
    const { sessionId } = await createSession("echo", AUTH, "long_poll");

    // Wait for upstream to open
    await new Promise<void>((res) => setTimeout(res, 50));

    // Drain initial frames
    const initial = await pollOnce(sessionId, 0, 200);
    const afterSeq = initial.nextAfter;

    // Close the echo server forcefully — close all connections
    for (const client of echo.wss.clients) {
      client.close(1000, "server shutting down");
    }

    // Poll until we get a close frame (or timeout)
    let closeFrame: BridgeEnvelope | undefined;
    for (let attempt = 0; attempt < 15 && closeFrame === undefined; attempt++) {
      await new Promise<void>((res) => setTimeout(res, 50));
      const result = await pollOnce(sessionId, afterSeq, 300);
      closeFrame = result.frames.find((f): boolean => f.kind === "close");
    }

    expect(closeFrame).toBeDefined();
    const payload = closeFrame?.payload as { source: string };
    expect(payload.source).toBe("upstream");
  });
});

describe("client close propagation", () => {
  it("9 — POST /close causes upstream websocket to close", async () => {
    const { sessionId } = await createSession("echo");
    await new Promise<void>((res) => setTimeout(res, 50));

    // Track upstream disconnect
    let upstreamClosed = false;
    for (const client of echo.wss.clients) {
      client.on("close", () => {
        upstreamClosed = true;
      });
    }

    const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/close`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify({ code: 1000, reason: "client done" }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { closed: boolean; state: string };
    expect(body.closed).toBe(true);
    expect(body.state).toBe("closed");

    // Give time for upstream close to propagate
    await new Promise<void>((res) => setTimeout(res, 100));
    expect(upstreamClosed).toBe(true);
  });
});

describe("session not found", () => {
  it("10 — returns 404 for unknown session id", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions/h2w_doesnotexist1234567/send`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify({ frames: [] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("SSE CORS headers regression (reply.hijack bypasses @fastify/cors)", () => {
  it("12 — GET /events with Origin header returns access-control-allow-origin on the SSE 200 response", async () => {
    // Open-mode config (allowedOrigins: []) — confirms SSE stream is healthy.
    // The origin-specific CORS assertion is in test 13.
    const { transport } = await createSession("echo", AUTH, "sse");

    await new Promise<void>((res) => setTimeout(res, 30));

    const eventsUrl = `${baseUrl}${transport.receiveUrl}?after=0`;
    const sseRes = await fetch(eventsUrl, {
      headers: {
        authorization: AUTH,
        // The standard makeConfig() has allowedOrigins: [] (open mode), so CORS
        // headers are not added for an empty origin. To test the full round-trip
        // we need a server configured with allowedOrigins: [ORIGIN].
        // Use the server already running; it has allowedOrigins: [] which means
        // "open mode" — buildResponseHeaders returns {} for any non-null origin
        // unless the origin is in the allow list.
        //
        // For this regression we just verify the header IS present when the
        // server is reconfigured with an explicit origin allow-list.
        // We test here with NO Origin header (open mode) and confirm the stream
        // is healthy — the origin-specific test is below.
        origin: "",
      },
    });
    expect(sseRes.ok).toBe(true);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // Also quickly confirm the stream is readable
    if (sseRes.body !== null) {
      const reader = sseRes.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain(":ok");
      reader.cancel().catch(() => {});
    }
  });

  it("13 — GET /events with explicit allowed Origin returns access-control-allow-origin", async () => {
    // Spin up a server with a configured allowed origin
    const ORIGIN = "http://allowed.test";
    const configWithCors: ServerConfig = {
      ...makeConfig(echo.url),
      security: {
        ...makeConfig(echo.url).security,
        cors: { allowedOrigins: [ORIGIN], allowCredentials: false },
      },
    };

    const manager = new SessionManager({
      sessionDefaults: {
        idleTimeoutMs: 60_000,
        maxDurationMs: 3_600_000,
        frameBuffer: {
          maxFrameBytes: 1_048_576,
          maxBufferedFrames: 1_000,
          maxBufferedBytes: 16_777_216,
          overflowPolicy: "close",
        },
      },
      maxSessionsPerToken: 20,
    });

    const corsServer = createHttpServer({
      config: configWithCors,
      sessionManager: manager,
      upstreamPolicy: new UpstreamPolicy(configWithCors.security.upstreamPolicy),
      auth: buildAuth({ requireAuth: true, tokens: [{ value: VALID_TOKEN }] }),
      ssrfGuard: makeFakeSsrfGuard(),
    });
    await corsServer.start();
    const corsBase = `http://127.0.0.1:${corsServer.port()}`;

    try {
      // Create session
      const sessRes = await fetch(`${corsBase}/v1/sessions`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          protocol: "https2wss",
          version: 1,
          transport: { mode: "sse", fallbacks: [] },
          upstream: { adapter: "websocket", profile: "echo" },
        }),
      });
      expect(sessRes.ok).toBe(true);
      const sess = (await sessRes.json()) as {
        sessionId: string;
        transport: { receiveUrl: string };
      };

      await new Promise<void>((res) => setTimeout(res, 30));

      // Fetch SSE with the allowed origin
      const sseRes = await fetch(`${corsBase}${sess.transport.receiveUrl}?after=0`, {
        headers: { authorization: AUTH, origin: ORIGIN },
      });
      expect(sseRes.ok).toBe(true);
      // The CORS header MUST be present on the hijacked SSE response
      expect(sseRes.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      sseRes.body?.cancel();
    } finally {
      await corsServer.stop();
    }
  });
});

describe("static asset routes (unauthenticated)", () => {
  it("14a — GET /_/lib/client/index.js returns 200 application/javascript with no auth", async () => {
    const res = await fetch(`${baseUrl}/_/lib/client/index.js`);
    // If the build hasn't run yet the route returns 404 — skip gracefully.
    if (res.status === 404) {
      const body = (await res.json()) as { error: string };
      if (body.error.includes("build")) {
        console.warn("/_/lib/client/index.js: build not present — skipping body check");
        return;
      }
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const text = await res.text();
    expect(text).toMatch(/ResilientWebSocket/);
  });

  it("14b — GET /_/lib/ha/index.js returns 200 application/javascript with no auth", async () => {
    const res = await fetch(`${baseUrl}/_/lib/ha/index.js`);
    if (res.status === 404) {
      const body = (await res.json()) as { error: string };
      if (body.error.includes("build")) {
        console.warn("/_/lib/ha/index.js: build not present — skipping body check");
        return;
      }
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const text = await res.text();
    expect(text).toMatch(/HomeAssistantClient/);
  });

  it("14c — GET /_/shim/wsbridge.js returns 200 with placeholder tokens intact", async () => {
    const res = await fetch(`${baseUrl}/_/shim/wsbridge.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const text = await res.text();
    expect(text).toContain("BRIDGE_URL_PLACEHOLDER");
    expect(text).toContain("BRIDGE_TOKEN_PLACEHOLDER");
    expect(text).toContain("function defineWebSocketConstants(socket)");
    expect(text).toContain("return defineWebSocketConstants(new ResilientWebSocket(");
  });

  it("14d — GET /_/shim/ha-frontend.js injects instance WebSocket constants", async () => {
    await server.stop();
    server = makeServer(echo.url, (config) => ({
      ...config,
      frontendProxy: {
        ...config.frontendProxy,
        enabled: true,
        pathPrefix: "/",
        bridgeToken: VALID_TOKEN,
        upstreamProfile: "echo",
      },
    }));
    await server.start();
    baseUrl = `http://127.0.0.1:${server.port()}`;

    const res = await fetch(`${baseUrl}/_/shim/ha-frontend.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const text = await res.text();
    expect(text).toContain("function defineWebSocketConstants(socket)");
    expect(text).toContain("return defineWebSocketConstants(new ResilientWebSocket(");
  });

  it("14e — auth/token requests are forwarded with form body and upstream origin", async () => {
    await server.stop();
    let seen: {
      origin: string | null;
      referer: string | null;
      forwarded: string | null;
      xForwardedFor: string | null;
      contentType: string | null;
      body: string;
    } | null = null;

    const upstream = createServer((req, res) => {
      if (req.url !== "/auth/token") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        seen = {
          origin: req.headers.origin == null ? null : String(req.headers.origin),
          referer: req.headers.referer == null ? null : String(req.headers.referer),
          forwarded: req.headers.forwarded == null ? null : String(req.headers.forwarded),
          xForwardedFor:
            req.headers["x-forwarded-for"] == null ? null : String(req.headers["x-forwarded-for"]),
          contentType:
            req.headers["content-type"] == null ? null : String(req.headers["content-type"]),
          body: Buffer.concat(chunks).toString("utf-8"),
        };
        res.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": upstreamUrl,
          "access-control-allow-credentials": "true",
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as AddressInfo;
    const upstreamUrl = `http://127.0.0.1:${port}`;

    server = makeServer(echo.url, (config) => ({
      ...config,
      frontendProxy: {
        ...config.frontendProxy,
        enabled: true,
        pathPrefix: "/",
        upstreamUrl,
        bridgeToken: VALID_TOKEN,
        upstreamProfile: "echo",
      },
    }));
    await server.start();
    baseUrl = `http://127.0.0.1:${server.port()}`;

    try {
      const proxyRes = await fetch(`${baseUrl}/auth/token`, {
        method: "POST",
        headers: {
          origin: baseUrl,
          referer: `${baseUrl}/auth/authorize`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=authorization_code&code=foo&client_id=bar",
      });
      expect(proxyRes.status).toBe(200);
      expect(proxyRes.headers.get("access-control-allow-origin")).toBe(baseUrl);
      expect(proxyRes.headers.get("access-control-allow-credentials")).toBeNull();
      expect(await proxyRes.json()).toEqual({ ok: true });
      const snapshot = seen as {
        origin: string | null;
        referer: string | null;
        forwarded: string | null;
        xForwardedFor: string | null;
        contentType: string | null;
        body: string;
      } | null;
      if (snapshot === null) throw new Error("upstream did not receive proxied auth/token request");
      expect(snapshot.origin).toBe(upstreamUrl);
      expect(snapshot.referer).toBe(`${upstreamUrl}/auth/authorize`);
      expect(snapshot.forwarded).toBeNull();
      expect(snapshot.xForwardedFor).toBeNull();
      expect(snapshot.contentType).toContain("application/x-www-form-urlencoded");
      expect(snapshot.body).toBe("grant_type=authorization_code&code=foo&client_id=bar");
    } finally {
      await closeHttpServer(upstream);
    }
  });

  it("14f — auth/token multipart FormData requests are forwarded as raw bodies", async () => {
    await server.stop();
    let seen: { contentType: string | null; body: string } | null = null;

    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        seen = {
          contentType:
            req.headers["content-type"] == null ? null : String(req.headers["content-type"]),
          body: Buffer.concat(chunks).toString("utf-8"),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as AddressInfo;
    const upstreamUrl = `http://127.0.0.1:${port}`;

    server = makeServer(echo.url, (config) => ({
      ...config,
      frontendProxy: {
        ...config.frontendProxy,
        enabled: true,
        pathPrefix: "/",
        upstreamUrl,
        bridgeToken: VALID_TOKEN,
        upstreamProfile: "echo",
      },
    }));
    await server.start();
    baseUrl = `http://127.0.0.1:${server.port()}`;

    try {
      const form = new FormData();
      form.append("grant_type", "authorization_code");
      form.append("code", "foo");
      form.append("client_id", "bar");

      const proxyRes = await fetch(`${baseUrl}/auth/token`, {
        method: "POST",
        headers: { origin: baseUrl },
        body: form,
      });

      expect(proxyRes.status).toBe(200);
      expect(await proxyRes.json()).toEqual({ ok: true });
      const snapshot = seen;
      if (snapshot === null) {
        throw new Error("upstream did not receive multipart auth/token request");
      }
      expect(snapshot.contentType).toContain("multipart/form-data");
      expect(snapshot.body).toContain('name="grant_type"');
      expect(snapshot.body).toContain("authorization_code");
      expect(snapshot.body).toContain('name="code"');
      expect(snapshot.body).toContain("foo");
      expect(snapshot.body).toContain('name="client_id"');
      expect(snapshot.body).toContain("bar");
    } finally {
      await closeHttpServer(upstream);
    }
  });
});

describe("GET /healthz", () => {
  it("11 — returns 200 with status ok (no auth required)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string; sessions: number };
    expect(body.status).toBe("ok");
    expect(typeof body.sessions).toBe("number");
  });

  it("healthz includes active session count", async () => {
    await createSession("echo");
    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as { sessions: number };
    expect(body.sessions).toBeGreaterThanOrEqual(1);
  });
});
