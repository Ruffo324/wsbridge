/**
 * Unit tests for HA protocol type guards.
 */

import { describe, expect, it } from "vitest";
import {
  isAuthInvalid,
  isAuthOk,
  isAuthRequired,
  isEventMsg,
  isPong,
  isResultMsg,
} from "../src/protocol.js";

describe("isAuthRequired", () => {
  it("returns true for a valid auth_required message", () => {
    expect(isAuthRequired({ type: "auth_required", ha_version: "2024.1.0" })).toBe(true);
  });

  it("returns false for a different type", () => {
    expect(isAuthRequired({ type: "auth_ok", ha_version: "2024.1.0" })).toBe(false);
  });

  it("returns false when ha_version is missing", () => {
    expect(isAuthRequired({ type: "auth_required" })).toBe(false);
  });

  it("is tolerant of extra fields", () => {
    expect(isAuthRequired({ type: "auth_required", ha_version: "2024.1.0", extra: true })).toBe(
      true,
    );
  });

  it("returns false for non-object input", () => {
    expect(isAuthRequired("auth_required")).toBe(false);
    expect(isAuthRequired(null)).toBe(false);
    expect(isAuthRequired(undefined)).toBe(false);
  });
});

describe("isAuthOk", () => {
  it("returns true for a valid auth_ok message", () => {
    expect(isAuthOk({ type: "auth_ok", ha_version: "2024.1.0" })).toBe(true);
  });

  it("returns false for auth_required", () => {
    expect(isAuthOk({ type: "auth_required", ha_version: "2024.1.0" })).toBe(false);
  });

  it("returns false when ha_version is missing", () => {
    expect(isAuthOk({ type: "auth_ok" })).toBe(false);
  });

  it("is tolerant of extra fields", () => {
    expect(isAuthOk({ type: "auth_ok", ha_version: "2024.1.0", bonus: "field" })).toBe(true);
  });
});

describe("isAuthInvalid", () => {
  it("returns true for a valid auth_invalid message", () => {
    expect(isAuthInvalid({ type: "auth_invalid", message: "Token expired" })).toBe(true);
  });

  it("returns false for auth_ok", () => {
    expect(isAuthInvalid({ type: "auth_ok", ha_version: "2024.1.0" })).toBe(false);
  });

  it("returns false when message is missing", () => {
    expect(isAuthInvalid({ type: "auth_invalid" })).toBe(false);
  });

  it("is tolerant of extra fields", () => {
    expect(isAuthInvalid({ type: "auth_invalid", message: "bad token", code: 403 })).toBe(true);
  });
});

describe("isResultMsg", () => {
  it("returns true for a success result", () => {
    expect(isResultMsg({ type: "result", id: 1, success: true, result: null })).toBe(true);
  });

  it("returns true for a failure result with error", () => {
    expect(
      isResultMsg({
        type: "result",
        id: 2,
        success: false,
        result: null,
        error: { code: "not_found", message: "Entity not found" },
      }),
    ).toBe(true);
  });

  it("returns false when id is missing", () => {
    expect(isResultMsg({ type: "result", success: true, result: null })).toBe(false);
  });

  it("returns false when success is missing", () => {
    expect(isResultMsg({ type: "result", id: 1, result: null })).toBe(false);
  });

  it("is tolerant of extra fields", () => {
    expect(
      isResultMsg({ type: "result", id: 3, success: true, result: [], extra_future: "field" }),
    ).toBe(true);
  });
});

describe("isEventMsg", () => {
  const validEvent = {
    type: "event",
    id: 5,
    event: {
      event_type: "state_changed",
      data: {},
      origin: "LOCAL",
      time_fired: "2024-01-01T00:00:00+00:00",
      context: {},
    },
  };

  it("returns true for a valid event message", () => {
    expect(isEventMsg(validEvent)).toBe(true);
  });

  it("returns false when event field is missing", () => {
    expect(isEventMsg({ type: "event", id: 5 })).toBe(false);
  });

  it("returns false for a result message", () => {
    expect(isEventMsg({ type: "result", id: 5, success: true, result: null })).toBe(false);
  });

  it("is tolerant of extra fields at the top level", () => {
    expect(isEventMsg({ ...validEvent, future_field: true })).toBe(true);
  });

  it("returns false for array input", () => {
    expect(isEventMsg([])).toBe(false);
  });
});

describe("isPong", () => {
  it("returns true for a valid pong message", () => {
    expect(isPong({ type: "pong", id: 6 })).toBe(true);
  });

  it("returns false when id is not a number", () => {
    expect(isPong({ type: "pong", id: "6" })).toBe(false);
  });

  it("returns false for a ping message", () => {
    expect(isPong({ type: "ping", id: 6 })).toBe(false);
  });

  it("is tolerant of extra fields", () => {
    expect(isPong({ type: "pong", id: 6, timestamp: Date.now() })).toBe(true);
  });
});
