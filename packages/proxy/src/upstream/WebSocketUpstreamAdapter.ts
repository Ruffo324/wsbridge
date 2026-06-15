import type { BridgeEnvelope } from "@https2wss/protocol";
import { BridgeError, buildEnvelope } from "@https2wss/protocol";
import { WebSocket } from "ws";
import { HeaderPolicy } from "../security/headerPolicy.js";
import { SsrfGuard } from "../security/ssrfGuard.js";
import type { UpstreamAdapter, UpstreamAdapterFactoryInput } from "./UpstreamAdapter.js";

export interface WebSocketUpstreamOptions {
  /** Override the ws constructor (for tests / DI). */
  wsCtor?: typeof WebSocket;
  /** Override the SsrfGuard (for tests). */
  ssrfGuard?: SsrfGuard;
  /** Connect timeout in ms. Default 10_000. */
  connectTimeoutMs?: number;
  /** Optional injectable clock for session.markUpstream*(now) calls. */
  clock?: () => number;
}

type AdapterState = "connecting" | "open" | "closing" | "closed" | "errored";

class WebSocketUpstreamAdapter implements UpstreamAdapter {
  private _state: AdapterState = "connecting";
  private ws: WebSocket | null = null;

  private readonly input: UpstreamAdapterFactoryInput;
  private readonly opts: Required<Pick<WebSocketUpstreamOptions, "connectTimeoutMs" | "clock">> & {
    wsCtor: typeof WebSocket;
    ssrfGuard: SsrfGuard;
  };

  constructor(input: UpstreamAdapterFactoryInput, opts?: WebSocketUpstreamOptions) {
    this.input = input;
    this.opts = {
      wsCtor: opts?.wsCtor ?? WebSocket,
      ssrfGuard:
        opts?.ssrfGuard ??
        new SsrfGuard({ allowPrivateNetwork: input.resolved.allowPrivateNetwork }),
      connectTimeoutMs: opts?.connectTimeoutMs ?? 10_000,
      clock: opts?.clock ?? (() => Date.now()),
    };
  }

  get state(): AdapterState {
    return this._state;
  }

  async connect(): Promise<void> {
    const { session, resolved, clientHeaders } = this.input;
    const now = this.opts.clock;

    // 1. SSRF check — emit error frame before re-throwing
    try {
      await this.opts.ssrfGuard.assertAllowed(resolved.url);
    } catch (err) {
      const bridgeErr =
        err instanceof BridgeError
          ? err
          : new BridgeError("POLICY_DENIED", "SSRF guard error", { cause: err });

      this._state = "errored";
      this.emitErrorFrame(bridgeErr);
      session.markErrored(now());
      throw bridgeErr;
    }

    // 2. Filter headers
    const filtered = new HeaderPolicy({
      allowedHeaders: resolved.allowedHeaders as string[],
    }).filterOutbound(clientHeaders);

    // 3. Connect
    return new Promise<void>((resolve, reject) => {
      const WsCtor = this.opts.wsCtor;
      const ws = new WsCtor(resolved.url.toString(), { headers: filtered });
      this.ws = ws;

      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        ws.removeListener("open", onOpen);
        ws.removeListener("error", onPreOpenError);
      };

      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();

        this._state = "open";
        session.markUpstreamOpen(now());

        // Emit upstream_open control frame
        const envelope = this.buildControlFrame("upstream_open");
        session.emitOutbound(envelope);

        // Register post-open event handlers
        ws.on("message", this.onMessage.bind(this));
        ws.on("error", this.onPostOpenError.bind(this));
        ws.on("close", this.onClose.bind(this));

        resolve();
      };

      const onPreOpenError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();

        this._state = "errored";
        const bridgeErr = new BridgeError("UPSTREAM_CONNECT_FAILED", err.message, {
          retryable: true,
          cause: err,
        });
        this.emitErrorFrame(bridgeErr);
        session.markErrored(now());
        reject(bridgeErr);
      };

      // Timeout
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        ws.terminate();

