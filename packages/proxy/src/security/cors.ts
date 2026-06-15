import { BridgeError } from "@https2wss/protocol";
import type { SecurityConfig } from "../config/securityConfig.js";

export class CorsPolicy {
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly allowWildcard: boolean;
  private readonly allowCredentials: boolean;

  constructor(cfg: SecurityConfig["cors"]) {
    this.allowCredentials = cfg.allowCredentials;
    const hasWildcard = cfg.allowedOrigins.includes("*");

    if (hasWildcard && cfg.allowCredentials) {
      throw new BridgeError(
        "POLICY_DENIED",
        "CORS wildcard origin cannot be combined with allowCredentials: true",
        { retryable: false },
      );
    }

    this.allowWildcard = hasWildcard;
    this.allowedOrigins = new Set(cfg.allowedOrigins.filter((o: string) => o !== "*"));
  }

  /**
   * Returns true if the origin is allowed.
   * null/undefined origin is allowed only when allowedOrigins is empty AND credentials disabled.
   */
  isAllowed(origin: string | null | undefined): boolean {
    if (origin === null || origin === undefined || origin === "") {
      // No origin header — allow only in open mode (no configured origins, no credentials)
      return this.allowedOrigins.size === 0 && !this.allowWildcard && !this.allowCredentials;
    }

    if (this.allowedOrigins.has(origin)) {
      return true;
    }

    // Wildcard mode (no credentials) — any non-null origin is allowed
    if (this.allowWildcard) {
      return true;
    }

    return false;
  }

  /**
   * Build CORS response headers for a request from the given origin.
   * Returns empty object if the origin is not allowed.
   */
  buildResponseHeaders(origin: string | null | undefined): Record<string, string> {
    if (!this.isAllowed(origin)) {
      return {};
    }

    if (origin === null || origin === undefined || origin === "") {
      // Open mode — no origin header means no CORS headers needed
      return {};
    }

    const headers: Record<string, string> = {
      "access-control-allow-origin": origin,
      vary: "Origin",
    };

    if (this.allowCredentials) {
      headers["access-control-allow-credentials"] = "true";
    }

    return headers;
  }
}
