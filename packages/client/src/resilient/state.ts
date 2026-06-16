/**
 * Shared constants and types for ResilientWebSocket decision logic.
 */

// WebSocket numeric readyState constants
export const CONNECTING = 0 as const;
export const OPEN = 1 as const;
export const CLOSING = 2 as const;
export const CLOSED = 3 as const;

export type ReadyState = typeof CONNECTING | typeof OPEN | typeof CLOSING | typeof CLOSED;

/** Transport currently in use */
export type Transport = "native" | "bridge";

/** Why the transport-change event fired */
export type FallbackReason =
  | "no-native-support"
  | "connect-failure"
  | "heartbeat-timeout"
  | "sticky-cookie";
