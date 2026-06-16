/**
 * run-demo.mjs — orchestrates the standalone echo demo.
 *
 * 1. Spawns echoServer (PORT=9001)
 * 2. Spawns proxyServer (HTTPS2WSS_TOKEN from env)
 * 3. Polls /healthz until proxy is ready (max 15s)
 * 4. Spawns demoClient (profile: "echo" → ws://127.0.0.1:9001)
 * 5. On client exit, kills proxy + echo; propagates exit code.
 *
 * Profile selection:
 *   Standalone mode uses profile "echo" (ws://127.0.0.1:9001) declared in config.yml.
 *   Docker Compose mode uses profile "echo-docker" (ws://echo:9001).
 *   No URL mutation required — both profiles coexist in config.yml.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ECHO_DEMO = path.resolve(__dirname, "..");

const TOKEN = process.env.HTTPS2WSS_TOKEN ?? "dev-token-1234";
const BRIDGE_URL = "http://127.0.0.1:8080";

// Resolve the tsx CLI entrypoint. tsx's `bin` field points to dist/cli.mjs but
// the subpath is not in "exports", so we locate the package root via require.resolve
// on package.json and build the path from there. This is cross-platform and avoids
// using the .bin shell wrapper which Node cannot exec directly on Windows.
const require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(require.resolve("tsx/package.json"));
const TSX_CLI = path.join(tsxPkgDir, "dist", "cli.mjs");

/** Spawn a tsx process and pipe its stdout/stderr to the parent. */
function spawnTsx(srcFile, env = {}) {
  const child = spawn(process.execPath, [TSX_CLI, srcFile], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: ECHO_DEMO,
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${path.basename(srcFile, ".ts")}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${path.basename(srcFile, ".ts")}] ${d}`));
  return child;
}

/** Poll /healthz until 200 or timeout. */
async function waitForProxy(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BRIDGE_URL}/healthz`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`proxy did not become healthy within ${timeoutMs}ms`);
}

function kill(child) {
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

async function main() {
  console.log("[demo] starting echo server …");
  const echo = spawnTsx(path.join(ECHO_DEMO, "src", "echoServer.ts"), { PORT: "9001" });

  console.log("[demo] starting proxy …");
  const proxy = spawnTsx(path.join(ECHO_DEMO, "src", "proxyServer.ts"), {
    HTTPS2WSS_TOKEN: TOKEN,
  });

  let exitCode = 0;

  try {
    console.log("[demo] waiting for proxy /healthz …");
    await waitForProxy();
    console.log("[demo] proxy ready — starting demo client …");

    exitCode = await new Promise((resolve) => {
      const client = spawnTsx(path.join(ECHO_DEMO, "src", "demoClient.ts"), {
        HTTPS2WSS_TOKEN: TOKEN,
        BRIDGE_URL,
      });
      client.on("exit", (code) => resolve(code ?? 0));
    });

    console.log(`[demo] client exited with code ${exitCode}`);
  } catch (err) {
    console.error(`[demo] ERROR: ${err.message}`);
    exitCode = 1;
  } finally {
    console.log("[demo] shutting down proxy + echo …");
    kill(proxy);
    kill(echo);
    // Give them a moment to flush
    await new Promise((r) => setTimeout(r, 500));
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[demo] fatal:", err);
  process.exit(1);
});
