import type { BridgeEnvelope, SessionState } from "@https2wss/protocol";
import { FrameBuffer, type FrameBufferLimits } from "./FrameBuffer.js";
import { Sequencer } from "./Sequencer.js";

export type SessionTransportMode = "poll" | "long_poll" | "sse";

/** Matches ClosePayload.source from the protocol types — defined locally to avoid importing the full payload type. */
export type CloseSource = "client" | "bridge" | "upstream" | "timeout" | "policy";

export interface SessionConfig {
  id: string;
  transportMode: SessionTransportMode;
  upstreamProfile: string;
  idleTimeoutMs: number;
  maxDurationMs: number;
  frameBuffer: FrameBufferLimits;
  /** Epoch ms — caller injects so tests can use a fake clock. */
  createdAt: number;
}

export interface SessionInfoSnapshot {
  sessionId: string;
  state: SessionState;
  createdAt: string;
  lastActivityAt: string;
  transportMode: SessionTransportMode;
  upstream: { adapter: string; state: SessionState };
}

export type SessionEvent =
  | { type: "state_changed"; state: SessionState }
  | { type: "outbound_frame"; envelope: BridgeEnvelope }
  | { type: "closed"; code: number; reason: string; source: CloseSource };

/**
 * Per-session state container.
 *
 * Lifecycle (illegal transitions are no-ops returning false):
 *   connecting → open       (markUpstreamOpen)
 *   connecting → closing    (markClosing)
 *   connecting → errored    (markErrored)
 *   open       → closing    (markClosing)
 *   open       → errored    (markErrored)
 *   closing    → closed     (markClosed)
 *   errored    → closed     (markClosed)
 *   closed     → (terminal)
 *
 * Timers are NOT owned here — SessionManager owns them and calls tick()
 * which keeps tests fully deterministic via an injectable clock.
 */
export class Session {
  readonly id: string;
  readonly transportMode: SessionTransportMode;
  readonly upstreamProfile: string;
  readonly createdAt: number;

  state: SessionState = "connecting";
  lastActivityAt: number;
  sequencer: Sequencer;
  buffer: FrameBuffer;
  upstreamState: SessionState = "connecting";

  private readonly handlers: Set<(ev: SessionEvent) => void> = new Set();

  constructor(cfg: SessionConfig) {
    this.id = cfg.id;
    this.transportMode = cfg.transportMode;
    this.upstreamProfile = cfg.upstreamProfile;
    this.createdAt = cfg.createdAt;
    this.lastActivityAt = cfg.createdAt;
    this.sequencer = new Sequencer();
    this.buffer = new FrameBuffer(cfg.frameBuffer);
  }

  /** Record incoming activity — updates lastActivityAt for idle detection. */
  touch(now: number): void {
    this.lastActivityAt = now;
  }

  /**
   * Upstream is open: transition connecting → open.
   * For MVP, also flips the overall session state to open.
   * Returns false (no-op) if the current state is not "connecting".
   */
  markUpstreamOpen(now: number): boolean {
    if (this.state !== "connecting") {
      return false;
    }
    this.upstreamState = "open";
    this.touch(now);
    this.applyTransition("open");
    return true;
  }

  /**
   * Begin closing: connecting|open → closing.
   * Returns false (no-op) for any other source state.
   */
  markClosing(now: number, source: CloseSource, code: number, reason: string): boolean {
    if (this.state !== "connecting" && this.state !== "open") {
      return false;
    }
    this.touch(now);
    this.applyTransition("closing");
    // Store close metadata so markClosed can emit it; kept inline via a field on the
    // closure — SessionManager immediately follows up with markClosed in the close flow.
    void source;
    void code;
    void reason;
    return true;
  }

  /**
   * Terminal: closing|errored → closed.
   * Emits both state_changed and closed events.
   * Returns false (no-op) if the current state is neither "closing" nor "errored".
   */
  markClosed(now: number, source: CloseSource, code: number, reason: string): boolean {
    if (this.state !== "closing" && this.state !== "errored") {
      return false;
    }
    this.touch(now);
    this.applyTransition("closed");
    this.emit({ type: "closed", code, reason, source });
    return true;
  }

  /**
   * Enter errored state: connecting|open → errored.
   * Returns false for any other source state.
   */
  markErrored(now: number): boolean {
    if (this.state !== "connecting" && this.state !== "open") {
      return false;
    }
    this.touch(now);
    this.applyTransition("errored");
    return true;
  }

  /**
   * Subscribe to session events. Returns an unsubscribe function.
   */
  on(handler: (ev: SessionEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Emit an outbound frame event (called by the upstream adapter / transport layer).
   * @internal
   */
  emitOutbound(envelope: BridgeEnvelope): void {
    this.emit({ type: "outbound_frame", envelope });
  }

  toSnapshot(now: number): SessionInfoSnapshot {
    void now; // reserved for future relative-time fields
    return {
      sessionId: this.id,
      state: this.state,
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      transportMode: this.transportMode,
      upstream: {
        adapter: this.upstreamProfile,
        state: this.upstreamState,
      },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private applyTransition(next: SessionState): void {
    this.state = next;
    this.emit({ type: "state_changed", state: next });
  }

  private emit(ev: SessionEvent): void {
    for (const handler of this.handlers) {
      handler(ev);
    }
  }
}
