import { BridgeError } from "@https2wss/protocol";
import { describe, expect, it } from "vitest";
import { CorsPolicy } from "../src/security/cors.js";

describe("CorsPolicy", () => {
  describe("constructor", () => {
    it("throws POLICY_DENIED when wildcard + credentials are combined", () => {
      expect(() => new CorsPolicy({ allowedOrigins: ["*"], allowCredentials: true })).toThrow(
        expect.objectContaining({ code: "POLICY_DENIED" }),
      );
    });

    it("does not throw when wildcard is used without credentials", () => {
      expect(
        () => new CorsPolicy({ allowedOrigins: ["*"], allowCredentials: false }),
      ).not.toThrow();
    });

    it("does not throw for a normal exact-origin config with credentials", () => {
      expect(
        () =>
          new CorsPolicy({
            allowedOrigins: ["https://app.example.com"],
            allowCredentials: true,
          }),
      ).not.toThrow();
    });
  });

  describe("isAllowed", () => {
    it("returns true for a known allowed origin", () => {
      const policy = new CorsPolicy({
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: false,
      });
      expect(policy.isAllowed("https://app.example.com")).toBe(true);
    });

    it("returns false for an unlisted origin", () => {
      const policy = new CorsPolicy({
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: false,
      });
      expect(policy.isAllowed("https://evil.example.com")).toBe(false);
    });

    it("returns false for null origin when allowedOrigins is non-empty", () => {
      const policy = new CorsPolicy({
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: false,
      });
      expect(policy.isAllowed(null)).toBe(false);
    });

    it("returns false for undefined origin when allowedOrigins is non-empty", () => {
      const policy = new CorsPolicy({
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: false,
      });
      expect(policy.isAllowed(undefined)).toBe(false);
    });

    it("returns true for null origin in open mode (empty allowedOrigins, no credentials)", () => {
      const policy = new CorsPolicy({ allowedOrigins: [], allowCredentials: false });
      expect(policy.isAllowed(null)).toBe(true);
    });

    it("returns true for any non-null origin in wildcard mode", () => {
      const policy = new CorsPolicy({ allowedOrigins: ["*"], allowCredentials: false });
      expect(policy.isAllowed("https://any.example.com")).toBe(true);
      expect(policy.isAllowed("http://localhost:3000")).toBe(true);
    });

    it("treats empty string origin same as null", () => {
      const policy = new CorsPolicy({ allowedOrigins: [], allowCredentials: false });
      expect(policy.isAllowed("")).toBe(true);
    });
  });

  describe("buildResponseHeaders", () => {
    it("returns echoed origin and Vary for allowed origin", () => {
      const policy = new CorsPolicy({
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: false,
      });
      const headers = policy.buildResponseHeaders("https://app.example.com");
      expect(headers).toMatchObject({
        "access-control-allow-origin": "https://app.example.com",
        vary: "Origin",
      });
    });

    it("returns empty headers for disallowed origin", () => {
      const policy = new CorsPolicy({
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: false,
      });
      const headers = policy.buildResponseHeaders("https://evil.example.com");
      expect(headers).toEqual({});
    });

    it("includes Access-Control-Allow-Credentials when allowCredentials: true", () => {
      const policy = new CorsPolicy({
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: true,
      });
      const headers = policy.buildResponseHeaders("https://app.example.com");
      expect(headers["access-control-allow-credentials"]).toBe("true");
    });

    it("omits Access-Control-Allow-Credentials when allowCredentials: false", () => {
      const policy = new CorsPolicy({
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: false,
      });
      const headers = policy.buildResponseHeaders("https://app.example.com");
      expect(headers).not.toHaveProperty("access-control-allow-credentials");
    });

    it("echoes specific origin even in wildcard mode (never returns *)", () => {
      const policy = new CorsPolicy({ allowedOrigins: ["*"], allowCredentials: false });
      const headers = policy.buildResponseHeaders("https://specific.example.com");
      expect(headers["access-control-allow-origin"]).toBe("https://specific.example.com");
      expect(headers["access-control-allow-origin"]).not.toBe("*");
    });

    it("returns empty headers for null origin when origins configured", () => {
      const policy = new CorsPolicy({
        allowedOrigins: ["https://app.example.com"],
        allowCredentials: false,
      });
      expect(policy.buildResponseHeaders(null)).toEqual({});
    });
  });

  describe("error type", () => {
    it("constructor error is a BridgeError", () => {
      try {
        new CorsPolicy({ allowedOrigins: ["*"], allowCredentials: true });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
      }
    });
  });
});
