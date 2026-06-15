import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/envelope.js";
import { BridgeError } from "../src/errors.js";

const BASE_SID = "h2w_abcdefghijklmnop";
const BASE_TS = "2026-06-15T12:00:00.000Z";

function makeEnvelope(overrides: Record<string, unknown>) {
  return {
    v: 1,
    sid: BASE_SID,
    seq: 1,
    ts: BASE_TS,
    ...overrides,
  };
}

describe("schema — valid envelopes", () => {
  it("accepts a data text envelope", () => {
    const env = makeEnvelope({
      kind: "data",
      payload: { opcode: "text", encoding: "utf8", data: "hello", fin: true },
    });
    const parsed = parseEnvelope(env);
    expect(parsed.kind).toBe("data");
    expect(parsed.sid).toBe(BASE_SID);
    expect(parsed.seq).toBe(1);
    if (parsed.kind === "data") {
      expect(parsed.payload.opcode).toBe("text");
      expect(parsed.payload.data).toBe("hello");
    }
  });

  it("accepts a data binary envelope", () => {
    const env = makeEnvelope({
      kind: "data",
      payload: { opcode: "binary", encoding: "base64", data: "AAECAwQ=", fin: true },
    });
    const parsed = parseEnvelope(env);
    expect(parsed.kind).toBe("data");
    if (parsed.kind === "data") {
      expect(parsed.payload.opcode).toBe("binary");
      expect(parsed.payload.encoding).toBe("base64");
    }
  });

  it("accepts a control upstream_open envelope", () => {
    const env = makeEnvelope({
      kind: "control",
      payload: { event: "upstream_open", details: {} },
    });
    const parsed = parseEnvelope(env);
    expect(parsed.kind).toBe("control");
    if (parsed.kind === "control") {
      expect(parsed.payload.event).toBe("upstream_open");
    }
  });

  it("accepts a close envelope", () => {
    const env = makeEnvelope({
      kind: "close",
      payload: { code: 1000, reason: "normal closure", source: "client" },
    });
    const parsed = parseEnvelope(env);
    expect(parsed.kind).toBe("close");
    if (parsed.kind === "close") {
      expect(parsed.payload.code).toBe(1000);
      expect(parsed.payload.source).toBe("client");
    }
  });

  it("accepts an error envelope", () => {
    const env = makeEnvelope({
      kind: "error",
      payload: { code: "UPSTREAM_CONNECT_FAILED", message: "failed", retryable: true },
    });
    const parsed = parseEnvelope(env);
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") {
      expect(parsed.payload.code).toBe("UPSTREAM_CONNECT_FAILED");
      expect(parsed.payload.retryable).toBe(true);
    }
  });

  it("accepts a heartbeat envelope", () => {
    const env = makeEnvelope({ kind: "heartbeat", payload: {} });
    const parsed = parseEnvelope(env);
    expect(parsed.kind).toBe("heartbeat");
  });

  it("accepts optional ack field", () => {
    const env = makeEnvelope({
      kind: "heartbeat",
      payload: {},
      ack: 5,
    });
    const parsed = parseEnvelope(env);
    expect(parsed.ack).toBe(5);
  });
});

