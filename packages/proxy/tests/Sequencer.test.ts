import { describe, expect, it } from "vitest";
import { Sequencer } from "../src/sessions/Sequencer.js";

describe("Sequencer — outbound", () => {
  it("nextOut() returns 1, 2, 3 in order from a fresh sequencer", () => {
    const s = new Sequencer();
    expect(s.nextOut()).toBe(1);
    expect(s.nextOut()).toBe(2);
    expect(s.nextOut()).toBe(3);
  });

  it("peekNextIn() starts at 1 and does not advance the counter", () => {
    const s = new Sequencer();
    expect(s.peekNextIn()).toBe(1);
    expect(s.peekNextIn()).toBe(1); // idempotent
  });
});

describe("Sequencer — inbound classification", () => {
  it("seq 1 is accepted and advances nextInSeq to 2", () => {
    const s = new Sequencer();
    const result = s.classifyInbound(1);
    expect(result.kind).toBe("accept");
    if (result.kind === "accept") {
      expect(result.seq).toBe(1);
    }
    expect(s.peekNextIn()).toBe(2);
  });

  it("seq 1 then seq 2 are both accepted", () => {
    const s = new Sequencer();
    expect(s.classifyInbound(1).kind).toBe("accept");
    const r2 = s.classifyInbound(2);
    expect(r2.kind).toBe("accept");
    if (r2.kind === "accept") {
      expect(r2.seq).toBe(2);
    }
    expect(s.peekNextIn()).toBe(3);
  });

  it("seq 1 accepted then seq 1 again is duplicate", () => {
    const s = new Sequencer();
    s.classifyInbound(1);
    const r = s.classifyInbound(1);
    expect(r.kind).toBe("duplicate");
    if (r.kind === "duplicate") {
      expect(r.seq).toBe(1);
    }
    // State unchanged: nextInSeq is still 2
    expect(s.peekNextIn()).toBe(2);
  });

  it("seq 5 after seq 1 and 2 are accepted is out-of-order (expected 3, got 5)", () => {
    const s = new Sequencer();
    s.classifyInbound(1);
    s.classifyInbound(2);
    const r = s.classifyInbound(5);
    expect(r.kind).toBe("out_of_order");
    if (r.kind === "out_of_order") {
      expect(r.expected).toBe(3);
      expect(r.got).toBe(5);
    }
    // State unchanged
    expect(s.peekNextIn()).toBe(3);
  });

  it("state does not advance after duplicate", () => {
    const s = new Sequencer();
    s.classifyInbound(1);
    s.classifyInbound(1); // duplicate
    expect(s.peekNextIn()).toBe(2);
  });

  it("state does not advance after out-of-order", () => {
    const s = new Sequencer();
    s.classifyInbound(1);
    s.classifyInbound(5); // out-of-order
    expect(s.peekNextIn()).toBe(2);
  });

  it("non-integer seq is classified as out_of_order", () => {
    const s = new Sequencer();
    const r = s.classifyInbound(1.5);
    expect(r.kind).toBe("out_of_order");
    if (r.kind === "out_of_order") {
      expect(r.expected).toBe(1);
      expect(r.got).toBe(1.5);
    }
    expect(s.peekNextIn()).toBe(1); // state unchanged
  });

  it("seq 0 (not a valid positive integer) is out_of_order", () => {
    const s = new Sequencer();
    const r = s.classifyInbound(0);
    expect(r.kind).toBe("out_of_order");
    expect(s.peekNextIn()).toBe(1); // state unchanged
  });

  it("negative seq is out_of_order", () => {
    const s = new Sequencer();
    const r = s.classifyInbound(-1);
    expect(r.kind).toBe("out_of_order");
    expect(s.peekNextIn()).toBe(1); // state unchanged
  });
});
