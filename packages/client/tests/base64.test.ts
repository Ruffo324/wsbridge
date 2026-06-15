import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "../src/util/base64.js";

describe("base64", () => {
  it("encodes known bytes to the correct base64 string", () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4]);
    expect(encodeBase64(bytes)).toBe("AAECAwQ=");
  });

  it("round-trips arbitrary bytes", () => {
    // 100 pseudo-random bytes
    const bytes = Uint8Array.from({ length: 100 }, (_, i) => (i * 37 + 13) % 256);
    const encoded = encodeBase64(bytes);
    const decoded = decodeBase64(encoded);
    expect(decoded).toEqual(bytes);
  });

  it("handles empty input", () => {
    expect(encodeBase64(new Uint8Array(0))).toBe("");
    expect(decodeBase64("")).toEqual(new Uint8Array(0));
  });

  it("handles single-byte input (two padding chars)", () => {
    // 0x00 → "AA=="
    const b = Uint8Array.from([0]);
    expect(encodeBase64(b)).toBe("AA==");
    expect(decodeBase64("AA==")).toEqual(b);
  });

  it("handles two-byte input (one padding char)", () => {
    // [0, 1] → "AAE="
    const b = Uint8Array.from([0, 1]);
    expect(encodeBase64(b)).toBe("AAE=");
    expect(decodeBase64("AAE=")).toEqual(b);
  });

  it("decodes base64 without padding", () => {
    // "AAECAwQ=" without padding → still decodes correctly
    const decoded = decodeBase64("AAECAwQ");
    expect(decoded).toEqual(Uint8Array.from([0, 1, 2, 3, 4]));
  });

  it("throws on invalid base64 characters", () => {
    expect(() => decodeBase64("!!!")).toThrow();
  });

  it("round-trips all byte values 0-255", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const encoded = encodeBase64(bytes);
    const decoded = decodeBase64(encoded);
    expect(decoded).toEqual(bytes);
  });

  it("round-trips a non-multiple-of-3 length", () => {
    // 10 bytes — remainder 1
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});
