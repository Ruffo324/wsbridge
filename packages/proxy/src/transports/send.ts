import { BridgeError, bridgeEnvelopeSchema } from "@https2wss/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SessionManager } from "../sessions/SessionManager.js";
import type { UpstreamAdapter } from "../upstream/UpstreamAdapter.js";

const sendBodySchema = z.object({
  frames: z.array(bridgeEnvelopeSchema),
});

export interface SendDeps {
  sessionManager: SessionManager;
  adapterMap: Map<string, UpstreamAdapter>;
  clock: () => number;
}

export function registerSend(fastify: FastifyInstance, deps: SendDeps): void {
  const { sessionManager, adapterMap, clock } = deps;

  fastify.post("/v1/sessions/:id/send", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessionManager.get(id);
    if (session === undefined) {
      throw new BridgeError("SESSION_NOT_FOUND", `session ${id} not found`);
    }

    const parseResult = sendBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      const first = parseResult.error.issues[0];
      throw new BridgeError(
        "PROTOCOL_VERSION_UNSUPPORTED",
        first !== undefined ? first.message : "invalid send body",
      );
    }

    const { frames } = parseResult.data;
    const adapter = adapterMap.get(id);
    const now = clock();

    for (const env of frames) {
      // Validate sid matches
      if (env.sid !== session.id) {
        throw new BridgeError("POLICY_DENIED", "frame sid does not match session id");
      }

      // Process ack first
      if (env.ack !== undefined) {
        session.buffer.ack(env.ack);
      }

      // Classify inbound sequence
      const classification = session.sequencer.classifyInbound(env.seq);

      if (classification.kind === "accept") {
        if (env.kind === "data") {
          const payload = env.payload as { opcode: string; encoding: string; data: string };
          if (adapter !== undefined) {
            if (payload.opcode === "text") {
              adapter.sendText(payload.data);
            } else if (payload.opcode === "binary") {
              const bytes = Buffer.from(payload.data, "base64");
              adapter.sendBinary(new Uint8Array(bytes));
            }
          }
        } else if (env.kind === "close") {
          const payload = env.payload as { code: number; reason: string };
          if (adapter !== undefined) {
            adapter.close(payload.code, payload.reason);
          }
          sessionManager.close(session.id, payload.code, payload.reason, "client");
          // Session is now closed; stop processing further frames
          break;
        } else if (env.kind === "heartbeat") {
          // Heartbeat — just touch
        }
        // control/error frames accepted but no-op for MVP
        session.touch(now);
      } else if (classification.kind === "duplicate") {
        // Silently swallow — re-ack already counted via ack processing
        session.touch(now);
      } else {
        // out_of_order — close and throw
        sessionManager.close(session.id, 1002, "sequence out of order", "bridge");
        throw new BridgeError(
          "SEQUENCE_OUT_OF_ORDER",
          `expected seq ${classification.expected}, got ${classification.got}`,
        );
      }
    }

    // After all frames: respond with ack = last accepted inbound seq - 1
    const ack = session.sequencer.peekNextIn() - 1;
    return reply.send({ accepted: true, ack, state: session.state });
  });
}
