import { BridgeError } from "@https2wss/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config/serverConfig.js";
import { CorsPolicy } from "../security/cors.js";
import type { SessionEvent } from "../sessions/Session.js";
import type { SessionManager } from "../sessions/SessionManager.js";

export interface SseDeps {
  config: ServerConfig;
  sessionManager: SessionManager;
  clock: () => number;
  /** CorsPolicy is needed because reply.hijack() bypasses @fastify/cors. */
  corsPolicy?: CorsPolicy;
}

export function registerSse(fastify: FastifyInstance, deps: SseDeps): void {
  const { config, sessionManager, clock } = deps;
  const heartbeatIntervalMs = config.transports.sse.heartbeatIntervalMs;
  // Build a CorsPolicy from config if one wasn't injected. Needed because
  // reply.hijack() bypasses the @fastify/cors plugin's response hooks.
  const corsPolicy = deps.corsPolicy ?? new CorsPolicy(config.security.cors);

  fastify.get("/v1/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessionManager.get(id);
    if (session === undefined) {
      throw new BridgeError("SESSION_NOT_FOUND", `session ${id} not found`);
    }
    session.touch(clock());

    // Determine replay position: prefer Last-Event-ID header, then `after` query param
    const lastEventId = req.headers["last-event-id"];
    const query = req.query as { after?: string };
    let after = 0;
    if (typeof lastEventId === "string" && lastEventId !== "") {
      const parsed = parseInt(lastEventId, 10);
      if (!Number.isNaN(parsed)) after = parsed;
    } else if (query.after !== undefined) {
      const parsed = parseInt(query.after, 10);
      if (!Number.isNaN(parsed)) after = parsed;
    }

    // Take manual control of the response
    reply.hijack();
    const raw = reply.raw;

    // reply.hijack() bypasses @fastify/cors, so we must add CORS headers manually.
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    const corsHeaders = corsPolicy.buildResponseHeaders(origin ?? null);

    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...corsHeaders,
    });
    raw.write(":ok\n\n");
    session.touch(clock());

    // Replay buffered frames since `after`
    for (const envelope of session.buffer.since(after)) {
      raw.write(`id: ${envelope.seq}\nevent: frame\ndata: ${JSON.stringify(envelope)}\n\n`);
    }

    // Heartbeat
    const heartbeat = setInterval(() => {
      raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      session.touch(clock());
    }, heartbeatIntervalMs);

    let done = false;

    const unsubscribe = session.on((ev: SessionEvent) => {
      if (done) return;
      if (ev.type === "outbound_frame") {
        const envelope = ev.envelope;
        raw.write(`id: ${envelope.seq}\nevent: frame\ndata: ${JSON.stringify(envelope)}\n\n`);
        session.touch(clock());
        // On close frame, signal terminal state
        if (envelope.kind === "close") {
          done = true;
          clearInterval(heartbeat);
          unsubscribe();
          raw.write("event: close\ndata: {}\n\n");
          raw.end();
        }
      } else if (ev.type === "closed") {
        if (!done) {
          done = true;
          clearInterval(heartbeat);
          unsubscribe();
          raw.write("event: close\ndata: {}\n\n");
          raw.end();
        }
      }
    });

    req.raw.on("close", () => {
      if (!done) {
        done = true;
        clearInterval(heartbeat);
        unsubscribe();
        // Do NOT call raw.end() — the client already closed; writing would error
      }
    });
  });
}
