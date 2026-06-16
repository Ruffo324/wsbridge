/**
 * Home Assistant WebSocket protocol adapter.
 *
 * Runs the HA WebSocket protocol on top of any WebSocket-like transport:
 * native WebSocket, Https2WssSocket, or ResilientWebSocket.
 */

export { HomeAssistantClient } from "./HomeAssistantClient.js";
export {
  type HaEvent,
  type HaState,
  type HomeAssistantClientOptions,
  HomeAssistantError,
  type HomeAssistantErrorCode,
  type HomeAssistantSocketLike,
  type SubscriptionHandle,
} from "./types.js";

// ── Convenience factory ───────────────────────────────────────────────────

import type { ResilientWebSocketInit } from "@https2wss/client";
import { ResilientWebSocket } from "@https2wss/client";
import { HomeAssistantClient } from "./HomeAssistantClient.js";
import type { HomeAssistantClientOptions } from "./types.js";

export interface ConnectViaBridgeOptions {
  /**
   * The HA WebSocket URL used as the native target.
   * e.g. "wss://homeassistant.local/api/websocket"
   */
  target: string;
  /** HA long-lived access token. */
  accessToken: string;
  /** Bridge config — fed into ResilientWebSocket. */
  bridge: ResilientWebSocketInit["bridge"];
  /** Optional knobs forwarded to ResilientWebSocket. */
  resilient?: Omit<ResilientWebSocketInit, "bridge">;
  /** Optional knobs forwarded to HomeAssistantClient. */
  ha?: Omit<HomeAssistantClientOptions, "socket" | "accessToken">;
}

/**
 * Convenience factory: wraps the target URL in a ResilientWebSocket (native-first
 * with bridge fallback), then drives the HA authentication handshake.
 *
 * Resolves the authenticated HomeAssistantClient on auth_ok.
 * If authentication fails, the underlying socket is closed and the rejection propagates.
 */
export function connectViaBridge(opts: ConnectViaBridgeOptions): Promise<HomeAssistantClient> {
  const ws = new ResilientWebSocket(opts.target, {
    bridge: opts.bridge,
    ...opts.resilient,
  });

  const client = new HomeAssistantClient({
    socket: ws,
    accessToken: opts.accessToken,
    ...opts.ha,
  });

  return client.authenticate().then(
    () => client,
    (err: unknown) => {
      client.close();
      return Promise.reject(err);
    },
  );
}
