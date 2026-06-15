import type { BridgeEnvelope } from "@https2wss/protocol";
import { describe, expect, it } from "vitest";
import { FrameBuffer, type FrameBufferLimits } from "../src/sessions/FrameBuffer.js";

const SID = "h2w_abcdefghijklmnop";

function makeEnvelope(seq: number): BridgeEnvelope {
  return {
    v: 1,
    sid: SID,
    seq,
    kind: "data",
    ts: new Date().toISOString(),
    payload: { opcode: "text", encoding: "utf8", data: `frame-${seq}`, fin: true },
  };
}

const defaultLimits: FrameBufferLimits = {
  maxFrameBytes: 1024,
  maxBufferedFrames: 10,
  maxBufferedBytes: 8192,
  overflowPolicy: "close",
};

describe("FrameBuffer — basic store and since", () => {
  it("stores a frame and since(0) returns it", () => {
    const buf = new FrameBuffer(defaultLimits);
    const env = makeEnvelope(1);
    const result = buf.store(env, 100);
    expect(result.ok).toBe(true);

    const frames = buf.since(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe(env);
  });

  it("since(seq) returns nothing when seq equals the only stored frame's seq", () => {
    const buf = new FrameBuffer(defaultLimits);
    const env = makeEnvelope(1);
    buf.store(env, 100);

    expect(buf.since(1)).toHaveLength(0);
  });

  it("since(after) only returns frames with seq > after", () => {
    const buf = new FrameBuffer(defaultLimits);
    buf.store(makeEnvelope(1), 50);
    buf.store(makeEnvelope(2), 50);
    buf.store(makeEnvelope(3), 50);

    const frames = buf.since(1);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.seq).toBe(2);
    expect(frames[1]?.seq).toBe(3);
  });

  it("since(N) where N >= max stored seq returns empty array", () => {
    const buf = new FrameBuffer(defaultLimits);
    buf.store(makeEnvelope(5), 50);
    expect(buf.since(5)).toHaveLength(0);
    expect(buf.since(99)).toHaveLength(0);
  });

  it("since(after) result is in seq order (same as insertion order)", () => {
    const buf = new FrameBuffer(defaultLimits);
    buf.store(makeEnvelope(1), 10);
    buf.store(makeEnvelope(2), 10);
    buf.store(makeEnvelope(3), 10);

    const frames = buf.since(0);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });
});

describe("FrameBuffer — ack trimming", () => {
  it("ack trims frames with seq <= ack; bufferedFrames and bufferedBytes decrease", () => {
    const buf = new FrameBuffer(defaultLimits);
    buf.store(makeEnvelope(1), 100);
    buf.store(makeEnvelope(2), 100);
    buf.store(makeEnvelope(3), 100);

    buf.ack(2);

    expect(buf.bufferedFrames()).toBe(1);
    expect(buf.bufferedBytes()).toBe(100);
    expect(buf.since(0).map((f) => f.seq)).toEqual([3]);
  });

  it("ack is idempotent — calling twice with the same value is safe", () => {
    const buf = new FrameBuffer(defaultLimits);
    buf.store(makeEnvelope(1), 200);
    buf.ack(1);
    buf.ack(1); // second call — no error, no change
    expect(buf.bufferedFrames()).toBe(0);
    expect(buf.bufferedBytes()).toBe(0);
  });

  it("ack(0) removes nothing", () => {
    const buf = new FrameBuffer(defaultLimits);
    buf.store(makeEnvelope(1), 100);
    buf.ack(0);
    expect(buf.bufferedFrames()).toBe(1);
  });
});

describe("FrameBuffer — overflow policies", () => {
  it("store() returns FRAME_TOO_LARGE when sizeBytes > maxFrameBytes", () => {
    const buf = new FrameBuffer(defaultLimits); // maxFrameBytes = 1024
    const env = makeEnvelope(1);
    const result = buf.store(env, 2000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("FRAME_TOO_LARGE");
    }
    // Frame was NOT stored
    expect(buf.bufferedFrames()).toBe(0);
  });

  it("store() returns BUFFER_OVERFLOW when maxBufferedFrames is exceeded; offending frame not stored", () => {
    const limits: FrameBufferLimits = {
      maxFrameBytes: 1024,
      maxBufferedFrames: 2,
      maxBufferedBytes: 8192,
      overflowPolicy: "close",
    };
    const buf = new FrameBuffer(limits);
    buf.store(makeEnvelope(1), 10);
    buf.store(makeEnvelope(2), 10);

    const result = buf.store(makeEnvelope(3), 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("BUFFER_OVERFLOW");
    }
    // Third frame not stored
    expect(buf.bufferedFrames()).toBe(2);
  });

  it("store() returns BUFFER_OVERFLOW when maxBufferedBytes would be exceeded", () => {
    const limits: FrameBufferLimits = {
      maxFrameBytes: 1024,
      maxBufferedFrames: 100,
      maxBufferedBytes: 250,
      overflowPolicy: "close",
    };
    const buf = new FrameBuffer(limits);
    buf.store(makeEnvelope(1), 100);
    buf.store(makeEnvelope(2), 100);

    // 100+100 = 200 stored; adding 100 more = 300 > 250 → overflow
    const result = buf.store(makeEnvelope(3), 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("BUFFER_OVERFLOW");
    }
    expect(buf.bufferedBytes()).toBe(200);
  });
});

describe("FrameBuffer — bufferedBytes and bufferedFrames", () => {
  it("bufferedBytes and bufferedFrames start at 0", () => {
    const buf = new FrameBuffer(defaultLimits);
    expect(buf.bufferedBytes()).toBe(0);
    expect(buf.bufferedFrames()).toBe(0);
  });

  it("bufferedBytes tracks total byte count correctly across store and ack", () => {
    const buf = new FrameBuffer(defaultLimits);
    buf.store(makeEnvelope(1), 300);
    buf.store(makeEnvelope(2), 500);
    expect(buf.bufferedBytes()).toBe(800);

    buf.ack(1);
    expect(buf.bufferedBytes()).toBe(500);
  });
});
