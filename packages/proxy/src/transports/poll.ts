import { BridgeError } from "@https2wss/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config/serverConfig.js";
import type { SessionEvent } from "../sessions/Session.js";
import type { SessionManager } from "../sessions/SessionManager.js";

export interface PollDeps {
  config: ServerConfig;
  sessionManager: SessionManager;
}

export function registerPoll(fastify: FastifyInstance, deps: PollDeps): void {
  const { config, sessionManager } = deps;
  const maxTimeoutMs = config.transports.longPoll.maxTimeoutMs;

  fastify.get("/v1/sessions/:id/poll", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessionManager.get(id);
    if (session === undefined) {
      throw new BridgeError("SESSION_NOT_FOUND", `session ${id} not found`);
    }

    const query = req.query as { after?: string; timeoutMs?: string };
    const after = query.after !== undefined ? parseInt(query.after, 10) : 0;
    const requestedTimeout = query.timeoutMs !== undefined ? parseInt(query.timeoutMs, 10) : 25_000;
    const timeoutMs = Math.min(requestedTimeout, maxTimeoutMs);

    // If frames are already available, return immediately
    const immediate = session.buffer.since(after);
    if (immediate.length > 0) {
      const nextAfter = immediate[immediate.length - 1]?.seq ?? after;
      return reply.send({ frames: immediate, nextAfter, state: session.state });
    }

    // Wait for new frames or timeout
    const { frames, nextAfter } = await new Promise<{
      frames: ReturnType<typeof session.buffer.since>;
      nextAfter: number;
    }>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (unsubscribe !== undefined) unsubscribe();
      };

      const finish = (result: ReturnType<typeof session.buffer.since>, na: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ frames: result, nextAfter: na });
      };

      unsubscribe = session.on((ev: SessionEvent) => {
        if (ev.type === "outbound_frame") {
          const pending = session.buffer.since(after);
          if (pending.length > 0) {
            const last = pending[pending.length - 1];
            finish(pending, last?.seq ?? after);
          }
        } else if (ev.type === "closed") {
          // Return whatever is in the buffer before terminating
          const pending = session.buffer.since(after);
          const last = pending[pending.length - 1];
          finish(pending, last?.seq ?? after);
        }
      });

      timer = setTimeout(() => {
        finish([], after);
      }, timeoutMs);

      // Handle client disconnect
      req.raw.on("close", () => {
        if (!settled) {
          settled = true;
          cleanup();
          // Resolve with empty — no-op response will be discarded
          resolve({ frames: [], nextAfter: after });
        }
      });
    });

    return reply.send({ frames, nextAfter, state: session.state });
  });
}
