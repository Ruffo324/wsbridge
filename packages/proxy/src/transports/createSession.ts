import { BridgeError } from "@https2wss/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config/serverConfig.js";
import type { SsrfGuard } from "../security/ssrfGuard.js";
import type { UpstreamPolicy } from "../security/upstreamPolicy.js";
import type { SessionTransportMode } from "../sessions/Session.js";
import type { SessionManager } from "../sessions/SessionManager.js";
import type { UpstreamAdapter, UpstreamAdapterFactory } from "../upstream/UpstreamAdapter.js";

const createSessionBodySchema = z.object({
  protocol: z.literal("https2wss"),
  version: z.literal(1),
  transport: z
    .object({
      mode: z.enum(["sse", "long_poll", "poll"]),
      fallbacks: z.array(z.enum(["sse", "long_poll", "poll"])).default([]),
    })
    .default({ mode: "sse", fallbacks: ["long_poll", "poll"] }),
  upstream: z.object({
    adapter: z.literal("websocket"),
    profile: z.string().optional(),
    url: z.string().optional(),
  }),
  options: z
    .object({
      binary: z.enum(["base64"]).optional(),
      ordered: z.boolean().optional(),
      resume: z.boolean().optional(),
      heartbeatIntervalMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export interface CreateSessionDeps {
  config: ServerConfig;
  sessionManager: SessionManager;
  upstreamPolicy: UpstreamPolicy;
  ssrfGuard: SsrfGuard;
  upstreamAdapterFactory: UpstreamAdapterFactory;
  adapterMap: Map<string, UpstreamAdapter>;
  clock: () => number;
}

export function registerCreateSession(fastify: FastifyInstance, deps: CreateSessionDeps): void {
  const { config, sessionManager, upstreamPolicy, adapterMap } = deps;

  const adapterFactory = deps.upstreamAdapterFactory;

  fastify.post("/v1/sessions", async (req, reply) => {
    // Parse and validate body
    const parseResult = createSessionBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      const first = parseResult.error.issues[0];
      throw new BridgeError(
        "PROTOCOL_VERSION_UNSUPPORTED",
        first !== undefined ? first.message : "invalid request body",
      );
    }
    const body = parseResult.data;

    // Token id from auth hook decoration
    const tokenId = (req as { tokenId?: string }).tokenId ?? "anonymous";

    // Resolve upstream
    const resolved =
      body.upstream.profile !== undefined
        ? upstreamPolicy.resolve({ kind: "profile", name: body.upstream.profile })
        : body.upstream.url !== undefined
          ? upstreamPolicy.resolve({ kind: "directUrl", url: body.upstream.url })
          : (() => {
              throw new BridgeError("POLICY_DENIED", "upstream profile or url required");
            })();

    // Select transport
    const enabledSet = new Set(config.transports.enabled);
    const requested = body.transport.mode;
    const fallbacks = body.transport.fallbacks;
    let selected: SessionTransportMode | undefined;

    if (enabledSet.has(requested)) {
      selected = requested;
    } else {
      for (const fb of fallbacks) {
        if (enabledSet.has(fb)) {
          selected = fb;
          break;
        }
      }
    }
    if (selected === undefined) {
      throw new BridgeError("POLICY_DENIED", "no enabled transport available");
    }

    // Create session
    const session = sessionManager.create({
      token: tokenId,
      transportMode: selected,
      upstreamProfile: resolved.profileName,
    });

    // Build adapter
    const adapter = adapterFactory({
      session,
      resolved,
      clientHeaders: {},
    });

    // Wire outbound frames → buffer
    const unsubscribe = session.on((ev) => {
      if (ev.type === "outbound_frame") {
        const serialized = JSON.stringify(ev.envelope);
        const sizeBytes = Buffer.byteLength(serialized, "utf8");
        const result = session.buffer.store(ev.envelope, sizeBytes);
        if (!result.ok) {
          unsubscribe();
          sessionManager.close(session.id, 1011, "buffer overflow", "policy");
        }
      }
    });

    // Connect upstream; on failure, clean up session
    try {
      await adapter.connect();
    } catch (err) {
      unsubscribe();
      // session may already be closed by adapter's error path; close defensively
      sessionManager.close(session.id, 1011, "upstream connect failed", "bridge");
      throw err;
    }

    // Store adapter for send/close routes
    adapterMap.set(session.id, adapter);

    // Clean up map entry when session is eventually closed
    session.on((ev) => {
      if (ev.type === "closed") {
        adapterMap.delete(session.id);
      }
    });

    const receiveUrl =
      selected === "sse" ? `/v1/sessions/${session.id}/events` : `/v1/sessions/${session.id}/poll`;

    return reply.code(200).send({
      sessionId: session.id,
      state: session.state,
      transport: {
        selected,
        sendUrl: `/v1/sessions/${session.id}/send`,
        receiveUrl,
      },
      limits: {
        maxFrameBytes: config.sessions.maxFrameBytes,
        maxBufferedFrames: config.sessions.maxBufferedFrames,
        idleTimeoutMs: config.sessions.idleTimeoutMs,
      },
    });
  });
}
