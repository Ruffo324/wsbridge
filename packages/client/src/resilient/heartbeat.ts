/**
 * Heartbeat watchdog — tiny, unit-testable class that tracks the last-seen
 * message timestamp and fires a callback when liveness is lost.
 *
 * Usage:
 *   const hb = new HeartbeatWatchdog({ timeoutMs, clock, onDead });
 *   hb.start();
 *   // call hb.recordActivity() on every inbound message
 *   // call hb.tick() on every periodic check (interval managed externally)
 *   hb.stop();
 */

export interface HeartbeatOptions {
  /** How long (ms) without inbound traffic before declaring dead. */
  timeoutMs: number;
  /** Injected clock — defaults to Date.now. */
  clock?: () => number;
  /** Custom liveness predicate. When provided, overrides the default age check. */
  isAlive?: (lastMsgAgeMs: number) => boolean;
  /** Called at most once when the watchdog detects a dead connection. */
  onDead: () => void;
}

export class HeartbeatWatchdog {
  private readonly timeoutMs: number;
  private readonly clock: () => number;
  private readonly isAliveOverride: ((lastMsgAgeMs: number) => boolean) | undefined;
  private readonly onDead: () => void;

  private lastActivityAt: number;
  private dead = false;
  private started = false;

  constructor(opts: HeartbeatOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.clock = opts.clock ?? (() => Date.now());
    this.isAliveOverride = opts.isAlive;
    this.onDead = opts.onDead;
    this.lastActivityAt = this.clock();
  }

  /** Mark the watchdog as started and reset the activity timestamp. */
  start(): void {
    this.lastActivityAt = this.clock();
    this.dead = false;
    this.started = true;
  }

  /** Record an inbound message — resets the timeout deadline. */
  recordActivity(): void {
    this.lastActivityAt = this.clock();
  }

  /**
   * Run a single liveness check.  Call this from an external setInterval.
   * Invokes `onDead` at most once; subsequent ticks after death are no-ops.
   */
  tick(): void {
    if (!this.started || this.dead) return;
    const age = this.clock() - this.lastActivityAt;
    const alive = this.isAliveOverride != null ? this.isAliveOverride(age) : age <= this.timeoutMs;
    if (!alive) {
      this.dead = true;
      this.onDead();
    }
  }

  /** Stop the watchdog — `onDead` will never fire after this. */
  stop(): void {
    this.dead = true;
    this.started = false;
  }

  /** Whether `onDead` has already been called. */
  get isDead(): boolean {
    return this.dead;
  }
}
