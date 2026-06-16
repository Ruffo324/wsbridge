/**
 * demoClient.ts — sends "hello from node" through the proxy and logs the echo.
 *
 * Usage:
 *   HTTPS2WSS_TOKEN=dev-token-1234 tsx src/demoClient.ts
 *
 * Environment variables:
 *   HTTPS2WSS_TOKEN  — bearer token (required)
 *   BRIDGE_URL       — proxy URL (default: http://127.0.0.1:8080)
 */

import { Https2WssSocket } from "@https2wss/client";

const bridgeUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:8080";
const authToken = process.env.HTTPS2WSS_TOKEN;

if (authToken === undefined || authToken === "") {
  console.error("ERROR: HTTPS2WSS_TOKEN environment variable is required");
  process.exit(1);
}

console.log(`connecting to proxy at ${bridgeUrl} with profile "echo"`);

// 5-second safety timeout — exit 2 if no message received
const safetyTimeout = setTimeout(() => {
  console.error("TIMEOUT: no echo received within 5 seconds");
  process.exit(2);
}, 5000);

const socket = new Https2WssSocket("wss://echo", {
  bridgeUrl,
  authToken,
  upstreamProfile: "echo",
});

socket.onopen = () => {
  console.log("socket open — sending hello");
  socket.send("hello from node");
};

socket.onmessage = (ev: MessageEvent) => {
  console.log(`echo received: ${String(ev.data)}`);
  clearTimeout(safetyTimeout);
  socket.close();
  // Give close handshake a moment, then exit
  setTimeout(() => process.exit(0), 200);
};

socket.onerror = () => {
  console.error("socket error");
  clearTimeout(safetyTimeout);
  process.exit(1);
};
