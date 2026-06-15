import type { BridgeEnvelope } from "@https2wss/protocol";
import { describe, expect, it, vi } from "vitest";
import { Session, type SessionConfig, type SessionEvent } from "../src/sessions/Session.js";

const BASE_CONFIG: SessionConfig = {
  id: "h2w_testabcdefghijkl",
  transportMode: "sse",
  upstreamProfile: "echo",
  idleTimeoutMs: 60_000,
  maxDurationMs: 3_600_000,
  frameBuffer: {
    maxFrameBytes: 1024,
    maxBufferedFrames: 100,
    maxBufferedBytes: 65536,
    overflowPolicy: "close",
  },
  createdAt: 1_000_000,
};

function makeSession(overrides: Partial<SessionConfig> = {}): Session {
  return new Session({ ...BASE_CONFIG, ...overrides });
}

function makeEnvelope(seq: number): BridgeEnvelope {
  return {
    v: 1,
    sid: BASE_CONFIG.id,
    seq,
    kind: "data",
    ts: new Date().toISOString(),
    payload: { opcode: "text", encoding: "utf8", data: "hi", fin: true },
  };
}

describe("Session — initial state", () => {
  it("starts in connecting state with correct id and transportMode", () => {
    const s = makeSession();
    expect(s.state).toBe("connecting");
    expect(s.id).toBe(BASE_CONFIG.id);
    expect(s.transportMode).toBe("sse");
    expect(s.upstreamState).toBe("connecting");
  });

  it("lastActivityAt equals createdAt at construction", () => {
    const s = makeSession();
    expect(s.lastActivityAt).toBe(BASE_CONFIG.createdAt);
  });
});

describe("Session — touch", () => {
  it("touch(now) updates lastActivityAt", () => {
    const s = makeSession();
    s.touch(2_000_000);
    expect(s.lastActivityAt).toBe(2_000_000);
  });
});

describe("Session — valid state transitions", () => {
  it("connecting → open via markUpstreamOpen returns true", () => {
    const s = makeSession();
    expect(s.markUpstreamOpen(1_001_000)).toBe(true);
    expect(s.state).toBe("open");
    expect(s.upstreamState).toBe("open");
  });

  it("connecting → closing via markClosing returns true", () => {
    const s = makeSession();
    expect(s.markClosing(1_001_000, "client", 1000, "done")).toBe(true);
    expect(s.state).toBe("closing");
  });

  it("connecting → errored via markErrored returns true", () => {
    const s = makeSession();
    expect(s.markErrored(1_001_000)).toBe(true);
    expect(s.state).toBe("errored");
  });

  it("open → closing via markClosing returns true", () => {
    const s = makeSession();
    s.markUpstreamOpen(1_001_000);
    expect(s.markClosing(1_002_000, "bridge", 1001, "going away")).toBe(true);
    expect(s.state).toBe("closing");
  });

  it("open → errored via markErrored returns true", () => {
    const s = makeSession();
    s.markUpstreamOpen(1_001_000);
    expect(s.markErrored(1_002_000)).toBe(true);
    expect(s.state).toBe("errored");
  });

  it("closing → closed via markClosed returns true and emits closed event", () => {
    const s = makeSession();
    s.markUpstreamOpen(1_001_000);
    s.markClosing(1_002_000, "client", 1000, "done");

    const events: SessionEvent[] = [];
    s.on((ev) => events.push(ev));

    expect(s.markClosed(1_003_000, "client", 1000, "done")).toBe(true);
    expect(s.state).toBe("closed");

    const closed = events.find((e) => e.type === "closed");
    expect(closed).toBeDefined();
    if (closed?.type === "closed") {
      expect(closed.code).toBe(1000);
      expect(closed.reason).toBe("done");
      expect(closed.source).toBe("client");
    }
  });

  it("errored → closed via markClosed returns true", () => {
    const s = makeSession();
    s.markErrored(1_001_000);
    expect(s.markClosed(1_002_000, "bridge", 1011, "internal error")).toBe(true);
    expect(s.state).toBe("closed");
  });
});

