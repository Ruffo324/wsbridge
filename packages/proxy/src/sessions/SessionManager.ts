import { BridgeError } from "@https2wss/protocol";
import type { FrameBufferLimits } from "./FrameBuffer.js";
import { generateSessionId } from "./ids.js";
import {
  type CloseSource,
  Session,
  type SessionConfig,
  type SessionTransportMode,
} from "./Session.js";

export interface SessionManagerConfig {
  sessionDefaults: Omit<SessionConfig, "id" | "createdAt" | "transportMode" | "upstreamProfile">;
  maxSessionsPerToken: number;
  /** Injectable clock — defaults to Date.now. Tests pass a fake clock. */
  clock?: () => number;
}

export interface CreateSessionInput {
  token: string;
  transportMode: SessionTransportMode;
  upstreamProfile: string;
}

/**
 * Registry and lifecycle owner for all sessions.
 *
 * Design decision: sessions are REMOVED from the registry on close so that
 * memory stays bounded (get() returns undefined after close). Callers that
 * need to observe the final state should listen via session.on() before closing.
 *
 * Token quota is enforced at create() time. Idle and max-duration expiry only
 * fires when tick() is called — P6 wires tick() to a real interval; tests
 * drive time by injecting a fake clock and calling tick() manually.
 */
export class SessionManager {
  private readonly defaults: Omit<
    SessionConfig,
    "id" | "createdAt" | "transportMode" | "upstreamProfile"
  >;
  private readonly maxSessionsPerToken: number;
  private readonly clock: () => number;

  /** Primary registry: sessionId → Session */
  private readonly registry = new Map<string, Session>();

  /** Per-token quota tracking: token → Set<sessionId> */
  private readonly tokenSessions = new Map<string, Set<string>>();

  constructor(cfg: SessionManagerConfig) {
    this.defaults = cfg.sessionDefaults;
    this.maxSessionsPerToken = cfg.maxSessionsPerToken;
    this.clock = cfg.clock ?? (() => Date.now());
  }

  /**
   * Create a new session for the given token.
   * Throws BridgeError(POLICY_DENIED) if the token has reached maxSessionsPerToken.
   */
  create(input: CreateSessionInput): Session {
    const now = this.clock();
    const { token, transportMode, upstreamProfile } = input;

    const existing = this.tokenSessions.get(token);
    if (existing !== undefined && existing.size >= this.maxSessionsPerToken) {
      throw new BridgeError(
        "POLICY_DENIED",
        `Token has reached the maximum of ${this.maxSessionsPerToken} concurrent sessions`,
      );
    }

    const id = generateSessionId();
    const cfg: SessionConfig = {
      ...this.defaults,
      id,
      createdAt: now,
      transportMode,
      upstreamProfile,
    };

    const session = new Session(cfg);
    this.registry.set(id, session);

    if (existing !== undefined) {
      existing.add(id);
    } else {
      this.tokenSessions.set(token, new Set([id]));
    }

    return session;
  }

  /** Look up a session by ID. Returns undefined for unknown or already-closed sessions. */
  get(sessionId: string): Session | undefined {
    return this.registry.get(sessionId);
  }

  /** Return a read-only snapshot of all currently-tracked sessions (for observability). */
  list(): readonly Session[] {
    return Array.from(this.registry.values());
  }

  /**
   * Close a session and remove it from the registry.
   * No-op if the session is not found.
   */
  close(sessionId: string, code: number, reason: string, source: CloseSource): void {
    const session = this.registry.get(sessionId);
    if (session === undefined) {
      return;
    }
    const now = this.clock();
    // Drive through closing → closed in one step (acceptable for manager-initiated closes)
    if (session.state !== "closing" && session.state !== "closed" && session.state !== "errored") {
      session.markClosing(now, source, code, reason);
    }
    session.markClosed(now, source, code, reason);
    this.removeFromRegistry(sessionId);
  }

  /**
   * Inspect all sessions and close any that have exceeded their idle or
   * max-duration limits. Returns the number of sessions closed this tick.
   *
   * P6 wires this to a real setInterval; tests call it manually after
   * advancing the fake clock.
   */
  tick(): number {
    const now = this.clock();
    let closed = 0;

    for (const session of Array.from(this.registry.values())) {
      if (session.state === "closed" || session.state === "errored") {
        // Shouldn't normally be in the registry at this point, but clean up anyway
        this.removeFromRegistry(session.id);
        continue;
      }

      const idleMs = now - session.lastActivityAt;
      const durationMs = now - session.createdAt;

      if (idleMs > this.defaults.idleTimeoutMs || durationMs > this.defaults.maxDurationMs) {
        this.close(session.id, 1001, "session expired", "timeout");
        closed += 1;
      }
    }

    return closed;
  }

  /**
   * Count currently-open (non-closed) sessions for a given token.
   * Sessions removed from the registry are not counted.
   */
  countByToken(token: string): number {
    return this.tokenSessions.get(token)?.size ?? 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private removeFromRegistry(sessionId: string): void {
    this.registry.delete(sessionId);

    // Remove from token quota tracking
    for (const [token, sids] of this.tokenSessions) {
      if (sids.has(sessionId)) {
        sids.delete(sessionId);
        if (sids.size === 0) {
          this.tokenSessions.delete(token);
        }
        break;
      }
    }
  }
}

// Re-export FrameBufferLimits for use in SessionManagerConfig callers
export type { FrameBufferLimits };
