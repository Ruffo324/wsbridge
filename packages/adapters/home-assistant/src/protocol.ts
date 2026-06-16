/**
 * Type guards for Home Assistant WebSocket protocol messages.
 *
 * All guards are tolerant of extra fields — HA may add new fields in future
 * versions without breaking existing code.
 */

// ── Raw message shapes (for internal use only) ────────────────────────────

export interface AuthRequiredMsg {
  type: "auth_required";
  ha_version: string;
}

export interface AuthOkMsg {
  type: "auth_ok";
  ha_version: string;
}

export interface AuthInvalidMsg {
  type: "auth_invalid";
  message: string;
}

export interface ResultMsg {
  type: "result";
  id: number;
  success: boolean;
  result: unknown;
  error?: { code: string; message: string };
}

export interface EventMsg {
  type: "event";
  id: number;
  event: {
    event_type: string;
    data: Record<string, unknown>;
    origin: string;
    time_fired: string;
    context: Record<string, unknown>;
  };
}

export interface PongMsg {
  type: "pong";
  id: number;
}

/** Any inbound message (union). */
export type HaInboundMsg =
  | AuthRequiredMsg
  | AuthOkMsg
  | AuthInvalidMsg
  | ResultMsg
  | EventMsg
  | PongMsg;

// ── Type guards ───────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True if msg is `{type:"auth_required", ha_version: string}`. */
export function isAuthRequired(msg: unknown): msg is AuthRequiredMsg {
  return isObject(msg) && msg["type"] === "auth_required" && typeof msg["ha_version"] === "string";
}

/** True if msg is `{type:"auth_ok", ha_version: string}`. */
export function isAuthOk(msg: unknown): msg is AuthOkMsg {
  return isObject(msg) && msg["type"] === "auth_ok" && typeof msg["ha_version"] === "string";
}

/** True if msg is `{type:"auth_invalid", message: string}`. */
export function isAuthInvalid(msg: unknown): msg is AuthInvalidMsg {
  return isObject(msg) && msg["type"] === "auth_invalid" && typeof msg["message"] === "string";
}

/** True if msg is a `{type:"result", id: number, success: boolean}`. */
export function isResultMsg(msg: unknown): msg is ResultMsg {
  return (
    isObject(msg) &&
    msg["type"] === "result" &&
    typeof msg["id"] === "number" &&
    typeof msg["success"] === "boolean"
  );
}

/** True if msg is a `{type:"event", id: number, event: {...}}`. */
export function isEventMsg(msg: unknown): msg is EventMsg {
  return (
    isObject(msg) &&
    msg["type"] === "event" &&
    typeof msg["id"] === "number" &&
    isObject(msg["event"])
  );
}

/** True if msg is `{type:"pong", id: number}`. */
export function isPong(msg: unknown): msg is PongMsg {
  return isObject(msg) && msg["type"] === "pong" && typeof msg["id"] === "number";
}
