export type SessionState = "connecting" | "open" | "closing" | "closed" | "errored";

export interface SessionInfo {
  sessionId: string;
  state: SessionState;
  createdAt: string;
  lastActivityAt: string;
  transportMode: "poll" | "long_poll" | "sse";
  upstream: { adapter: string; state: SessionState };
}

export interface DataPayload {
  opcode: "text" | "binary";
  encoding: "utf8" | "base64";
  data: string;
  fin: boolean;
}

export interface ControlPayload {
  event: "upstream_open" | "upstream_close" | "client_ready" | "transport_ready" | "drain";
  details?: Record<string, unknown>;
}

export interface ClosePayload {
  code: number;
  reason: string;
  source: "client" | "bridge" | "upstream" | "timeout" | "policy";
}

export interface ErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type HeartbeatPayload = Record<string, never>;

export type BridgePayload =
  | DataPayload
  | ControlPayload
  | ClosePayload
  | ErrorPayload
  | HeartbeatPayload;

export interface BridgeEnvelope {
  v: 1;
  sid: string;
  seq: number;
  ack?: number;
  kind: "data" | "control" | "error" | "close" | "heartbeat";
  ts: string;
  payload: BridgePayload;
}

export type BridgeEnvelopeInput = Omit<BridgeEnvelope, "v" | "ts">;
