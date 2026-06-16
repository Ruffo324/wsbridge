/**
 * ResilientWebSocket — native-first WebSocket with cookie-sticky bridge fallback.
 *
 * Decision flow (§P11b spec):
 *   1. If a valid sticky-fallback cookie is present → bridge immediately.
 *   2. If WebSocket is not available in the environment → bridge immediately (no cookie written).
 *   3. Otherwise attempt native WebSocket:
 *      a. Opens OK → clear fallback cookie, keep native; start heartbeat.
 *      b. Error / close before open, or nativeConnectTimeoutMs elapses → write cookie, switch to bridge.
 *      c. Heartbeat timeout on an already-open socket → write cookie, switch to bridge.
 *
 * Once on bridge, the instance never reverts to native — create a new
 * ResilientWebSocket to re-evaluate (cookie permitting).
 *
 * Security note: the fallback cookie contains only an epoch-ms expiry timestamp —
 * no secrets. SameSite=Lax + Secure (auto-applied on HTTPS) is the recommended
 * security posture. See resilient/cookies.ts for the browser jar implementation.
 */

import type { Https2WssSocketInit } from "./Https2WssSocket.js";
import { Https2WssSocket } from "./Https2WssSocket.js";
import type { CookieJar } from "./resilient/cookies.js";
import {
  defaultCookieJar,
  parseFallbackCookie,
  serializeFallbackCookie,
} from "./resilient/cookies.js";
import { HeartbeatWatchdog } from "./resilient/heartbeat.js";
import type { FallbackReason, ReadyState, Transport } from "./resilient/state.js";
import { CLOSED, CLOSING, CONNECTING, OPEN } from "./resilient/state.js";

// Re-export public types
export type { CookieJar } from "./resilient/cookies.js";
export type { Transport } from "./resilient/state.js";

// ── Public init type ──────────────────────────────────────────────────────

export interface ResilientWebSocketInit {
  /** Bridge fallback configuration. Required. */
  bridge: Https2WssSocketInit;

  /** Max ms to wait for native `open` before declaring failure. Default 4000. */
  nativeConnectTimeoutMs?: number;

  /** Max ms with no inbound traffic before mid-session connection is considered dead. Default 15000. */
  heartbeatTimeoutMs?: number;

  /**
   * Optional alive callback for HA-specific or custom liveness logic.
   * When provided, OVERRIDES the default `lastMsgAgeMs > heartbeatTimeoutMs` rule.
   */
  isAlive?: (lastMsgAgeMs: number) => boolean;

  /** Cookie name for the sticky fallback decision. Default "h2w-fallback". */
  cookieName?: string;

  /** TTL for the sticky-fallback cookie. Default 24 hours. Set to 0 to disable persistence. */
  cookieTtlMs?: number;

  /** Inject a cookie jar for tests / non-browser env. Defaults to `globalThis.document` if available. */
  cookies?: CookieJar;

  /** Inject a clock for tests. Default Date.now. */
  clock?: () => number;

  /** Override WebSocket constructor for tests. Default `globalThis.WebSocket`. */
  webSocketCtor?: typeof WebSocket;
}

// ── HandlerSlot (same pattern as Https2WssSocket) ─────────────────────────

class HandlerSlot<E extends Event = Event> {
  private handler: ((ev: E) => void) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly target: EventTarget,
    private readonly type: string,
  ) {}

  get(): ((ev: E) => void) | null {
    return this.handler;
  }

  set(fn: ((ev: E) => void) | null): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.handler = fn;
    if (fn !== null) {
      this.target.addEventListener(this.type, fn as EventListenerOrEventListenerObject);
      this.unsubscribe = () =>
        this.target.removeEventListener(this.type, fn as EventListenerOrEventListenerObject);
    }
  }
}

// ── Helper ────────────────────────────────────────────────────────────────

function makeCloseEvent(code: number, reason: string): Event {
  if (typeof CloseEvent !== "undefined") {
    return new CloseEvent("close", { code, reason, wasClean: code === 1000 });
  }
  const ev = new Event("close");
  Object.defineProperties(ev, {
    code: { value: code, enumerable: true },
    reason: { value: reason, enumerable: true },
    wasClean: { value: code === 1000, enumerable: true },
  });
  return ev;
}

