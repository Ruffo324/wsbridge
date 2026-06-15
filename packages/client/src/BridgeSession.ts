/**
 * BridgeSession — low-level session handle (spec §17.1).
 *
 * Close URL derivation: the server response includes a sendUrl
 * (e.g. /v1/sessions/<sid>/send). The close endpoint is on the same base:
 * /v1/sessions/<sid>/close. We derive it by replacing "/send" at the end
 * of the sendUrl. This is reliable because the server always returns the
 * sendUrl in that exact form.
 */

import type {
  BridgeEnvelope,
  BridgeErrorCode,
  BridgeError as IBridgeError,
} from "@https2wss/protocol";
import { BridgeError, buildEnvelope } from "@https2wss/protocol";
import { Emitter } from "./events.js";
import { LongPollTransport } from "./transports/LongPollTransport.js";
import { PollTransport } from "./transports/PollTransport.js";
import { SseTransport } from "./transports/SseTransport.js";
import type { Transport } from "./transports/Transport.js";

export type SessionState = "connecting" | "open" | "closing" | "closed" | "errored";

export interface SessionLimits {
  maxFrameBytes: number;
  maxBufferedFrames: number;
  idleTimeoutMs: number;
}

export interface BridgeSessionInit {
  bridgeUrl: string;
  authToken?: string;
  sessionId: string;
  sendUrl: string;
  receiveUrl: string;
  transport: "poll" | "long_poll" | "sse";
  limits: SessionLimits;
  fetchImpl?: typeof fetch;
}

export class BridgeSession {
  readonly id: string;

  private _state: SessionState = "connecting";
  private readonly init: BridgeSessionInit;
  private readonly fetchImpl: typeof fetch;

  // Event emitters
  private readonly frameEmitter = new Emitter<BridgeEnvelope>();
  private readonly stateEmitter = new Emitter<SessionState>();
  private readonly closeEmitter = new Emitter<{ code: number; reason: string; source: string }>();
  private readonly errorEmitter = new Emitter<IBridgeError | Error>();

  // Sequencing
  private lastReceivedSeq = 0;
  private outboundSeq = 0;

  // Transport
  private readonly transport: Transport;
  private readonly abortController = new AbortController();

  // bufferedAmount tracking: sum of content-length of pending POST bodies
  private _bufferedAmount = 0;

  constructor(init: BridgeSessionInit) {
    this.id = init.sessionId;
    this.init = init;
    this.fetchImpl = init.fetchImpl ?? globalThis.fetch.bind(globalThis);

    // Build absolute URLs if relative
    const receiveUrl = this.toAbsolute(init.receiveUrl);

    const ctx = {
      url: receiveUrl,
      authToken: init.authToken,
      startAfter: 0,
      fetchImpl: this.fetchImpl,
    };

    if (init.transport === "sse") {
      this.transport = new SseTransport(ctx);
    } else if (init.transport === "long_poll") {
      this.transport = new LongPollTransport(ctx);
    } else {
      this.transport = new PollTransport(ctx);
    }

    // Start the transport loop (fire-and-forget; controlled by abortController)
    void this.transport
      .run(this.abortController.signal, (env) => {
        this.handleInboundFrame(env);
      })
      .catch((err: unknown) => {
        if (!this.abortController.signal.aborted) {
          this.errorEmitter.emit(err instanceof Error ? err : new Error(String(err)));
        }
      });
  }

  get state(): SessionState {
    return this._state;
  }

  // ── Overloaded on() for type safety ─────────────────────────────────────

