/**
 * Public types for the Home Assistant WebSocket adapter.
 */

// ── Socket interface ──────────────────────────────────────────────────────

/**
 * The minimal WebSocket-like surface that HomeAssistantClient requires.
 * Compatible with native WebSocket, Https2WssSocket, and ResilientWebSocket.
 */
export interface HomeAssistantSocketLike {
  /** WebSocket ready state (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED) */
  readonly readyState: number;
  /** Send a text message. HA protocol is all JSON text. */
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Attach an event listener. All listener signatures use Event for compatibility with EventTarget. */
  addEventListener(type: string, listener: (ev: Event) => void): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
}

// ── Error types ───────────────────────────────────────────────────────────

export type HomeAssistantErrorCode =
  /** HA replied auth_invalid */
  | "AUTH_INVALID"
  /** Never received auth_required or auth_ok within the timeout */
  | "AUTH_TIMEOUT"
  /** Operation attempted before authenticate() succeeded */
  | "NOT_AUTHENTICATED"
  /** No result received within requestTimeoutMs */
  | "REQUEST_TIMEOUT"
  /** HA responded with success: false */
  | "REQUEST_FAILED"
  /** Operation attempted on a closed socket */
  | "SOCKET_CLOSED"
  /** Malformed inbound message */
  | "PROTOCOL_ERROR";

export class HomeAssistantError extends Error {
  readonly code: HomeAssistantErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: HomeAssistantErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HomeAssistantError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

// ── Client options ────────────────────────────────────────────────────────

export interface HomeAssistantClientOptions {
  /** The WebSocket-like socket to run the HA protocol over. */
  socket: HomeAssistantSocketLike;
  /** Long-lived HA access token. */
  accessToken: string;
  /**
   * Reject pending requests after this many ms.
   * @default 15_000
   */
  requestTimeoutMs?: number;
  /**
   * Inject a clock for tests.
   * @default Date.now
   */
  clock?: () => number;
  /**
   * Interval at which to send {type:"ping"} and expect {type:"pong"}.
   * Set to 0 to disable. If a ping times out (requestTimeoutMs) the connection
   * is considered dead; close() is called and an error event is dispatched.
   * @default 30_000
   */
  pingIntervalMs?: number;
}

// ── HA domain types ───────────────────────────────────────────────────────

export interface HaEvent {
  event_type: string;
  data: Record<string, unknown>;
  origin: string;
  time_fired: string;
  context: Record<string, unknown>;
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: Record<string, unknown>;
}

// ── Subscription handle ───────────────────────────────────────────────────

export interface SubscriptionHandle {
  /** The HA subscription id (same as the id sent in subscribe_events). */
  readonly id: number;
  /** Send unsubscribe_events and await confirmation. */
  unsubscribe(): Promise<void>;
}
