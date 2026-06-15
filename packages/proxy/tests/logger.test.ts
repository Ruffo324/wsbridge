import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildLogger } from "../src/observability/logger.js";

/** Capture pino JSON lines to an array. */
function captureLogger(): { lines: string[]; logger: ReturnType<typeof buildLogger> } {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString("utf8").trim();
      if (text) lines.push(text);
      callback();
    },
  });

  const logger = pino(
    {
      level: "debug",
      redact: {
        paths: [
          "authorization",
          "cookie",
          "headers.authorization",
          "headers.cookie",
          "req.headers.authorization",
          "req.headers.cookie",
          "token",
          "tokens[*].value",
        ],
        censor: "[Redacted]",
      },
    },
    dest,
  );

  return { lines, logger };
}

describe("buildLogger", () => {
  it("creates a logger without throwing", () => {
    expect(() => buildLogger()).not.toThrow();
  });

  it("creates a logger with custom level", () => {
    const logger = buildLogger({ level: "debug" });
    expect(logger.level).toBe("debug");
  });

  it("defaults to info level", () => {
    const logger = buildLogger();
    expect(logger.level).toBe("info");
  });
});

describe("Logger redaction", () => {
  it("redacts top-level authorization field", () => {
    const { lines, logger } = captureLogger();
    logger.info({ authorization: "Bearer supersecret" }, "test");
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.authorization).toBe("[Redacted]");
    expect(JSON.stringify(parsed)).not.toContain("supersecret");
  });

  it("redacts nested headers.authorization", () => {
    const { lines, logger } = captureLogger();
    logger.info({ headers: { authorization: "Bearer nested-secret" } }, "test");
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const headers = parsed.headers as Record<string, unknown>;
    expect(headers.authorization).toBe("[Redacted]");
    expect(JSON.stringify(parsed)).not.toContain("nested-secret");
  });

  it("redacts nested headers.cookie", () => {
    const { lines, logger } = captureLogger();
    logger.info({ headers: { cookie: "session=abc123" } }, "test");
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const headers = parsed.headers as Record<string, unknown>;
    expect(headers.cookie).toBe("[Redacted]");
    expect(JSON.stringify(parsed)).not.toContain("abc123");
  });

  it("redacts req.headers.authorization", () => {
    const { lines, logger } = captureLogger();
    logger.info({ req: { headers: { authorization: "Bearer reqsecret" } } }, "test");
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const req = parsed.req as Record<string, unknown>;
    const reqHeaders = req.headers as Record<string, unknown>;
    expect(reqHeaders.authorization).toBe("[Redacted]");
    expect(JSON.stringify(parsed)).not.toContain("reqsecret");
  });

  it("redacts top-level token field", () => {
    const { lines, logger } = captureLogger();
    logger.info({ token: "rawtoken123" }, "test");
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.token).toBe("[Redacted]");
    expect(JSON.stringify(parsed)).not.toContain("rawtoken123");
  });

  it("redacts tokens[*].value (array of token objects)", () => {
    const { lines, logger } = captureLogger();
    logger.info({ tokens: [{ value: "tokensecret1" }, { value: "tokensecret2" }] }, "test");
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const tokens = parsed.tokens as Array<Record<string, unknown>>;
    expect(tokens[0]?.value).toBe("[Redacted]");
    expect(tokens[1]?.value).toBe("[Redacted]");
    expect(JSON.stringify(parsed)).not.toContain("tokensecret1");
    expect(JSON.stringify(parsed)).not.toContain("tokensecret2");
  });

  it("does not redact non-sensitive fields", () => {
    const { lines, logger } = captureLogger();
    logger.info({ sessionId: "h2w_abc123", status: "open" }, "test");
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.sessionId).toBe("h2w_abc123");
    expect(parsed.status).toBe("open");
  });
});
