/**
 * Static asset routes — unauthenticated, wide CORS.
 *
 * Three GET endpoints registered BEFORE the bearer-auth hook so they are
 * accessible without a token:
 *
 *   GET /_/lib/client/index.js  — @https2wss/client browser bundle
 *   GET /_/lib/ha/index.js      — @https2wss/home-assistant-adapter browser bundle
 *   GET /_/shim/wsbridge.js     — ready-to-paste HA frontend WebSocket shim
 *
 * All three responses carry:
 *   Content-Type:                application/javascript; charset=utf-8
 *   Cache-Control:               public, max-age=300
 *   Access-Control-Allow-Origin: *
 *   Access-Control-Allow-Methods: GET, OPTIONS
 *
 * If the underlying file is not present (build not yet run) the route returns
 * 404 with a JSON error body.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

// ── Header helpers ────────────────────────────────────────────────────────────

const JS_HEADERS = {
  "content-type": "application/javascript; charset=utf-8",
  "cache-control": "public, max-age=300",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

// ── File readers ──────────────────────────────────────────────────────────────

/**
 * Attempt to read a file; return its contents as a string, or null if not found.
 */
function tryRead(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve a path relative to THIS compiled module's location.
 * After `pnpm deploy --prod`, the layout is:
 *   dist/transports/staticAssets.js        ← this file
 *   dist/transports/staticAssets/wsbridge-shim.js
 * so a sibling-directory lookup works correctly in production.
 */
function resolveLocal(relativePath: string): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, relativePath);
}

/**
 * Resolve a path inside a node_modules package installed alongside this proxy.
 * We walk up from the compiled module to the package root and then into
 * node_modules.
 */
function resolveNodeModule(packagePath: string): string {
  const __filename = fileURLToPath(import.meta.url);
  // dist/transports/staticAssets.js → walk up two dirs to reach package root
  const __dirname = dirname(__filename);
  const packageRoot = join(__dirname, "..", "..");
  return join(packageRoot, "node_modules", packagePath);
}

// ── Route registrar ───────────────────────────────────────────────────────────

export function registerStaticAssets(fastify: FastifyInstance): void {
  // ── GET /_/lib/client/index.js ─────────────────────────────────────────────
  fastify.get("/_/lib/client/index.js", async (_req, reply) => {
    const filePath = resolveNodeModule("@https2wss/client/dist/browser/index.js");
    const content = tryRead(filePath);
    if (content === null) {
      return reply.code(404).send({
        error:
          "Client browser bundle not present — run `pnpm build` in the https2wss workspace first.",
      });
    }
    return reply.code(200).headers(JS_HEADERS).send(content);
  });

  // ── GET /_/lib/ha/index.js ─────────────────────────────────────────────────
  fastify.get("/_/lib/ha/index.js", async (_req, reply) => {
    const filePath = resolveNodeModule("@https2wss/home-assistant-adapter/dist/browser/index.js");
    const content = tryRead(filePath);
    if (content === null) {
      return reply.code(404).send({
        error:
          "Home Assistant adapter browser bundle not present — run `pnpm build` in the https2wss workspace first.",
      });
    }
    return reply.code(200).headers(JS_HEADERS).send(content);
  });

  // ── GET /_/shim/wsbridge.js ────────────────────────────────────────────────
  fastify.get("/_/shim/wsbridge.js", async (_req, reply) => {
    const filePath = resolveLocal("staticAssets/wsbridge-shim.js");
    const content = tryRead(filePath);
    if (content === null) {
      return reply.code(404).send({
        error:
          "Shim file not found — this is a packaging error; ensure staticAssets/wsbridge-shim.js is present alongside the compiled proxy.",
      });
    }
    return reply.code(200).headers(JS_HEADERS).send(content);
  });
}
