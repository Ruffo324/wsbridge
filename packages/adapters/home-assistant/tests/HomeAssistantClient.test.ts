/**
 * Unit tests for HomeAssistantClient using an in-memory fake socket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAssistantClient } from "../src/HomeAssistantClient.js";
import type { HomeAssistantSocketLike } from "../src/types.js";
import { HomeAssistantError } from "../src/types.js";

// ── FakeSocket ────────────────────────────────────────────────────────────

class FakeSocket extends EventTarget implements HomeAssistantSocketLike {
  readyState = 1; // OPEN by default
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(_c?: number, _r?: string): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  emitMessage(obj: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(obj) }));
  }

  emitOpen(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  emitError(): void {
    this.dispatchEvent(new Event("error"));
  }

  lastSent(): unknown {
    const raw = this.sent[this.sent.length - 1];
    return raw !== undefined ? (JSON.parse(raw) as unknown) : undefined;
  }

  sentAt(index: number): unknown {
    const raw = this.sent[index];
    return raw !== undefined ? (JSON.parse(raw) as unknown) : undefined;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeClient(
  socket: FakeSocket,
  opts: { requestTimeoutMs?: number; clock?: () => number; pingIntervalMs?: number } = {},
): HomeAssistantClient {
  return new HomeAssistantClient({
    socket,
    accessToken: "test-token",
    requestTimeoutMs: opts.requestTimeoutMs ?? 100,
    clock: opts.clock,
    pingIntervalMs: opts.pingIntervalMs ?? 0, // disable pings by default in tests
  });
}

/** Drive authenticate() by simulating the auth handshake from the server side. */
async function doAuth(
  socket: FakeSocket,
  client: HomeAssistantClient,
  haVersion = "2024.1.0",
): Promise<{ ha_version: string }> {
  const authP = client.authenticate();
  socket.emitMessage({ type: "auth_required", ha_version: haVersion });
  socket.emitMessage({ type: "auth_ok", ha_version: haVersion });
  return authP;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("HomeAssistantClient.authenticate()", () => {
  let socket: FakeSocket;
  let client: HomeAssistantClient;

  beforeEach(() => {
    socket = new FakeSocket();
    client = makeClient(socket);
  });

  afterEach(() => {
    client.close();
  });

  it("happy path: resolves with ha_version after auth_ok", async () => {
    const result = await doAuth(socket, client, "2024.6.0");
    expect(result).toEqual({ ha_version: "2024.6.0" });
    expect(client.authenticated).toBe(true);
    expect(client.haVersion).toBe("2024.6.0");
  });

  it("sends auth message with the access token", async () => {
    const authP = client.authenticate();
    socket.emitMessage({ type: "auth_required", ha_version: "2024.1.0" });
    socket.emitMessage({ type: "auth_ok", ha_version: "2024.1.0" });
    await authP;
    const authMsg = socket.sentAt(0) as Record<string, unknown>;
    expect(authMsg["type"]).toBe("auth");
    expect(authMsg["access_token"]).toBe("test-token");
  });

  it("rejects with AUTH_INVALID when server sends auth_invalid", async () => {
    const authP = client.authenticate();
    socket.emitMessage({ type: "auth_required", ha_version: "2024.1.0" });
    socket.emitMessage({ type: "auth_invalid", message: "Token expired" });
    await expect(authP).rejects.toMatchObject({
      code: "AUTH_INVALID",
      message: "Token expired",
    });
  });

  it("rejects with AUTH_TIMEOUT when socket closes before auth completes", async () => {
    const authP = client.authenticate();
    socket.emitMessage({ type: "auth_required", ha_version: "2024.1.0" });
    // Close before auth_ok
    socket.close();
    await expect(authP).rejects.toMatchObject({ code: "AUTH_TIMEOUT" });
  });

  it("is idempotent — calling twice returns the same promise", () => {
    const p1 = client.authenticate();
    const p2 = client.authenticate();
    expect(p1).toBe(p2);
  });

  it("rejects with AUTH_TIMEOUT when socket closes after auth_required but before auth_ok", async () => {
    // Fresh socket starting in CONNECTING state
    const connectingSocket = new FakeSocket();
    connectingSocket.readyState = 0; // CONNECTING
    const c2 = makeClient(connectingSocket);
    // Start auth — waits for the handshake
    const authP = c2.authenticate();
    // Socket opens, server sends auth_required, client sends auth
    connectingSocket.readyState = 1;
    connectingSocket.dispatchEvent(new Event("open"));
    connectingSocket.emitMessage({ type: "auth_required", ha_version: "2024.1.0" });
    // Socket closes before auth_ok
    connectingSocket.readyState = 3;
    connectingSocket.dispatchEvent(new Event("close"));
    await expect(authP).rejects.toMatchObject({ code: "AUTH_TIMEOUT" });
    c2.close();
  });
});

describe("HomeAssistantClient — unauthenticated guard", () => {
  it("getStates() before authenticate() rejects with NOT_AUTHENTICATED", async () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    await expect(client.getStates()).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    client.close();
  });

  it("callService() before authenticate() rejects with NOT_AUTHENTICATED", async () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    await expect(client.callService("light", "turn_on")).rejects.toMatchObject({
      code: "NOT_AUTHENTICATED",
    });
    client.close();
  });
});

