import { describe, expect, it } from "vitest";
import { HeaderPolicy } from "../src/security/headerPolicy.js";

describe("HeaderPolicy", () => {
  describe("filterOutbound", () => {
    it("drops everything when allowedHeaders is empty", () => {
      const policy = new HeaderPolicy({ allowedHeaders: [] });
      const result = policy.filterOutbound({ "content-type": "application/json", accept: "*/*" });
      expect(result).toEqual({});
    });

    it("passes a header that is explicitly allowed", () => {
      const policy = new HeaderPolicy({ allowedHeaders: ["x-custom-header"] });
      const result = policy.filterOutbound({ "x-custom-header": "value123" });
      expect(result).toEqual({ "x-custom-header": "value123" });
    });

    it("preserves authorization when explicitly in allowedHeaders", () => {
      const policy = new HeaderPolicy({ allowedHeaders: ["authorization"] });
      const result = policy.filterOutbound({ authorization: "Bearer token123" });
      expect(result).toEqual({ authorization: "Bearer token123" });
    });

    it("blocks host when not in allowedHeaders (default-blocked)", () => {
      const policy = new HeaderPolicy({ allowedHeaders: ["accept"] });
      const result = policy.filterOutbound({ host: "example.com", accept: "application/json" });
      expect(result).not.toHaveProperty("host");
      expect(result).toHaveProperty("accept");
    });

    it("blocks cookie when not in allowedHeaders", () => {
      const policy = new HeaderPolicy({ allowedHeaders: ["content-type"] });
      const result = policy.filterOutbound({
        cookie: "session=abc",
        "content-type": "text/plain",
      });
      expect(result).not.toHaveProperty("cookie");
      expect(result).toHaveProperty("content-type");
    });

    it("blocks origin when not in allowedHeaders", () => {
      const policy = new HeaderPolicy({ allowedHeaders: [] });
      const result = policy.filterOutbound({ origin: "https://example.com" });
      expect(result).not.toHaveProperty("origin");
    });

    it("blocks x-forwarded-for when not in allowedHeaders", () => {
      const policy = new HeaderPolicy({ allowedHeaders: [] });
      const result = policy.filterOutbound({ "x-forwarded-for": "1.2.3.4" });
      expect(result).not.toHaveProperty("x-forwarded-for");
    });

    it("is case-insensitive on input header keys — uppercase key passes when lowercase in allowlist", () => {
      const policy = new HeaderPolicy({ allowedHeaders: ["x-custom"] });
      const result = policy.filterOutbound({ "X-Custom": "value" });
      // The output key is lowercased
      expect(result).toHaveProperty("x-custom", "value");
    });

    it("drops non-allowed custom headers without throwing", () => {
      const policy = new HeaderPolicy({ allowedHeaders: ["x-allowed"] });
      const result = policy.filterOutbound({ "x-allowed": "yes", "x-not-allowed": "no" });
      expect(result).toEqual({ "x-allowed": "yes" });
    });

    it("allows authorization explicitly even though it is in DEFAULT_BLOCKED", () => {
      const policy = new HeaderPolicy({ allowedHeaders: ["authorization"] });
      const result = policy.filterOutbound({
        authorization: "Bearer tok",
        host: "example.com",
      });
      expect(result).toEqual({ authorization: "Bearer tok" });
      expect(result).not.toHaveProperty("host");
    });

    it("returns an empty object for empty headers input", () => {
      const policy = new HeaderPolicy({ allowedHeaders: ["x-foo"] });
      expect(policy.filterOutbound({})).toEqual({});
    });
  });
});