  on(event: "frame", listener: (env: BridgeEnvelope) => void): () => void;
  on(event: "state", listener: (state: SessionState) => void): () => void;
  on(
    event: "close",
    listener: (info: { code: number; reason: string; source: string }) => void,
  ): () => void;
  on(event: "error", listener: (err: IBridgeError | Error) => void): () => void;
  on(
    event: "frame" | "state" | "close" | "error",
    listener:
      | ((env: BridgeEnvelope) => void)
      | ((state: SessionState) => void)
      | ((info: { code: number; reason: string; source: string }) => void)
      | ((err: IBridgeError | Error) => void),
  ): () => void {
    switch (event) {
      case "frame":
        return this.frameEmitter.on(listener as (env: BridgeEnvelope) => void);
      case "state":
        return this.stateEmitter.on(listener as (state: SessionState) => void);
      case "close":
        return this.closeEmitter.on(
          listener as (info: { code: number; reason: string; source: string }) => void,
        );
      case "error":
        return this.errorEmitter.on(listener as (err: IBridgeError | Error) => void);
    }
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  async sendText(data: string): Promise<void> {
    this.outboundSeq++;
    const env = buildEnvelope({
      sid: this.id,
      seq: this.outboundSeq,
      ack: this.lastReceivedSeq,
      kind: "data",
      payload: { opcode: "text", encoding: "utf8", data, fin: true },
    });
    await this.postFrames([env]);
  }

  async sendBinary(data: Uint8Array | ArrayBuffer): Promise<void> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Import here to avoid circular — but this is util only, fine
    const { encodeBase64 } = await import("./util/base64.js");
    const b64 = encodeBase64(bytes);

    this.outboundSeq++;
    const env = buildEnvelope({
      sid: this.id,
      seq: this.outboundSeq,
      ack: this.lastReceivedSeq,
      kind: "data",
      payload: { opcode: "binary", encoding: "base64", data: b64, fin: true },
    });
    await this.postFrames([env]);
  }

  async close(code = 1000, reason = "client requested close"): Promise<void> {
    if (this._state === "closed" || this._state === "closing") {
      return;
    }
    this.setState("closing");

    const closeUrl = this.toAbsolute(this.init.sendUrl.replace(/\/send$/, "/close"));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.init.authToken !== undefined) {
      headers.authorization = `Bearer ${this.init.authToken}`;
    }

    try {
      await this.fetchImpl(closeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ code, reason }),
      });
    } catch {
      // Ignore — server may have already closed
    }

    this.abortController.abort();
    this.setState("closed");
  }

  get bufferedAmount(): number {
    return this._bufferedAmount;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private handleInboundFrame(env: BridgeEnvelope): void {
    // De-duplicate by seq per spec §11
    if (env.seq <= this.lastReceivedSeq) {
      return; // duplicate — ignore
    }
    this.lastReceivedSeq = env.seq;

    switch (env.kind) {
      case "control": {
        const payload = env.payload as { event?: string };
        if (payload.event === "upstream_open") {
          this.setState("open");
        }
        break;
      }
      case "data":
        this.frameEmitter.emit(env);
        break;
      case "error": {
        const payload = env.payload as { code: string; message: string; retryable: boolean };
        const err = new BridgeError(payload.code as BridgeErrorCode, payload.message, {
          retryable: payload.retryable,
        });
        this.errorEmitter.emit(err);
        break;
      }
      case "close": {
        const payload = env.payload as { code: number; reason: string; source: string };
        this.closeEmitter.emit(payload);
        this.abortController.abort();
        this.setState("closed");
        break;
      }
      case "heartbeat":
        // Heartbeat frames are intentionally ignored — they only keep transport alive
        break;
      default:
        // Unknown kinds ignored
        break;
    }
  }

  private setState(newState: SessionState): void {
    if (this._state === newState) return;
    this._state = newState;
    this.stateEmitter.emit(newState);
  }

  private async postFrames(frames: BridgeEnvelope[]): Promise<void> {
    const body = JSON.stringify({ frames });
    const sendUrl = this.toAbsolute(this.init.sendUrl);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.init.authToken !== undefined) {
      headers.authorization = `Bearer ${this.init.authToken}`;
    }

    // Track approximate buffered bytes (length of the JSON body)
    this._bufferedAmount += body.length;

    try {
      const res = await this.fetchImpl(sendUrl, {
        method: "POST",
        headers,
        body,
      });

      if (!res.ok) {
        let errorBody: unknown;
        try {
          errorBody = await res.json();
        } catch {
          errorBody = {};
        }
        const errData = errorBody as { error?: { code?: string; message?: string } };
        const code = errData.error?.code ?? "INTERNAL_ERROR";
        const message = errData.error?.message ?? `POST /send failed: ${res.status}`;
        throw new BridgeError(code as BridgeErrorCode, message);
      }
    } finally {
      this._bufferedAmount = Math.max(0, this._bufferedAmount - body.length);
    }
  }

  /**
   * Convert a server-relative URL (e.g. /v1/sessions/.../send) to an
   * absolute URL using the bridgeUrl base. If the URL is already absolute,
   * returns it unchanged.
   */
  private toAbsolute(url: string): string {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    // Strip trailing slash from base, then prepend
    const base = this.init.bridgeUrl.replace(/\/$/, "");
    return `${base}${url}`;
  }
}
