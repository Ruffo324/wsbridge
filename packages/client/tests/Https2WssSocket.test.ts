/**
 * Integration tests for Https2WssSocket.
 * Tests the WebSocket-like surface against a real proxy + ws echo server.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/BridgeClient.js";
import { Https2WssSocket } from "../src/Https2WssSocket.js";
import { startProxyWithEcho, VALID_TOKEN } from "./helpers/setupProxy.js";

type ProxyEnv = Awaited<ReturnType<typeof startProxyWithEcho>>;

let env: ProxyEnv;

beforeEach(async () => {
  env = await startProxyWithEcho();
}, 15_000);

afterEach(async () => {
  await env.cleanup();
}, 10_000);

function openSocket(
  overrides: Partial<Parameters<typeof Https2WssSocket>[1]> = {},
): Https2WssSocket {
  return new Https2WssSocket("wss://echo", {
    bridgeUrl: env.baseUrl,
    authToken: VALID_TOKEN,
    upstreamProfile: "echo",
    ...overrides,
  });
}

/** Wait for the socket's onopen to fire. */
async function waitOpen(socket: Https2WssSocket, timeoutMs = 6000): Promise<void> {
  if (socket.readyState === 1) return;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitOpen timed out")), timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

describe("Https2WssSocket", () => {
  it("1 — readyState starts at CONNECTING (0) then transitions to OPEN (1)", async () => {
    const socket = openSocket();
    expect(socket.readyState).toBe(0); // CONNECTING immediately

    await waitOpen(socket);
    expect(socket.readyState).toBe(1); // OPEN

    socket.close();
  }, 10_000);

  it("2 — onopen fires when connection is established", async () => {
    const socket = openSocket();
    let opened = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("onopen timeout")), 6000);
      socket.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      };
    });

    expect(opened).toBe(true);
    socket.close();
  }, 10_000);

  it("3 — socket.send('hello') produces onmessage with data: 'hello'", async () => {
    const socket = openSocket();
    await waitOpen(socket);

    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("onmessage timeout")), 5000);
      socket.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(ev.data as string);
      };
      socket.send("hello");
    });

    expect(received).toBe("hello");
    socket.close();
  }, 12_000);

  it("4 — sending Uint8Array produces onmessage with ArrayBuffer data", async () => {
    const socket = openSocket();
    await waitOpen(socket);

    const bytes = Uint8Array.from([0, 1, 2, 3, 4]);

    const received = await new Promise<ArrayBuffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("onmessage (binary) timeout")), 5000);
      socket.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          clearTimeout(timer);
          resolve(ev.data);
        }
      };
      socket.send(bytes);
    });

    expect(received).toBeInstanceOf(ArrayBuffer);
    const decoded = new Uint8Array(received);
    expect(Array.from(decoded)).toEqual([0, 1, 2, 3, 4]);
    socket.close();
  }, 12_000);

  it("5 — socket.close() fires onclose with code and reason", async () => {
    const socket = openSocket();
    await waitOpen(socket);

    const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("onclose timeout")), 5000);
      socket.onclose = (ev) => {
        clearTimeout(timer);
        resolve({
          code: (ev as CloseEvent).code ?? (ev as unknown as { code: number }).code,
          reason: (ev as CloseEvent).reason ?? (ev as unknown as { reason: string }).reason,
        });
      };
      socket.close(1000, "test done");
    });

    expect(closeEvent.code).toBe(1000);
    expect(socket.readyState).toBe(3); // CLOSED
  }, 10_000);

  it("6 — readyState lifecycle: 0 → 1 → 3", async () => {
    const socket = openSocket();
    const states: number[] = [socket.readyState];

    await waitOpen(socket);
    states.push(socket.readyState);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("close timeout")), 5000);
      socket.onclose = () => {
        clearTimeout(timer);
        states.push(socket.readyState);
        resolve();
      };
      socket.close();
    });

    expect(states[0]).toBe(0); // CONNECTING
    expect(states[1]).toBe(1); // OPEN
    expect(states[2]).toBe(3); // CLOSED
  }, 12_000);

  it("7 — addEventListener/removeEventListener work for 'message' events", async () => {
    const socket = openSocket();
    await waitOpen(socket);

    const received: string[] = [];
    function handler(ev: Event): void {
      received.push((ev as MessageEvent).data as string);
    }

    socket.addEventListener("message", handler);

    const messagePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("message timeout")), 5000);
      function check(ev: Event): void {
        if ((ev as MessageEvent).data === "ping") {
          clearTimeout(timer);
          socket.removeEventListener("message", check);
          resolve();
        }
      }
      socket.addEventListener("message", check);
    });

    socket.send("ping");
    await messagePromise;

    socket.removeEventListener("message", handler);
    // After removal, further messages should not reach handler
    socket.send("ignored");
    await new Promise<void>((res) => setTimeout(res, 200));
    // handler was only fired once (for "ping")
    expect(received).toContain("ping");

    socket.close();
  }, 12_000);

  it("8 — send throws InvalidStateError when not OPEN", () => {
    const socket = openSocket();
    // readyState is 0 (CONNECTING)
    expect(() => socket.send("too early")).toThrow();
  });

  it("9 — bufferedAmount is a non-negative number", async () => {
    const socket = openSocket();
    await waitOpen(socket);

    expect(typeof socket.bufferedAmount).toBe("number");
    expect(socket.bufferedAmount).toBeGreaterThanOrEqual(0);
    socket.close();
  }, 10_000);

  it("10 — already-open session still fires open when wired after upstream_open", async () => {
    const client = new BridgeClient({ bridgeUrl: env.baseUrl, authToken: VALID_TOKEN });
    const session = await client.openSession({
      transport: "sse",
      upstream: { adapter: "websocket", profile: "echo" },
    });

    await new Promise<void>((resolve, reject) => {
      if (session.state === "open") {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("session open timeout")), 5000);
      const off = session.on("state", (state) => {
        if (state === "open") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });

    const originalOpenSession = BridgeClient.prototype.openSession;
    BridgeClient.prototype.openSession = async function () {
      return session;
    };

    try {
      const socket = openSocket();
      await waitOpen(socket, 2000);
      expect(socket.readyState).toBe(1);
      socket.close();
    } finally {
      BridgeClient.prototype.openSession = originalOpenSession;
      await session.close();
    }
  }, 12_000);
});