describe("Session — illegal transitions (no-ops)", () => {
  it("closed → markUpstreamOpen returns false and does not change state", () => {
    const s = makeSession();
    s.markUpstreamOpen(1_001_000);
    s.markClosing(1_002_000, "client", 1000, "done");
    s.markClosed(1_003_000, "client", 1000, "done");

    const events: SessionEvent[] = [];
    s.on((ev) => events.push(ev));

    expect(s.markUpstreamOpen(1_004_000)).toBe(false);
    expect(s.state).toBe("closed");
    expect(events).toHaveLength(0);
  });

  it("closed → markClosing returns false", () => {
    const s = makeSession();
    s.markUpstreamOpen(1_001_000);
    s.markClosing(1_002_000, "client", 1000, "done");
    s.markClosed(1_003_000, "client", 1000, "done");

    expect(s.markClosing(1_004_000, "bridge", 1000, "nope")).toBe(false);
    expect(s.state).toBe("closed");
  });

  it("closed → markErrored returns false", () => {
    const s = makeSession();
    s.markUpstreamOpen(1_001_000);
    s.markClosing(1_002_000, "client", 1000, "done");
    s.markClosed(1_003_000, "client", 1000, "done");

    expect(s.markErrored(1_004_000)).toBe(false);
    expect(s.state).toBe("closed");
  });

  it("open → markUpstreamOpen returns false (already past connecting)", () => {
    const s = makeSession();
    s.markUpstreamOpen(1_001_000);
    expect(s.markUpstreamOpen(1_002_000)).toBe(false);
  });

  it("connecting → markClosed returns false (must go through closing/errored first)", () => {
    const s = makeSession();
    expect(s.markClosed(1_001_000, "bridge", 1000, "done")).toBe(false);
    expect(s.state).toBe("connecting");
  });
});

describe("Session — event subscription", () => {
  it("state_changed events are emitted for valid transitions", () => {
    const s = makeSession();
    const events: SessionEvent[] = [];
    s.on((ev) => events.push(ev));

    s.markUpstreamOpen(1_001_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("state_changed");
    if (events[0]?.type === "state_changed") {
      expect(events[0].state).toBe("open");
    }
  });

  it("no events emitted for illegal transitions", () => {
    const s = makeSession();
    s.markUpstreamOpen(1_001_000);
    s.markClosing(1_002_000, "client", 1000, "done");
    s.markClosed(1_003_000, "client", 1000, "done");

    const events: SessionEvent[] = [];
    s.on((ev) => events.push(ev));

    s.markUpstreamOpen(1_004_000); // illegal
    expect(events).toHaveLength(0);
  });

  it("unsubscribe stops further event delivery", () => {
    const s = makeSession();
    const events: SessionEvent[] = [];
    const unsub = s.on((ev) => events.push(ev));

    s.markUpstreamOpen(1_001_000);
    expect(events).toHaveLength(1);

    unsub();
    s.markClosing(1_002_000, "client", 1000, "done");
    expect(events).toHaveLength(1); // no more events after unsubscribe
  });

  it("emitOutbound fires outbound_frame event", () => {
    const s = makeSession();
    const events: SessionEvent[] = [];
    s.on((ev) => events.push(ev));

    const env = makeEnvelope(1);
    s.emitOutbound(env);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("outbound_frame");
    if (events[0]?.type === "outbound_frame") {
      expect(events[0].envelope).toBe(env);
    }
  });

  it("multiple handlers all receive events", () => {
    const s = makeSession();
    const a: SessionEvent[] = [];
    const b: SessionEvent[] = [];
    s.on((ev) => a.push(ev));
    s.on((ev) => b.push(ev));

    s.markUpstreamOpen(1_001_000);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe("Session — toSnapshot", () => {
  it("returns current state including upstreamState", () => {
    const s = makeSession();
    s.markUpstreamOpen(1_001_000);

    const snap = s.toSnapshot(1_001_000);
    expect(snap.sessionId).toBe(BASE_CONFIG.id);
    expect(snap.state).toBe("open");
    expect(snap.upstream.state).toBe("open");
    expect(snap.transportMode).toBe("sse");
    expect(snap.createdAt).toBe(new Date(BASE_CONFIG.createdAt).toISOString());
  });

  it("lastActivityAt in snapshot reflects touch() calls", () => {
    const s = makeSession();
    s.touch(1_500_000);

    const snap = s.toSnapshot(1_500_000);
    expect(snap.lastActivityAt).toBe(new Date(1_500_000).toISOString());
  });
});

describe("Session — sequencer and buffer are wired", () => {
  it("sequencer.nextOut() mints increasing sequence numbers", () => {
    const s = makeSession();
    expect(s.sequencer.nextOut()).toBe(1);
    expect(s.sequencer.nextOut()).toBe(2);
  });

  it("buffer.store then buffer.since work correctly", () => {
    const s = makeSession();
    const env = makeEnvelope(s.sequencer.nextOut());
    const stored = s.buffer.store(env, 50);
    expect(stored.ok).toBe(true);
    expect(s.buffer.since(0)).toHaveLength(1);
  });
});

// Suppress unused import warning from vi — it's used for spy capability if needed
void vi;
