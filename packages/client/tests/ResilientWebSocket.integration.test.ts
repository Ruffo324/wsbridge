/**
 * Integration tests for ResilientWebSocket against the real proxy + ws echo server.
 *
 * "Native" path in Node:
 *   We inject `ws.WebSocket` as the native WebSocket constructor — it has the
 *   same surface and connects to the actual echo server.  This is a reasonable
 *   Node-side stand-in for the real browser API (the behaviour under test is the
 *   open/message/close event wiring, which ws.WebSocket faithfully reproduces).
 *
 * Cookie persistence:
 *   Tests use an in-memory CookieJar so state doesn't leak between test runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as WsWebSocket } from "ws";
import { ResilientWebSocket } from "../src/ResilientWebSocket.js";
import type { CookieJar } from "../src/resilient/cookies.js";
import { startEchoServer, startProxyWithEcho, VALID_TOKEN } from "./helpers/setupProxy.js";

type ProxyEnv = Awaited<ReturnType<typeof startProxyWithEcho>>;

// ── In-memory CookieJar ───────────────────────────────────────────────────

function makeMemoryCookieJar(): CookieJar {
  const store = new Map<string, string>();
  return {
    get(name) {
      return store.get(name);
    },
    set(name, value) {
      store.set(name, value);
    },
    delete(name) {
      store.delete(name);
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function waitOpen(rws: ResilientWebSocket, timeoutMs = 8000): Promise<void> {
  if (rws.readyState === 1) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitOpen timed out")), timeoutMs);
    rws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function waitMessage(rws: ResilientWebSocket, timeoutMs = 5000): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitMessage timed out")), timeoutMs);
    rws.onmessage = (ev) => {
      clearTimeout(timer);
      resolve(ev.data);
    };
  });
}

// ── Proxy env ─────────────────────────────────────────────────────────────

let env: ProxyEnv;

beforeEach(async () => {
  env = await startProxyWithEcho();
}, 15_000);

afterEach(async () => {
  await env.cleanup();
}, 10_000);

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ResilientWebSocket integration", () => {
  it("1 — bridge path: text echo round-trip (webSocketCtor undefined)", async () => {
    const cookies = makeMemoryCookieJar();

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: {
        bridgeUrl: env.baseUrl,
        authToken: VALID_TOKEN,
        upstreamProfile: "echo",
      },
      webSocketCtor: undefined, // force bridge path
      cookies,
      cookieTtlMs: 3600000,
    });

    await waitOpen(rws, 10_000);
    expect(rws.readyState).toBe(1);
    expect(rws.transport).toBe("bridge");

    const msgPromise = waitMessage(rws, 5000);
    rws.send("hello integration");
    const data = await msgPromise;
    expect(data).toBe("hello integration");

    rws.close();
  }, 20_000);

  it("2 — forced fallback via always-failing ctor: bridge echo still works", async () => {
    const cookies = makeMemoryCookieJar();

    // Stub ctor that always fails immediately
    class AlwaysErrorWs extends EventTarget {
      readonly url: string;
      readyState: 0 | 1 | 2 | 3 = 3;
      bufferedAmount = 0;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent | Event) => void) | null = null;

      constructor(url: string) {
        super();
        this.url = url;
        // Fire error asynchronously so the ResilientWebSocket handlers are set up first
        Promise.resolve()
          .then(() => {
            this.onerror?.(new Event("error"));
          })
          .catch(() => {
            /* noop */
          });
      }

      send(): void {
        throw new DOMException("Not open", "InvalidStateError");
      }
      close(): void {
        /* noop */
      }
    }

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: {
        bridgeUrl: env.baseUrl,
        authToken: VALID_TOKEN,
        upstreamProfile: "echo",
      },
      webSocketCtor: AlwaysErrorWs as unknown as typeof WebSocket,
      cookies,
      cookieTtlMs: 3600000,
      nativeConnectTimeoutMs: 500,
    });

    const transportChanges: string[] = [];
    rws.addEventListener("transport-change", (ev) => {
      transportChanges.push((ev as CustomEvent<{ reason: string }>).detail.reason);
    });

    await waitOpen(rws, 10_000);
    expect(rws.transport).toBe("bridge");
    expect(transportChanges).toContain("connect-failure");

    const msgPromise = waitMessage(rws, 5000);
    rws.send("forced fallback test");
    const data = await msgPromise;
    expect(data).toBe("forced fallback test");

    rws.close();
  }, 20_000);

  it("3 — sticky cookie: second ResilientWebSocket skips native entirely", async () => {
    const cookies = makeMemoryCookieJar();

    class AlwaysErrorWs2 extends EventTarget {
      readonly url: string;
      readyState: 0 | 1 | 2 | 3 = 3;
      bufferedAmount = 0;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent | Event) => void) | null = null;

      constructor(url: string) {
        super();
        this.url = url;
        Promise.resolve()
          .then(() => {
            this.onerror?.(new Event("error"));
          })
          .catch(() => {
            /* noop */
          });
      }

      send(): void {
        throw new DOMException("Not open", "InvalidStateError");
      }
      close(): void {
        /* noop */
      }
    }

    let nativeCtorCallCount = 0;

    class CountingWs extends AlwaysErrorWs2 {
      constructor(url: string) {
        super(url);
        nativeCtorCallCount++;
      }
    }

    // Instance 1: sets cookie via fallback
    const rws1 = new ResilientWebSocket("wss://echo", {
      bridge: { bridgeUrl: env.baseUrl, authToken: VALID_TOKEN, upstreamProfile: "echo" },
      webSocketCtor: CountingWs as unknown as typeof WebSocket,
      cookies,
      cookieTtlMs: 3600000,
    });

    await waitOpen(rws1, 10_000);
    expect(rws1.transport).toBe("bridge");
    rws1.close();

    // Verify cookie was written
    expect(cookies.get("h2w-fallback")).toBeDefined();

    const callsAfterFirst = nativeCtorCallCount; // should be 1

    // Instance 2: reads cookie, skips native
    const rws2 = new ResilientWebSocket("wss://echo", {
      bridge: { bridgeUrl: env.baseUrl, authToken: VALID_TOKEN, upstreamProfile: "echo" },
      webSocketCtor: CountingWs as unknown as typeof WebSocket,
      cookies,
      cookieTtlMs: 3600000,
    });

    const tc2Promise = new Promise<string>((resolve) => {
      rws2.addEventListener("transport-change", (ev) => {
        resolve((ev as CustomEvent<{ reason: string }>).detail.reason);
      });
    });

    await waitOpen(rws2, 10_000);
    const reason = await tc2Promise;

    expect(reason).toBe("sticky-cookie");
    // CountingWs constructor was NOT called again
    expect(nativeCtorCallCount).toBe(callsAfterFirst);

    rws2.close();
  }, 30_000);

  it("4 — native ws.WebSocket connects directly to echo: text round-trip", async () => {
    // Start a raw echo server (no proxy) to test the pure native path
    const echo = await startEchoServer();
    const cookies = makeMemoryCookieJar();

    try {
      const rws = new ResilientWebSocket(echo.url, {
        bridge: {
          bridgeUrl: env.baseUrl,
          authToken: VALID_TOKEN,
          upstreamProfile: "echo",
        },
        webSocketCtor: WsWebSocket as unknown as typeof WebSocket,
        cookies,
        cookieTtlMs: 3600000,
      });

      await waitOpen(rws, 8000);
      expect(rws.transport).toBe("native");

      const msgPromise = waitMessage(rws, 4000);
      rws.send("native ws echo");
      const data = await msgPromise;
      expect(data).toBe("native ws echo");

      rws.close();
    } finally {
      await echo.cleanup();
    }
  }, 20_000);
});