// ── ResilientWebSocket ────────────────────────────────────────────────────

export class ResilientWebSocket extends EventTarget {
  // Public readonly fields
  readonly url: string;

  private _readyState: ReadyState = CONNECTING;
  private _transport: Transport = "native";
  private _bufferedAmount = 0;

  // Inner socket (native WebSocket or Https2WssSocket)
  private innerSocket: WebSocket | Https2WssSocket | null = null;

  // Pending sends — buffered while no socket is open
  private readonly pendingSends: Array<string | ArrayBufferLike | ArrayBufferView> = [];

  // Config
  private readonly bridgeInit: Https2WssSocketInit;
  private readonly nativeConnectTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly isAliveOverride: ((lastMsgAgeMs: number) => boolean) | undefined;
  private readonly cookieName: string;
  private readonly cookieTtlMs: number;
  private readonly cookieJar: CookieJar | undefined;
  private readonly clock: () => number;
  private readonly webSocketCtor: typeof WebSocket | undefined;

  // Timers
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatWatchdog: HeartbeatWatchdog | null = null;

  // Flag: have we already committed to the fallback path?
  private fallbackCommitted = false;

  // Flag: closed by caller — no further events
  private callerClosed = false;

  // Handler slots
  private readonly openSlot: HandlerSlot<Event>;
  private readonly messageSlot: HandlerSlot<MessageEvent>;
  private readonly errorSlot: HandlerSlot<Event>;
  private readonly closeSlot: HandlerSlot<CloseEvent | Event>;

  constructor(target: string, init: ResilientWebSocketInit) {
    super();
    this.url = target;

    this.bridgeInit = init.bridge;
    this.nativeConnectTimeoutMs = init.nativeConnectTimeoutMs ?? 4000;
    this.heartbeatTimeoutMs = init.heartbeatTimeoutMs ?? 15000;
    this.isAliveOverride = init.isAlive;
    this.cookieName = init.cookieName ?? "h2w-fallback";
    this.cookieTtlMs = init.cookieTtlMs ?? 24 * 60 * 60 * 1000;
    this.clock = init.clock ?? (() => Date.now());
    // Use the explicit webSocketCtor if provided (even if undefined — callers may pass
    // `undefined` explicitly to force the bridge path in tests or environments without WS).
    // Fall back to globalThis.WebSocket only when the property is absent from init.
    this.webSocketCtor =
      "webSocketCtor" in init
        ? init.webSocketCtor
        : typeof WebSocket !== "undefined"
          ? WebSocket
          : undefined;

    // Resolve cookie jar: explicit > browser default > none
    if (init.cookieTtlMs === 0) {
      this.cookieJar = undefined; // persistence disabled
    } else {
      this.cookieJar = init.cookies ?? defaultCookieJar();
    }

    this.openSlot = new HandlerSlot<Event>(this, "open");
    this.messageSlot = new HandlerSlot<MessageEvent>(this, "message");
    this.errorSlot = new HandlerSlot<Event>(this, "error");
    this.closeSlot = new HandlerSlot<CloseEvent | Event>(this, "close");

    // Defer decide() to a macrotask (setTimeout 0) so callers can attach
    // event listeners immediately after construction before any events fire.
    // Note: Promise.resolve().then() (microtask) is insufficient because
    // microtasks flush before the next synchronous statement returns in V8.
    setTimeout(() => {
      this.decide();
    }, 0);
  }

  // ── Public getters ────────────────────────────────────────────────────────

  get readyState(): ReadyState {
    return this._readyState;
  }

  get transport(): Transport {
    return this._transport;
  }

  get bufferedAmount(): number {
    if (this.innerSocket !== null) {
      return this.innerSocket.bufferedAmount;
    }
    return this._bufferedAmount;
  }

