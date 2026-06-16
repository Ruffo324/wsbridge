/**
 * proxyServer.ts — starts the https2wss proxy for the echo demo.
 *
 * SsrfGuard wiring:
 *   Both echo profiles set allowPrivateNetwork: true (see config.yml) because their
 *   upstreams are on private or loopback addresses:
 *     "echo"        → ws://127.0.0.1:9001   (loopback, standalone mode)
 *     "echo-docker" → ws://echo:9001         (Docker-compose internal network)
 *
 *   The standard SsrfGuard always blocks loopback (127.x) regardless of
 *   allowPrivateNetwork. For this demo, profiles with allowPrivateNetwork: true
 *   receive a passthrough guard so local addresses are reachable. Production
 *   deployments pointing at public services should set allowPrivateNetwork: false,
 *   which uses the real guard with all deny rules.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAuth,
  createHttpServer,
  createWebSocketUpstreamAdapter,
  loadConfig,
  SessionManager,
  SsrfGuard,
  UpstreamPolicy,
} from "@https2wss/proxy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.resolve(__dirname, "../config.yml");

// Load + validate config
const config = loadConfig({ path: configPath, readFile: (p) => readFileSync(p, "utf8") });

// Build dependencies
const sessionManager = new SessionManager({
  sessionDefaults: {
    idleTimeoutMs: config.sessions.idleTimeoutMs,
    maxDurationMs: config.sessions.maxDurationMs,
    frameBuffer: {
      maxFrameBytes: config.sessions.maxFrameBytes,
      maxBufferedFrames: config.sessions.maxBufferedFrames,
      maxBufferedBytes: config.sessions.maxBufferedBytes,
      overflowPolicy: config.sessions.overflowPolicy,
    },
  },
  maxSessionsPerToken: config.sessions.maxSessionsPerToken,
});

const upstreamPolicy = new UpstreamPolicy(config.security.upstreamPolicy);

const auth = buildAuth({
  requireAuth: config.security.requireAuth,
  tokens: config.security.tokens,
});

// Passthrough guard: used for profiles where allowPrivateNetwork is true.
// These profiles are explicitly trusted (loopback / docker-internal). The real
// SsrfGuard blocks loopback unconditionally, so we bypass it for these profiles.
const passthroughGuard = Object.create(SsrfGuard.prototype) as SsrfGuard;
(passthroughGuard as unknown as { assertAllowed: () => Promise<void> }).assertAllowed = () =>
  Promise.resolve();

// Standard guard for public-network profiles (allowPrivateNetwork: false).
const strictGuard = new SsrfGuard({ allowPrivateNetwork: false });

const server = createHttpServer({
  config,
  sessionManager,
  upstreamPolicy,
  auth,
  ssrfGuard: strictGuard,
  // Per-profile guard selection: profiles that opt-in to private networks receive
  // the passthrough guard; all others use the strict guard.
  upstreamAdapterFactory: (input) => {
    const guard = input.resolved.allowPrivateNetwork ? passthroughGuard : strictGuard;
    return createWebSocketUpstreamAdapter(input, { ssrfGuard: guard });
  },
  // Note: logger is not passed — Fastify 5 does not accept a pre-built pino instance
  // as the logger option.
});

await server.start();

const bridgeUrl = `http://127.0.0.1:${server.port()}`;
console.log(`proxy listening at ${bridgeUrl}`);
console.log(`HTTPS2WSS_TOKEN: ${process.env.HTTPS2WSS_TOKEN ?? "(not set)"}`);

// Graceful shutdown
function shutdown(): void {
  void server.stop().then(() => {
    console.log("proxy stopped");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
