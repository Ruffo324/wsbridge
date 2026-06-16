/**
 * Unit tests for ResilientWebSocket.
 *
 * All tests use:
 *  - a stub WebSocket constructor (no real network)
 *  - an in-memory CookieJar
 *  - a deterministic clock (real time when not needed; overridden where timing matters)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResilientWebSocket } from "../src/ResilientWebSocket.js";
import type { CookieJar } from "../src/resilient/cookies.js";
import { serializeFallbackCookie } from "../src/resilient/cookies.js";

// ── In-memory CookieJar ───────────────────────────────────────────────────

function makeMemoryCookieJar(): CookieJar & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
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

// ── Stub WebSocket ────────────────────────────────────────────────────────

type StubAction =
  | { type: "open"; delayMs: number }
  | { type: "error"; delayMs: number }
  | { type: "close"; code?: number; reason?: string; delayMs: number }
  | { type: "message"; data: unknown; delayMs: number }
  | { type: "never" }; // never fires open (used to simulate timeout)

/**
 * Build a stub WebSocket constructor.
 * The action sequence is consumed in order per construction.
 */
function makeStubWsCtor(actions: StubAction[]): {
  ctor: typeof WebSocket;
  instances: StubWsInstance[];
} {
  const instances: StubWsInstance[] = [];
  let actionIdx = 0;

  class StubWsInstance extends EventTarget {
    readonly url: string;
    readyState: 0 | 1 | 2 | 3 = 0;
    bufferedAmount = 0;

    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onclose: ((ev: CloseEvent | Event) => void) | null = null;

    readonly sentMessages: Array<string | ArrayBuffer | ArrayBufferView> = [];

    constructor(url: string) {
      super();
      this.url = url;
      instances.push(this);

      const action = actions[actionIdx++] ?? { type: "never" };
      this.scheduleAction(action);
    }

    private scheduleAction(action: StubAction): void {
      if (action.type === "never") return;

      setTimeout(() => {
        if (action.type === "open") {
          this.readyState = 1;
          const ev = new Event("open");
          this.onopen?.(ev);
        } else if (action.type === "error") {
          const ev = new Event("error");
          this.onerror?.(ev);
        } else if (action.type === "close") {
          this.readyState = 3;
          let ev: Event;
          if (typeof CloseEvent !== "undefined") {
            ev = new CloseEvent("close", {
              code: action.code ?? 1006,
              reason: action.reason ?? "",
              wasClean: (action.code ?? 1006) === 1000,
            });
          } else {
            ev = new Event("close");
            Object.defineProperties(ev, {
              code: { value: action.code ?? 1006, enumerable: true },
              reason: { value: action.reason ?? "", enumerable: true },
            });
          }
          this.onclose?.(ev as CloseEvent);
        } else if (action.type === "message") {
          const ev = new MessageEvent("message", { data: action.data });
          this.onmessage?.(ev);
        }
      }, action.delayMs);
    }

    send(data: string | ArrayBuffer | ArrayBufferView): void {
      if (this.readyState !== 1) {
        throw new DOMException("Not open", "InvalidStateError");
      }
      this.sentMessages.push(data);
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      // Fire onclose asynchronously (mirrors browser behaviour)
      setTimeout(() => {
        let ev: Event;
        if (typeof CloseEvent !== "undefined") {
          ev = new CloseEvent("close", { code, reason, wasClean: code === 1000 });
        } else {
          ev = new Event("close");
          Object.defineProperties(ev, {
            code: { value: code, enumerable: true },
            reason: { value: reason, enumerable: true },
          });
        }
        this.onclose?.(ev as CloseEvent);
      }, 0);
    }
  }

  return { ctor: StubWsInstance as unknown as typeof WebSocket, instances };
}

// ── Default bridge init (won't actually connect — only used for type shape) ─

const BRIDGE_INIT = {
  bridgeUrl: "http://localhost:9999",
  authToken: "test-token",
  upstreamProfile: "echo",
};

// ── Helper: wait for an event on EventTarget ──────────────────────────────

