import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config/serverConfig.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const RESERVED_ROOT_PREFIXES = ["/v1/", "/_/", "/healthz"] as const;

export function normalizeProxyPathPrefix(pathPrefix: string): string {
  if (pathPrefix.trim() === "" || pathPrefix === "/") return "/";
  const prefixed = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

export function isFrontendProxyRequest(config: ServerConfig, url: string): boolean {
  const proxy = config.frontendProxy;
  if (proxy?.enabled !== true) return false;
  const path = url.split("?", 1)[0] ?? "/";
  const prefix = normalizeProxyPathPrefix(proxy.pathPrefix);
  if (prefix === "/") {
    return !RESERVED_ROOT_PREFIXES.some(
      (reserved) => path === reserved.slice(0, -1) || path.startsWith(reserved),
    );
  }
  return path === prefix || path.startsWith(`${prefix}/`);
}

function upstreamPathFor(config: ServerConfig, requestUrl: string): string {
  const prefix = normalizeProxyPathPrefix(config.frontendProxy.pathPrefix);
  if (prefix === "/") return requestUrl;
  const [path, query = ""] = requestUrl.split("?", 2);
  const rest = (path ?? "").slice(prefix.length) || "/";
  return query ? `${rest}?${query}` : rest;
}

function buildUpstreamUrl(config: ServerConfig, requestUrl: string): string {
  const base = config.frontendProxy.upstreamUrl.replace(/\/$/, "");
  const path = upstreamPathFor(config, requestUrl);
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function copyRequestHeaders(req: FastifyRequest, config: ServerConfig): Headers {
  const headers = new Headers();
  const upstreamOrigin = new URL(config.frontendProxy.upstreamUrl).origin;
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === "host" ||
      lower === "content-length" ||
      lower === "forwarded" ||
      lower.startsWith("x-forwarded-")
    )
      continue;
    if (lower === "origin") {
      headers.set(name, upstreamOrigin);
      continue;
    }
    if (lower === "referer") {
      if (typeof value === "string" && value.length > 0) {
        try {
          const referer = new URL(value);
          headers.set(name, `${upstreamOrigin}${referer.pathname}${referer.search}`);
        } catch {
          headers.set(name, upstreamOrigin);
        }
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function copyResponseHeaders(upstream: Response, reply: FastifyReply, req: FastifyRequest): void {
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "content-length" || lower === "content-encoding")
      return;
    if (lower.startsWith("access-control-")) return;
    // set-cookie is handled through getSetCookie when available.
    if (lower === "set-cookie") return;
    reply.header(name, value);
  });
  const requestOrigin = req.headers.origin;
  if (typeof requestOrigin === "string" && requestOrigin.length > 0) {
    reply.header("access-control-allow-origin", requestOrigin);
  }
  const withCookies = upstream.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = withCookies.getSetCookie?.() ?? [];
  if (cookies.length > 0) reply.header("set-cookie", cookies);
}

function escapeJsString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function shimScript(config: ServerConfig): string {
  const proxy = config.frontendProxy;
  const bridgeUrl = proxy.bridgeUrl || "window.location.origin";
  const bridgeUrlExpr = proxy.bridgeUrl ? escapeJsString(proxy.bridgeUrl) : bridgeUrl;
  return `import { Https2WssSocket } from "/_/lib/client/index.js";
const NativeWebSocket = window.WebSocket;
const BRIDGE_URL = ${bridgeUrlExpr};
const BRIDGE_TOKEN = ${escapeJsString(proxy.bridgeToken)};
const UPSTREAM_PROFILE = ${escapeJsString(proxy.upstreamProfile)};
async function disableHomeAssistantServiceWorker() {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // Best effort only: the WebSocket bridge must still install even when a
    // browser blocks cache/service-worker APIs.
  }
}
void disableHomeAssistantServiceWorker();
function isHomeAssistantWebSocketUrl(url) {
  const text = typeof url === "string" ? url : String(url && url.url ? url.url : url);
  return text.replace(/\\?.*$/, "").endsWith("/api/websocket");
}
function defineWebSocketConstants(socket) {
  for (const [key, value] of [
    ["CONNECTING", NativeWebSocket.CONNECTING],
    ["OPEN", NativeWebSocket.OPEN],
    ["CLOSING", NativeWebSocket.CLOSING],
    ["CLOSED", NativeWebSocket.CLOSED],
  ]) {
    if (socket[key] === undefined) {
      Object.defineProperty(socket, key, { value, configurable: true });
    }
  }
  return socket;
}
function WrappedWebSocket(url, protocols) {
  if (isHomeAssistantWebSocketUrl(url)) {
    return defineWebSocketConstants(new Https2WssSocket(String(url), {
      bridgeUrl: BRIDGE_URL,
      authToken: BRIDGE_TOKEN,
      upstreamProfile: UPSTREAM_PROFILE,
      transport: "sse",
    }));
  }
  return new NativeWebSocket(url, protocols);
}
WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;
WrappedWebSocket.prototype = NativeWebSocket.prototype;
window.WebSocket = WrappedWebSocket;
window.__HTTPS2WSS_HA_FRONTEND_PROXY__ = { enabled: true, upstreamProfile: UPSTREAM_PROFILE };
`;
}

function disabledServiceWorkerScript(): string {
  return `self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch {}
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch {}
    try { await self.registration.unregister(); } catch {}
    try {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) client.navigate(client.url);
    } catch {}
  })());
});
self.addEventListener("fetch", () => {});
`;
}

function injectShim(html: string): string {
  const tag = '<script type="module" src="/_/shim/ha-frontend.js"></script>';
  if (html.includes("/_/shim/ha-frontend.js")) return html;
  const headMatch = /<head(\s[^>]*)?>/i.exec(html);
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}\n${tag}\n${html.slice(insertAt)}`;
  }
  return `${tag}\n${html}`;
}

function bodyForProxy(req: FastifyRequest): Promise<BodyInit | undefined> | BodyInit | undefined {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const body = req.body as unknown;
  if (body === undefined || body === null) return undefined;
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else {
        params.set(key, String(value));
      }
    }
    return params.toString();
  }
  return JSON.stringify(body);
}

export function registerFrontendProxy(fastify: FastifyInstance, config: ServerConfig): void {
  if (config.frontendProxy?.enabled !== true) return;

  fastify.get("/_/shim/ha-frontend.js", async (_req, reply) => {
    return reply
      .code(200)
      .headers({
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      })
      .send(shimScript(config));
  });

  fastify.get("/service_worker.js", async (_req, reply) => {
    return reply
      .code(200)
      .headers({
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "service-worker-allowed": "/",
        "clear-site-data": '"cache"',
      })
      .send(disabledServiceWorkerScript());
  });

  fastify.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
    url: "*",
    handler: async (req, reply) => {
      if (!isFrontendProxyRequest(config, req.url))
        return reply.code(404).send({ error: "not found" });

      const upstreamUrl = buildUpstreamUrl(config, req.url);
      const method = req.method;
      let upstream: Response;
      try {
        upstream = await fetch(upstreamUrl, {
          method,
          headers: copyRequestHeaders(req, config),
          body: await bodyForProxy(req),
          redirect: "manual",
        });
      } catch (error) {
        fastify.log.error(
          { error, upstreamUrl, method, url: req.url },
          "frontend proxy request failed",
        );
        throw error;
      }

      copyResponseHeaders(upstream, reply, req);
      reply.code(upstream.status);

      if (method === "HEAD") return reply.send();

      const contentType = upstream.headers.get("content-type") ?? "";
      if (config.frontendProxy.injectWebSocketShim && contentType.includes("text/html")) {
        const text = await upstream.text();
        reply.header("content-type", contentType);
        reply.header("cache-control", "no-store");
        return reply.send(injectShim(text));
      }

      const bytes = Buffer.from(await upstream.arrayBuffer());
      return reply.send(bytes);
    },
  });
}
