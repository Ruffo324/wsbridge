/**
 * SSE transport using fetch + ReadableStream (no EventSource dependency).
 * Works in browsers and Node 18+.
 *
 * Reconnect strategy: on disconnect or error, wait with exponential backoff
 * (100ms initial, doubling, capped at 5 s). Each reconnect sends the latest
 * seen seq as `Last-Event-ID` so the server can resume the stream.
 * Reconnect attempts are unbounded for MVP.
 */

import type { BridgeEnvelope } from "@https2wss/protocol";
import { parseEnvelope } from "@https2wss/protocol";
import { sleep } from "../util/sleep.js";
import { SseParser } from "./sseParser.js";
import type { Transport, TransportContext } from "./Transport.js";

const MAX_BACKOFF_MS = 5_000;

export class SseTransport implements Transport {
  private readonly ctx: TransportContext;

  constructor(ctx: TransportContext) {
    this.ctx = ctx;
  }

  async run(signal: AbortSignal, onFrame: (env: BridgeEnvelope) => void): Promise<void> {
    let lastSeq = this.ctx.startAfter;
    let backoffMs = 100;

    while (!signal.aborted) {
      try {
        await this.openStream(signal, lastSeq, onFrame, (seq) => {
          lastSeq = seq;
        });
        // If openStream returns normally, the stream ended cleanly
        backoffMs = 100;
      } catch (_err) {
        if (signal.aborted) {
          break;
        }
        // On error, back off before reconnecting
        await sleep(backoffMs, signal).catch(() => {});
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }

      if (signal.aborted) {
        break;
      }

      // Brief delay before reconnect even on clean stream end
      await sleep(backoffMs, signal).catch(() => {});
    }
  }

  private async openStream(
    signal: AbortSignal,
    startAfter: number,
    onFrame: (env: BridgeEnvelope) => void,
    onSeq: (seq: number) => void,
  ): Promise<void> {
    const url = `${this.ctx.url}?after=${startAfter}`;
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      "last-event-id": String(startAfter),
    };
    if (this.ctx.authToken !== undefined) {
      headers.authorization = `Bearer ${this.ctx.authToken}`;
    }

    const res = await this.ctx.fetchImpl(url, { headers, signal });

    if (!res.ok) {
      throw new Error(`SSE request failed with status ${res.status}`);
    }

    const body = res.body;
    if (body === null) {
      throw new Error("SSE response body is null");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        const text = decoder.decode(value, { stream: true });
        const events = parser.push(text);

        for (const ev of events) {
          if (ev.event === "frame") {
            try {
              const raw: unknown = JSON.parse(ev.data);
              const env = parseEnvelope(raw);
              onFrame(env);
            } catch {
              // Malformed frame — skip and continue
            }
          }

          // Track the latest seq from the SSE id field for reconnect
          if (ev.id !== undefined) {
            const parsed = Number(ev.id);
            if (!Number.isNaN(parsed)) {
              onSeq(parsed);
            }
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  stop(): void {
    // The AbortSignal passed to run() controls shutdown
  }
}
