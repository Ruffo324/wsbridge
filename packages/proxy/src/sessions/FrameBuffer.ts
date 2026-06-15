import type { BridgeEnvelope } from "@https2wss/protocol";

export interface FrameBufferLimits {
  /** Maximum size (bytes) for a single frame. Frames exceeding this are rejected before storage. */
  maxFrameBytes: number;
  /** Maximum number of frames that may be buffered at once. */
  maxBufferedFrames: number;
  /** Maximum total buffered bytes across all stored frames. */
  maxBufferedBytes: number;
  /** MVP only supports "close": overflow terminates the session. */
  overflowPolicy: "close";
}

interface StoredFrame {
  seq: number;
  envelope: BridgeEnvelope;
  sizeBytes: number;
}

export type StoreResult =
  | { ok: true }
  | { ok: false; reason: "BUFFER_OVERFLOW" | "FRAME_TOO_LARGE" };

/**
 * Bounded outbound (bridge → client) replay buffer.
 *
 * Frames are stored in insertion order, which is monotonically increasing
 * by seq (since outbound seq is always minted by Sequencer.nextOut()).
 * A linear scan is sufficient for bounded arrays.
 */
export class FrameBuffer {
  private readonly limits: FrameBufferLimits;
  private frames: StoredFrame[] = [];
  private totalBytes = 0;

  constructor(limits: FrameBufferLimits) {
    this.limits = limits;
  }

  /**
   * Store an outbound frame.
   * Returns ok=true on success.
   * Returns ok=false with FRAME_TOO_LARGE if sizeBytes > maxFrameBytes.
   * Returns ok=false with BUFFER_OVERFLOW if adding the frame would exceed
   * maxBufferedFrames or maxBufferedBytes. The offending frame is NOT stored.
   */
  store(envelope: BridgeEnvelope, sizeBytes: number): StoreResult {
    if (sizeBytes > this.limits.maxFrameBytes) {
      return { ok: false, reason: "FRAME_TOO_LARGE" };
    }

    if (this.frames.length >= this.limits.maxBufferedFrames) {
      return { ok: false, reason: "BUFFER_OVERFLOW" };
    }

    if (this.totalBytes + sizeBytes > this.limits.maxBufferedBytes) {
      return { ok: false, reason: "BUFFER_OVERFLOW" };
    }

    this.frames.push({ seq: envelope.seq, envelope, sizeBytes });
    this.totalBytes += sizeBytes;
    return { ok: true };
  }

  /**
   * Return all stored frames with seq > after, in seq order.
   * since(0) returns everything. since(N) where N ≥ max stored seq returns [].
   */
  since(after: number): BridgeEnvelope[] {
    const result: BridgeEnvelope[] = [];
    for (const frame of this.frames) {
      if (frame.seq > after) {
        result.push(frame.envelope);
      }
    }
    return result;
  }

  /**
   * Trim all stored frames with seq ≤ ack (client-acknowledged).
   * Idempotent: calling twice with the same ack is safe.
   */
  ack(ack: number): void {
    const remaining: StoredFrame[] = [];
    let removedBytes = 0;
    for (const frame of this.frames) {
      if (frame.seq <= ack) {
        removedBytes += frame.sizeBytes;
      } else {
        remaining.push(frame);
      }
    }
    this.frames = remaining;
    this.totalBytes -= removedBytes;
  }

  /** Approximate total buffered bytes. */
  bufferedBytes(): number {
    return this.totalBytes;
  }

  /** Number of frames currently stored in the buffer. */
  bufferedFrames(): number {
    return this.frames.length;
  }
}
