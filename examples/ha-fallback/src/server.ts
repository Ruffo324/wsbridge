/**
 * server.ts — static HTTP server for the ha-fallback demo.
 *
 * Serves:
 *   /              → examples/ha-fallback/public/index.html
 *   /index.html    → same
 *   /lib/client/index.js → packages/client/dist/index.js  (browser ESM bundle)
 *
 * Usage:
 *   tsx src/server.ts
 * Then open http://localhost:3001
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.resolve(__dirname, "../public");
const CLIENT_DIST = path.resolve(__dirname, "../../../packages/client/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath);
  return MIME[ext] ?? "application/octet-stream";
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mimeFor(filePath) });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/" || url === "/index.html") {
    serveFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  // /lib/client/index.js → packages/client/dist/index.js
  if (url.startsWith("/lib/client/")) {
    const rel = url.slice("/lib/client/".length);
    serveFile(res, path.join(CLIENT_DIST, rel));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const port = Number(process.env.PORT ?? 3001);
server.listen(port, () => {
  console.log(`ha-fallback demo at http://localhost:${port}`);
  console.log(`  /                    → public/index.html`);
  console.log(`  /lib/client/...      → packages/client/dist/...`);
});
