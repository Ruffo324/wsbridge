import type { Level, Logger } from "pino";
import pino from "pino";

export interface LoggerOptions {
  level?: Level;
  pretty?: boolean;
  redactPaths?: ReadonlyArray<string>;
}

const BASE_REDACT_PATHS: ReadonlyArray<string> = [
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "token",
  "tokens[*].value",
];

export function buildLogger(opts?: LoggerOptions): Logger {
  const level: Level = opts?.level ?? "info";
  const pretty = opts?.pretty ?? false;

  const callerPaths = opts?.redactPaths ?? [];
  const redactPaths = [...BASE_REDACT_PATHS, ...callerPaths];

  const baseOptions: pino.LoggerOptions = {
    level,
    redact: {
      paths: redactPaths as string[],
      censor: "[Redacted]",
    },
  };

  if (pretty) {
    return pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: { colorize: true },
      },
    });
  }

  return pino(baseOptions);
}

export type { Logger };
