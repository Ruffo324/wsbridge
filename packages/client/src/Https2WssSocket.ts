/**
 * Https2WssSocket — WebSocket-like surface (spec §17.2).
 *
 * Design notes:
 * - Does NOT claim full native WebSocket compatibility (spec §17.2 explicitly prohibits it).
 * - Extends EventTarget for addEventListener/removeEventListener support.
 * - `onopen`, `onmessage`, `onerror`, `onclose` handler properties are wired to EventTarget
 *   so that assigning a new function replaces the previous one.
 *
 * Node / CloseEvent:
 *   Node 18+ ships `CloseEvent` but earlier versions do not. We detect availability at
 *   runtime. If unavailable we dispatch a plain Event extended with enumerable `code` and
 *   `reason` properties — documented deviation from the browser API.
 */

import type { BridgeEnvelope } from "@https2wss/protocol";
import type { OpenSessionInput } from "./BridgeClient.js";
import { BridgeClient } from "./BridgeClient.js";
import type { BridgeSession } from "./BridgeSession.js";
import { decodeBase64 } from "./util/base64.js";

export interface Https2WssSocketInit {
  bridgeUrl: string;
  authToken?: string;
  upstreamProfile?: string;
  upstreamUrl?: string;
  transport?: "sse" | "long_poll" | "poll";
  fetchImpl?: typeof fetch;
}

// Numeric readyState constants — match WebSocket spec exactly
const CONNECTING = 0 as const;
const OPEN = 1 as const;
const CLOSING = 2 as const;
const CLOSED = 3 as const;

type ReadyState = typeof CONNECTING | typeof OPEN | typeof CLOSING | typeof CLOSED;

/** Tracks one assignable event handler (onopen, onmessage, etc.) */
class HandlerSlot {
  private handler: ((ev: Event) => void) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly target: EventTarget,
    private readonly type: string,
  ) {}

  get(): ((ev: Event) => void) | null {
    return this.handler;
  }

  set(fn: ((ev: Event) => void) | null): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.handler = fn;
    if (fn !== null) {
      this.target.addEventListener(this.type, fn);
      this.unsubscribe = () => this.target.removeEventListener(this.type, fn);
    }
  }
}

/**
 * Build a close-like event. Prefers the native CloseEvent when available;
 * falls back to a plain Event with code/reason added as enumerable properties.
 * (Documented deviation: the fallback does not extend CloseEvent.)
 */
function makeCloseEvent(code: number, reason: string): Event {
  if (typeof CloseEvent !== "undefined") {
    return new CloseEvent("close", { code, reason, wasClean: code === 1000 });
  }
  // Fallback for environments without CloseEvent (older Node)
  const ev = new Event("close");
  Object.defineProperties(ev, {
    code: { value: code, enumerable: true },
    reason: { value: reason, enumerable: true },
    wasClean: { value: code === 1000, enumerable: true },
  });
  return ev;
}

export class Https2WssSocket extends EventTarget {
  readonly url: string;

  private _readyState: ReadyState = CONNECTING;
  private session: BridgeSession | null = null;

  private readonly openSlot: HandlerSlot;
  private readonly messageSlot: HandlerSlot;
  private readonly errorSlot: HandlerSlot;
  private readonly closeSlot: HandlerSlot;

  constructor(target: string, init: Https2WssSocketInit) {
    super();
    this.url = target;

    this.openSlot = new HandlerSlot(this, "open");
    this.messageSlot = new HandlerSlot(this, "message");
    this.errorSlot = new HandlerSlot(this, "error");
    this.closeSlot = new HandlerSlot(this, "close");

    const client = new BridgeClient({
      bridgeUrl: init.bridgeUrl,
      authToken: init.authToken,
      fetchImpl: init.fetchImpl,
    });

    const sessionInput: OpenSessionInput = {
      transport: init.transport,
      upstream: {
        adapter: "websocket",
        profile: init.upstreamProfile,
        url: init.upstreamUrl,
      },
    };

    void client
      .openSession(sessionInput)
      .then((session) => {
        this.session = session;
        this.wireSession(session);
      })
      .catch((err: unknown) => {
        this._readyState = CLOSED;
        this.dispatchEvent(new Event("error"));
        this.dispatchEvent(
          makeCloseEvent(1006, err instanceof Error ? err.message : "connect failed"),
        );
      });
  }

