/**
 * HomeAssistantClient — implements the Home Assistant WebSocket protocol on
 * top of any WebSocket-like transport (native WebSocket, Https2WssSocket,
 * or ResilientWebSocket).
 *
 * Auth flow:
 *   1. If socket is CONNECTING, wait for "open".
 *   2. Wait for {type:"auth_required"}.
 *   3. Send {type:"auth", access_token}.
 *   4. Wait for {type:"auth_ok"} or {type:"auth_invalid"}.
 *   5. Resolve with {ha_version} or reject with HomeAssistantError.
 *
 * If the socket closes before auth_ok, the auth promise rejects with
 * code "AUTH_TIMEOUT" (chosen because the failure is from the server's
 * perspective — the session was lost before auth completed; not a protocol
 * violation from the client's perspective).
 *
 * Ping interval:
 *   When pingIntervalMs > 0 (default 30 000), the client sends periodic
 *   {type:"ping"} messages. If a ping times out (requestTimeoutMs elapsed
 *   with no pong), close() is called and a synthetic "error" event is
 *   dispatched on the underlying socket reference — callers can observe
 *   this as the client going silent.
 *
 * Unknown inbound message types:
 *   Logged via console.debug and ignored. The client never crashes on
 *   future HA protocol additions.
 *
 * TODO(future): subscribeTrigger — HA supports trigger-based subscriptions
 *   (type:"subscribe_trigger") which differ from subscribe_events. Tracked
 *   as a future enhancement.
 *
 * TODO(future): reconnect helper — if the transport is a ResilientWebSocket
 *   HA may re-send auth_required after reconnect. Consider a reconnectAuth()
 *   method or a "auth_required" event that callers can listen to for
 *   re-authentication on transport-level reconnects.
 */

import {
  isAuthInvalid,
  isAuthOk,
  isAuthRequired,
  isEventMsg,
  isPong,
  isResultMsg,
} from "./protocol.js";
import type {
  HaEvent,
  HaState,
  HomeAssistantClientOptions,
  HomeAssistantSocketLike,
  SubscriptionHandle,
} from "./types.js";
import { HomeAssistantError } from "./types.js";

// ── Internal pending-request record ──────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: HomeAssistantError) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ── HomeAssistantClient ───────────────────────────────────────────────────

export class HomeAssistantClient {
  // ── Config ──────────────────────────────────────────────────────────────
  private readonly socket: HomeAssistantSocketLike;
  private readonly accessToken: string;
  private readonly requestTimeoutMs: number;
  private readonly clock: () => number;
  private readonly pingIntervalMs: number;

  // ── Monotonic ID counter (starts at 1) ──────────────────────────────────
  private nextId = 1;

  // ── Auth state ──────────────────────────────────────────────────────────
  private _authenticated = false;
  private _haVersion: string | undefined;
  private authPromise: Promise<{ ha_version: string }> | null = null;

  /**
   * Buffer for the first auth_required message, in case it arrives before
   * authenticate() is called (e.g. when the socket is already open at construction).
   * Only ever stores the most recent auth_required until authenticate() reads it.
   */
  private bufferedAuthRequired: { ha_version: string } | null = null;

  // ── Pending result-based requests (id → PendingRequest) ─────────────────
  private readonly pending = new Map<number, PendingRequest>();

  // ── Active event subscriptions (subscriptionId → handler) ───────────────
  private readonly subscriptions = new Map<number, (ev: HaEvent) => void>();

  // ── Ping state ──────────────────────────────────────────────────────────
  private pingIntervalHandle: ReturnType<typeof setInterval> | null = null;

  // ── Closed flag ─────────────────────────────────────────────────────────
  private closed = false;

  /**
   * Reference to the in-flight auth-close listener so that close() can
   * remove it before dispatching a close event (prevents unhandled rejections
   * when close() is called while authentication is still in progress).
   */
  private authCloseListenerRef: ((ev: Event) => void) | null = null;

  // ── Bound message listener (kept for removeEventListener) ───────────────
  private readonly messageListener: (ev: Event) => void;
  private readonly closeListener: (ev: Event) => void;

  constructor(opts: HomeAssistantClientOptions) {
    this.socket = opts.socket;
    this.accessToken = opts.accessToken;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.clock = opts.clock ?? (() => Date.now());
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000;

    this.messageListener = (ev: Event) => {
      this.handleMessage(ev as MessageEvent);
    };
    this.closeListener = () => {
      this.handleSocketClose();
    };

    this.socket.addEventListener("message", this.messageListener);
    this.socket.addEventListener("close", this.closeListener);
  }

  // ── Public getters ───────────────────────────────────────────────────────