describe("schema — version rejection", () => {
  it("rejects envelope with v: 2 with PROTOCOL_VERSION_UNSUPPORTED", () => {
    const env = makeEnvelope({ v: 2, kind: "heartbeat", payload: {} });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
    try {
      parseEnvelope(env);
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      if (err instanceof BridgeError) {
        expect(err.code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
      }
    }
  });
});

describe("schema — missing required fields", () => {
  it("rejects envelope missing sid", () => {
    const { sid: _sid, ...env } = makeEnvelope({ kind: "heartbeat", payload: {} }) as Record<
      string,
      unknown
    >;
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("rejects envelope missing seq", () => {
    const { seq: _seq, ...env } = makeEnvelope({ kind: "heartbeat", payload: {} }) as Record<
      string,
      unknown
    >;
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("rejects envelope missing kind", () => {
    const { kind: _kind, ...env } = makeEnvelope({ kind: "heartbeat", payload: {} }) as Record<
      string,
      unknown
    >;
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("rejects envelope missing ts", () => {
    const { ts: _ts, ...env } = makeEnvelope({ kind: "heartbeat", payload: {} }) as Record<
      string,
      unknown
    >;
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("rejects envelope missing payload", () => {
    const { payload: _payload, ...env } = makeEnvelope({
      kind: "heartbeat",
      payload: {},
    }) as Record<string, unknown>;
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });
});

describe("schema — data frame opcode/encoding rules", () => {
  it("rejects data text with encoding: base64", () => {
    const env = makeEnvelope({
      kind: "data",
      payload: { opcode: "text", encoding: "base64", data: "aGVsbG8=", fin: true },
    });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("rejects data binary with encoding: utf8", () => {
    const env = makeEnvelope({
      kind: "data",
      payload: { opcode: "binary", encoding: "utf8", data: "hello", fin: true },
    });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("accepts data binary with non-base64 data string (schema-level base64 shape only — adapter validates content)", () => {
    const env = makeEnvelope({
      kind: "data",
      payload: { opcode: "binary", encoding: "base64", data: "not-real-base64!!!", fin: true },
    });
    const parsed = parseEnvelope(env);
    expect(parsed.kind).toBe("data");
  });
});

describe("schema — control frame", () => {
  it("rejects control with an unknown event string", () => {
    const env = makeEnvelope({
      kind: "control",
      payload: { event: "totally_unknown_event" },
    });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });
});

describe("schema — close frame", () => {
  it("rejects close with source: alien", () => {
    const env = makeEnvelope({
      kind: "close",
      payload: { code: 1000, reason: "ok", source: "alien" },
    });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });
});

describe("schema — error frame", () => {
  it("rejects error with a code outside the 13 defined codes", () => {
    const env = makeEnvelope({
      kind: "error",
      payload: { code: "MADE_UP_ERROR", message: "oops", retryable: false },
    });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });
});

describe("schema — heartbeat strict object", () => {
  it("rejects heartbeat with extra fields in payload", () => {
    const env = makeEnvelope({
      kind: "heartbeat",
      payload: { extraField: "not allowed" },
    });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });
});

describe("schema — sid pattern", () => {
  it("rejects sid that does not match h2w_ pattern", () => {
    const env = makeEnvelope({ kind: "heartbeat", payload: {}, sid: "invalid-sid" });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("rejects sid shorter than 16 chars after prefix", () => {
    const env = makeEnvelope({ kind: "heartbeat", payload: {}, sid: "h2w_short" });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("accepts sid matching the pattern with exactly 16 chars after prefix", () => {
    const env = makeEnvelope({
      kind: "heartbeat",
      payload: {},
      sid: "h2w_abcdefghijklmnop",
    });
    const parsed = parseEnvelope(env);
    expect(parsed.sid).toBe("h2w_abcdefghijklmnop");
  });
});

describe("schema — seq validation", () => {
  it("rejects seq = 0", () => {
    const env = makeEnvelope({ kind: "heartbeat", payload: {}, seq: 0 });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("rejects seq = -1", () => {
    const env = makeEnvelope({ kind: "heartbeat", payload: {}, seq: -1 });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("rejects seq = 1.5 (non-integer)", () => {
    const env = makeEnvelope({ kind: "heartbeat", payload: {}, seq: 1.5 });
    expect(() => parseEnvelope(env)).toThrowError(BridgeError);
  });

  it("accepts seq = 1", () => {
    const env = makeEnvelope({ kind: "heartbeat", payload: {}, seq: 1 });
    const parsed = parseEnvelope(env);
    expect(parsed.seq).toBe(1);
  });
});
