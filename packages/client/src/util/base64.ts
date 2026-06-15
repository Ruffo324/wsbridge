/**
 * Pure-JS base64 encode/decode — no environment branching.
 *
 * Payloads are bounded by maxFrameBytes (default 1 MiB) so the performance
 * of a pure-JS implementation is acceptable.
 */

const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Build a reverse lookup table once at module load. */
const REVERSE = new Uint8Array(256).fill(255);
for (let i = 0; i < TABLE.length; i++) {
  const code = TABLE.charCodeAt(i);
  REVERSE[code] = i;
}

/**
 * Encode a Uint8Array to a base64 string (standard alphabet, with padding).
 */
export function encodeBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  let out = "";
  let i = 0;

  // Process every complete group of 3 bytes → 4 characters
  for (; i + 2 < len; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += TABLE[b0 >> 2];
    out += TABLE[((b0 & 0x3) << 4) | (b1 >> 4)];
    out += TABLE[((b1 & 0xf) << 2) | (b2 >> 6)];
    out += TABLE[b2 & 0x3f];
  }

  // Handle remaining 1 or 2 bytes
  const remaining = len - i;
  if (remaining === 1) {
    const b0 = bytes[i] ?? 0;
    out += TABLE[b0 >> 2];
    out += TABLE[(b0 & 0x3) << 4];
    out += "==";
  } else if (remaining === 2) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    out += TABLE[b0 >> 2];
    out += TABLE[((b0 & 0x3) << 4) | (b1 >> 4)];
    out += TABLE[(b1 & 0xf) << 2];
    out += "=";
  }

  return out;
}

/**
 * Decode a base64 string to a Uint8Array.
 * Tolerates optional `=` padding and ignores whitespace.
 * Throws on invalid characters.
 */
export function decodeBase64(str: string): Uint8Array {
  // Strip whitespace and padding for length calculation
  const stripped = str.replace(/[\s=]/g, "");
  if (stripped.length % 4 === 1) {
    throw new RangeError("Invalid base64 string: length modulo 4 cannot be 1");
  }

  const outLen = Math.floor((stripped.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let outIdx = 0;

  for (let i = 0; i < stripped.length; i += 4) {
    const c0 = stripped.charCodeAt(i);
    const c1 = i + 1 < stripped.length ? stripped.charCodeAt(i + 1) : "A".charCodeAt(0);
    const c2 = i + 2 < stripped.length ? stripped.charCodeAt(i + 2) : "A".charCodeAt(0);
    const c3 = i + 3 < stripped.length ? stripped.charCodeAt(i + 3) : "A".charCodeAt(0);

    const v0 = REVERSE[c0] ?? 255;
    const v1 = REVERSE[c1] ?? 255;
    const v2 = REVERSE[c2] ?? 255;
    const v3 = REVERSE[c3] ?? 255;

    if (v0 === 255 || v1 === 255) {
      throw new RangeError(`Invalid base64 character at position ${i}`);
    }

    out[outIdx++] = (v0 << 2) | (v1 >> 4);

    if (i + 2 < stripped.length) {
      if (v2 === 255) {
        throw new RangeError(`Invalid base64 character at position ${i + 2}`);
      }
      out[outIdx++] = ((v1 & 0xf) << 4) | (v2 >> 2);
    }

    if (i + 3 < stripped.length) {
      if (v3 === 255) {
        throw new RangeError(`Invalid base64 character at position ${i + 3}`);
      }
      out[outIdx++] = ((v2 & 0x3) << 6) | v3;
    }
  }

  return out.subarray(0, outIdx);
}
