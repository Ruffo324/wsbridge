import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loadConfig.js";

function makeReadFile(yaml: string): (p: string) => string {
  return () => yaml;
}

describe("loadConfig", () => {
  it("loads minimal config with all defaults", () => {
    const cfg = loadConfig({
      path: "config.yml",
      readFile: makeReadFile("{}"),
    });
    expect(cfg.server.host).toBe("0.0.0.0");
    expect(cfg.server.port).toBe(8080);
    expect(cfg.sessions.idleTimeoutMs).toBe(120_000);
    expect(cfg.transports.enabled).toEqual(["sse", "long_poll", "poll"]);
    expect(cfg.logging.level).toBe("info");
  });

  it("parses a full config correctly", () => {
    const yaml = `
server:
  host: "127.0.0.1"
  port: 9090
security:
  requireAuth: true
  tokens:
    - env: MY_TOKEN
  cors:
    allowedOrigins:
      - "https://example.com"
  upstreamPolicy:
    default: deny
    allow:
      - name: echo
        adapter: websocket
        url: "ws://localhost:9001"
        allowedHeaders: []
        allowPrivateNetwork: false
sessions:
  idleTimeoutMs: 60000
  maxDurationMs: 1800000
  maxSessionsPerToken: 10
transports:
  enabled:
    - sse
    - long_poll
  sse:
    heartbeatIntervalMs: 15000
  longPoll:
    maxTimeoutMs: 20000
logging:
  level: debug
`;
    const cfg = loadConfig({ path: "config.yml", readFile: makeReadFile(yaml) });
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.server.port).toBe(9090);
    expect(cfg.security.requireAuth).toBe(true);
    expect(cfg.security.tokens).toEqual([{ env: "MY_TOKEN" }]);
    expect(cfg.security.cors.allowedOrigins).toEqual(["https://example.com"]);
    expect(cfg.security.upstreamPolicy.allow).toHaveLength(1);
    expect(cfg.security.upstreamPolicy.allow[0]?.name).toBe("echo");
    expect(cfg.sessions.idleTimeoutMs).toBe(60_000);
    expect(cfg.sessions.maxSessionsPerToken).toBe(10);
    expect(cfg.transports.enabled).toEqual(["sse", "long_poll"]);
    expect(cfg.transports.sse.heartbeatIntervalMs).toBe(15_000);
    expect(cfg.transports.longPoll.maxTimeoutMs).toBe(20_000);
    expect(cfg.logging.level).toBe("debug");
  });

  it("throws on missing file", () => {
    expect(() => loadConfig({ path: "/does/not/exist.yml" })).toThrow(/Failed to read/);
  });

  it("throws on invalid YAML", () => {
    expect(() =>
      loadConfig({
        path: "config.yml",
        readFile: makeReadFile("{ bad yaml: [unclosed"),
      }),
    ).toThrow(/Failed to parse/);
  });

  it("throws on invalid schema value with clear message", () => {
    const yaml = `
server:
  port: -1
`;
    expect(() => loadConfig({ path: "config.yml", readFile: makeReadFile(yaml) })).toThrow(
      /Config validation failed/,
    );
  });

  it("does not resolve env token values — leaves them as objects", () => {
    const yaml = `
security:
  tokens:
    - env: SOME_VAR
`;
    const cfg = loadConfig({ path: "config.yml", readFile: makeReadFile(yaml) });
    expect(cfg.security.tokens[0]).toEqual({ env: "SOME_VAR" });
  });
});
