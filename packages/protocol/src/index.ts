export type { ValidateEnvelopeResult } from "./envelope.js";
export { buildEnvelope, parseEnvelope, validateEnvelope } from "./envelope.js";

export type { BridgeErrorCode, BridgeErrorOptions, FormattedError } from "./errors.js";
export {
  BRIDGE_ERROR_CODES,
  BridgeError,
  formatError,
} from "./errors.js";

export type { ParsedBridgeEnvelope } from "./schema.js";
export { bridgeEnvelopeSchema, sessionInfoSchema } from "./schema.js";

export type {
  BridgeEnvelope,
  BridgeEnvelopeInput,
  BridgePayload,
  ClosePayload,
  ControlPayload,
  DataPayload,
  ErrorPayload,
  HeartbeatPayload,
  SessionInfo,
  SessionState,
} from "./types.js";
