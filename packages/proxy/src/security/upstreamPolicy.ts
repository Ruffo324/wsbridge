import { BridgeError } from "@https2wss/protocol";
import type { SecurityConfig } from "../config/securityConfig.js";

export interface ResolvedUpstream {
  profileName: string;
  adapter: "websocket";
  url: URL;
  allowedHeaders: ReadonlyArray<string>;
  allowPrivateNetwork: boolean;
}

const ALLOWED_WS_SCHEMES = new Set(["ws:", "wss:"]);

function validateWsUrl(rawUrl: string, contextLabel: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BridgeError("POLICY_DENIED", `invalid URL in upstream profile "${contextLabel}"`, {
      retryable: false,
    });
  }
  if (!ALLOWED_WS_SCHEMES.has(parsed.protocol)) {
    throw new BridgeError(
      "POLICY_DENIED",
      `upstream profile "${contextLabel}" URL must use ws: or wss: scheme, got "${parsed.protocol}"`,
      { retryable: false },
    );
  }
  return parsed;
}

export class UpstreamPolicy {
  private readonly profileMap: Map<string, ResolvedUpstream>;
  private readonly allowDirectUrl: boolean;

  constructor(cfg: SecurityConfig["upstreamPolicy"]) {
    this.allowDirectUrl = cfg.allowDirectUrl;
    this.profileMap = new Map<string, ResolvedUpstream>();

    for (const profile of cfg.allow) {
      // Validate scheme at construction time (fail fast on bad config)
      const url = validateWsUrl(profile.url, profile.name);
      const resolved: ResolvedUpstream = {
        profileName: profile.name,
        adapter: "websocket",
        url,
        allowedHeaders: profile.allowedHeaders.map((h: string) => h.toLowerCase()),
        allowPrivateNetwork: profile.allowPrivateNetwork,
      };
      this.profileMap.set(profile.name, resolved);
    }
  }

  resolve(
    input: { kind: "profile"; name: string } | { kind: "directUrl"; url: string },
  ): ResolvedUpstream {
    if (input.kind === "profile") {
      const entry = this.profileMap.get(input.name);
      if (entry === undefined) {
        throw new BridgeError(
          "UPSTREAM_NOT_ALLOWED",
          `upstream profile "${input.name}" is not in the allow list`,
          { retryable: false },
        );
      }
      return entry;
    }

    // kind === "directUrl"
    if (!this.allowDirectUrl) {
      throw new BridgeError("UPSTREAM_NOT_ALLOWED", "direct upstream URLs are not enabled", {
        retryable: false,
      });
    }

    // Validate scheme — throw POLICY_DENIED for non-ws schemes
    const url = validateWsUrl(input.url, "<direct>");

    return {
      profileName: "<direct>",
      adapter: "websocket",
      url,
      allowedHeaders: [],
      allowPrivateNetwork: false,
    };
  }
}