  get authenticated(): boolean {
    return this._authenticated;
  }

  get haVersion(): string | undefined {
    return this._haVersion;
  }

  // ── authenticate() ───────────────────────────────────────────────────────

  /**
   * Wait for the socket to open and complete the HA auth handshake.
   * Resolves on auth_ok; rejects on auth_invalid or socket close.
   * Safe to call multiple times — returns the same in-flight promise.
   */
  authenticate(): Promise<{ ha_version: string }> {
    if (this.authPromise !== null) {
      return this.authPromise;
    }

    this.authPromise = this.runAuthHandshake();
    return this.authPromise;
  }

  private runAuthHandshake(): Promise<{ ha_version: string }> {
    return new Promise<{ ha_version: string }>((resolve, reject) => {
      if (this.closed) {
        reject(new HomeAssistantError("SOCKET_CLOSED", "Socket is closed"));
        return;
      }

      // We need to drive a small state machine via the message listener.
      // The shared message listener (handleMessage) is already attached, but
      // auth messages arrive before we're authenticated, so we handle them
      // via a dedicated one-shot auth message handler registered here.
      // We detach it as soon as auth completes or fails.

      let authDone = false;

      // If auth_required arrived before authenticate() was called (e.g. socket
      // was already open when the client was constructed), start in the
      // waiting_auth_result phase and send auth immediately.
      const hadBufferedAuthRequired = this.bufferedAuthRequired !== null;
      this.bufferedAuthRequired = null; // consume the buffer

      let authPhase: "waiting_open" | "waiting_auth_required" | "waiting_auth_result";
      if (hadBufferedAuthRequired) {
        authPhase = "waiting_auth_result";
        this.socket.send(JSON.stringify({ type: "auth", access_token: this.accessToken }));
      } else if (this.socket.readyState === 1) {
        authPhase = "waiting_auth_required";
      } else {
        authPhase = "waiting_open";
      }

      const done = (result: { ha_version: string } | HomeAssistantError) => {
        if (authDone) return;
        authDone = true;
        this.authCloseListenerRef = null;
        this.socket.removeEventListener("message", authMsgListener);
        this.socket.removeEventListener("open", openListener);
        this.socket.removeEventListener("close", authCloseListener);

        if (result instanceof HomeAssistantError) {
          reject(result);
        } else {
          this._authenticated = true;
          this._haVersion = result.ha_version;
          // Start ping interval after successful auth
          if (this.pingIntervalMs > 0) {
            this.startPingInterval();
          }
          resolve(result);
        }
      };

      const authMsgListener = (ev: Event) => {
        const msgEv = ev as MessageEvent;
        let parsed: unknown;
        try {
          parsed = JSON.parse(msgEv.data as string) as unknown;
        } catch {
          done(
            new HomeAssistantError("PROTOCOL_ERROR", "Failed to parse JSON during auth handshake"),
          );
          return;
        }

        if (authPhase === "waiting_auth_required") {
          if (isAuthRequired(parsed)) {
            authPhase = "waiting_auth_result";
            this.socket.send(JSON.stringify({ type: "auth", access_token: this.accessToken }));
          } else {
            done(
              new HomeAssistantError(
                "PROTOCOL_ERROR",
                `Expected auth_required, got: ${String((parsed as Record<string, unknown>)["type"] ?? "unknown")}`,
              ),
            );
          }
        } else if (authPhase === "waiting_auth_result") {
          if (isAuthOk(parsed)) {
            done({ ha_version: parsed.ha_version });
          } else if (isAuthInvalid(parsed)) {
            done(
              new HomeAssistantError("AUTH_INVALID", parsed.message, {
                message: parsed.message,
              }),
            );
          } else {
            done(
              new HomeAssistantError(
                "PROTOCOL_ERROR",
                `Expected auth_ok or auth_invalid, got: ${String((parsed as Record<string, unknown>)["type"] ?? "unknown")}`,
              ),
            );
          }
        }
      };

      const openListener = () => {
        authPhase = "waiting_auth_required";
      };

      const authCloseListener = () => {
        done(
          new HomeAssistantError("AUTH_TIMEOUT", "Socket closed before authentication completed"),
        );
      };

      // Store reference so close() can remove it before triggering socket close,
      // preventing unhandled rejections when close() is called during auth.
      this.authCloseListenerRef = authCloseListener;

      this.socket.addEventListener("message", authMsgListener);
      this.socket.addEventListener("open", openListener);
      this.socket.addEventListener("close", authCloseListener);
    });
  }

  // ── subscribeEvents() ────────────────────────────────────────────────────

