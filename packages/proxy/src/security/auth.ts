import { createHash } from "node:crypto";
import { BridgeError } from "@https2wss/protocol";
import type { SecurityConfig } from "../config/securityConfig.js";

export interface AuthVerifier {
  /** Returns the resolved token id on success; throws BridgeError(AUTH_REQUIRED|AUTH_INVALID) on failure. */
  verifyAuthorizationHeader(header: string | undefined): { tokenId: string };
}

export interface BuildAuthOptions {
  requireAuth: boolean;
  tokens: SecurityConfig["tokens"];
  /** Inject env for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Stable opaque identifier: first 8 hex chars of sha256 of raw token. */
function tokenId(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

const BEARER_RE = /^Bearer (.+)$/;

export function buildAuth(opts: BuildAuthOptions): AuthVerifier {
  const env = opts.env ?? process.env;
  const validTokens = new Map<string, string>(); // raw → tokenId

  for (const src of opts.tokens) {
    if ("value" in src) {
      validTokens.set(src.value, tokenId(src.value));
    } else {
      const raw = env[src.env];
      if (raw === undefined || raw === "") {
        // warn but do not crash startup — caller may provide a logger; use stderr here
        process.stderr.write(
          `[https2wss] WARNING: env var "${src.env}" referenced in tokens config is not set; skipping.\n`,
        );
      } else if (raw.length < 8) {
        process.stderr.write(
          `[https2wss] WARNING: env var "${src.env}" resolved to a value shorter than 8 chars; skipping.\n`,
        );
      } else {
        validTokens.set(raw, tokenId(raw));
      }
    }
  }

  return {
    verifyAuthorizationHeader(header: string | undefined): { tokenId: string } {
      if (header === undefined) {
        if (!opts.requireAuth) {
          return { tokenId: "anonymous" };
        }
        throw new BridgeError("AUTH_REQUIRED", "authentication required", { retryable: false });
      }

      const match = BEARER_RE.exec(header);
      if (match === null || match[1] === undefined || match[1].trim() === "") {
        throw new BridgeError("AUTH_INVALID", "malformed authorization header", {
          retryable: false,
        });
      }

      const rawToken = match[1];
      const id = validTokens.get(rawToken);
      if (id === undefined) {
        throw new BridgeError("AUTH_INVALID", "invalid token", { retryable: false });
      }

      return { tokenId: id };
    },
  };
}
