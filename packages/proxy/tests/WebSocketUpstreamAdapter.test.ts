import type { AddressInfo } from "node:net";
import type { BridgeEnvelope } from "@https2wss/protocol";
import { BridgeError } from "@https2wss/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { SsrfGuard } from "../src/security/ssrfGuard.js";
import type { ResolvedUpstream } from "../src/security/upstreamPolicy.js";
import { Session, type SessionConfig } from "../src/sessions/Session.js";
import { createWebSocketUpstreamAdapter } from "../src/upstream/WebSocketUpstreamAdapter.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const BASE_CONFIG: SessionConfig = {
  id: "h2w_test_upstream001",
  transportMode: "sse",
  upstreamProfile: "echo",
  idleTimeoutMs: 60_000,
  maxDurationMs: 3_600_000,
  frameBuffer: {
    maxFrameBytes: 1_048_576,
    maxBufferedFrames: 1_000,
    maxBufferedBytes: 10_485_760,
    overflowPolicy: "close",
  },
  createdAt: 1_000_000,
};

function makeSession(): Session {
  return new Session({ ...BASE_CONFIG });
}

/** A resolved upstream pointing to a local ws server. */
function makeResolved(port: number): ResolvedUpstream {
  return {
    profileName: "echo",
    adapter: "websocket",
    url: new URL(`ws://127.0.0.1:${port}`),
    allowedHeaders: [],
    allowPrivateNetwork: true,
  };
}

/** A no-op SsrfGuard that always allows — required so loopback is not denied in tests. */
function makeFakeSsrfGuard(): SsrfGuard {
  const fake = Object.create(SsrfGuard.prototype) as SsrfGuard;
  (fake as unknown as { assertAllowed: () => Promise<void> }).assertAllowed = () =>
    Promise.resolve();
  return fake;
}

/** Capture outbound frames emitted by a session. Returns frames array + unsubscribe fn. */
function captureFrames(session: Session): { frames: BridgeEnvelope[]; off: () => void } {
  const frames: BridgeEnvelope[] = [];
  const off = session.on((ev) => {
    if (ev.type === "outbound_frame") frames.push(ev.envelope);
  });
  return { frames, off };
}