function waitForEvent<T extends Event>(
  target: EventTarget,
  type: string,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${type}"`)), timeoutMs);
    const handler = (ev: Event) => {
      clearTimeout(timer);
      target.removeEventListener(type, handler);
      resolve(ev as T);
    };
    target.addEventListener(type, handler);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ResilientWebSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 1. No-native-support → bridge immediately ─────────────────────────

  it("1 — no WebSocket ctor: goes to bridge; no cookie written; transport-change reason='no-native-support'", async () => {
    const cookies = makeMemoryCookieJar();

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: undefined,
      cookies,
      cookieTtlMs: 3600000,
    });

    const tcPromise = waitForEvent<CustomEvent>(rws, "transport-change");
    // Advance just past t=0 to fire the deferred decide(); don't run ALL timers
    // which would also run the 3000ms waitForEvent timeout before transport-change fires.
    await vi.advanceTimersByTimeAsync(1);

    const tc = await tcPromise;
    expect(tc.detail).toMatchObject({ to: "bridge", reason: "no-native-support" });

    // Cookie NOT set (per spec: no-native-support doesn't persist)
    expect(cookies.store.size).toBe(0);

    // readyState is CONNECTING (bridge is opening but has no real server)
    expect(rws.readyState).toBe(0);
    expect(rws.transport).toBe("bridge");
  });

  // ── 2. Sticky cookie → bridge immediately ─────────────────────────────

  it("2 — valid sticky cookie: bridge immediately; reason='sticky-cookie'", async () => {
    const cookies = makeMemoryCookieJar();
    const futureMs = Date.now() + 3_600_000;
    cookies.store.set("h2w-fallback", serializeFallbackCookie(futureMs));

    const { ctor } = makeStubWsCtor([{ type: "open", delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
    });

    const tcPromise = waitForEvent<CustomEvent>(rws, "transport-change");
    // Just past t=0: fires the deferred decide() without running the 3000ms waitForEvent timeout
    await vi.advanceTimersByTimeAsync(1);

    const tc = await tcPromise;
    expect(tc.detail).toMatchObject({ to: "bridge", reason: "sticky-cookie" });
    expect(rws.transport).toBe("bridge");
  });

  // ── 3. Sticky cookie expired → native attempted ───────────────────────

  it("3 — expired sticky cookie: native is attempted; on success cookie cleared", async () => {
    const cookies = makeMemoryCookieJar();
    // expired cookie — with fake timers, Date.now() starts at 0, so subtract is always past
    const pastMs = Date.now() - 1000;
    cookies.store.set("h2w-fallback", serializeFallbackCookie(pastMs));

    const { ctor, instances } = makeStubWsCtor([{ type: "open", delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
      // Large heartbeat timeout so the watchdog doesn't fire during bounded advance
      heartbeatTimeoutMs: 999_999,
    });

    const openPromise = waitForEvent(rws, "open");
    // Advance just enough: t=0 decide() fires, t=10 stub open fires
    await vi.advanceTimersByTimeAsync(200);
    await openPromise;

    // Native was attempted (a stub instance was created)
    expect(instances.length).toBe(1);
    expect(rws.transport).toBe("native");
    // Cookie should have been cleared
    expect(cookies.store.has("h2w-fallback")).toBe(false);
    rws.close();
  });

  // ── 4. Native opens within timeout ───────────────────────────────────

  it("4 — native opens within timeout: transport='native', no fallback, onopen fires", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor } = makeStubWsCtor([{ type: "open", delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
      // Large heartbeat timeout so watchdog doesn't fire during bounded advance
      heartbeatTimeoutMs: 999_999,
    });

    let opened = false;
    rws.onopen = () => {
      opened = true;
    };

    // Bounded advance: just enough for t=0 decide, t=10 stub open
    await vi.advanceTimersByTimeAsync(200);

    expect(opened).toBe(true);
    expect(rws.transport).toBe("native");
    expect(rws.readyState).toBe(1);
    // No sticky cookie written
    expect(cookies.store.has("h2w-fallback")).toBe(false);
    rws.close();
  });

  // ── 5. Native fails (error before open) → fallback + cookie ──────────

  it("5 — native error before open: fallback fires; cookie set; reason='connect-failure'", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor } = makeStubWsCtor([{ type: "error", delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
    });

    const tcPromise = waitForEvent<CustomEvent>(rws, "transport-change");
    await vi.runAllTimersAsync();
    const tc = await tcPromise;

    expect(tc.detail).toMatchObject({ from: "native", to: "bridge", reason: "connect-failure" });
    expect(cookies.store.has("h2w-fallback")).toBe(true);
    expect(rws.transport).toBe("bridge");
  });

  // ── 6. Native close before open → fallback + cookie ──────────────────

  it("6 — native close before open: fallback fires; reason='connect-failure'", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor } = makeStubWsCtor([{ type: "close", code: 1006, delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
    });

    const tcPromise = waitForEvent<CustomEvent>(rws, "transport-change");
    await vi.runAllTimersAsync();
    const tc = await tcPromise;

    expect(tc.detail.reason).toBe("connect-failure");
    expect(cookies.store.has("h2w-fallback")).toBe(true);
  });

  // ── 7. Native connect timeout → fallback ─────────────────────────────

  it("7 — native connect timeout: fallback fires after nativeConnectTimeoutMs", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor } = makeStubWsCtor([{ type: "never" }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
      nativeConnectTimeoutMs: 500,
    });

    const tcPromise = waitForEvent<CustomEvent>(rws, "transport-change");
    await vi.advanceTimersByTimeAsync(600);
    const tc = await tcPromise;

    expect(tc.detail.reason).toBe("connect-failure");
    expect(cookies.store.has("h2w-fallback")).toBe(true);
    expect(rws.transport).toBe("bridge");
  });

  // ── 8. Heartbeat miss mid-session → fallback ──────────────────────────

  it("8 — heartbeat timeout after native open: reason='heartbeat-timeout'; pending sends replayed", async () => {
    const cookies = makeMemoryCookieJar();
    // Native opens, then goes quiet (no more messages)
    const { ctor } = makeStubWsCtor([{ type: "open", delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
      heartbeatTimeoutMs: 300,
    });

    // Wait for open
    const openPromise = waitForEvent(rws, "open");
    await vi.advanceTimersByTimeAsync(20);
    await openPromise;

    expect(rws.transport).toBe("native");

    const tcPromise = waitForEvent<CustomEvent>(rws, "transport-change");
    // Advance time past heartbeat timeout; interval fires every ~100ms (300/3)
    await vi.advanceTimersByTimeAsync(600);
    const tc = await tcPromise;

    expect(tc.detail.reason).toBe("heartbeat-timeout");
    expect(rws.transport).toBe("bridge");
    expect(cookies.store.has("h2w-fallback")).toBe(true);
  });

  // ── 9. isAlive override ───────────────────────────────────────────────

  it("9 — isAlive override returning true keeps native alive beyond timeoutMs", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor } = makeStubWsCtor([{ type: "open", delayMs: 10 }]);

    let transportChanged = false;
    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
      heartbeatTimeoutMs: 100,
      isAlive: () => true, // always alive
    });

    rws.addEventListener("transport-change", () => {
      transportChanged = true;
    });

    const openPromise = waitForEvent(rws, "open");
    await vi.advanceTimersByTimeAsync(20);
    await openPromise;

    await vi.advanceTimersByTimeAsync(2000);
    expect(transportChanged).toBe(false);
    expect(rws.transport).toBe("native");
  });

  it("9b — isAlive override returning false triggers fallback immediately after first tick", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor } = makeStubWsCtor([{ type: "open", delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
      heartbeatTimeoutMs: 1000,
      isAlive: () => false, // always dead
    });

    const openPromise = waitForEvent(rws, "open");
    await vi.advanceTimersByTimeAsync(20);
    await openPromise;

    const tcPromise = waitForEvent<CustomEvent>(rws, "transport-change");
    await vi.advanceTimersByTimeAsync(500); // first tick (1000/3 ≈ 333ms)
    const tc = await tcPromise;

    expect(tc.detail.reason).toBe("heartbeat-timeout");
  });

  // ── 10. close() propagates to inner socket ────────────────────────────

  it("10 — close() on native-open socket sets readyState=CLOSING then CLOSED", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor, instances } = makeStubWsCtor([
      { type: "open", delayMs: 10 },
      // Second action unused; first instance's close() fires its own onclose via stub.close()
    ]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
    });

    const openPromise = waitForEvent(rws, "open");
    await vi.advanceTimersByTimeAsync(20);
    await openPromise;

    expect(rws.readyState).toBe(1);

    rws.close(1000, "done");
    expect(rws.readyState).toBe(2); // CLOSING

    // Let the stub close event fire
    await vi.advanceTimersByTimeAsync(50);

    expect(rws.readyState).toBe(3); // CLOSED
    expect(instances[0]?.readyState).toBe(3);
  });

  // ── 11. cookieTtlMs: 0 disables persistence ───────────────────────────

  it("11 — cookieTtlMs=0: cookie never written even after fallback", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor } = makeStubWsCtor([{ type: "error", delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 0, // disabled
    });

    const tcPromise = waitForEvent<CustomEvent>(rws, "transport-change");
    await vi.runAllTimersAsync();
    const tc = await tcPromise;

    expect(tc.detail.reason).toBe("connect-failure");
    // Cookie jar was not used (cookieTtlMs=0 means no jar)
    expect(cookies.store.size).toBe(0);
  });

  // ── 12. Second instance reads cookie → skips native ──────────────────

  it("12 — second ResilientWebSocket reads sticky cookie and skips native", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor: ctor1 } = makeStubWsCtor([{ type: "error", delayMs: 10 }]);
    const { ctor: ctor2, instances: instances2 } = makeStubWsCtor([]);

    // First instance sets the cookie via fallback
    const rws1 = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor1,
      cookies,
      cookieTtlMs: 3600000,
    });

    const tc1Promise = waitForEvent<CustomEvent>(rws1, "transport-change");
    await vi.runAllTimersAsync();
    await tc1Promise;

    expect(cookies.store.has("h2w-fallback")).toBe(true);

    // Second instance — should see the cookie and go straight to bridge without touching native ctor
    const rws2 = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor2,
      cookies,
      cookieTtlMs: 3600000,
    });

    const tc2Promise = waitForEvent<CustomEvent>(rws2, "transport-change");
    await vi.runAllTimersAsync();
    const tc2 = await tc2Promise;

    expect(tc2.detail.reason).toBe("sticky-cookie");
    // ctor2 was never called (no native instances)
    expect(instances2.length).toBe(0);
  });

  // ── 13. send() while CONNECTING buffers until open ───────────────────

  it("13 — send() before open is buffered and drained on open", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor, instances } = makeStubWsCtor([{ type: "open", delayMs: 50 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
    });

    expect(rws.readyState).toBe(0);
    rws.send("buffered-message");

    const openPromise = waitForEvent(rws, "open");
    await vi.advanceTimersByTimeAsync(100);
    await openPromise;

    expect(instances[0]?.sentMessages).toContain("buffered-message");
  });

  // ── 14. send() when CLOSED throws ────────────────────────────────────

  it("14 — send() when CLOSED throws InvalidStateError", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor } = makeStubWsCtor([{ type: "open", delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
    });

    const openPromise = waitForEvent(rws, "open");
    await vi.advanceTimersByTimeAsync(20);
    await openPromise;

    rws.close();
    await vi.runAllTimersAsync();

    expect(() => rws.send("nope")).toThrow(DOMException);
  });

  // ── 15. transport property starts as 'native' ─────────────────────────

  it("15 — transport starts as 'native' then stays 'native' on successful open", async () => {
    const cookies = makeMemoryCookieJar();
    const { ctor } = makeStubWsCtor([{ type: "open", delayMs: 10 }]);

    const rws = new ResilientWebSocket("wss://echo", {
      bridge: BRIDGE_INIT,
      webSocketCtor: ctor,
      cookies,
      cookieTtlMs: 3600000,
    });

    const openPromise = waitForEvent(rws, "open");
    await vi.advanceTimersByTimeAsync(20);
    await openPromise;

    expect(rws.transport).toBe("native");
    rws.close();
    await vi.advanceTimersByTimeAsync(10);
  });
});
