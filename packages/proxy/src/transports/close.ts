import { BridgeError } from "@https2wss/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SessionManager } from "../sessions/SessionManager.js";
import type { UpstreamAdapter } from "../upstream/UpstreamAdapter.js";

const closeBodySchema = z.object({
  code: z.number().int().min(1000).max(4999).default(1000),
  reason: z.string().default("client requested close"),
});

export interface CloseDeps {
  sessionManager: SessionManager;
  adapterMap: Map<string, UpstreamAdapter>;
}

export function registerClose(fastify: FastifyInstance, deps: CloseDeps): void {
  const { sessionManager, adapterMap } = deps;

  fastify.post("/v1/sessions/:id/close", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessionManager.get(id);
    if (session === undefined) {
      throw new BridgeError("SESSION_NOT_FOUND", `session ${id} not found`);
    }

    const parseResult = closeBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      const first = parseResult.error.issues[0];
      throw new BridgeError(
        "INTERNAL_ERROR",
        first !== undefined ? first.message : "invalid close body",
      );
    }

    const { code, reason } = parseResult.data;
    const adapter = adapterMap.get(id);
    if (adapter !== undefined) {
      adapter.close(code, reason);
    }
    sessionManager.close(id, code, reason, "client");

    return reply.send({ closed: true, state: "closed" });
  });
}
