/**
 * Tracks the two independent monotonic sequence counters for one session:
 *   - outbound (bridge → client): we mint these via nextOut()
 *   - inbound  (client → bridge): we validate these via classifyInbound()
 *
 * Non-integer or ≤ 0 inbound seq values are treated as out_of_order
 * (because the protocol schema requires seq to be an integer ≥ 1, so any
 * value that fails that is semantically a gap / unrecognisable frame).
 */

export type InboundClassification =
  | { kind: "accept"; seq: number }
  | { kind: "duplicate"; seq: number }
  | { kind: "out_of_order"; expected: number; got: number };

export class Sequencer {
  /** Outbound counter — last seq number issued to a b2c frame. Starts at 0; first call to nextOut() returns 1. */
  private outSeq = 0;

  /** Next expected inbound seq. Starts at 1 (first client frame must have seq = 1). */
  private nextInSeq = 1;

  /** Mint the next outbound sequence number. Monotonically increasing from 1. */
  nextOut(): number {
    this.outSeq += 1;
    return this.outSeq;
  }

  /** Peek at the next expected inbound sequence number without mutating state. */
  peekNextIn(): number {
    return this.nextInSeq;
  }

  /**
   * Classify an inbound sequence number.
   * - "accept":       seq === nextInSeq; advances nextInSeq by 1.
   * - "duplicate":    seq < nextInSeq (already seen; caller may re-ack but must not re-deliver).
   * - "out_of_order": seq > nextInSeq, or seq is not a positive integer; state unchanged.
   */
  classifyInbound(seq: number): InboundClassification {
    // Treat non-positive-integer values as out-of-order
    if (!Number.isInteger(seq) || seq <= 0) {
      return { kind: "out_of_order", expected: this.nextInSeq, got: seq };
    }

    if (seq === this.nextInSeq) {
      this.nextInSeq += 1;
      return { kind: "accept", seq };
    }

    if (seq < this.nextInSeq) {
      return { kind: "duplicate", seq };
    }

    // seq > nextInSeq — gap
    return { kind: "out_of_order", expected: this.nextInSeq, got: seq };
  }
}
