import { describe, expect, it } from "vitest";
import { buildEnvelope, parseEnvelope, validateEnvelope } from "../src/envelope.js";
import { BridgeError } from "../src/errors.js";

const VALID_SID = "h2w_abcdefghijklmnop";
const VALID_TS = "2026-06-15T12:00:00.000Z";

describe("buildEnvelope", () => {
  it("sets v: 1 and a fresh ts automatically", () => {
    const before = Date.now();
    const env = buildEnvelope({
      sid: VALID_SID,
      seq: 1,
      kind: "data",
      payload: { opcode: "text", encoding: "utf8", data: "hello", fin: true },
    });
    const after = Date.now();

    expect(env.v).toBe(1);
    expect(new Date(env.ts).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(env.ts).getTime()).toBeLessThanOrEqual(after);
  });

  it("returns an envelope that round-trips through parseEnvelope", () => {
    const env = buildEnvelope({
      sid: VALID_SID,
      seq: 2,
      kind: "control",
      payload: { event: "upstream_open" },
    });

    const stringified = JSON.stringify(env);
    const reparsed = parseEnvelope(JSON.parse(stringified));
    expect(reparsed.v).toBe(1);
    expect(reparsed.sid).toBe(VALID_SID);
    expect(reparsed.seq).toBe(2);
    expect(reparsed.kind).toBe("control");
  });

  it("returns correct payload fields for a data text frame", () => {
    const env = buildEnvelope({
      sid: VALID_SID,
      seq: 3,
      kind: "data",
      payload: { opcode: "text", encoding: "utf8", data: "world", fin: false },
    });
    if (env.kind === "data") {
      expect(env.payload.opcode).toBe("text");
      expect(env.payload.data).toBe("world");
      expect(env.payload.fin).toBe(false);
    } else {
      expect.fail("expected data kind");
    }
  });

  it("returns correct payload for a heartbeat frame", () => {
    const env = buildEnvelope({ sid: VALID_SID, seq: 4, kind: "heartbeat", payload: {} });
    expect(env.kind).toBe("heartbeat");
  });

  it("propagates optional ack field", () => {
    const env = buildEnvelope({
      sid: VALID_SID,
      seq: 5,
      ack: 3,
      kind: "heartbeat",
      payload: {},
    });
    expect(env.ack).toBe(3);
  });

  it("throws BridgeError(INTERNAL_ERROR) if payload is structurally invalid", () => {
    expect(() =>
      buildEnvelope({
        sid: VALID_SID,
        seq: 1,
        kind: "data",
        payload: { opcode: "text", encoding: "base64", data: "bad", fin: true },
      }),
    ).toThrowError(BridgeError);

    try {
      buildEnvelope({
        sid: VALID_SID,
        seq: 1,
        kind: "data",
        payload: { opcode: "text", encoding: "base64", data: "bad", fin: true },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      if (err instanceof BridgeError) {
        expect(err.code).toBe("INTERNAL_ERROR");
      }
    }
  });
});

describe("parseEnvelope", () => {
  it("parses a known-good JSON-stringified envelope and returns the exact object", () => {
    const raw = {
      v: 1,
      sid: VALID_SID,
      seq: 1,
      ts: VALID_TS,
      kind: "close",
      payload: { code: 1000, reason: "done", source: "client" },
    };
    const parsed = parseEnvelope(raw);
    expect(parsed.v).toBe(1);
    expect(parsed.sid).toBe(VALID_SID);
    expect(parsed.seq).toBe(1);
    expect(parsed.ts).toBe(VALID_TS);
    expect(parsed.kind).toBe("close");
    if (parsed.kind === "close") {
      expect(parsed.payload.code).toBe(1000);
      expect(parsed.payload.reason).toBe("done");
      expect(parsed.payload.source).toBe("client");
    }
  });

  it("throws BridgeError with PROTOCOL_VERSION_UNSUPPORTED for v: 2", () => {
    const raw = { v: 2, sid: VALID_SID, seq: 1, ts: VALID_TS, kind: "heartbeat", payload: {} };
    expect(() => parseEnvelope(raw)).toThrowError(BridgeError);
    try {
      parseEnvelope(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      if (err instanceof BridgeError) {
        expect(err.code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
      }
    }
  });

  it("throws BridgeError with INTERNAL_ERROR for a structurally invalid payload", () => {
    const raw = {
      v: 1,
      sid: VALID_SID,
      seq: 1,
      ts: VALID_TS,
      kind: "control",
      payload: { event: "UNKNOWN_EVENT" },
    };
    expect(() => parseEnvelope(raw)).toThrowError(BridgeError);
    try {
      parseEnvelope(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      if (err instanceof BridgeError) {
        expect(err.code).toBe("INTERNAL_ERROR");
      }
    }
  });

  it("throws BridgeError when parsing a non-object", () => {
    expect(() => parseEnvelope("not an envelope")).toThrowError(BridgeError);
    expect(() => parseEnvelope(null)).toThrowError(BridgeError);
    expect(() => parseEnvelope(42)).toThrowError(BridgeError);
  });
});

describe("validateEnvelope", () => {
  it("returns ok: true with envelope on success", () => {
    const raw = {
      v: 1,
      sid: VALID_SID,
      seq: 1,
      ts: VALID_TS,
      kind: "heartbeat",
      payload: {},
    };
    const result = validateEnvelope(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.kind).toBe("heartbeat");
      expect(result.envelope.sid).toBe(VALID_SID);
    }
  });

  it("returns ok: false with a BridgeError on version mismatch (does not throw)", () => {
    const raw = { v: 99, sid: VALID_SID, seq: 1, ts: VALID_TS, kind: "heartbeat", payload: {} };
    let result: ReturnType<typeof validateEnvelope> | undefined;
    expect(() => {
      result = validateEnvelope(raw);
    }).not.toThrow();
    expect(result).toBeDefined();
    if (result !== undefined && !result.ok) {
      expect(result.error).toBeInstanceOf(BridgeError);
      expect(result.error.code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
    }
  });

  it("returns ok: false with a BridgeError on schema failure (does not throw)", () => {
    const raw = { v: 1, sid: "bad-sid", seq: 1, ts: VALID_TS, kind: "heartbeat", payload: {} };
    let result: ReturnType<typeof validateEnvelope> | undefined;
    expect(() => {
      result = validateEnvelope(raw);
    }).not.toThrow();
    expect(result).toBeDefined();
    if (result !== undefined && !result.ok) {
      expect(result.error).toBeInstanceOf(BridgeError);
      expect(result.error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("returns ok: true for all five kinds correctly", () => {
    const kinds = [
      {
        kind: "data" as const,
        payload: { opcode: "text", encoding: "utf8", data: "x", fin: true },
      },
      { kind: "control" as const, payload: { event: "drain" } },
      { kind: "close" as const, payload: { code: 1001, reason: "go away", source: "bridge" } },
      {
        kind: "error" as const,
        payload: { code: "SESSION_NOT_FOUND", message: "not found", retryable: false },
      },
      { kind: "heartbeat" as const, payload: {} },
    ];

    for (const { kind, payload } of kinds) {
      const raw = { v: 1, sid: VALID_SID, seq: 1, ts: VALID_TS, kind, payload };
      const result = validateEnvelope(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.envelope.kind).toBe(kind);
      }
    }
  });
});