  // ── readyState ────────────────────────────────────────────────────────────

  get readyState(): ReadyState {
    return this._readyState;
  }

  // ── bufferedAmount ────────────────────────────────────────────────────────

  get bufferedAmount(): number {
    return this.session?.bufferedAmount ?? 0;
  }

  // ── send ─────────────────────────────────────────────────────────────────

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this._readyState !== OPEN) {
      throw new DOMException("WebSocket is not in OPEN state", "InvalidStateError");
    }
    if (this.session === null) {
      throw new DOMException("Session not available", "InvalidStateError");
    }

    const sess = this.session;
    if (typeof data === "string") {
      void sess.sendText(data).catch((err: unknown) => {
        this.dispatchEvent(new Event("error"));
        void this.handleClose(1006, err instanceof Error ? err.message : "send error");
      });
    } else {
      // ArrayBuffer or ArrayBufferView → coerce to Uint8Array
      const buf = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      void sess.sendBinary(buf).catch((err: unknown) => {
        this.dispatchEvent(new Event("error"));
        void this.handleClose(1006, err instanceof Error ? err.message : "send error");
      });
    }
  }

  // ── close ─────────────────────────────────────────────────────────────────

  close(code = 1000, reason = ""): void {
    if (this._readyState === CLOSED || this._readyState === CLOSING) {
      return;
    }
    this._readyState = CLOSING;
    void this.session
      ?.close(code, reason)
      .then(() => {
        this._readyState = CLOSED;
        this.dispatchEvent(makeCloseEvent(code, reason));
      })
      .catch(() => {
        this._readyState = CLOSED;
        this.dispatchEvent(makeCloseEvent(code, reason));
      });
  }

  // ── Handler properties ────────────────────────────────────────────────────

  get onopen(): ((ev: Event) => void) | null {
    return this.openSlot.get();
  }
  set onopen(fn: ((ev: Event) => void) | null) {
    this.openSlot.set(fn);
  }

  get onmessage(): ((ev: MessageEvent) => void) | null {
    return this.messageSlot.get() as ((ev: MessageEvent) => void) | null;
  }
  set onmessage(fn: ((ev: MessageEvent) => void) | null) {
    this.messageSlot.set(fn as ((ev: Event) => void) | null);
  }

  get onerror(): ((ev: Event) => void) | null {
    return this.errorSlot.get();
  }
  set onerror(fn: ((ev: Event) => void) | null) {
    this.errorSlot.set(fn);
  }

  get onclose(): ((ev: Event) => void) | null {
    return this.closeSlot.get();
  }
  set onclose(fn: ((ev: Event) => void) | null) {
    this.closeSlot.set(fn);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private wireSession(session: BridgeSession): void {
    session.on("state", (state) => {
      if (state === "open") {
        this._readyState = OPEN;
        this.dispatchEvent(new Event("open"));
      } else if (state === "closed" || state === "errored") {
        void this.handleClose(1000, "");
      }
    });

    session.on("frame", (env: BridgeEnvelope) => {
      this.handleDataFrame(env);
    });

    session.on("close", (info) => {
      void this.handleClose(info.code, info.reason);
    });

    session.on("error", () => {
      this.dispatchEvent(new Event("error"));
    });
  }

  private handleDataFrame(env: BridgeEnvelope): void {
    const payload = env.payload as {
      opcode: "text" | "binary";
      encoding: "utf8" | "base64";
      data: string;
    };

    let messageData: string | ArrayBuffer;
    if (payload.opcode === "text") {
      messageData = payload.data;
    } else {
      // Binary: decode base64 → ArrayBuffer
      // decodeBase64 always produces a Uint8Array backed by a plain ArrayBuffer.
      const bytes = decodeBase64(payload.data);
      // TypeScript types Uint8Array.buffer as ArrayBuffer | SharedArrayBuffer; cast is safe
      // because our pure-JS decodeBase64 always allocates a regular ArrayBuffer.
      const rawBuf = bytes.buffer as ArrayBuffer;
      messageData = rawBuf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    this.dispatchEvent(new MessageEvent("message", { data: messageData }));
  }

  private async handleClose(code: number, reason: string): Promise<void> {
    if (this._readyState === CLOSED) return;
    this._readyState = CLOSED;
    this.dispatchEvent(makeCloseEvent(code, reason));
  }
}
