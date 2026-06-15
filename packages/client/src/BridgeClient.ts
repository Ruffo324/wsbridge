import type { BridgeErrorCode } from "@https2wss/protocol";
import { BridgeError } from "@https2wss/protocol";
import type { BridgeSessionInit, SessionLimits } from "./BridgeSession.js";
import { BridgeSession } from "./BridgeSession.js";

export interface BridgeClientInit {
  bridgeUrl: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export interface OpenSessionInput {
  transport?: "sse" | "long_poll" | "poll";
  upstream: { adapter: "websocket"; profile?: string; url?: string };
  options?: {
    binary?: "base64";
    ordered?: boolean;
    resume?: boolean;
    heartbeatIntervalMs?: number;
  };
}

/** Response shape returned by POST /v1/sessions */
interface CreateSessionResponse {
  sessionId: string;
  state: string;
  transport: {
    selected: "sse" | "long_poll" | "poll";
    sendUrl: string;
    receiveUrl: string;
  };
  limits: SessionLimits;
}

export class BridgeClient {
  private readonly bridgeUrl: string;
  private readonly authToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(init: BridgeClientInit) {
    this.bridgeUrl = init.bridgeUrl.replace(/\/$/, "");
    this.authToken = init.authToken;
    this.fetchImpl = init.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async openSession(input: OpenSessionInput): Promise<BridgeSession> {
    const transportMode = input.transport ?? "sse";
    const fallbacks: string[] =
      transportMode === "sse"
        ? ["long_poll", "poll"]
        : transportMode === "long_poll"
          ? ["poll"]
          : [];

    const body = {
      protocol: "https2wss",
      version: 1,
      transport: { mode: transportMode, fallbacks },
      upstream: input.upstream,
      options: input.options ?? { binary: "base64" as const, ordered: true },
    };

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.authToken !== undefined) {
      headers.authorization = `Bearer ${this.authToken}`;
    }

    const res = await this.fetchImpl(`${this.bridgeUrl}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let errorBody: unknown;
      try {
        errorBody = await res.json();
      } catch {
        errorBody = {};
      }
      const errData = errorBody as { error?: { code?: string; message?: string } };
      const code = errData.error?.code ?? "INTERNAL_ERROR";
      const message = errData.error?.message ?? `openSession failed: ${res.status}`;
      throw new BridgeError(code as BridgeErrorCode, message);
    }

    const data = (await res.json()) as CreateSessionResponse;

    const sessionInit: BridgeSessionInit = {
      bridgeUrl: this.bridgeUrl,
      authToken: this.authToken,
      sessionId: data.sessionId,
      sendUrl: data.transport.sendUrl,
      receiveUrl: data.transport.receiveUrl,
      transport: data.transport.selected,
      limits: data.limits,
      fetchImpl: this.fetchImpl,
    };

    return new BridgeSession(sessionInit);
  }
}
