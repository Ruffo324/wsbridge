import type { BridgeEnvelope } from "@https2wss/protocol";
import { parseEnvelope } from "@https2wss/protocol";
import { sleep } from "../util/sleep.js";
import type { Transport, TransportContext } from "./Transport.js";

const LONG_POLL_TIMEOUT_MS = 25_000;
const MAX_BACKOFF_MS = 5_000;

interface PollResponse {
  frames: unknown[];
  nextAfter: number;
  state: string;
}

export class LongPollTransport implements Transport {
  private readonly ctx: TransportContext;

  constructor(ctx: TransportContext) {
    this.ctx = ctx;
  }

  async run(signal: AbortSignal, onFrame: (env: BridgeEnvelope) => void): Promise<void> {
    let after = this.ctx.startAfter;
    let backoffMs = 100;

    while (!signal.aborted) {
      const url = `${this.ctx.url}?after=${after}&timeoutMs=${LONG_POLL_TIMEOUT_MS}`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.ctx.authToken !== undefined) {
        headers.authorization = `Bearer ${this.ctx.authToken}`;
      }

      try {
        const res = await this.ctx.fetchImpl(url, { headers, signal });

        if (!res.ok) {
          await sleep(backoffMs, signal);
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          continue;
        }

        const body = (await res.json()) as PollResponse;
        backoffMs = 100; // reset on success

        for (const raw of body.frames) {
          const env = parseEnvelope(raw);
          onFrame(env);
        }

        after = body.nextAfter;
        // Immediately re-poll — long poll completes either on data or timeout
      } catch (_err) {
        if (signal.aborted) {
          break;
        }
        await sleep(backoffMs, signal).catch(() => {});
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  stop(): void {
    // The AbortSignal passed to run() controls shutdown
  }
}
