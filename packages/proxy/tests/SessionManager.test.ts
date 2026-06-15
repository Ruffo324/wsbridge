import { BridgeError } from "@https2wss/protocol";
import { describe, expect, it } from "vitest";
import { SessionManager, type SessionManagerConfig } from "../src/sessions/SessionManager.js";

const SID_REGEX = /^h2w_[A-Za-z0-9_-]{16,}$/;

function makeManager(overrides: Partial<SessionManagerConfig> = {}): {
  manager: SessionManager;
  now: { value: number };
} {
  const now = { value: 0 };
  const manager = new SessionManager({
    sessionDefaults: {
      idleTimeoutMs: 60_000,
      maxDurationMs: 3_600_000,
      frameBuffer: {
        maxFrameBytes: 1024,
        maxBufferedFrames: 100,
        maxBufferedBytes: 65536,
        overflowPolicy: "close",
      },
    },
    maxSessionsPerToken: 3,
    clock: () => now.value,
    ...overrides,
  });
  return { manager, now };
}

describe("SessionManager — create", () => {
  it("returns a session with an id matching the protocol regex", () => {
    const { manager } = makeManager();
    const session = manager.create({
      token: "tok1",
      transportMode: "sse",
      upstreamProfile: "echo",
    });
    expect(session.id).toMatch(SID_REGEX);
  });

  it("returned session starts in connecting state", () => {
    const { manager } = makeManager();
    const session = manager.create({
      token: "tok1",
      transportMode: "poll",
      upstreamProfile: "echo",
    });
    expect(session.state).toBe("connecting");
  });

  it("session is retrievable via get()", () => {
    const { manager } = makeManager();
    const session = manager.create({
      token: "tok1",
      transportMode: "sse",
      upstreamProfile: "echo",
    });
    expect(manager.get(session.id)).toBe(session);
  });

  it("each create produces a unique session id", () => {
    // Use a high quota manager so 10 creates with unique tokens never hit the limit
    const { manager } = makeManager({ maxSessionsPerToken: 100 });
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      ids.add(
        manager.create({ token: `tok-unique-${i}`, transportMode: "sse", upstreamProfile: "echo" })
          .id,
      );
    }
    expect(ids.size).toBe(10);
  });

  it("throws BridgeError(POLICY_DENIED) when token reaches maxSessionsPerToken", () => {
    const { manager } = makeManager({ maxSessionsPerToken: 2 });
    manager.create({ token: "tok-limited", transportMode: "sse", upstreamProfile: "echo" });
    manager.create({ token: "tok-limited", transportMode: "sse", upstreamProfile: "echo" });

    expect(() =>
      manager.create({ token: "tok-limited", transportMode: "sse", upstreamProfile: "echo" }),
    ).toThrowError(BridgeError);

    try {
      manager.create({ token: "tok-limited", transportMode: "sse", upstreamProfile: "echo" });
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      if (err instanceof BridgeError) {
        expect(err.code).toBe("POLICY_DENIED");
      }
    }
  });

  it("different tokens have independent quotas", () => {
    const { manager } = makeManager({ maxSessionsPerToken: 1 });
    expect(() =>
      manager.create({ token: "tokA", transportMode: "sse", upstreamProfile: "echo" }),
    ).not.toThrow();
    expect(() =>
      manager.create({ token: "tokB", transportMode: "sse", upstreamProfile: "echo" }),
    ).not.toThrow();
  });
});

describe("SessionManager — get and list", () => {
  it("get() returns undefined for an unknown session id", () => {
    const { manager } = makeManager();
    expect(manager.get("h2w_doesnotexist0123456")).toBeUndefined();
  });

  it("get() returns undefined after the session has been closed", () => {
    const { manager } = makeManager();
    const session = manager.create({
      token: "tok1",
      transportMode: "sse",
      upstreamProfile: "echo",
    });
    const id = session.id;

    manager.close(id, 1000, "done", "client");
    expect(manager.get(id)).toBeUndefined();
  });

  it("list() reflects current active sessions", () => {
    const { manager } = makeManager();
    expect(manager.list()).toHaveLength(0);

    const s1 = manager.create({ token: "tok1", transportMode: "sse", upstreamProfile: "echo" });
    const s2 = manager.create({ token: "tok1", transportMode: "sse", upstreamProfile: "echo" });
    expect(manager.list()).toHaveLength(2);

    manager.close(s1.id, 1000, "done", "client");
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]).toBe(s2);
  });
});

