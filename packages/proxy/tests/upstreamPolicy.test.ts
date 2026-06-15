import { BridgeError } from "@https2wss/protocol";
import { describe, expect, it } from "vitest";
import type { SecurityConfig } from "../src/config/securityConfig.js";
import { UpstreamPolicy } from "../src/security/upstreamPolicy.js";

type PolicyConfig = SecurityConfig["upstreamPolicy"];

const ECHO_PROFILE: PolicyConfig["allow"][number] = {
  name: "echo",
  adapter: "websocket",
  url: "ws://echo:9001",
  allowedHeaders: ["X-Custom-Token"],
  allowPrivateNetwork: false,
};

const HA_PROFILE: PolicyConfig["allow"][number] = {
  name: "home-assistant-local",
  adapter: "websocket",
  url: "wss://192.168.178.9:8123/api/websocket",
  allowedHeaders: ["Authorization"],
  allowPrivateNetwork: true,
};

function makeCfg(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    default: "deny",
    allow: [ECHO_PROFILE],
    allowDirectUrl: false,
    ...overrides,
  };
}

describe("UpstreamPolicy", () => {
  describe("profile lookup", () => {
    it("resolves a known profile successfully", () => {
      const policy = new UpstreamPolicy(makeCfg());
      const result = policy.resolve({ kind: "profile", name: "echo" });
      expect(result.profileName).toBe("echo");
      expect(result.adapter).toBe("websocket");
      expect(result.url.href).toBe("ws://echo:9001/");
      expect(result.allowPrivateNetwork).toBe(false);
    });

    it("normalises allowedHeaders to lowercase", () => {
      const policy = new UpstreamPolicy(makeCfg());
      const result = policy.resolve({ kind: "profile", name: "echo" });
      expect(result.allowedHeaders).toContain("x-custom-token");
    });

    it("resolves a profile with allowPrivateNetwork: true", () => {
      const policy = new UpstreamPolicy(makeCfg({ allow: [HA_PROFILE] }));
      const result = policy.resolve({ kind: "profile", name: "home-assistant-local" });
      expect(result.allowPrivateNetwork).toBe(true);
      expect(result.allowedHeaders).toContain("authorization");
    });

    it("throws UPSTREAM_NOT_ALLOWED for unknown profile", () => {
      const policy = new UpstreamPolicy(makeCfg());
      expect(() => policy.resolve({ kind: "profile", name: "nonexistent" })).toThrow(
        expect.objectContaining({ code: "UPSTREAM_NOT_ALLOWED" }),
      );
    });
  });

  describe("directUrl", () => {
    it("throws UPSTREAM_NOT_ALLOWED when allowDirectUrl is false", () => {
      const policy = new UpstreamPolicy(makeCfg({ allowDirectUrl: false }));
      expect(() => policy.resolve({ kind: "directUrl", url: "wss://example.com/ws" })).toThrow(
        expect.objectContaining({ code: "UPSTREAM_NOT_ALLOWED" }),
      );
    });

    it("resolves a wss:// direct URL when allowDirectUrl is true", () => {
      const policy = new UpstreamPolicy(makeCfg({ allowDirectUrl: true }));
      const result = policy.resolve({ kind: "directUrl", url: "wss://example.com/ws" });
      expect(result.url.href).toBe("wss://example.com/ws");
      expect(result.allowPrivateNetwork).toBe(false);
      expect(result.allowedHeaders).toHaveLength(0);
      expect(result.profileName).toBe("<direct>");
    });

    it("resolves a ws:// direct URL when allowDirectUrl is true", () => {
      const policy = new UpstreamPolicy(makeCfg({ allowDirectUrl: true }));
      const result = policy.resolve({ kind: "directUrl", url: "ws://echo:9001" });
      expect(result.url.protocol).toBe("ws:");
    });

    it("throws POLICY_DENIED for http:// direct URL even when allowDirectUrl is true", () => {
      const policy = new UpstreamPolicy(makeCfg({ allowDirectUrl: true }));
      expect(() => policy.resolve({ kind: "directUrl", url: "http://example.com" })).toThrow(
        expect.objectContaining({ code: "POLICY_DENIED" }),
      );
    });

    it("throws POLICY_DENIED for https:// direct URL even when allowDirectUrl is true", () => {
      const policy = new UpstreamPolicy(makeCfg({ allowDirectUrl: true }));
      expect(() => policy.resolve({ kind: "directUrl", url: "https://example.com" })).toThrow(
        expect.objectContaining({ code: "POLICY_DENIED" }),
      );
    });
  });

  describe("constructor validation", () => {
    it("throws POLICY_DENIED at construction when a profile URL has non-ws scheme", () => {
      expect(
        () =>
          new UpstreamPolicy(
            makeCfg({
              allow: [
                {
                  name: "bad",
                  adapter: "websocket",
                  url: "https://example.com",
                  allowedHeaders: [],
                  allowPrivateNetwork: false,
                },
              ],
            }),
          ),
      ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    });

    it("throws POLICY_DENIED at construction when a profile URL has http scheme", () => {
      expect(
        () =>
          new UpstreamPolicy(
            makeCfg({
              allow: [
                {
                  name: "bad",
                  adapter: "websocket",
                  url: "http://example.com",
                  allowedHeaders: [],
                  allowPrivateNetwork: false,
                },
              ],
            }),
          ),
      ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    });
  });

  describe("error types", () => {
    it("errors are BridgeError instances", () => {
      const policy = new UpstreamPolicy(makeCfg());
      try {
        policy.resolve({ kind: "profile", name: "unknown" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
      }
    });
  });
});
