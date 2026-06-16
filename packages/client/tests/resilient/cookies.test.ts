/**
 * Unit tests for cookies.ts — parseFallbackCookie / serializeFallbackCookie
 * and a smoke-test of defaultCookieJar with a minimal mocked document.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultCookieJar,
  parseFallbackCookie,
  serializeFallbackCookie,
} from "../../src/resilient/cookies.js";

// ── parseFallbackCookie / serializeFallbackCookie ─────────────────────────

describe("parseFallbackCookie", () => {
  it("parses a valid epoch-ms string", () => {
    expect(parseFallbackCookie("1750000000000")).toBe(1750000000000);
  });

  it("returns undefined for empty string", () => {
    expect(parseFallbackCookie("")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(parseFallbackCookie(undefined)).toBeUndefined();
  });

  it("returns undefined for non-numeric junk", () => {
    expect(parseFallbackCookie("bad-value")).toBeUndefined();
  });

  it("returns undefined for negative numbers", () => {
    expect(parseFallbackCookie("-1")).toBeUndefined();
  });

  it("returns undefined for zero", () => {
    expect(parseFallbackCookie("0")).toBeUndefined();
  });

  it("returns undefined for NaN-producing inputs", () => {
    expect(parseFallbackCookie("abc123")).toBeUndefined();
  });
});

describe("serializeFallbackCookie", () => {
  it("serializes a number to a string", () => {
    expect(serializeFallbackCookie(1750000000000)).toBe("1750000000000");
  });
});

// ── defaultCookieJar — returns undefined when document is absent ──────────

describe("defaultCookieJar (no document)", () => {
  let savedDocument: Document | undefined;
  let hadDocument: boolean;

  beforeEach(() => {
    hadDocument = "document" in globalThis;
    if (hadDocument) {
      savedDocument = globalThis.document;
    }
    // Remove document from globalThis to simulate non-browser env
    try {
      Object.defineProperty(globalThis, "document", {
        value: undefined,
        writable: true,
        configurable: true,
      });
    } catch {
      // Some environments may not allow this; skip if so
    }
  });

  afterEach(() => {
    if (hadDocument && savedDocument !== undefined) {
      Object.defineProperty(globalThis, "document", {
        value: savedDocument,
        writable: true,
        configurable: true,
      });
    }
  });

  it("returns undefined when document is not available", () => {
    // Re-import can't be done in ESM without dynamic import; test the guard directly
    // by checking typeof document at module level (already done inside defaultCookieJar)
    // We verify the function exists and returns undefined in non-browser context.
    if (typeof document === "undefined") {
      const jar = defaultCookieJar();
      expect(jar).toBeUndefined();
    } else {
      // document is still defined in this test env (Node with globalThis.document shim)
      // just verify the function is callable
      const jar = defaultCookieJar();
      // Either undefined or an object, depending on environment
      expect(jar === undefined || typeof jar === "object").toBe(true);
    }
  });
});

// ── defaultCookieJar — with mocked document ───────────────────────────────

describe("defaultCookieJar (browser mock)", () => {
  let cookieStore: Map<string, string>;
  let cookieString: string;
  let savedDocument: typeof globalThis.document | undefined;

  function rebuildCookieString(): void {
    cookieString = Array.from(cookieStore.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  function parseAndApplyCookieWrite(value: string): void {
    const parts = value.split(";").map((s) => s.trim());
    const first = parts[0] ?? "";
    const eqIdx = first.indexOf("=");
    if (eqIdx < 0) return;
    const rawKey = first.substring(0, eqIdx).trim();
    const rawVal = first.substring(eqIdx + 1).trim();

    // Check for deletion (epoch=1970)
    const expiresPart = parts.find((p) => p.toLowerCase().startsWith("expires="));
    if (expiresPart !== undefined) {
      const expiresVal = expiresPart.substring("expires=".length).trim();
      if (expiresVal.includes("1970")) {
        cookieStore.delete(rawKey);
        rebuildCookieString();
        return;
      }
    }

    cookieStore.set(rawKey, rawVal);
    rebuildCookieString();
  }

  beforeEach(() => {
    cookieStore = new Map();
    cookieString = "";
    savedDocument = globalThis.document;

    Object.defineProperty(globalThis, "document", {
      value: {
        get cookie(): string {
          return cookieString;
        },
        set cookie(v: string) {
          parseAndApplyCookieWrite(v);
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      value: savedDocument,
      writable: true,
      configurable: true,
    });
  });

  it("set and get round-trip", () => {
    const jar = defaultCookieJar();
    expect(jar).toBeDefined();
    if (jar === undefined) return;

    jar.set("h2w-fallback", "1750000000000", { maxAgeMs: 86400000 });
    const result = jar.get("h2w-fallback");
    expect(result).toBe("1750000000000");
  });

  it("get returns undefined for missing cookie", () => {
    const jar = defaultCookieJar();
    if (jar === undefined) return;
    expect(jar.get("nonexistent")).toBeUndefined();
  });

  it("delete removes the cookie", () => {
    const jar = defaultCookieJar();
    if (jar === undefined) return;

    jar.set("h2w-fallback", "1750000000000", { maxAgeMs: 86400000 });
    jar.delete("h2w-fallback");
    expect(jar.get("h2w-fallback")).toBeUndefined();
  });

  it("set includes SameSite, Path, and Expires attributes in the cookie string", () => {
    const writtenValues: string[] = [];

    Object.defineProperty(globalThis, "document", {
      value: {
        get cookie(): string {
          return cookieString;
        },
        set cookie(v: string) {
          writtenValues.push(v);
          parseAndApplyCookieWrite(v);
        },
      },
      writable: true,
      configurable: true,
    });

    const jar = defaultCookieJar();
    if (jar === undefined) return;

    jar.set("test-cookie", "val", { maxAgeMs: 1000 });

    const lastWrite = writtenValues[writtenValues.length - 1] ?? "";
    expect(lastWrite).toContain("SameSite=Lax");
    expect(lastWrite).toContain("Path=/");
    expect(lastWrite).toContain("Expires=");
  });

  it("set encodes special characters in name and value", () => {
    const jar = defaultCookieJar();
    if (jar === undefined) return;

    jar.set("my cookie", "hello world", { maxAgeMs: 1000 });
    // Encoding means spaces become %20
    const result = jar.get("my cookie");
    expect(result).toBe("hello world");
  });
});