/** Wait for a condition using polling — avoids real time dependencies. */
async function waitFor(
  condition: () => boolean,
  label = "condition",
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

// ── Echo server fixture ─────────────────────────────────────────────────────

describe("WebSocketUpstreamAdapter — integration", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      wss.on("listening", () => {
        port = (wss.address() as AddressInfo).port;
        resolve();
      });
      wss.on("connection", (client) => {
        // Echo server: relay every message back verbatim
        client.on("message", (data, isBinary) => {
          client.send(data, { binary: isBinary });
        });
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  // ── Test 1: connect echo upstream ───────────────────────────────────────

  it("connects to echo server and emits upstream_open control frame", async () => {
    const session = makeSession();
    const { frames, off } = captureFrames(session);

    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved: makeResolved(port), clientHeaders: {} },
      { ssrfGuard: makeFakeSsrfGuard() },
    );

    await adapter.connect();
    off();

    expect(session.state).toBe("open");
    expect(adapter.state).toBe("open");

    const controlFrame = frames.find((f) => f.kind === "control");
    expect(controlFrame).toBeDefined();
    expect(controlFrame?.payload).toMatchObject({ event: "upstream_open" });

    adapter.close(1000, "test done");
    await waitFor(() => adapter.state === "closed", "adapter closed after close()");
  });

  // ── Test 2: send text frame — receive echo via session listener ──────────

  it("echoes text frames back through session outbound listener", async () => {
    const session = makeSession();
    const { frames, off } = captureFrames(session);

    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved: makeResolved(port), clientHeaders: {} },
      { ssrfGuard: makeFakeSsrfGuard() },
    );

    await adapter.connect();
    adapter.sendText("hello world");

    await waitFor(() => frames.some((f) => f.kind === "data"), "data frame echoed");
    off();

    const dataFrame = frames.find((f) => f.kind === "data");
    expect(dataFrame?.payload).toMatchObject({
      opcode: "text",
      encoding: "utf8",
      data: "hello world",
      fin: true,
    });

    adapter.close(1000, "test done");
    await waitFor(() => adapter.state === "closed", "adapter closed");
  });

  // ── Test 3: send binary frame — receive binary echo ─────────────────────

  it("echoes binary frames as base64 data frames", async () => {
    const session = makeSession();
    const { frames, off } = captureFrames(session);

    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved: makeResolved(port), clientHeaders: {} },
      { ssrfGuard: makeFakeSsrfGuard() },
    );

    await adapter.connect();
    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    adapter.sendBinary(bytes);

    await waitFor(
      () =>
        frames.some(
          (f) => f.kind === "data" && (f.payload as { opcode: string }).opcode === "binary",
        ),
      "binary data frame echoed",
    );
    off();

    const dataFrame = frames.find(
      (f) => f.kind === "data" && (f.payload as { opcode: string }).opcode === "binary",
    );
    expect(dataFrame?.payload).toMatchObject({
      opcode: "binary",
      encoding: "base64",
      data: "AAECAwQ=",
      fin: true,
    });

    adapter.close(1000, "test done");
    await waitFor(() => adapter.state === "closed", "adapter closed");
  });

  // ── Test 4: upstream close propagates to client ──────────────────────────

  it("propagates upstream close event as close frame with source upstream", async () => {
    const session = makeSession();
    const { frames, off } = captureFrames(session);
    const closedEvents: Array<{ code: number; source: string }> = [];
    session.on((ev) => {
      if (ev.type === "closed") closedEvents.push({ code: ev.code, source: ev.source });
    });

    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved: makeResolved(port), clientHeaders: {} },
      { ssrfGuard: makeFakeSsrfGuard() },
    );

    await adapter.connect();

    // Make the server close the connection
    let serverClient: WebSocket | undefined;
    wss.once("connection", (client) => {
      serverClient = client;
    });
    // Connect a second time to grab the server-side socket for forced close
    // Instead, use the existing wss clients collection
    const clients = [...wss.clients];
    // Close all server-side clients — the one just connected is at the end
    for (const c of clients) {
      c.close(1001, "going away");
    }

    await waitFor(() => adapter.state === "closed", "adapter closed by server");
    off();

    const closeFrame = frames.find((f) => f.kind === "close");
    expect(closeFrame).toBeDefined();
    expect(closeFrame?.payload).toMatchObject({ source: "upstream" });

    // markClosed should have been called — session may have moved to errored or closing→closed
    expect(["closed", "errored"]).toContain(session.state);
    void serverClient; // suppress unused warning
  });

  // ── Test 5: connection failure creates structured error ──────────────────

  it("emits error frame and throws UPSTREAM_CONNECT_FAILED on connection failure", async () => {
    const session = makeSession();
    const { frames, off } = captureFrames(session);

    // Use a port nobody is listening on — pick a high port
    const badPort = 19999;
    const resolved = makeResolved(badPort);

    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved, clientHeaders: {} },
      { ssrfGuard: makeFakeSsrfGuard() },
    );

    let thrownErr: unknown;
    try {
      await adapter.connect();
    } catch (err) {
      thrownErr = err;
    }
    off();

    expect(thrownErr).toBeInstanceOf(BridgeError);
    expect((thrownErr as BridgeError).code).toBe("UPSTREAM_CONNECT_FAILED");
    expect(adapter.state).toBe("errored");

    const errorFrame = frames.find((f) => f.kind === "error");
    expect(errorFrame).toBeDefined();
  });

  // ── Test 6: connect timeout ──────────────────────────────────────────────

  it("throws UPSTREAM_CONNECT_FAILED on connect timeout (stubbed wsCtor)", async () => {
    const session = makeSession();
    const { frames, off } = captureFrames(session);

    // A fake WebSocket that never emits 'open' or 'error' — simulates a hang.
    // We use a minimal EventEmitter-compatible stub rather than extending the real WebSocket,
    // which would actually connect to the server.
    const { EventEmitter } = await import("node:events");
    class NeverOpenWs extends EventEmitter {
      constructor(_url: string | URL, _opts?: object) {
        super();
        // Never emit open — simulates a hung connection
      }
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      terminate(): void {
        // no-op
      }
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      close(): void {
        // no-op
      }
    }

    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved: makeResolved(port), clientHeaders: {} },
      {
        ssrfGuard: makeFakeSsrfGuard(),
        wsCtor: NeverOpenWs as unknown as typeof WebSocket,
        connectTimeoutMs: 50, // very short timeout
      },
    );

    let thrownErr: unknown;
    try {
      await adapter.connect();
    } catch (err) {
      thrownErr = err;
    }
    off();

    expect(thrownErr).toBeInstanceOf(BridgeError);
    expect((thrownErr as BridgeError).code).toBe("UPSTREAM_CONNECT_FAILED");
    expect((thrownErr as BridgeError).message).toContain("timed out");
    expect(adapter.state).toBe("errored");

    const errorFrame = frames.find((f) => f.kind === "error");
    expect(errorFrame).toBeDefined();
  });

  // ── Test 7: SSRF block path ──────────────────────────────────────────────

  it("emits error frame and throws POLICY_DENIED when SsrfGuard denies the connect", async () => {
    const session = makeSession();
    const { frames, off } = captureFrames(session);

    // Real SsrfGuard with default settings denies loopback
    const realGuard = new SsrfGuard({ allowPrivateNetwork: false });

    const resolved = makeResolved(port); // ws://127.0.0.1:<port> — loopback, will be denied

    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved, clientHeaders: {} },
      { ssrfGuard: realGuard },
    );

    let thrownErr: unknown;
    try {
      await adapter.connect();
    } catch (err) {
      thrownErr = err;
    }
    off();

    expect(thrownErr).toBeInstanceOf(BridgeError);
    expect((thrownErr as BridgeError).code).toBe("POLICY_DENIED");
    expect(adapter.state).toBe("errored");

    const errorFrame = frames.find((f) => f.kind === "error");
    expect(errorFrame).toBeDefined();
    expect((errorFrame?.payload as { code: string }).code).toBe("POLICY_DENIED");
  });

  // ── Test 8: sendText/sendBinary throw when not open ──────────────────────

  it("throws UPSTREAM_CLOSED when sendText is called before connect", () => {
    const session = makeSession();
    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved: makeResolved(port), clientHeaders: {} },
      { ssrfGuard: makeFakeSsrfGuard() },
    );

    expect(() => adapter.sendText("hello")).toThrow(
      expect.objectContaining({ code: "UPSTREAM_CLOSED" }),
    );
  });

  it("throws UPSTREAM_CLOSED when sendBinary is called before connect", () => {
    const session = makeSession();
    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved: makeResolved(port), clientHeaders: {} },
      { ssrfGuard: makeFakeSsrfGuard() },
    );

    expect(() => adapter.sendBinary(new Uint8Array([1, 2, 3]))).toThrow(
      expect.objectContaining({ code: "UPSTREAM_CLOSED" }),
    );
  });

  // ── Test 9: close is idempotent ───────────────────────────────────────────

  it("close() is idempotent when already closed or errored", async () => {
    const session = makeSession();
    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved: makeResolved(port), clientHeaders: {} },
      { ssrfGuard: makeFakeSsrfGuard() },
    );

    await adapter.connect();
    adapter.close(1000, "first");
    await waitFor(() => adapter.state === "closed", "adapter closed");

    // Should not throw on second close
    expect(() => adapter.close(1000, "second")).not.toThrow();
  });

  // ── Test 10: sequence numbers are monotonically increasing ───────────────

  it("emits frames with monotonically increasing seq numbers", async () => {
    const session = makeSession();
    const { frames, off } = captureFrames(session);

    const adapter = createWebSocketUpstreamAdapter(
      { session, resolved: makeResolved(port), clientHeaders: {} },
      { ssrfGuard: makeFakeSsrfGuard() },
    );

    await adapter.connect();
    adapter.sendText("msg1");
    adapter.sendText("msg2");

    await waitFor(() => frames.filter((f) => f.kind === "data").length >= 2, "two data frames");
    off();

    const seqs = frames.map((f) => f.seq);
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1] ?? 0;
      expect(seqs[i]).toBeGreaterThan(prev);
    }

    adapter.close(1000, "done");
    await waitFor(() => adapter.state === "closed", "adapter closed");
  });
});
