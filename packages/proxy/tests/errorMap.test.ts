import { BridgeError, type BridgeErrorCode } from "@https2wss/protocol";
import { describe, expect, it } from "vitest";
import { errorToHttp } from "../src/transports/errorMap.js";

const EXPECTED: Array<[BridgeErrorCode, number]> = [
  ["PROTOCOL_VERSION_UNSUPPORTED", 400],
  ["AUTH_REQUIRED", 401],
  ["AUTH_INVALID", 401],
  ["POLICY_DENIED", 403],
  ["UPSTREAM_NOT_ALLOWED", 403],
  ["UPSTREAM_CONNECT_FAILED", 502],
  ["UPSTREAM_CLOSED", 410],
  ["SESSION_NOT_FOUND", 404],
  ["SESSION_CLOSED", 410],
  ["FRAME_TOO_LARGE", 413],
  ["BUFFER_OVERFLOW", 507],
  ["SEQUENCE_OUT_OF_ORDER", 409],
  ["TRANSPORT_TIMEOUT", 504],
  ["INTERNAL_ERROR", 500],
];

describe("errorToHttp", () => {
  it.each(EXPECTED)("maps BridgeError(%s) → HTTP %d", (code, expectedStatus) => {
    const err = new BridgeError(code, "test message");
    const { status, body } = errorToHttp(err);
    expect(status).toBe(expectedStatus);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe("test message");
  });

  it("maps unknown error → 500 INTERNAL_ERROR with safe message", () => {
    const err = new Error("secret database password is xyz");
    const { status, body } = errorToHttp(err);
    expect(status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("internal error");
    // Must NOT leak the original message
    expect(body.error.message).not.toContain("secret");
  });

  it("passes BridgeError details into body.details", () => {
    const err = new BridgeError("POLICY_DENIED", "denied", {
      details: { reason: "ssrf", address: "127.0.0.1" },
    });
    const { body } = errorToHttp(err);
    expect(body.error.details).toEqual({ reason: "ssrf", address: "127.0.0.1" });
  });

  it("omits details key when BridgeError has no details", () => {
    const err = new BridgeError("SESSION_NOT_FOUND", "not found");
    const { body } = errorToHttp(err);
    expect(body.error.details).toBeUndefined();
  });

  it("carries retryable flag from BridgeError", () => {
    const retryable = new BridgeError("UPSTREAM_CONNECT_FAILED", "connect failed");
    expect(errorToHttp(retryable).body.error.retryable).toBe(true);
    const notRetryable = new BridgeError("AUTH_INVALID", "bad token");
    expect(errorToHttp(notRetryable).body.error.retryable).toBe(false);
  });
});
