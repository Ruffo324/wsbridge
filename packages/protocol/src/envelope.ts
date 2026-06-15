import { BridgeError } from "./errors.js";
import { bridgeEnvelopeSchema, type ParsedBridgeEnvelope } from "./schema.js";
import type { BridgeEnvelopeInput } from "./types.js";

export function buildEnvelope(input: BridgeEnvelopeInput): ParsedBridgeEnvelope {
  const candidate = {
    v: 1 as const,
    ts: new Date().toISOString(),
    ...input,
  };

  const result = bridgeEnvelopeSchema.safeParse(candidate);
  if (!result.success) {
    throw new BridgeError("INTERNAL_ERROR", "buildEnvelope produced an invalid envelope", {
      details: { issues: result.error.issues },
    });
  }

  return result.data;
}

export function parseEnvelope(value: unknown): ParsedBridgeEnvelope {
  if (
    value !== null &&
    typeof value === "object" &&
    "v" in value &&
    (value as Record<string, unknown>).v !== 1
  ) {
    throw new BridgeError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `Protocol version ${String((value as Record<string, unknown>).v)} is not supported`,
    );
  }

  const result = bridgeEnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw new BridgeError("INTERNAL_ERROR", "Invalid envelope", {
      details: { issues: result.error.issues },
    });
  }

  return result.data;
}

export type ValidateEnvelopeResult =
  | { ok: true; envelope: ParsedBridgeEnvelope }
  | { ok: false; error: BridgeError };

export function validateEnvelope(value: unknown): ValidateEnvelopeResult {
  try {
    const envelope = parseEnvelope(value);
    return { ok: true, envelope };
  } catch (err) {
    if (err instanceof BridgeError) {
      return { ok: false, error: err };
    }
    return {
      ok: false,
      error: new BridgeError("INTERNAL_ERROR", "Unexpected error during validation", {
        cause: err,
      }),
    };
  }
}
