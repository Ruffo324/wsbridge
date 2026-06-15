import { z } from "zod";
import { BRIDGE_ERROR_CODES } from "./errors.js";

const SID_PATTERN = /^h2w_[A-Za-z0-9_-]{16,}$/;

const baseEnvelope = z.object({
  v: z.literal(1),
  sid: z.string().regex(SID_PATTERN),
  seq: z.number().int().min(1),
  ack: z.number().int().min(0).optional(),
  ts: z.iso.datetime(),
});

const dataPayloadSchema = z
  .object({
    opcode: z.enum(["text", "binary"]),
    encoding: z.enum(["utf8", "base64"]),
    data: z.string(),
    fin: z.boolean(),
  })
  .refine(
    (x) =>
      (x.opcode === "text" && x.encoding === "utf8") ||
      (x.opcode === "binary" && x.encoding === "base64"),
    { message: "encoding must match opcode" },
  );

const controlPayloadSchema = z.object({
  event: z.enum(["upstream_open", "upstream_close", "client_ready", "transport_ready", "drain"]),
  details: z.record(z.string(), z.unknown()).optional(),
});

const closePayloadSchema = z.object({
  code: z.number().int().min(1000).max(4999),
  reason: z.string(),
  source: z.enum(["client", "bridge", "upstream", "timeout", "policy"]),
});

const errorPayloadSchema = z.object({
  code: z.enum(BRIDGE_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const heartbeatPayloadSchema = z.object({}).strict();

const dataEnvelopeSchema = baseEnvelope.extend({
  kind: z.literal("data"),
  payload: dataPayloadSchema,
});

const controlEnvelopeSchema = baseEnvelope.extend({
  kind: z.literal("control"),
  payload: controlPayloadSchema,
});

const closeEnvelopeSchema = baseEnvelope.extend({
  kind: z.literal("close"),
  payload: closePayloadSchema,
});

const errorEnvelopeSchema = baseEnvelope.extend({
  kind: z.literal("error"),
  payload: errorPayloadSchema,
});

const heartbeatEnvelopeSchema = baseEnvelope.extend({
  kind: z.literal("heartbeat"),
  payload: heartbeatPayloadSchema,
});

export const bridgeEnvelopeSchema = z.discriminatedUnion("kind", [
  dataEnvelopeSchema,
  controlEnvelopeSchema,
  closeEnvelopeSchema,
  errorEnvelopeSchema,
  heartbeatEnvelopeSchema,
]);

export type ParsedBridgeEnvelope = z.infer<typeof bridgeEnvelopeSchema>;

export const sessionInfoSchema = z.object({
  sessionId: z.string(),
  state: z.enum(["connecting", "open", "closing", "closed", "errored"]),
  createdAt: z.iso.datetime(),
  lastActivityAt: z.iso.datetime(),
  transportMode: z.enum(["poll", "long_poll", "sse"]),
  upstream: z.object({
    adapter: z.string(),
    state: z.enum(["connecting", "open", "closing", "closed", "errored"]),
  }),
});