  // ── send ──────────────────────────────────────────────────────────────────

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this._readyState === CLOSED || this._readyState === CLOSING) {
      throw new DOMException("WebSocket is not in OPEN state", "InvalidStateError");
    }
    if (this._readyState !== OPEN || this.innerSocket === null) {
      // Buffer while connecting / during transport handoff
      this.pendingSends.push(data);
      return;
    }
    this.innerSocket.send(data as string | ArrayBuffer | ArrayBufferView);
  }

  // ── close ─────────────────────────────────────────────────────────────────

  close(code = 1000, reason = ""): void {
    if (this._readyState === CLOSED || this._readyState === CLOSING) return;
    this.callerClosed = true;
    this._readyState = CLOSING;
    this.cancelTimers();
    if (this.innerSocket !== null) {
      this.innerSocket.close(code, reason);
    } else {
      this._readyState = CLOSED;
      this.dispatchEvent(makeCloseEvent(code, reason));
    }
  }

  // ── Handler properties ────────────────────────────────────────────────────

  get onopen(): ((ev: Event) => void) | null {
    return this.openSlot.get();
  }
  set onopen(fn: ((ev: Event) => void) | null) {
    this.openSlot.set(fn);
  }

  get onmessage(): ((ev: MessageEvent) => void) | null {
    return this.messageSlot.get();
  }
  set onmessage(fn: ((ev: MessageEvent) => void) | null) {
    this.messageSlot.set(fn);
  }

  get onerror(): ((ev: Event) => void) | null {
    return this.errorSlot.get();
  }
  set onerror(fn: ((ev: Event) => void) | null) {
    this.errorSlot.set(fn);
  }

  get onclose(): ((ev: CloseEvent | Event) => void) | null {
    return this.closeSlot.get();
  }
  set onclose(fn: ((ev: CloseEvent | Event) => void) | null) {
    this.closeSlot.set(fn);
  }

  // ── Private — decision logic ──────────────────────────────────────────────

  private decide(): void {
    // Rule 1: sticky cookie present and not expired → go straight to bridge
    if (this.cookieJar !== undefined) {
      const raw = this.cookieJar.get(this.cookieName);
      const until = parseFallbackCookie(raw);
      if (until !== undefined && until > this.clock()) {
        this.emitTransportChange("bridge", "sticky-cookie");
        this.openBridge();
        return;
      }
    }

    // Rule 2: no native WebSocket constructor → go straight to bridge (no cookie)
    if (this.webSocketCtor === undefined) {
      this.emitTransportChange("bridge", "no-native-support");
      this.openBridge();
      return;
    }

    // Rule 3: attempt native
    this.openNative();
  }

  private openNative(): void {
    const Ctor = this.webSocketCtor;
    if (Ctor === undefined) {
      this.triggerFallback("connect-failure");
      return;
    }
    let nativeSocket: WebSocket;
    try {
      nativeSocket = new Ctor(this.url);
    } catch {
      // Construction itself threw (shouldn't happen with a valid ctor, but guard anyway)
      this.triggerFallback("connect-failure");
      return;
    }

    this.innerSocket = nativeSocket;

    // Start connect timer
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this._readyState !== OPEN && !this.callerClosed) {
        this.triggerFallback("connect-failure");
      }
    }, this.nativeConnectTimeoutMs);

    nativeSocket.onopen = () => {
      if (this.callerClosed) return;
      this.cancelConnectTimer();
      this._readyState = OPEN;
      this._transport = "native";

      // Clear any stale fallback cookie
      this.cookieJar?.delete(this.cookieName);

      this.drainPendingSends();
      this.dispatchEvent(new Event("open"));
      this.startHeartbeat(nativeSocket);
    };

    nativeSocket.onerror = () => {
      if (this._readyState === OPEN) {
        // Mid-session error; forward then wait for close
        this.dispatchEvent(new Event("error"));
      } else if (!this.callerClosed) {
        // Pre-open error → trigger fallback
        this.triggerFallback("connect-failure");
      }
    };

    nativeSocket.onclose = (ev: CloseEvent) => {
      if (this.callerClosed) {
        this.cancelTimers();
        this._readyState = CLOSED;
        // Create new event to avoid re-dispatching an already-dispatching event
        this.dispatchEvent(makeCloseEvent(ev.code ?? 1000, ev.reason ?? ""));
        return;
      }
      if (this._readyState !== OPEN) {
        // Closed before open — this is a connect failure
        this.triggerFallback("connect-failure");
        return;
      }
      // Normal mid-session close (not a heartbeat timeout)
      this.cancelTimers();
      this._readyState = CLOSED;
      this.dispatchEvent(makeCloseEvent(ev.code ?? 1000, ev.reason ?? ""));
    };

    nativeSocket.onmessage = (ev: MessageEvent) => {
      this.heartbeatWatchdog?.recordActivity();
      this.dispatchEvent(new MessageEvent("message", { data: ev.data as unknown }));
    };
  }

  private startHeartbeat(nativeSocket: WebSocket): void {
    // Check interval: heartbeatTimeoutMs/3 but not below 100ms (testability) and not above 5000ms.
    const checkIntervalMs = Math.min(5000, Math.max(100, Math.floor(this.heartbeatTimeoutMs / 3)));

    this.heartbeatWatchdog = new HeartbeatWatchdog({
      timeoutMs: this.heartbeatTimeoutMs,
      clock: this.clock,
      isAlive: this.isAliveOverride,
      onDead: () => {
        if (this.callerClosed || this.fallbackCommitted) return;
        // Close native with 1006 (abnormal), then fall back
        try {
          nativeSocket.close(1006, "heartbeat timeout");
        } catch {
          // Socket may already be closing — ignore
        }
        this.triggerFallback("heartbeat-timeout");
      },
    });
    this.heartbeatWatchdog.start();

    this.heartbeatInterval = setInterval(() => {
      this.heartbeatWatchdog?.tick();
    }, checkIntervalMs);
  }

  private triggerFallback(reason: FallbackReason): void {
    if (this.fallbackCommitted) return;
    this.fallbackCommitted = true;

    this.cancelTimers();

    // Detach the native socket's event handlers to prevent duplicate events
    if (this.innerSocket !== null && !(this.innerSocket instanceof Https2WssSocket)) {
      const ws = this.innerSocket as WebSocket;
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.innerSocket = null;
    }

    // Write sticky cookie (except for no-native-support which skips persistence)
    if (reason !== "no-native-support" && this.cookieJar !== undefined && this.cookieTtlMs > 0) {
      const until = this.clock() + this.cookieTtlMs;
      this.cookieJar.set(this.cookieName, serializeFallbackCookie(until), {
        maxAgeMs: this.cookieTtlMs,
        path: "/",
        sameSite: "Lax",
      });
    }

    this.emitTransportChange("bridge", reason);
    this.openBridge();
  }

  private openBridge(): void {
    this._transport = "bridge";
    this._readyState = CONNECTING;

    const bridge = new Https2WssSocket(this.url, this.bridgeInit);
    this.innerSocket = bridge;

    bridge.onopen = () => {
      if (this.callerClosed) return;
      this._readyState = OPEN;
      this.drainPendingSends();
      this.dispatchEvent(new Event("open"));
    };

    bridge.onmessage = (ev: MessageEvent) => {
      this.dispatchEvent(new MessageEvent("message", { data: ev.data as unknown }));
    };

    bridge.onerror = () => {
      this.dispatchEvent(new Event("error"));
    };

    bridge.onclose = (ev: Event) => {
      this.cancelTimers();
      this._readyState = CLOSED;
      // Create a new close event to avoid ERR_EVENT_RECURSION — the incoming ev
      // is still "in dispatch" on the bridge socket's EventTarget.
      const code = (ev as CloseEvent).code ?? 1000;
      const reason = (ev as CloseEvent).reason ?? "";
      this.dispatchEvent(makeCloseEvent(code, reason));
    };
  }

  // ── Private — utilities ───────────────────────────────────────────────────

  private emitTransportChange(to: Transport, reason: FallbackReason): void {
    const from = this._transport;
    this._transport = to;
    this.dispatchEvent(
      new CustomEvent("transport-change", {
        detail: { from, to, reason },
      }),
    );
  }

  private drainPendingSends(): void {
    if (this.innerSocket === null) return;
    const socket = this.innerSocket;
    while (this.pendingSends.length > 0) {
      const item = this.pendingSends.shift();
      if (item === undefined) break;
      try {
        socket.send(item as string | ArrayBuffer | ArrayBufferView);
      } catch {
        // Best-effort; some browsers throw on a non-open socket —
        // re-buffer the item so it isn't silently dropped.
        this.pendingSends.unshift(item);
        break;
      }
    }
  }

  private cancelConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private cancelTimers(): void {
    this.cancelConnectTimer();
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.heartbeatWatchdog?.stop();
    this.heartbeatWatchdog = null;
  }
}
