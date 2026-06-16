/**
 * Unit tests for HeartbeatWatchdog.
 * All timing is deterministic via injected clock.
 */

import { describe, expect, it, vi } from "vitest";
import { HeartbeatWatchdog } from "../../src/resilient/heartbeat.js";

describe("HeartbeatWatchdog", () => {
  it("does not fire onDead while activity is fresh", () => {
    let now = 1000;
    const onDead = vi.fn();
    const wd = new HeartbeatWatchdog({ timeoutMs: 500, clock: () => now, onDead });
    wd.start();

    now = 1300; // 300 ms — still within window
    wd.tick();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("fires onDead when age exceeds timeoutMs", () => {
    let now = 1000;
    const onDead = vi.fn();
    const wd = new HeartbeatWatchdog({ timeoutMs: 500, clock: () => now, onDead });
    wd.start();

    now = 1600; // 600 ms > 500 ms
    wd.tick();
    expect(onDead).toHaveBeenCalledOnce();
  });

  it("fires onDead exactly once even after multiple ticks", () => {
    let now = 1000;
    const onDead = vi.fn();
    const wd = new HeartbeatWatchdog({ timeoutMs: 500, clock: () => now, onDead });
    wd.start();

    now = 1600;
    wd.tick();
    now = 1700;
    wd.tick();
    now = 1800;
    wd.tick();
    expect(onDead).toHaveBeenCalledOnce();
  });

  it("recordActivity resets the deadline", () => {
    let now = 1000;
    const onDead = vi.fn();
    const wd = new HeartbeatWatchdog({ timeoutMs: 500, clock: () => now, onDead });
    wd.start();

    now = 1400; // 400 ms — close to threshold
    wd.recordActivity(); // reset
    now = 1800; // 400 ms after reset — still within window
    wd.tick();
    expect(onDead).not.toHaveBeenCalled();

    now = 2400; // 600 ms after last reset
    wd.tick();
    expect(onDead).toHaveBeenCalledOnce();
  });

  it("stop prevents future onDead calls", () => {
    let now = 1000;
    const onDead = vi.fn();
    const wd = new HeartbeatWatchdog({ timeoutMs: 500, clock: () => now, onDead });
    wd.start();
    wd.stop();

    now = 1600;
    wd.tick();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("does not fire before start() is called", () => {
    let now = 1000;
    const onDead = vi.fn();
    const wd = new HeartbeatWatchdog({ timeoutMs: 500, clock: () => now, onDead });

    now = 9999;
    wd.tick();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("isAlive override: returning true keeps connection alive past timeoutMs", () => {
    let now = 1000;
    const onDead = vi.fn();
    const wd = new HeartbeatWatchdog({
      timeoutMs: 500,
      clock: () => now,
      isAlive: (_age) => true, // always alive
      onDead,
    });
    wd.start();

    now = 5000; // way beyond timeout
    wd.tick();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("isAlive override: returning false immediately fires onDead", () => {
    let now = 1000;
    const onDead = vi.fn();
    const wd = new HeartbeatWatchdog({
      timeoutMs: 500,
      clock: () => now,
      isAlive: (_age) => false, // always dead
      onDead,
    });
    wd.start();

    now = 1001; // barely any time passed
    wd.tick();
    expect(onDead).toHaveBeenCalledOnce();
  });

  it("isDead is false before firing and true after", () => {
    let now = 1000;
    const onDead = vi.fn();
    const wd = new HeartbeatWatchdog({ timeoutMs: 500, clock: () => now, onDead });
    wd.start();

    expect(wd.isDead).toBe(false);
    now = 1600;
    wd.tick();
    expect(wd.isDead).toBe(true);
  });
});
