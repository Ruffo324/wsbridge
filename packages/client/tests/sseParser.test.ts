import { describe, expect, it } from "vitest";
import { SseParser } from "../src/transports/sseParser.js";

describe("SseParser", () => {
  it("parses a single complete event in one chunk", () => {
    const p = new SseParser();
    const events = p.push("event: frame\ndata: hello\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("frame");
    expect(events[0]?.data).toBe("hello");
  });

  it("parses an event split across two chunks", () => {
    const p = new SseParser();
    const first = p.push("data: hel");
    expect(first).toHaveLength(0);
    const second = p.push("lo\n\n");
    expect(second).toHaveLength(1);
    expect(second[0]?.data).toBe("hello");
  });

  it("parses multiple events in one chunk", () => {
    const p = new SseParser();
    const events = p.push("data: a\n\ndata: b\n\ndata: c\n\n");
    expect(events).toHaveLength(3);
    expect(events[0]?.data).toBe("a");
    expect(events[1]?.data).toBe("b");
    expect(events[2]?.data).toBe("c");
  });

  it("ignores comment lines", () => {
    const p = new SseParser();
    const events = p.push(": this is a comment\ndata: real\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("real");
  });

  it("ignores heartbeat-style comments between events", () => {
    const p = new SseParser();
    const events = p.push("data: first\n\n: heartbeat 2026-06-15T12:00:00Z\n\ndata: second\n\n");
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe("first");
    expect(events[1]?.data).toBe("second");
  });

  it("id persists across events", () => {
    const p = new SseParser();
    const events = p.push("id: 5\ndata: with-id\n\ndata: without-explicit-id\n\n");
    expect(events[0]?.id).toBe("5");
    expect(events[1]?.id).toBe("5"); // id persists
  });

  it("id updates with each new id field", () => {
    const p = new SseParser();
    const events = p.push("id: 1\ndata: a\n\nid: 2\ndata: b\n\n");
    expect(events[0]?.id).toBe("1");
    expect(events[1]?.id).toBe("2");
  });

  it("reads event type correctly", () => {
    const p = new SseParser();
    const events = p.push("event: frame\ndata: payload\n\n");
    expect(events[0]?.event).toBe("frame");
  });

  it("handles \\r\\n line endings", () => {
    const p = new SseParser();
    const events = p.push("data: crlf\r\n\r\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("crlf");
  });

  it("handles lone \\r line endings", () => {
    const p = new SseParser();
    const events = p.push("data: cr\r\r");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("cr");
  });

  it("joins multiple data lines with \\n", () => {
    const p = new SseParser();
    const events = p.push("data: line1\ndata: line2\ndata: line3\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("line1\nline2\nline3");
  });

  it("does not dispatch event when data is empty", () => {
    const p = new SseParser();
    // A blank line with no preceding data should not dispatch
    const events = p.push("\n");
    expect(events).toHaveLength(0);
  });

  it("flush returns no events if no line terminator was seen", () => {
    const p = new SseParser();
    // Push incomplete line — no \n yet
    void p.push("data: incomplete");
    const flushed = p.flush();
    expect(flushed).toHaveLength(0);
  });
});
