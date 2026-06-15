/**
 * Test helper: spin up a ws echo server + https2wss proxy on ephemeral ports.
 *
 * Small duplication with packages/proxy/tests/httpServer.test.ts is intentional
 * (per spec §P7: "small duplication is OK in MVP").
 */

import type { AddressInfo } from "node:net";
import type { HttpServer, ServerConfig } from "@https2wss/proxy";
import {
  buildAuth,
  createHttpServer,
  SessionManager,
  SsrfGuard,
  UpstreamPolicy,
} from "@https2wss/proxy";
import { WebSocketServer } from "ws";

export const VALID_TOKEN = "test-client-token-abcdef";

/** No-op SsrfGuard that allows loopback connections (required for echo tests). */
function makeFakeSsrfGuard(): SsrfGuard {
  const fake = Object.create(SsrfGuard.prototype) as SsrfGuard;
  (fake as unknown as { assertAllowed: () => Promise<void> }).assertAllowed = () =>
    Promise.resolve();
  return fake;
}

/** Start a WebSocket echo server on a random port. Returns url and cleanup fn. */
export async function startEchoServer(): Promise<{
  wss: WebSocketServer;
  url: string;
  cleanup: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((res) => wss.on("listening", res));
  const { port } = wss.address() as AddressInfo;

  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      ws.send(data, { binary: isBinary });
    });
  });

  return {
    wss,
    url: `ws://127.0.0.1:${port}`,
    cleanup: () =>
      new Promise<void>((res) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => res());
      }),
  };
}

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
      tickIntervalMs: 60_000,
    },
    transports: {
      enabled: ["sse", "long_poll", "poll"],
      sse: { heartbeatIntervalMs: 50 },
      longPoll: { maxTimeoutMs: 500 },
    },
    logging: { level: "error", redactHeaders: ["authorization", "cookie"] },
  };
}

export async function startProxyWithEcho(): Promise<{
  proxy: HttpServer;
  baseUrl: string;
  wss: WebSocketServer;
  cleanup: () => Promise<void>;
}> {
  const echo = await startEchoServer();
  const config = makeConfig(echo.url);

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

  const proxy = createHttpServer({ config, sessionManager, upstreamPolicy, auth, ssrfGuard });
  await proxy.start();

  const baseUrl = `http://127.0.0.1:${proxy.port()}`;

  return {
    proxy,
    baseUrl,
    wss: echo.wss,
    cleanup: async () => {
      await proxy.stop();
      await echo.cleanup();
    },
  };
}
