import type { ResolvedUpstream } from "../security/upstreamPolicy.js";
import type { Session } from "../sessions/Session.js";

export interface UpstreamAdapter {
  /** Open the upstream connection. Resolves on successful handshake. Throws BridgeError on failure. */
  connect(): Promise<void>;
  /** Send a text payload upstream. Throws if not connected. */
  sendText(data: string): void;
  /** Send a binary payload upstream. The buffer is the raw bytes; the adapter handles framing. */
  sendBinary(data: Uint8Array): void;
  /** Close the upstream. Idempotent. `code` follows WebSocket conventions (1000 normal). */
  close(code: number, reason: string): void;
  /** Current state. */
  readonly state: "connecting" | "open" | "closing" | "closed" | "errored";
}

export interface UpstreamAdapterFactoryInput {
  /** adapter calls session.emitOutbound / session.markUpstream* on lifecycle */
  session: Session;
  /** from UpstreamPolicy */
  resolved: ResolvedUpstream;
  /** client-supplied headers (already lowercased keys) — filter via HeaderPolicy */
  clientHeaders: Record<string, string>;
  signal?: AbortSignal;
}

export type UpstreamAdapterFactory = (input: UpstreamAdapterFactoryInput) => UpstreamAdapter;
