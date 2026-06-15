import { createHash } from "node:crypto";
import { BridgeError } from "@https2wss/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuth } from "../src/security/auth.js";

function sha256Prefix(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildAuth", () => {
  describe("requireAuth: true", () => {
    it("throws AUTH_REQUIRED when no header is provided", () => {
      const auth = buildAuth({ requireAuth: true, tokens: [] });
      expect(() => auth.verifyAuthorizationHeader(undefined)).toThrow(
        expect.objectContaining({ code: "AUTH_REQUIRED" }),
      );
    });

    it("throws AUTH_INVALID for a non-Bearer scheme ('Token abc')", () => {
      const auth = buildAuth({
        requireAuth: true,
        tokens: [{ value: "secretkey1" }],
      });
      expect(() => auth.verifyAuthorizationHeader("Token abc")).toThrow(
        expect.objectContaining({ code: "AUTH_INVALID" }),
      );
    });

    it("throws AUTH_INVALID for 'Bearer' with no token value", () => {
      const auth = buildAuth({
        requireAuth: true,
        tokens: [{ value: "secretkey1" }],
      });
      expect(() => auth.verifyAuthorizationHeader("Bearer")).toThrow(
        expect.objectContaining({ code: "AUTH_INVALID" }),
      );
    });

    it("throws AUTH_INVALID for 'Bearer ' (trailing space only)", () => {
      const auth = buildAuth({
        requireAuth: true,
        tokens: [{ value: "secretkey1" }],
      });
      expect(() => auth.verifyAuthorizationHeader("Bearer ")).toThrow(
        expect.objectContaining({ code: "AUTH_INVALID" }),
      );
    });

    it("throws AUTH_INVALID for correct scheme but wrong token", () => {
      const auth = buildAuth({
        requireAuth: true,
        tokens: [{ value: "goodtoken1" }],
      });
      expect(() => auth.verifyAuthorizationHeader("Bearer wrongtoken")).toThrow(
        expect.objectContaining({ code: "AUTH_INVALID" }),
      );
    });

    it("returns deterministic tokenId for a correct literal token", () => {
      const raw = "correcttoken123";
      const auth = buildAuth({ requireAuth: true, tokens: [{ value: raw }] });
      const result = auth.verifyAuthorizationHeader(`Bearer ${raw}`);
      expect(result.tokenId).toBe(sha256Prefix(raw));
    });

    it("returns the same tokenId on repeated calls (stable)", () => {
      const raw = "stabletoken123";
      const auth = buildAuth({ requireAuth: true, tokens: [{ value: raw }] });
      const r1 = auth.verifyAuthorizationHeader(`Bearer ${raw}`);
      const r2 = auth.verifyAuthorizationHeader(`Bearer ${raw}`);
      expect(r1.tokenId).toBe(r2.tokenId);
    });

    it("produces different tokenIds for different tokens", () => {
      const raw1 = "firsttoken123";
      const raw2 = "secondtoken12";
      const auth = buildAuth({
        requireAuth: true,
        tokens: [{ value: raw1 }, { value: raw2 }],
      });
      const r1 = auth.verifyAuthorizationHeader(`Bearer ${raw1}`);
      const r2 = auth.verifyAuthorizationHeader(`Bearer ${raw2}`);
      expect(r1.tokenId).not.toBe(r2.tokenId);
    });
  });

  describe("requireAuth: false", () => {
    it("returns tokenId 'anonymous' when no header provided", () => {
      const auth = buildAuth({ requireAuth: false, tokens: [] });
      const result = auth.verifyAuthorizationHeader(undefined);
      expect(result.tokenId).toBe("anonymous");
    });

    it("still throws AUTH_INVALID for a malformed header even if auth not required", () => {
      const auth = buildAuth({ requireAuth: false, tokens: [{ value: "goodtoken1" }] });
      expect(() => auth.verifyAuthorizationHeader("Token abc")).toThrow(
        expect.objectContaining({ code: "AUTH_INVALID" }),
      );
    });

    it("still throws AUTH_INVALID for a wrong token even if auth not required", () => {
      const auth = buildAuth({ requireAuth: false, tokens: [{ value: "goodtoken1" }] });
      expect(() => auth.verifyAuthorizationHeader("Bearer wrongtoken")).toThrow(
        expect.objectContaining({ code: "AUTH_INVALID" }),
      );
    });
  });

  describe("env-based token resolution", () => {
    it("resolves token from env var at construction time", () => {
      const fakeEnv = { MY_TOKEN: "envbasedtoken" };
      const auth = buildAuth({
        requireAuth: true,
        tokens: [{ env: "MY_TOKEN" }],
        env: fakeEnv,
      });
      const result = auth.verifyAuthorizationHeader("Bearer envbasedtoken");
      expect(result.tokenId).toBe(sha256Prefix("envbasedtoken"));
    });

    it("does not throw at construction when env var is missing — only emits warning", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const fakeEnv: NodeJS.ProcessEnv = {};
      expect(() =>
        buildAuth({ requireAuth: true, tokens: [{ env: "MISSING_VAR" }], env: fakeEnv }),
      ).not.toThrow();
      expect(stderrSpy).toHaveBeenCalled();
    });

    it("missing env var causes auth to fail (token never added to set)", () => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const fakeEnv: NodeJS.ProcessEnv = {};
      const auth = buildAuth({ requireAuth: true, tokens: [{ env: "MISSING" }], env: fakeEnv });
      expect(() => auth.verifyAuthorizationHeader("Bearer anything")).toThrow(
        expect.objectContaining({ code: "AUTH_INVALID" }),
      );
    });
  });

  describe("error type", () => {
    it("errors are BridgeError instances", () => {
      const auth = buildAuth({ requireAuth: true, tokens: [] });
      try {
        auth.verifyAuthorizationHeader(undefined);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
      }
    });
  });
});
