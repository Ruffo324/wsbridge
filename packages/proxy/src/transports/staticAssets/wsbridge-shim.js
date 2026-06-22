// https2wss bridge — HA frontend WebSocket shim.
//
// Drop this file into HA's /config/www/ AND reference it from configuration.yaml:
//
//   frontend:
//     extra_module_url:
//       - /local/wsbridge-shim.js
//
// Then edit the BRIDGE_URL / BRIDGE_TOKEN / UPSTREAM_PROFILE constants below
// to match your add-on configuration before placing this file.
//
// What it does: replaces window.WebSocket so any HA frontend code that opens
// a connection to URL ending in "/api/websocket" automatically uses the
// https2wss bridge. Other WebSocket connections are unaffected.

import { Https2WssSocket } from "BRIDGE_URL_PLACEHOLDER/_/lib/client/index.js";

const BRIDGE_URL = "BRIDGE_URL_PLACEHOLDER";
const BRIDGE_TOKEN = "BRIDGE_TOKEN_PLACEHOLDER";
const UPSTREAM_PROFILE = "ha-core";

const NativeWS = window.WebSocket;
function defineWebSocketConstants(socket) {
  for (const [key, value] of [
    ["CONNECTING", NativeWS.CONNECTING],
    ["OPEN", NativeWS.OPEN],
    ["CLOSING", NativeWS.CLOSING],
    ["CLOSED", NativeWS.CLOSED],
  ]) {
    if (socket[key] === undefined) {
      Object.defineProperty(socket, key, { value, configurable: true });
    }
  }
  return socket;
}
const wrapped = function (url, protocols) {
  if (typeof url === "string" && url.replace(/\?.*$/, "").endsWith("/api/websocket")) {
    return defineWebSocketConstants(new Https2WssSocket(url, {
      bridgeUrl: BRIDGE_URL,
      authToken: BRIDGE_TOKEN,
      upstreamProfile: UPSTREAM_PROFILE,
      transport: "sse",
    }));
  }
  return new NativeWS(url, protocols);
};
Object.assign(wrapped, {
  CONNECTING: NativeWS.CONNECTING,
  OPEN: NativeWS.OPEN,
  CLOSING: NativeWS.CLOSING,
  CLOSED: NativeWS.CLOSED,
});
window.WebSocket = wrapped;