describe("HomeAssistantClient.subscribeEvents()", () => {
  let socket: FakeSocket;
  let client: HomeAssistantClient;

  beforeEach(async () => {
    socket = new FakeSocket();
    client = makeClient(socket);
    await doAuth(socket, client);
  });

  afterEach(() => {
    client.close();
  });

  it("sends subscribe_events and resolves after result success", async () => {
    const handler = vi.fn();
    const subP = client.subscribeEvents(handler);

    // Server confirms subscription
    const subMsg = socket.lastSent() as Record<string, unknown>;
    const subId = subMsg["id"] as number;
    socket.emitMessage({ type: "result", id: subId, success: true, result: null });

    const handle = await subP;
    expect(handle.id).toBe(subId);
    expect(socket.sent.length).toBeGreaterThan(0);
    const sentMsg = JSON.parse(socket.sent[socket.sent.length - 1] as string) as Record<
      string,
      unknown
    >;
    expect(sentMsg["type"]).toBe("subscribe_events");
  });

  it("includes event_type when specified", async () => {
    const handler = vi.fn();
    const subP = client.subscribeEvents(handler, "state_changed");

    const subMsg = socket.lastSent() as Record<string, unknown>;
    const subId = subMsg["id"] as number;
    expect(subMsg["event_type"]).toBe("state_changed");
    socket.emitMessage({ type: "result", id: subId, success: true, result: null });

    await subP;
  });

  it("invokes handler for each event matching the subscription id", async () => {
    const events: unknown[] = [];
    const subP = client.subscribeEvents((ev) => events.push(ev));

    const subMsg = socket.lastSent() as Record<string, unknown>;
    const subId = subMsg["id"] as number;
    socket.emitMessage({ type: "result", id: subId, success: true, result: null });
    await subP;

    // Server sends two events
    const makeEvent = (entityId: string) => ({
      type: "event",
      id: subId,
      event: {
        event_type: "state_changed",
        data: { entity_id: entityId },
        origin: "LOCAL",
        time_fired: "2024-01-01T00:00:00+00:00",
        context: {},
      },
    });

    socket.emitMessage(makeEvent("light.kitchen"));
    socket.emitMessage(makeEvent("switch.fan"));

    expect(events).toHaveLength(2);
    expect((events[0] as { data: { entity_id: string } }).data.entity_id).toBe("light.kitchen");
  });

  it("unsubscribe() sends unsubscribe_events, future events are NOT delivered", async () => {
    const events: unknown[] = [];
    const subP = client.subscribeEvents((ev) => events.push(ev));

    const subMsg = socket.lastSent() as Record<string, unknown>;
    const subId = subMsg["id"] as number;
    socket.emitMessage({ type: "result", id: subId, success: true, result: null });
    const handle = await subP;

    // Unsubscribe
    const unsubP = handle.unsubscribe();
    const unsubMsg = socket.lastSent() as Record<string, unknown>;
    expect(unsubMsg["type"]).toBe("unsubscribe_events");
    expect(unsubMsg["subscription"]).toBe(subId);

    const unsubId = unsubMsg["id"] as number;
    socket.emitMessage({ type: "result", id: unsubId, success: true, result: null });
    await unsubP;

    // Subsequent event with same id should NOT trigger handler
    socket.emitMessage({
      type: "event",
      id: subId,
      event: {
        event_type: "state_changed",
        data: {},
        origin: "LOCAL",
        time_fired: "2024-01-01T00:00:00+00:00",
        context: {},
      },
    });

    expect(events).toHaveLength(0);
  });
});

