import fastifyCors from "@fastify/cors";
import { BridgeError } from "@https2wss/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { ServerConfig } from "./config/serverConfig.js";
import type { Logger } from "./observability/logger.js";
import type { AuthVerifier } from "./security/auth.js";
import type { SsrfGuard } from "./security/ssrfGuard.js";
import type { UpstreamPolicy } from "./security/upstreamPolicy.js";
import type { SessionManager } from "./sessions/SessionManager.js";
import { registerClose } from "./transports/close.js";
import { registerCreateSession } from "./transports/createSession.js";
import { errorToHttp } from "./transports/errorMap.js";
import { isFrontendProxyRequest, registerFrontendProxy } from "./transports/frontendProxy.js";
import { registerHealthz } from "./transports/healthz.js";
import { registerPoll } from "./transports/poll.js";
import { registerSend } from "./transports/send.js";
import { registerSse } from "./transports/sse.js";
import { registerStaticAssets } from "./transports/staticAssets.js";
import type { UpstreamAdapter, UpstreamAdapterFactory } from "./upstream/UpstreamAdapter.js";
import { createWebSocketUpstreamAdapter } from "./upstream/WebSocketUpstreamAdapter.js";

export interface HttpServerDeps {
  config: ServerConfig;
  sessionManager: SessionManager;
  upstreamPolicy: UpstreamPolicy;
  auth: AuthVerifier;
  ssrfGuard: SsrfGuard;
  upstreamAdapterFactory?: UpstreamAdapterFactory;
  logger?: Logger;
  /** Injectable clock for tests. */
  clock?: () => number;
}

export interface HttpServer {
  fastify: FastifyInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Returns the bound port (useful when port: 0 is used for ephemeral binding). */
  port(): number;
}

// Augment FastifyRequest to carry tokenId set by the auth hook
declare module "fastify" {
  interface FastifyRequest {
    tokenId?: string;
  }
}

export function createHttpServer(deps: HttpServerDeps): HttpServer {
  const { config, sessionManager, upstreamPolicy, auth, ssrfGuard, logger } = deps;
  const clock = deps.clock ?? (() => Date.now());

  // Adapter map shared across route handlers — keyed by session ID
  const adapterMap = new Map<string, UpstreamAdapter>();

  // Wrap the adapter factory to inject the shared SsrfGuard (so tests can substitute a fake)
  const adapterFactory: UpstreamAdapterFactory =
    deps.upstreamAdapterFactory ??
    ((input) => createWebSocketUpstreamAdapter(input, { ssrfGuard }));

  const fastify = Fastify({
    logger: logger ?? false,
  });

  // ── CORS ─────────────────────────────────────────────────────────────────

  const allowedOrigins = config.security.cors.allowedOrigins;
  void fastify.register(fastifyCors, {
    origin:
      allowedOrigins.length === 0
        ? false
        : (origin, callback) => {
            if (origin === undefined || allowedOrigins.includes(origin)) {
              callback(null, true);
            } else {
              callback(null, false);
            }
          },
    credentials: config.security.cors.allowCredentials,
  });

  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  // ── Auth hook ────────────────────────────────────────────────────────────

  // Paths that are intentionally unauthenticated (static assets + healthz).
  // Checked in the auth hook below so these routes never require a bearer token.
  const UNAUTHENTICATED_PREFIXES = ["/healthz", "/_/lib/", "/_/shim/"] as const;

  fastify.addHook("onRequest", async (req: FastifyRequest, reply) => {
    // Skip auth for static assets and healthz
    if (
      UNAUTHENTICATED_PREFIXES.some((prefix) => req.url === prefix || req.url.startsWith(prefix)) ||
      isFrontendProxyRequest(config, req.url)
    )
      return;

    try {
      const { tokenId } = auth.verifyAuthorizationHeader(req.headers.authorization);
      req.tokenId = tokenId;
    } catch (err) {
      const { status, body } = errorToHttp(err);
      const headers: Record<string, string> = {};
      if (err instanceof BridgeError && err.code === "AUTH_REQUIRED") {
        headers["www-authenticate"] = "Bearer";
      }
      return reply.code(status).headers(headers).send(body);
    }
  });

  // ── Global error handler ─────────────────────────────────────────────────

  fastify.setErrorHandler((err, _req, reply) => {
    fastify.log.error({ err }, "request failed");
    const { status, body } = errorToHttp(err);
    const headers: Record<string, string> = {};
    if (err instanceof BridgeError && err.code === "AUTH_REQUIRED") {
      headers["www-authenticate"] = "Bearer";
    }
    void reply.code(status).headers(headers).send(body);
  });

  // ── Routes ───────────────────────────────────────────────────────────────

  // Static assets are registered first (before auth routes) for clarity,
  // though route registration order does not affect the hook skip list above.
  registerStaticAssets(fastify);

  registerHealthz(fastify, sessionManager);

  registerCreateSession(fastify, {
    config,
    sessionManager,
    upstreamPolicy,
    ssrfGuard,
    upstreamAdapterFactory: adapterFactory,
    adapterMap,
    clock,
  });

  registerSend(fastify, { sessionManager, adapterMap, clock });

  registerPoll(fastify, { config, sessionManager });

  registerSse(fastify, { config, sessionManager });

  registerClose(fastify, { sessionManager, adapterMap });

  registerFrontendProxy(fastify, config);

  // ── Tick interval ────────────────────────────────────────────────────────

  let tickInterval: ReturnType<typeof setInterval> | undefined;

  return {
    fastify,

    async start(): Promise<void> {
      await fastify.listen({ host: config.server.host, port: config.server.port });
      tickInterval = setInterval(() => sessionManager.tick(), config.sessions.tickIntervalMs);
    },

    async stop(): Promise<void> {
      if (tickInterval !== undefined) {
        clearInterval(tickInterval);
        tickInterval = undefined;
      }
      // Close all upstream adapters to release ws connections before shutting down
      for (const [sid, adapter] of adapterMap) {
        try {
          adapter.close(1001, "server shutting down");
        } catch {
          // ignore — adapter may already be closed
        }
        sessionManager.close(sid, 1001, "server shutting down", "bridge");
      }
      adapterMap.clear();
      await fastify.close();
    },

    port(): number {
      const addr = fastify.server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("Server is not listening or bound to a pipe");
      }
      return addr.port;
    },
  };
}