  /**
   * Subscribe to HA events.
   * @param handler Invoked for each matching event.
   * @param eventType If omitted, subscribes to all events.
   */
  async subscribeEvents(
    handler: (ev: HaEvent) => void,
    eventType?: string,
  ): Promise<SubscriptionHandle> {
    this.requireAuthenticated();

    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, type: "subscribe_events" };
    if (eventType !== undefined) {
      msg["event_type"] = eventType;
    }

    await this.sendAndWait(id, msg);

    // Subscription confirmed — register the handler
    this.subscriptions.set(id, handler);

    const self = this;
    return {
      id,
      async unsubscribe(): Promise<void> {
        const unsubId = self.nextId++;
        await self.sendAndWait(unsubId, {
          id: unsubId,
          type: "unsubscribe_events",
          subscription: id,
        });
        self.subscriptions.delete(id);
      },
    };
  }

  // ── callService() ────────────────────────────────────────────────────────

  async callService(
    domain: string,
    service: string,
    options?: {
      serviceData?: Record<string, unknown>;
      target?: {
        entity_id?: string | string[];
        device_id?: string | string[];
        area_id?: string | string[];
      };
      returnResponse?: boolean;
    },
  ): Promise<unknown> {
    this.requireAuthenticated();

    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, type: "call_service", domain, service };
    if (options?.serviceData !== undefined) {
      msg["service_data"] = options.serviceData;
    }
    if (options?.target !== undefined) {
      msg["target"] = options.target;
    }
    if (options?.returnResponse !== undefined) {
      msg["return_response"] = options.returnResponse;
    }

    return this.sendAndWait(id, msg);
  }

  // ── getStates() ──────────────────────────────────────────────────────────

  async getStates(): Promise<HaState[]> {
    this.requireAuthenticated();
    const id = this.nextId++;
    const result = await this.sendAndWait(id, { id, type: "get_states" });
    return result as HaState[];
  }

  // ── getConfig() ──────────────────────────────────────────────────────────

  async getConfig(): Promise<Record<string, unknown>> {
    this.requireAuthenticated();
    const id = this.nextId++;
    const result = await this.sendAndWait(id, { id, type: "get_config" });
    return result as Record<string, unknown>;
  }

  // ── getServices() ────────────────────────────────────────────────────────

  async getServices(): Promise<Record<string, unknown>> {
    this.requireAuthenticated();
    const id = this.nextId++;
    const result = await this.sendAndWait(id, { id, type: "get_services" });
    return result as Record<string, unknown>;
  }

  // ── ping() ───────────────────────────────────────────────────────────────

  /**
   * Send an explicit ping and resolve on pong.
   * Returns the RTT in milliseconds (measured via the injected clock).
   *
   * The ping uses the same pending-request map as other requests with a
   * dedicated "pong" lookup in handleMessage. The clock injection makes
   * RTT deterministic in tests.
   */
  ping(): Promise<number> {
    if (this.closed) {
      return Promise.reject(new HomeAssistantError("SOCKET_CLOSED", "Socket is closed"));
    }

    const id = this.nextId++;
    const sentAt = this.clock();

    return new Promise<number>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        reject(new HomeAssistantError("REQUEST_TIMEOUT", `Ping ${id} timed out`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: () => {
          resolve(this.clock() - sentAt);
        },
        reject,
        timeoutHandle,
      });

      this.socket.send(JSON.stringify({ id, type: "ping" }));
    });
  }

  // ── close() ──────────────────────────────────────────────────────────────

  /**
   * Close the underlying socket and reject all pending requests with SOCKET_CLOSED.
   * Active subscriptions are dropped (no further deliveries).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPingInterval();
    this.socket.removeEventListener("message", this.messageListener);
    this.socket.removeEventListener("close", this.closeListener);
    // Remove the auth-close listener before closing to prevent spurious AUTH_TIMEOUT
    // rejections when close() is called while authentication is still in progress.
    if (this.authCloseListenerRef !== null) {
      this.socket.removeEventListener("close", this.authCloseListenerRef);
      this.authCloseListenerRef = null;
    }
    this.rejectAllPending("SOCKET_CLOSED", "Client closed");
    this.subscriptions.clear();
    try {
      this.socket.close();
    } catch {
      // Best-effort; socket may already be closed
    }
  }

  // ── Private — message dispatch ───────────────────────────────────────────

  private handleMessage(ev: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data as string) as unknown;
    } catch {
      // Malformed JSON — log and ignore; do NOT close the connection
      console.debug("[HomeAssistantClient] Failed to parse inbound message:", ev.data);
      return;
    }

    if (isResultMsg(parsed)) {
      this.handleResult(parsed);
    } else if (isEventMsg(parsed)) {
      this.handleEvent(parsed);
    } else if (isPong(parsed)) {
      this.handlePong(parsed);
    } else if (isAuthRequired(parsed)) {
      if (!this._authenticated) {
        // Buffer auth_required so authenticate() can replay it even if it was
        // received before authenticate() was called (e.g. socket already open).
        this.bufferedAuthRequired = { ha_version: parsed.ha_version };
      } else {
        // After auth, auth_required means HA restarted. Log + ignore.
        // TODO(future): Emit an event so callers can re-authenticate on HA restart.
        console.debug(
          "[HomeAssistantClient] Received auth_required after authentication (HA restart?)",
        );
      }
    } else if (isAuthOk(parsed) || isAuthInvalid(parsed)) {
      // These are driven by the auth-listener during the handshake.
      // If they arrive outside of that context, log and ignore.
      console.debug(
        "[HomeAssistantClient] Received auth message outside of handshake:",
        (parsed as unknown as { type: string })["type"],
      );
    } else {
      // Unknown message type — log and ignore for forward compatibility
      console.debug(
        "[HomeAssistantClient] Unknown message type:",
        (parsed as Record<string, unknown>)?.["type"] ?? "unknown",
      );
    }
  }

  private handleResult(msg: {
    id: number;
    success: boolean;
    result: unknown;
    error?: { code: string; message: string };
  }): void {
    const req = this.pending.get(msg.id);
    if (req === undefined) {
      console.debug("[HomeAssistantClient] Received result for unknown id:", msg.id);
      return;
    }
    clearTimeout(req.timeoutHandle);
    this.pending.delete(msg.id);

    if (msg.success) {
      req.resolve(msg.result);
    } else {
      const errCode = msg.error?.code ?? "unknown";
      const errMsg = msg.error?.message ?? "Request failed";
      req.reject(
        new HomeAssistantError("REQUEST_FAILED", errMsg, {
          ha_code: errCode,
          ha_message: errMsg,
        }),
      );
    }
  }

  private handleEvent(msg: {
    id: number;
    event: {
      event_type: string;
      data: Record<string, unknown>;
      origin: string;
      time_fired: string;
      context: Record<string, unknown>;
    };
  }): void {
    const handler = this.subscriptions.get(msg.id);
    if (handler === undefined) {
      return; // Subscription already removed
    }
    handler({
      event_type: msg.event.event_type,
      data: msg.event.data,
      origin: msg.event.origin,
      time_fired: msg.event.time_fired,
      context: msg.event.context,
    });
  }

  private handlePong(msg: { id: number }): void {
    const req = this.pending.get(msg.id);
    if (req === undefined) {
      return;
    }
    clearTimeout(req.timeoutHandle);
    this.pending.delete(msg.id);
    req.resolve(undefined);
  }

  private handleSocketClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPingInterval();
    this.rejectAllPending("SOCKET_CLOSED", "Socket closed unexpectedly");
    this.subscriptions.clear();
  }

  // ── Private — helpers ────────────────────────────────────────────────────

  private requireAuthenticated(): void {
    if (this.closed) {
      throw new HomeAssistantError("SOCKET_CLOSED", "Socket is closed");
    }
    if (!this._authenticated) {
      throw new HomeAssistantError(
        "NOT_AUTHENTICATED",
        "Call authenticate() before using the client",
      );
    }
  }

  private sendAndWait(id: number, msg: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new HomeAssistantError("SOCKET_CLOSED", "Socket is closed"));
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        reject(new HomeAssistantError("REQUEST_TIMEOUT", `Request ${id} timed out`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeoutHandle });
      this.socket.send(JSON.stringify(msg));
    });
  }

  private rejectAllPending(code: "SOCKET_CLOSED" | "REQUEST_TIMEOUT", message: string): void {
    for (const [, req] of this.pending) {
      clearTimeout(req.timeoutHandle);
      req.reject(new HomeAssistantError(code, message));
    }
    this.pending.clear();
  }

  private startPingInterval(): void {
    if (this.pingIntervalHandle !== null) return;
    this.pingIntervalHandle = setInterval(() => {
      if (this.closed) {
        this.stopPingInterval();
        return;
      }
      this.ping().catch(() => {
        // Ping timed out — treat as dead connection
        if (!this.closed) {
          this.close();
        }
      });
    }, this.pingIntervalMs);
  }

  private stopPingInterval(): void {
    if (this.pingIntervalHandle !== null) {
      clearInterval(this.pingIntervalHandle);
      this.pingIntervalHandle = null;
    }
  }
}
