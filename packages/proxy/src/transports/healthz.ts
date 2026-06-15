import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../sessions/SessionManager.js";

export function registerHealthz(fastify: FastifyInstance, sessionManager: SessionManager): void {
  fastify.get("/healthz", async (_req, reply) => {
    return reply.send({ status: "ok", sessions: sessionManager.list().length });
  });
}