describe("HomeAssistantClient.callService()", () => {
  let socket: FakeSocket;
  let client: HomeAssistantClient;

  beforeEach(async () => {
    socket = new FakeSocket();
    client = makeClient(socket);
    await doAuth(socket, client);
  });

  afterEach(() => {
    client.close();
  });

  it("sends the correct call_service message and resolves with result", async () => {
    const serviceP = client.callService("light", "turn_on", {
      target: { entity_id: "light.kitchen" },
    });

    const msg = socket.lastSent() as Record<string, unknown>;
    expect(msg["type"]).toBe("call_service");
    expect(msg["domain"]).toBe("light");
    expect(msg["service"]).toBe("turn_on");
    expect(msg["target"]).toEqual({ entity_id: "light.kitchen" });

    const id = msg["id"] as number;
    socket.emitMessage({
      type: "result",
      id,
      success: true,
      result: { entity_id: "light.kitchen" },
    });

    const result = await serviceP;
    expect(result).toEqual({ entity_id: "light.kitchen" });
  });

  it("rejects with REQUEST_FAILED when success: false", async () => {
    const serviceP = client.callService("light", "turn_on");
    const msg = socket.lastSent() as Record<string, unknown>;
    const id = msg["id"] as number;
    socket.emitMessage({
      type: "result",
      id,
      success: false,
      result: null,
      error: { code: "not_found", message: "Entity not found" },
    });

    await expect(serviceP).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      details: { ha_code: "not_found", ha_message: "Entity not found" },
    });
  });

  it("includes serviceData in the message", async () => {
    const serviceP = client.callService("climate", "set_temperature", {
      serviceData: { temperature: 22 },
    });
    const msg = socket.lastSent() as Record<string, unknown>;
    expect(msg["service_data"]).toEqual({ temperature: 22 });
    const id = msg["id"] as number;
    socket.emitMessage({ type: "result", id, success: true, result: null });
    await serviceP;
  });
});

describe("HomeAssistantClient.getStates()", () => {
  it("returns the state array from the result", async () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    await doAuth(socket, client);

    const statesP = client.getStates();
    const msg = socket.lastSent() as Record<string, unknown>;
    expect(msg["type"]).toBe("get_states");

    const fakeStates = [
      {
        entity_id: "light.kitchen",
        state: "on",
        attributes: {},
        last_changed: "2024-01-01T00:00:00+00:00",
        last_updated: "2024-01-01T00:00:00+00:00",
        context: {},
      },
    ];

    const id = msg["id"] as number;
    socket.emitMessage({ type: "result", id, success: true, result: fakeStates });

    const states = await statesP;
    expect(states).toEqual(fakeStates);
    client.close();
  });
});

describe("HomeAssistantClient.ping()", () => {
  it("returns RTT > 0 using the injected clock", async () => {
    let now = 1000;
    const clock = () => now;

    const socket = new FakeSocket();
    const client = makeClient(socket, { clock, requestTimeoutMs: 5000 });
    await doAuth(socket, client);

    const pingP = client.ping();
    const msg = socket.lastSent() as Record<string, unknown>;
    expect(msg["type"]).toBe("ping");
    const id = msg["id"] as number;

    // Advance clock before pong
    now = 1050;
    socket.emitMessage({ type: "pong", id });

    const rtt = await pingP;
    expect(rtt).toBe(50);
    client.close();
  });
});

