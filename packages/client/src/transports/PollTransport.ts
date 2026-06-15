import type { BridgeEnvelope } from "@https2wss/protocol";
import { parseEnvelope } from "@https2wss/protocol";
import { sleep } from "../util/sleep.js";
import type { Transport, TransportContext } from "./Transport.js";

const POLL_DELAY_MS = 200;
const MAX_BACKOFF_MS = 5_000;

interface PollResponse {
  frames: unknown[];
  nextAfter: number;
  state: string;
}

export class PollTransport implements Transport {
  private readonly ctx: TransportContext;
  private abortController: AbortController | undefined;

  constructor(ctx: TransportContext) {
    this.ctx = ctx;
  }

  async run(signal: AbortSignal, onFrame: (env: BridgeEnvelope) => void): Promise<void> {
    let after = this.ctx.startAfter;
    let backoffMs = POLL_DELAY_MS;

    while (!signal.aborted) {
      const url = `${this.ctx.url}?after=${after}&timeoutMs=0`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.ctx.authToken !== undefined) {
        headers.authorization = `Bearer ${this.ctx.authToken}`;
      }

      try {
        const res = await this.ctx.fetchImpl(url, { headers, signal });

        if (!res.ok) {
          // Back off on errors
          await sleep(backoffMs, signal);
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          continue;
        }

        const body = (await res.json()) as PollResponse;
        backoffMs = POLL_DELAY_MS; // reset on success

        for (const raw of body.frames) {
          const env = parseEnvelope(raw);
          onFrame(env);
        }

        after = body.nextAfter;

        // Brief pause before next poll to avoid a tight loop
        await sleep(POLL_DELAY_MS, signal);
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
    this.abortController?.abort();
  }
}
