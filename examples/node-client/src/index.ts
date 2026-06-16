/**
 * Minimal Node.js client example (spec §21.3).
 *
 * Requires a running https2wss proxy pointed at an echo WebSocket service.
 * See examples/echo/ for a self-contained demo that wires everything together.
 *
 * Usage:
 *   HTTPS2WSS_TOKEN=<token> tsx src/index.ts
 *
 * Or, point at the echo demo proxy:
 *   HTTPS2WSS_TOKEN=dev-token-1234 \
 *   BRIDGE_URL=http://localhost:8080 \
 *   tsx src/index.ts
 */

import { Https2WssSocket } from "@https2wss/client";

const socket = new Https2WssSocket("wss://echo", {
  bridgeUrl: process.env.BRIDGE_URL ?? "http://localhost:8080",
  authToken: process.env.HTTPS2WSS_TOKEN,
  upstreamProfile: "echo",
});

socket.addEventListener("open", () => {
  socket.send("hello from node");
});

socket.addEventListener("message", (event) => {
  const ev = event as MessageEvent;
  console.log(ev.data);
  socket.close();
});