describe("HomeAssistantClient — multiple in-flight requests", () => {
  it("resolves requests out-of-order by id", async () => {
    const socket = new FakeSocket();
    const client = makeClient(socket, { requestTimeoutMs: 5000 });
    await doAuth(socket, client);

    // Send two requests
    const p1 = client.getStates();
    const msg1 = socket.lastSent() as Record<string, unknown>;
    const id1 = msg1["id"] as number;

    const p2 = client.getConfig();
    const msg2 = socket.lastSent() as Record<string, unknown>;
    const id2 = msg2["id"] as number;

    // Resolve in reverse order
    socket.emitMessage({ type: "result", id: id2, success: true, result: { unit: "metric" } });
    socket.emitMessage({ type: "result", id: id1, success: true, result: [{ entity_id: "x" }] });

    const [states, config] = await Promise.all([p1, p2]);
    expect(states).toEqual([{ entity_id: "x" }]);
    expect(config).toEqual({ unit: "metric" });
    client.close();
  });
});

describe("HomeAssistantClient — request timeout", () => {
  it("rejects with REQUEST_TIMEOUT if no result arrives in time", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const client = makeClient(socket, { requestTimeoutMs: 200 });
    await doAuth(socket, client);

    const statesP = client.getStates();
    vi.advanceTimersByTime(201);

    await expect(statesP).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    client.close();
    vi.useRealTimers();
  });
});

describe("HomeAssistantClient.close()", () => {
  it("rejects pending requests with SOCKET_CLOSED", async () => {
    const socket = new FakeSocket();
    const client = makeClient(socket, { requestTimeoutMs: 5000 });
    await doAuth(socket, client);

    const statesP = client.getStates();
    client.close();

    await expect(statesP).rejects.toMatchObject({ code: "SOCKET_CLOSED" });
  });

  it("subscriptions are dropped after close — no further deliveries", async () => {
    const socket = new FakeSocket();
    const client = makeClient(socket, { requestTimeoutMs: 5000 });
    await doAuth(socket, client);

    const events: unknown[] = [];
    const subP = client.subscribeEvents((ev) => events.push(ev));
    const subMsg = socket.lastSent() as Record<string, unknown>;
    const subId = subMsg["id"] as number;
    socket.emitMessage({ type: "result", id: subId, success: true, result: null });
    await subP;

    client.close();

    // Emit event after close — should be ignored
    socket.emitMessage({
      type: "event",
      id: subId,
      event: {
        event_type: "state_changed",
        data: {},
        origin: "LOCAL",
        time_fired: "2024-01-01T00:00:00+00:00",
        context: {},
      },
    });

    expect(events).toHaveLength(0);
  });
});

describe("HomeAssistantClient — protocol resilience", () => {
  it("ignores malformed JSON and subsequent valid messages still work", async () => {
    const socket = new FakeSocket();
    const client = makeClient(socket, { requestTimeoutMs: 5000 });
    await doAuth(socket, client);

    const statesP = client.getStates();
    const msg = socket.lastSent() as Record<string, unknown>;
    const id = msg["id"] as number;

    // Emit malformed JSON — should be ignored
    socket.dispatchEvent(new MessageEvent("message", { data: "this is not json{{" }));

    // Real response still arrives
    socket.emitMessage({ type: "result", id, success: true, result: [] });

    const states = await statesP;
    expect(states).toEqual([]);
    client.close();
  });
});

describe("HomeAssistantError", () => {
  it("has the correct code and message", () => {
    const err = new HomeAssistantError("AUTH_INVALID", "Token expired");
    expect(err.code).toBe("AUTH_INVALID");
    expect(err.message).toBe("Token expired");
    expect(err.name).toBe("HomeAssistantError");
    expect(err instanceof Error).toBe(true);
  });

  it("carries optional details", () => {
    const err = new HomeAssistantError("REQUEST_FAILED", "Failed", { ha_code: "not_found" });
    expect(err.details).toEqual({ ha_code: "not_found" });
  });
});