        this._state = "errored";
        const bridgeErr = new BridgeError("UPSTREAM_CONNECT_FAILED", "upstream connect timed out", {
          retryable: true,
        });
        this.emitErrorFrame(bridgeErr);
        session.markErrored(now());
        reject(bridgeErr);
      }, this.opts.connectTimeoutMs);

      // AbortSignal support
      const { signal } = this.input;
      if (signal !== undefined) {
        if (signal.aborted) {
          if (!settled) {
            settled = true;
            cleanup();
            ws.terminate();
            this._state = "errored";
            const bridgeErr = new BridgeError("UPSTREAM_CONNECT_FAILED", "connection aborted", {
              retryable: false,
            });
            this.emitErrorFrame(bridgeErr);
            session.markErrored(now());
            reject(bridgeErr);
          }
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            if (!settled) {
              settled = true;
              cleanup();
              ws.terminate();
              this._state = "errored";
              const bridgeErr = new BridgeError("UPSTREAM_CONNECT_FAILED", "connection aborted", {
                retryable: false,
              });
              this.emitErrorFrame(bridgeErr);
              session.markErrored(now());
              reject(bridgeErr);
            }
          },
          { once: true },
        );
      }

      ws.on("open", onOpen);
      ws.on("error", onPreOpenError);

      // Handle unexpected-response (HTTP error during handshake) → UPSTREAM_CONNECT_FAILED
      ws.on("unexpected-response", (_req, res) => {
        if (settled) return;
        settled = true;
        cleanup();
        ws.terminate();

        this._state = "errored";
        const bridgeErr = new BridgeError(
          "UPSTREAM_CONNECT_FAILED",
          `upstream returned HTTP ${res.statusCode ?? "unknown"} during handshake`,
          { retryable: false },
        );
        this.emitErrorFrame(bridgeErr);
        session.markErrored(now());
        reject(bridgeErr);
      });
    });
  }

  sendText(data: string): void {
    if (this._state !== "open") {
      throw new BridgeError("UPSTREAM_CLOSED", "upstream not open", { retryable: false });
    }
    this.ws?.send(data);
  }

  sendBinary(data: Uint8Array): void {
    if (this._state !== "open") {
      throw new BridgeError("UPSTREAM_CLOSED", "upstream not open", { retryable: false });
    }
    this.ws?.send(data, { binary: true });
  }

  close(code: number, reason: string): void {
    if (this._state === "closed" || this._state === "errored") {
      return; // idempotent
    }
    this._state = "closing";
    this.ws?.close(code, reason);
  }

  // ── Private event handlers (post-open) ──────────────────────────────────

  private onMessage(data: unknown, isBinary: boolean): void {
    const { session } = this.input;
    let envelope: BridgeEnvelope;

    if (isBinary) {
      // Convert to Buffer for base64 encoding.
      // ws delivers binary messages as Buffer, Buffer[], or ArrayBuffer depending on binaryType.
      // We normalize to a single Buffer before base64-encoding.
      let buf: Buffer;
      if (Buffer.isBuffer(data)) {
        buf = data;
      } else if (data instanceof ArrayBuffer) {
        buf = Buffer.from(new Uint8Array(data));
      } else if (Array.isArray(data)) {
        buf = Buffer.concat(data as Buffer[]);
      } else {
        buf = Buffer.from(data as Uint8Array);
      }
      const b64 = buf.toString("base64");
      envelope = buildEnvelope({
        sid: session.id,
        seq: session.sequencer.nextOut(),
        kind: "data",
        payload: {
          opcode: "binary",
          encoding: "base64",
          data: b64,
          fin: true,
        },
      });
    } else {
      const text = typeof data === "string" ? data : (data?.toString() ?? "");
      envelope = buildEnvelope({
        sid: session.id,
        seq: session.sequencer.nextOut(),
        kind: "data",
        payload: {
          opcode: "text",
          encoding: "utf8",
          data: text,
          fin: true,
        },
      });
    }

    session.emitOutbound(envelope);
  }

  private onPostOpenError(_err: Error): void {
    const { session } = this.input;
    const now = this.opts.clock;

    if (this._state === "errored" || this._state === "closed") return;

    this._state = "errored";
    const bridgeErr = new BridgeError("UPSTREAM_CLOSED", "upstream WebSocket error", {
      retryable: false,
      cause: _err,
    });
    this.emitErrorFrame(bridgeErr);
    session.markErrored(now());
  }

  private onClose(code: number, reasonBuf: Buffer): void {
    const { session } = this.input;
    const now = this.opts.clock;

    if (this._state === "closed") return;

    const reason = reasonBuf.toString("utf8");
    this._state = "closed";

    // Emit close frame with source: "upstream"
    const envelope = buildEnvelope({
      sid: session.id,
      seq: session.sequencer.nextOut(),
      kind: "close",
      payload: {
        code,
        reason,
        source: "upstream",
      },
    });
    session.emitOutbound(envelope);

    // Transition through closing → closed; markClosing is a no-op if already closing.
    session.markClosing(now(), "upstream", code, reason);
    session.markClosed(now(), "upstream", code, reason);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private emitErrorFrame(err: BridgeError): void {
    const { session } = this.input;
    const envelope = buildEnvelope({
      sid: session.id,
      seq: session.sequencer.nextOut(),
      kind: "error",
      payload: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        details: err.details,
      },
    });
    session.emitOutbound(envelope);
  }

  private buildControlFrame(event: "upstream_open"): BridgeEnvelope {
    const { session } = this.input;
    return buildEnvelope({
      sid: session.id,
      seq: session.sequencer.nextOut(),
      kind: "control",
      payload: { event },
    });
  }
}

export function createWebSocketUpstreamAdapter(
  input: UpstreamAdapterFactoryInput,
  opts?: WebSocketUpstreamOptions,
): UpstreamAdapter {
  return new WebSocketUpstreamAdapter(input, opts);
}
