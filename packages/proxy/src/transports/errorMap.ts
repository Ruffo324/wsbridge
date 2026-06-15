import { BridgeError, type BridgeErrorCode } from "@https2wss/protocol";

const STATUS_MAP: Record<BridgeErrorCode, number> = {
  PROTOCOL_VERSION_UNSUPPORTED: 400,
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  POLICY_DENIED: 403,
  UPSTREAM_NOT_ALLOWED: 403,
  UPSTREAM_CONNECT_FAILED: 502,
  UPSTREAM_CLOSED: 410,
  SESSION_NOT_FOUND: 404,
  SESSION_CLOSED: 410,
  FRAME_TOO_LARGE: 413,
  BUFFER_OVERFLOW: 507,
  SEQUENCE_OUT_OF_ORDER: 409,
  TRANSPORT_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
};

interface HttpErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export function errorToHttp(err: unknown): { status: number; body: HttpErrorBody } {
  if (err instanceof BridgeError) {
    const body: HttpErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
      },
    };
    if (err.details !== undefined) {
      body.error.details = err.details;
    }
    return { status: STATUS_MAP[err.code], body };
  }

  // Unknown error — do NOT leak message details
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "internal error",
        retryable: false,
      },
    },
  };
}
