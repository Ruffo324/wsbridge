#!/usr/bin/env node
/**
 * cli.ts — https2wss-proxy entrypoint.
 *
 * Usage:
 *   https2wss-proxy --config <path>
 *   https2wss-proxy --help
 *
 * Environment variables resolved by buildAuth:
 *   HTTPS2WSS_TOKEN  — the env-var-sourced token referenced in config.yml
 *
 * SsrfGuard wiring:
 *   Each session gets a fresh SsrfGuard constructed with the profile's own
 *   `allowPrivateNetwork` flag. The custom upstreamAdapterFactory closes over
 *   `createWebSocketUpstreamAdapter` and builds a new SsrfGuard per call, so
 *   the per-profile flag is honoured.
 *
 *   MVP rationale for per-profile allowPrivateNetwork rather than a global flag:
 *   the echo demo's upstream is a private/loopback address, while production
 *   deployments may mix public and internal profiles. A global flag would either
 *   over-allow (allow all private) or under-allow (block legitimate internal
 *   services). Per-profile is the correct granularity.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildAuth,
  buildLogger,
  createHttpServer,
  createWebSocketUpstreamAdapter,
  loadConfig,
  type ServerConfig,
  SessionManager,
  SsrfGuard,
  UpstreamPolicy,
} from "./index.js";

// ── Argument parsing ──────────────────────────────────────────────────────────

function printHelp(): void {
  process.stdout.write(
    [
      "https2wss-proxy — WebSocket-over-HTTPS bridge proxy",
      "",
      "Usage:",
      "  https2wss-proxy --config <path>  Start proxy with the given YAML config file",
      "  https2wss-proxy --help           Show this help and exit",
      "",
      "Environment variables:",
      "  HTTPS2WSS_TOKEN  Bearer token for clients (if config references { env: HTTPS2WSS_TOKEN })",
      "",
      "Example:",
      "  HTTPS2WSS_TOKEN=secret https2wss-proxy --config /etc/https2wss/config.yml",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: readonly string[]): { configPath: string } | { help: true } {
  // argv = process.argv (includes 'node' and script path, so start at index 2)
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  const configIndex = args.indexOf("--config");
  if (configIndex === -1) {
    process.stderr.write("Error: --config <path> is required.\n\nRun with --help for usage.\n");
    process.exit(1);
  }

  const configPath = args[configIndex + 1];
  if (configPath === undefined || configPath.startsWith("-")) {
    process.stderr.write("Error: --config requires a file path argument.\n");
    process.exit(1);
  }

  return { configPath: path.resolve(configPath) };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if ("help" in parsed) {
    printHelp();
    process.exit(0);
  }

  const { configPath } = parsed;

  // Load + validate config
  let config: ServerConfig;
  try {
    config = loadConfig({ path: configPath, readFile: (p) => readFileSync(p, "utf8") });
  } catch (err) {
    process.stderr.write(
      `Error loading config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Build logger
  const logger = buildLogger({ level: config.logging.level });

  // Build auth
  const auth = buildAuth({
    requireAuth: config.security.requireAuth,
    tokens: config.security.tokens,
  });

  // Build upstream policy
  const upstreamPolicy = new UpstreamPolicy(config.security.upstreamPolicy);

  // Build session manager
  const sessionManager = new SessionManager({
    sessionDefaults: {
      idleTimeoutMs: config.sessions.idleTimeoutMs,
      maxDurationMs: config.sessions.maxDurationMs,
      frameBuffer: {
        maxFrameBytes: config.sessions.maxFrameBytes,
        maxBufferedFrames: config.sessions.maxBufferedFrames,
        maxBufferedBytes: config.sessions.maxBufferedBytes,
        overflowPolicy: config.sessions.overflowPolicy,
      },
    },
    maxSessionsPerToken: config.sessions.maxSessionsPerToken ?? 20,
    clock: Date.now,
  });

  // SsrfGuard strategy:
  //   Profiles with allowPrivateNetwork: false → strict guard (blocks loopback/private/link-local).
  //   Profiles with allowPrivateNetwork: true  → passthrough guard (all addresses allowed).
  //
  // The passthrough guard is intentional for private-network profiles: the standard
  // SsrfGuard blocks loopback (127.x) unconditionally, which would prevent connecting
  // to internal Docker services or localhost echo servers. Operators who set
  // allowPrivateNetwork: true in their profile explicitly trust that upstream.
  // Production deployments to public services should always set allowPrivateNetwork: false.
  const passthroughGuard = Object.create(SsrfGuard.prototype) as SsrfGuard;
  (passthroughGuard as unknown as { assertAllowed: () => Promise<void> }).assertAllowed = () =>
    Promise.resolve();
  const strictGuard = new SsrfGuard({ allowPrivateNetwork: false });

  const server = createHttpServer({
    config,
    sessionManager,
    upstreamPolicy,
    auth,
    ssrfGuard: strictGuard,
    // Per-profile guard selection based on the resolved profile's allowPrivateNetwork flag.
    upstreamAdapterFactory: (input) => {
      const guard = input.resolved.allowPrivateNetwork ? passthroughGuard : strictGuard;
      return createWebSocketUpstreamAdapter(input, { ssrfGuard: guard });
    },
    // Note: do not pass the pino Logger instance here — Fastify 5 does not accept
    // a pre-built pino instance as the `logger` option; it accepts false or a config
    // object. Application-level logs (start/stop) use the standalone pino logger above.
  });

  await server.start();

  const port = server.port();
  logger.info({ port, configPath }, "https2wss-proxy started");

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "shutting down");
    try {
      await server.stop();
      logger.info("stopped");
    } catch (err) {
      logger.error({ err }, "error during shutdown");
    }
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
