import type { BridgeEnvelope } from "@https2wss/protocol";

export interface Transport {
  /**
   * Start receiving frames. Calls onFrame for each delivered frame.
   * Resolves when the stream ends or the AbortSignal fires.
   */
  run(signal: AbortSignal, onFrame: (env: BridgeEnvelope) => void): Promise<void>;

  /** Best-effort stop (transports must also honour the AbortSignal passed to run). */
  stop(): void;
}

export interface TransportContext {
  /** Full receiveUrl (poll endpoint or events endpoint). */
  url: string;
  authToken?: string;
  /** Last seq the client has seen; sent as ?after=N / Last-Event-ID header. */
  startAfter: number;
  fetchImpl: typeof fetch;
}
