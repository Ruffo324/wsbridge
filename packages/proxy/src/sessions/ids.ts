import { randomBytes } from "node:crypto";

/**
 * Generate a unique session ID.
 * Format: "h2w_" + base64url(randomBytes(16)) — 22 chars after the prefix,
 * which satisfies the protocol regex /^h2w_[A-Za-z0-9_-]{16,}$/.
 */
export function generateSessionId(): string {
  const bytes = randomBytes(16);
  // Standard base64url: replace + with -, / with _, strip = padding
  const b64url = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `h2w_${b64url}`;
}
