import { parse as yamlParse } from "yaml";
import { ZodError } from "zod";
import { type ServerConfig, serverConfigSchema } from "./serverConfig.js";

export interface LoadConfigOptions {
  /** Path to the YAML config file. */
  path: string;
  /** Inject env (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Inject fs.readFileSync (for tests). */
  readFile?: (p: string) => string;
}

/**
 * Load and validate the server configuration from a YAML file.
 *
 * Token env vars are NOT resolved here — that responsibility stays in buildAuth.
 * This function only parses and validates the schema structure.
 */
export function loadConfig(opts: LoadConfigOptions): ServerConfig {
  const readFile =
    opts.readFile ??
    ((p: string): string => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      return fs.readFileSync(p, "utf8");
    });

  let raw: string;
  try {
    raw = readFile(opts.path);
  } catch (err) {
    throw new Error(
      `Failed to read config file "${opts.path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yamlParse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse YAML config file "${opts.path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    return serverConfigSchema.parse(parsed ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const path = first !== undefined ? first.path.join(".") : "unknown";
      const message = first !== undefined ? first.message : "validation error";
      throw new Error(`Config validation failed at "${path}": ${message}`);
    }
    throw err;
  }
}
