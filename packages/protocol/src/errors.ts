export const BRIDGE_ERROR_CODES = [
  "PROTOCOL_VERSION_UNSUPPORTED",
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "POLICY_DENIED",
  "UPSTREAM_NOT_ALLOWED",
  "UPSTREAM_CONNECT_FAILED",
  "UPSTREAM_CLOSED",
  "SESSION_NOT_FOUND",
  "SESSION_CLOSED",
  "FRAME_TOO_LARGE",
  "BUFFER_OVERFLOW",
  "SEQUENCE_OUT_OF_ORDER",
  "TRANSPORT_TIMEOUT",
  "INTERNAL_ERROR",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

const DEFAULT_RETRYABLE: Record<BridgeErrorCode, boolean> = {
  PROTOCOL_VERSION_UNSUPPORTED: false,
  AUTH_REQUIRED: false,
  AUTH_INVALID: false,
  POLICY_DENIED: false,
  UPSTREAM_NOT_ALLOWED: false,
  UPSTREAM_CONNECT_FAILED: true,
  UPSTREAM_CLOSED: false,
  SESSION_NOT_FOUND: false,
  SESSION_CLOSED: false,
  FRAME_TOO_LARGE: false,
  BUFFER_OVERFLOW: false,
  SEQUENCE_OUT_OF_ORDER: false,
  TRANSPORT_TIMEOUT: true,
  INTERNAL_ERROR: false,
};

export interface BridgeErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: BridgeErrorCode, message: string, opts: BridgeErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "BridgeError";
    this.code = code;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[code];
    if (opts.details !== undefined) {
      this.details = opts.details;
    }
  }
}

export interface FormattedError {
  error: {
    code: BridgeErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export function formatError(err: BridgeError | unknown): FormattedError {
  if (err instanceof BridgeError) {
    const result: FormattedError = {
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
      },
    };
    if (err.details !== undefined) {
      result.error.details = err.details;
    }
    return result;
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "internal error",
      retryable: false,
    },
  };
}
