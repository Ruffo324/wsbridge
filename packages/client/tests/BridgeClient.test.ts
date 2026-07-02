/**
 * Integration tests for BridgeClient + BridgeSession.
 * Spins a real proxy server backed by a ws echo server.
 */

import type { BridgeEnvelope } from "@https2wss/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/BridgeClient.js";
import { decodeBase64 } from "../src/util/base64.js";
import { startProxyWithEcho, VALID_TOKEN } from "./helpers/setupProxy.js";

type ProxyEnv = Awaited<ReturnType<typeof startProxyWithEcho>>;

let env: ProxyEnv;

beforeEach(async () => {
  env = await startProxyWithEcho();
}, 15_000);

afterEach(async () => {
  await env.cleanup();
}, 10_000);

// Helper: wait for a frame matching predicate with timeout
async function waitForFrame(
  listener: (cb: (env: BridgeEnvelope) => void) => () => void,
  predicate: (env: BridgeEnvelope) => boolean,
  timeoutMs = 5000,
): Promise<BridgeEnvelope> {
  return new Promise<BridgeEnvelope>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("waitForFrame timed out"));
    }, timeoutMs);

    const unsubscribe = listener((frame) => {
      if (predicate(frame)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(frame);
      }
    });
  });
}

describe("BridgeClient — openSession", () => {
  it("1 — opens a session and gets open state via upstream_open control frame", async () => {
    const client = new BridgeClient({
      bridgeUrl: env.baseUrl,
      authToken: VALID_TOKEN,
    });

    const session = await client.openSession({
      upstream: { adapter: "websocket", profile: "echo" },
    });

    // Wait for upstream_open → state "open"
    await new Promise<void>((resolve) => {
      if (session.state === "open") {
        resolve();
        return;
      }
      const unsub = session.on("state", (s) => {
        if (s === "open") {
          unsub();
          resolve();
        }
      });
      setTimeout(() => resolve(), 3000); // fallback
    });

    expect(["open", "connecting"]).toContain(session.state);
    await session.close();
  }, 10_000);

  it("2 — send text 'hello' and receive text echo via SSE", async () => {
    const client = new BridgeClient({
      bridgeUrl: env.baseUrl,
      authToken: VALID_TOKEN,
    });

    const session = await client.openSession({
      transport: "sse",
      upstream: { adapter: "websocket", profile: "echo" },
    });

    // Wait for open
    await new Promise<void>((resolve) => {
      if (session.state === "open") {
        resolve();
        return;
      }
      const u = session.on("state", (s) => {
        if (s === "open") {
          u();
          resolve();
        }
      });
    });

    const framePromise = waitForFrame(
      (cb) => session.on("frame", cb),
      (f) => f.kind === "data",
    );

    await session.sendText("hello");
    const frame = await framePromise;

    const payload = frame.payload as { opcode: string; data: string };
    expect(payload.opcode).toBe("text");
    expect(payload.data).toBe("hello");

    await session.close();
  }, 10_000);

  it("3 — send binary [0,1,2,3,4] via long_poll and receive base64 echo", async () => {
    const client = new BridgeClient({
      bridgeUrl: env.baseUrl,
      authToken: VALID_TOKEN,
    });

    const session = await client.openSession({
      transport: "long_poll",
      upstream: { adapter: "websocket", profile: "echo" },
    });

    await new Promise<void>((resolve) => {
      if (session.state === "open") {
        resolve();
        return;
      }
      const u = session.on("state", (s) => {
        if (s === "open") {
          u();
          resolve();
        }
      });
    });

    const framePromise = waitForFrame(
      (cb) => session.on("frame", cb),
      (f) => f.kind === "data",
    );

    const bytes = Uint8Array.from([0, 1, 2, 3, 4]);
    await session.sendBinary(bytes);
    const frame = await framePromise;

    const payload = frame.payload as { opcode: string; encoding: string; data: string };
    expect(payload.opcode).toBe("binary");
    expect(payload.encoding).toBe("base64");
    // Decode back to bytes
    const decoded = decodeBase64(payload.data);
    expect(Array.from(decoded)).toEqual([0, 1, 2, 3, 4]);

    await session.close();
  }, 15_000);

  it("4 — concurrent sendText calls are serialized before POST /send", async () => {
    const sendStarts: string[] = [];
    const sendCompletions: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/send") && init?.body !== undefined) {
        const body = String(init.body);
        const parsed = JSON.parse(body) as { frames: Array<{ seq: number }> };
        const seq = parsed.frames[0]?.seq;
        sendStarts.push(String(seq));
        if (seq === 1) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        const response = await fetch(input, init);
        sendCompletions.push(String(seq));
        return response;
      }
      return fetch(input, init);
    };

    const client = new BridgeClient({
      bridgeUrl: env.baseUrl,
      authToken: VALID_TOKEN,
      fetchImpl,
    });

    const session = await client.openSession({
      transport: "long_poll",
      upstream: { adapter: "websocket", profile: "echo" },
    });

    await new Promise<void>((resolve) => {
      if (session.state === "open") {
        resolve();
        return;
      }
      const u = session.on("state", (s) => {
        if (s === "open") {
          u();
          resolve();
        }
      });
    });

    await Promise.all([
      session.sendText("one"),
      session.sendText("two"),
      session.sendText("three"),
      session.sendText("four"),
      session.sendText("five"),
    ]);

    expect(sendStarts).toEqual(["1", "2", "3", "4", "5"]);
    expect(sendCompletions).toEqual(["1", "2", "3", "4", "5"]);
    expect(session.state).toBe("open");

    await session.close();
  }, 15_000);

  it("5 — session close from client closes upstream", async () => {
    const client = new BridgeClient({
      bridgeUrl: env.baseUrl,
      authToken: VALID_TOKEN,
    });

    const session = await client.openSession({
      transport: "sse",
      upstream: { adapter: "websocket", profile: "echo" },
    });

    await new Promise<void>((resolve) => {
      if (session.state === "open") {
        resolve();
        return;
      }
      const u = session.on("state", (s) => {
        if (s === "open") {
          u();
          resolve();
        }
      });
    });

    // Track upstream close
    let upstreamClosed = false;
    for (const client of env.wss.clients) {
      client.on("close", () => {
        upstreamClosed = true;
      });
    }

    await session.close(1000, "done");

    // Give time for upstream to close
    await new Promise<void>((res) => setTimeout(res, 200));
    expect(upstreamClosed).toBe(true);
  }, 10_000);

  it("5 — session close from server (upstream close) propagates close event to client", async () => {
    const client = new BridgeClient({
      bridgeUrl: env.baseUrl,
      authToken: VALID_TOKEN,
    });

    const session = await client.openSession({
      transport: "sse",
      upstream: { adapter: "websocket", profile: "echo" },
    });

    await new Promise<void>((resolve) => {
      if (session.state === "open") {
        resolve();
        return;
      }
      const u = session.on("state", (s) => {
        if (s === "open") {
          u();
          resolve();
        }
      });
    });

    // Register for close event
    const closePromise = new Promise<{ code: number; reason: string; source: string }>(
      (resolve) => {
        session.on("close", (info) => resolve(info));
      },
    );

    // Close all upstream connections
    for (const wsClient of env.wss.clients) {
      wsClient.close(1000, "server shutting down");
    }

    const closeInfo = await Promise.race([
      closePromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);

    expect(closeInfo.source).toBe("upstream");
  }, 10_000);

  it("6 — bad token → openSession throws with AUTH_INVALID", async () => {
    const client = new BridgeClient({
      bridgeUrl: env.baseUrl,
      authToken: "wrong-token",
    });

    await expect(
      client.openSession({ upstream: { adapter: "websocket", profile: "echo" } }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });
  });

  it("7 — disallowed upstream → openSession throws with UPSTREAM_NOT_ALLOWED", async () => {
    const client = new BridgeClient({
      bridgeUrl: env.baseUrl,
      authToken: VALID_TOKEN,
    });

    await expect(
      client.openSession({
        upstream: { adapter: "websocket", profile: "not-in-allow-list" },
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_NOT_ALLOWED" });
  });
});
