/**
 * Integration tests for HomeAssistantClient against a real Node.js ws server
 * that implements the HA WebSocket handshake protocol.
 *
 * The fake HA server:
 *   1. On connect: sends {type:"auth_required", ha_version:"2024.1.0"}.
 *   2. On receiving {type:"auth"}: sends auth_ok or auth_invalid based on the token.
 *   3. On receiving {type:"subscribe_events"}: sends a success result.
 *   4. On receiving {type:"call_service"}: sends a success result.
 *   5. On receiving {type:"get_states"}: sends a success result with a state array.
 *   6. On receiving {type:"ping"}: sends {type:"pong", id}.
 *   7. On receiving {type:"unsubscribe_events"}: sends a success result.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket as WsWebSocketType } from "ws";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { HomeAssistantClient } from "../src/HomeAssistantClient.js";
import type { HomeAssistantSocketLike } from "../src/types.js";

// ── Fake HA WebSocket Server ──────────────────────────────────────────────

interface FakeHaServerOptions {
  /** If set, auth_ok is sent for this token; otherwise auth_invalid for anything. */
  validToken?: string;
  /** Optional hook to inject custom event emission after subscription confirmation. */
  onSubscribed?: (serverWs: WsWebSocketType, subId: number) => void;
}

async function startFakeHaServer(opts: FakeHaServerOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const address = wss.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("Could not get server address"));
        return;
      }
      const port = address.port;

      wss.on("connection", (ws) => {
        // Step 1: Send auth_required on connect
        ws.send(JSON.stringify({ type: "auth_required", ha_version: "2024.1.0" }));

        ws.on("message", (data) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data.toString()) as Record<string, unknown>;
          } catch {
            return;
          }

          if (msg["type"] === "auth") {
            if (opts.validToken === undefined || msg["access_token"] === opts.validToken) {
              ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2024.1.0" }));
            } else {
              ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid token" }));
            }
          } else if (msg["type"] === "subscribe_events") {
            const id = msg["id"] as number;
            ws.send(JSON.stringify({ type: "result", id, success: true, result: null }));
            // Optionally inject events
            opts.onSubscribed?.(ws, id);
          } else if (msg["type"] === "unsubscribe_events") {
            const id = msg["id"] as number;
            ws.send(JSON.stringify({ type: "result", id, success: true, result: null }));
          } else if (msg["type"] === "call_service") {
            const id = msg["id"] as number;
            ws.send(
              JSON.stringify({
                type: "result",
                id,
                success: true,
                result: { service_response: null },
              }),
            );
          } else if (msg["type"] === "get_states") {
            const id = msg["id"] as number;
            ws.send(
              JSON.stringify({
                type: "result",
                id,
                success: true,
                result: [
                  {
                    entity_id: "light.kitchen",
                    state: "on",
                    attributes: { brightness: 255 },
                    last_changed: "2024-01-01T00:00:00+00:00",
                    last_updated: "2024-01-01T00:00:00+00:00",
                    context: {},
                  },
                ],
              }),
            );
          } else if (msg["type"] === "ping") {
            const id = msg["id"] as number;
            ws.send(JSON.stringify({ type: "pong", id }));
          }
        });
      });

      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            wss.close((err) => {
              if (err) rej(err);
              else res();
            });
          }),
      });
    });

    wss.on("error", reject);
  });
}

// ── Adapter: ws.WebSocket → HomeAssistantSocketLike ───────────────────────

/**
 * Wrap a ws.WebSocket instance to conform to HomeAssistantSocketLike.
 * ws.WebSocket already exposes addEventListener/removeEventListener in a
 * compatible shape.
 */
function wrapWsSocket(ws: WsWebSocketType): HomeAssistantSocketLike {
  return {
    get readyState() {
      return ws.readyState;
    },
    send(data: string) {
      ws.send(data);
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason);
    },
    addEventListener(type: string, listener: (ev: Event) => void) {
      if (type === "message") {
        const adapted = (data: Buffer | string) => {
          const ev = new MessageEvent("message", { data: data.toString() });
          (listener as (ev: MessageEvent) => void)(ev);
        };
        // Store adapted listener reference so removeEventListener can find it
        // (ws uses a different EventEmitter API — we just add and never remove for these tests)
        ws.on("message", adapted);
      } else if (type === "open") {
        ws.on("open", listener as () => void);
      } else if (type === "close") {
        ws.on("close", listener as () => void);
      } else if (type === "error") {
        ws.on("error", listener as () => void);
      }
    },
    removeEventListener(_type: string, _listener: (ev: Event) => void) {
      // Best-effort: ws.off requires the exact same reference.
      // For integration tests, we don't need precise cleanup here.
    },
  };
}

