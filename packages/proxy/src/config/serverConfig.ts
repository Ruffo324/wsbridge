import { z } from "zod";
import { securityConfigSchema } from "./securityConfig.js";

const serverSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(0).max(65535).default(8080),
  publicUrl: z.string().url().optional(),
});

const sessionsSchema = z.object({
  idleTimeoutMs: z.number().int().positive().default(120_000),
  maxDurationMs: z.number().int().positive().default(3_600_000),
  maxSessionsPerToken: z.number().int().positive().default(20),
  maxFrameBytes: z.number().int().positive().default(1_048_576),
  maxBufferedFrames: z.number().int().positive().default(1_000),
  maxBufferedBytes: z.number().int().positive().default(16_777_216),
  overflowPolicy: z.literal("close").default("close"),
  tickIntervalMs: z.number().int().positive().default(5_000),
});

const sseSchema = z.object({
  heartbeatIntervalMs: z.number().int().positive().default(30_000),
});

const longPollSchema = z.object({
  maxTimeoutMs: z.number().int().positive().default(30_000),
});

const transportsSchema = z.object({
  enabled: z.array(z.enum(["sse", "long_poll", "poll"])).default(["sse", "long_poll", "poll"]),
  sse: sseSchema.default({ heartbeatIntervalMs: 30_000 }),
  longPoll: longPollSchema.default({ maxTimeoutMs: 30_000 }),
});

const loggingSchema = z.object({
  level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  redactHeaders: z.array(z.string()).default(["authorization", "cookie"]),
});

const frontendProxySchema = z.object({
  enabled: z.boolean().default(false),
  /** Where the HA UI is exposed. Use "/" for a drop-in UI and keep /v1, /_/ and /healthz reserved for the bridge. */
  pathPrefix: z.string().default("/"),
  upstreamUrl: z.string().url().default("http://homeassistant:8123"),
  injectWebSocketShim: z.boolean().default(true),
  bridgeUrl: z.string().default(""),
  bridgeToken: z.string().default(""),
  upstreamProfile: z.string().default("ha-core"),
  transport: z.enum(["sse", "long_poll", "poll"]).default("long_poll"),
  nativeConnectTimeoutMs: z.number().int().nonnegative().default(1500),
  heartbeatTimeoutMs: z.number().int().positive().default(30_000),
});

export const serverConfigSchema = z.object({
  server: serverSchema.default({ host: "0.0.0.0", port: 8080 }),
  security: securityConfigSchema,
  sessions: sessionsSchema.default({
    idleTimeoutMs: 120_000,
    maxDurationMs: 3_600_000,
    maxSessionsPerToken: 20,
    maxFrameBytes: 1_048_576,
    maxBufferedFrames: 1_000,
    maxBufferedBytes: 16_777_216,
    overflowPolicy: "close",
    tickIntervalMs: 5_000,
  }),
  transports: transportsSchema.default({
    enabled: ["sse", "long_poll", "poll"],
    sse: { heartbeatIntervalMs: 30_000 },
    longPoll: { maxTimeoutMs: 30_000 },
  }),
  logging: loggingSchema.default({ level: "info", redactHeaders: ["authorization", "cookie"] }),
  frontendProxy: frontendProxySchema.default({
    enabled: false,
    pathPrefix: "/",
    upstreamUrl: "http://homeassistant:8123",
    injectWebSocketShim: true,
    bridgeUrl: "",
    bridgeToken: "",
    upstreamProfile: "ha-core",
    transport: "long_poll",
    nativeConnectTimeoutMs: 1500,
    heartbeatTimeoutMs: 30_000,
  }),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