describe("SessionManager — close", () => {
  it("close transitions the session to closed", () => {
    const { manager } = makeManager();
    const session = manager.create({
      token: "tok1",
      transportMode: "sse",
      upstreamProfile: "echo",
    });
    const events: string[] = [];
    session.on((ev) => events.push(ev.type));

    manager.close(session.id, 1000, "done", "client");

    expect(events).toContain("closed");
  });

  it("close reduces countByToken", () => {
    const { manager } = makeManager();
    const s1 = manager.create({ token: "mytoken", transportMode: "sse", upstreamProfile: "echo" });
    manager.create({ token: "mytoken", transportMode: "sse", upstreamProfile: "echo" });

    expect(manager.countByToken("mytoken")).toBe(2);
    manager.close(s1.id, 1000, "done", "client");
    expect(manager.countByToken("mytoken")).toBe(1);
  });

  it("close on unknown session id is a no-op (does not throw)", () => {
    const { manager } = makeManager();
    expect(() => manager.close("h2w_doesnotexist0123456", 1000, "done", "bridge")).not.toThrow();
  });
});

describe("SessionManager — tick: idle timeout", () => {
  it("tick closes sessions idle longer than idleTimeoutMs (source: timeout)", () => {
    const { manager, now } = makeManager();
    now.value = 0;

    const session = manager.create({
      token: "tok1",
      transportMode: "sse",
      upstreamProfile: "echo",
    });
    const id = session.id;

    // Advance past idle timeout
    now.value = 60_001;
    const closed = manager.tick();

    expect(closed).toBe(1);
    expect(manager.get(id)).toBeUndefined();
  });

  it("tick does not close a session that was touched recently", () => {
    const { manager, now } = makeManager();
    now.value = 0;

    const session = manager.create({
      token: "tok1",
      transportMode: "sse",
      upstreamProfile: "echo",
    });
    const id = session.id;

    // Touch at t=30000 (halfway through idle timeout)
    now.value = 30_000;
    session.touch(now.value);

    // Advance to t=70000 — only 40s since last touch, under the 60s idle timeout
    now.value = 70_000;
    const closed = manager.tick();

    expect(closed).toBe(0);
    expect(manager.get(id)).toBeDefined();
  });

  it("tick does not close a session that is within idle timeout", () => {
    const { manager, now } = makeManager();
    now.value = 0;

    const session = manager.create({
      token: "tok1",
      transportMode: "sse",
      upstreamProfile: "echo",
    });
    now.value = 30_000; // under 60s idle timeout
    const closed = manager.tick();

    expect(closed).toBe(0);
    expect(manager.get(session.id)).toBeDefined();
  });
});

describe("SessionManager — tick: max duration", () => {
  it("tick closes sessions that exceed maxDurationMs regardless of activity", () => {
    const { manager, now } = makeManager();
    now.value = 0;

    const session = manager.create({
      token: "tok1",
      transportMode: "sse",
      upstreamProfile: "echo",
    });
    const id = session.id;

    // Keep touching to reset idle, but exceed max duration
    now.value = 3_600_001;
    session.touch(now.value); // touches so idle is near zero

    const closed = manager.tick();
    expect(closed).toBe(1);
    expect(manager.get(id)).toBeUndefined();
  });
});

describe("SessionManager — countByToken", () => {
  it("returns 0 for a token with no sessions", () => {
    const { manager } = makeManager();
    expect(manager.countByToken("unknown-token")).toBe(0);
  });

  it("returns correct count across create and close operations", () => {
    const { manager } = makeManager();
    const s1 = manager.create({ token: "t", transportMode: "sse", upstreamProfile: "echo" });
    const s2 = manager.create({ token: "t", transportMode: "sse", upstreamProfile: "echo" });
    expect(manager.countByToken("t")).toBe(2);

    manager.close(s1.id, 1000, "done", "client");
    expect(manager.countByToken("t")).toBe(1);

    manager.close(s2.id, 1000, "done", "client");
    expect(manager.countByToken("t")).toBe(0);
  });
});