// ── Integration Tests ─────────────────────────────────────────────────────

describe("HomeAssistantClient integration", () => {
  let serverPort: number;
  let serverClose: () => Promise<void>;
  let wsClient: WsWebSocketType;
  let haClient: HomeAssistantClient;

  afterEach(async () => {
    haClient?.close();
    wsClient?.terminate();
    await serverClose?.();
  });

  it("full auth → subscribe → event → call_service lifecycle", async () => {
    // Start the fake HA server that emits one event after subscription
    const receivedEvents: unknown[] = [];

    ({ port: serverPort, close: serverClose } = await startFakeHaServer({
      validToken: "my-ha-token",
      onSubscribed: (serverWs, subId) => {
        // Emit a fake state_changed event to the client
        setTimeout(() => {
          serverWs.send(
            JSON.stringify({
              type: "event",
              id: subId,
              event: {
                event_type: "state_changed",
                data: { entity_id: "light.kitchen", new_state: { state: "off" } },
                origin: "LOCAL",
                time_fired: "2024-06-16T00:00:00+00:00",
                context: { id: "abc123", parent_id: null, user_id: null },
              },
            }),
          );
        }, 10);
      },
    }));

    // Create the ws client and the HomeAssistantClient BEFORE awaiting open,
    // so our message listener is attached before auth_required arrives.
    wsClient = new WsWebSocket(`ws://localhost:${serverPort}`);
    haClient = new HomeAssistantClient({
      socket: wrapWsSocket(wsClient),
      accessToken: "my-ha-token",
      requestTimeoutMs: 5000,
      pingIntervalMs: 0,
    });

    // Step 1: Authenticate (drives the open → auth_required → auth_ok handshake)
    const authResult = await haClient.authenticate();
    expect(authResult.ha_version).toBe("2024.1.0");
    expect(haClient.authenticated).toBe(true);

    // Step 2: Subscribe to all events
    const handle = await haClient.subscribeEvents((ev) => {
      receivedEvents.push(ev);
    });
    expect(handle.id).toBeTypeOf("number");

    // Wait for the server to emit the event
    await new Promise<void>((res) => setTimeout(res, 50));
    expect(receivedEvents).toHaveLength(1);
    expect((receivedEvents[0] as { event_type: string }).event_type).toBe("state_changed");

    // Step 3: Call a service
    const callResult = await haClient.callService("light", "turn_off", {
      target: { entity_id: "light.kitchen" },
    });
    expect(callResult).toEqual({ service_response: null });
  });

  it("rejects authenticate() when server sends auth_invalid", async () => {
    ({ port: serverPort, close: serverClose } = await startFakeHaServer({
      validToken: "correct-token",
    }));

    // Create client before awaiting open to catch auth_required early.
    wsClient = new WsWebSocket(`ws://localhost:${serverPort}`);
    haClient = new HomeAssistantClient({
      socket: wrapWsSocket(wsClient),
      accessToken: "wrong-token",
      requestTimeoutMs: 5000,
      pingIntervalMs: 0,
    });

    await expect(haClient.authenticate()).rejects.toMatchObject({
      code: "AUTH_INVALID",
      message: "Invalid token",
    });
  });

  it("handler captures fake events emitted for an active subscription", async () => {
    const events: Array<{ event_type: string }> = [];

    ({ port: serverPort, close: serverClose } = await startFakeHaServer({
      onSubscribed: (serverWs, subId) => {
        // Emit two events after a short delay so the client has time to register
        // the subscription handler before the events arrive.
        setTimeout(() => {
          for (const eventType of ["state_changed", "call_service"]) {
            serverWs.send(
              JSON.stringify({
                type: "event",
                id: subId,
                event: {
                  event_type: eventType,
                  data: {},
                  origin: "LOCAL",
                  time_fired: "2024-06-16T00:00:00+00:00",
                  context: {},
                },
              }),
            );
          }
        }, 20);
      },
    }));

    // Create client before awaiting open to catch auth_required early.
    wsClient = new WsWebSocket(`ws://localhost:${serverPort}`);
    haClient = new HomeAssistantClient({
      socket: wrapWsSocket(wsClient),
      accessToken: "any-token",
      requestTimeoutMs: 5000,
      pingIntervalMs: 0,
    });

    await haClient.authenticate();

    await haClient.subscribeEvents((ev) => {
      events.push({ event_type: ev.event_type });
    });

    // Allow events to propagate (server delays 20ms, add 50ms buffer)
    await new Promise<void>((res) => setTimeout(res, 100));

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.event_type).toBe("state_changed");
    expect(events[1]?.event_type).toBe("call_service");
  });
});
