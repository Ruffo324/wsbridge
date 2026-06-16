# Adapter Authoring

This guide covers adding a new upstream adapter to the bridge.

## The UpstreamAdapter interface

Implement this interface from `@https2wss/proxy`:

```ts
interface UpstreamAdapter {
  connect(): Promise<void>;
  sendText(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(code: number, reason: string): void;
  readonly state: "connecting" | "open" | "closing" | "closed" | "errored";
}
```

And provide a factory function:

```ts
type UpstreamAdapterFactory = (input: UpstreamAdapterFactoryInput) => UpstreamAdapter;

interface UpstreamAdapterFactoryInput {
  session: Session;
  resolved: ResolvedUpstream;
  clientHeaders: Record<string, string>;
  signal?: AbortSignal;
}
```

The `ResolvedUpstream` from `UpstreamPolicy.resolve()` carries:

```ts
interface ResolvedUpstream {
  profileName: string;
  adapter: "websocket";
  url: URL;
  allowedHeaders: ReadonlyArray<string>;
  allowPrivateNetwork: boolean;
}
```

## Mandatory: SSRF and header policy at connect time

Call `SsrfGuard.assertAllowed(url)` before opening any network connection. Construct the guard from `input.resolved.allowPrivateNetwork`:

```ts
const guard = new SsrfGuard({ allowPrivateNetwork: input.resolved.allowPrivateNetwork });
await guard.assertAllowed(input.resolved.url);
```

Filter client-supplied headers through `HeaderPolicy`:

```ts
const filtered = new HeaderPolicy({
  allowedHeaders: input.resolved.allowedHeaders as string[],
}).filterOutbound(input.clientHeaders);
```

Both classes are exported from `@https2wss/proxy`. Omitting these steps creates SSRF and header-injection vulnerabilities.

## Mapping upstream events to bridge frames

Use `session.emitOutbound(envelope)` to publish frames to the client:

```ts
import { buildEnvelope } from "@https2wss/protocol";

// Text message from upstream
const envelope = buildEnvelope({
  sid: session.id,
  seq: session.sequencer.nextOut(),
  kind: "data",
  payload: { opcode: "text", encoding: "utf8", data: text, fin: true },
});
session.emitOutbound(envelope);

// Binary message from upstream
const b64 = Buffer.from(bytes).toString("base64");
const envelope = buildEnvelope({
  sid: session.id,
  seq: session.sequencer.nextOut(),
  kind: "data",
  payload: { opcode: "binary", encoding: "base64", data: b64, fin: true },
});
session.emitOutbound(envelope);
```

Always call `session.sequencer.nextOut()` to mint the seq number. Never assign seq values manually.

## Session lifecycle methods

Call these at the appropriate moments:

| Method | When to call |
|--------|-------------|
| `session.markUpstreamOpen(now)` | Upstream connection handshake succeeded |
| `session.markErrored(now)` | Upstream connection failed or errored |
| `session.markClosing(now, source, code, reason)` | Upstream initiated close |
| `session.markClosed(now, source, code, reason)` | Connection fully closed |

`source` is one of `"client" | "bridge" | "upstream" | "timeout" | "policy"`.

Emit a close frame before calling `markClosing`/`markClosed`:

```ts
const envelope = buildEnvelope({
  sid: session.id,
  seq: session.sequencer.nextOut(),
  kind: "close",
  payload: { code, reason, source: "upstream" },
});
session.emitOutbound(envelope);
session.markClosing(now, "upstream", code, reason);
session.markClosed(now, "upstream", code, reason);
```

## Wiring the factory into the server

Pass the factory to `createHttpServer` via the `upstreamAdapterFactory` option:

```ts
import { createHttpServer } from "@https2wss/proxy";

const server = createHttpServer({
  config,
  sessionManager,
  upstreamPolicy,
  auth,
  ssrfGuard,
  upstreamAdapterFactory: myAdapterFactory,
});
```

If `upstreamAdapterFactory` is omitted, `createHttpServer` uses the default `WebSocketUpstreamAdapter`.

## Example sketch: JSON-RPC adapter

The Home Assistant scaffold (`packages/adapters/home-assistant/`) is currently an empty module. A JSON-RPC adapter would look roughly like:

```ts
function createJsonRpcAdapter(input: UpstreamAdapterFactoryInput): UpstreamAdapter {
  const { session, resolved } = input;
  let ws: WebSocket | null = null;

  return {
    state: "connecting",

    async connect() {
      const guard = new SsrfGuard({ allowPrivateNetwork: resolved.allowPrivateNetwork });
      await guard.assertAllowed(resolved.url);

      const filtered = new HeaderPolicy({
        allowedHeaders: resolved.allowedHeaders as string[],
      }).filterOutbound(input.clientHeaders);

      ws = new WebSocket(resolved.url.toString(), { headers: filtered });

      await new Promise<void>((resolve, reject) => {
        ws!.on("open", () => {
          session.markUpstreamOpen(Date.now());
          session.emitOutbound(buildEnvelope({
            sid: session.id,
            seq: session.sequencer.nextOut(),
            kind: "control",
            payload: { event: "upstream_open" },
          }));
          resolve();
        });
        ws!.on("error", reject);
      });
    },

    sendText(data) {
      // Wrap in JSON-RPC envelope before sending
      ws?.send(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { data } }));
    },

    sendBinary(data) {
      // JSON-RPC is text-only; encode as base64 param or reject
      ws?.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "binary",
        params: { data: Buffer.from(data).toString("base64") },
      }));
    },

    close(code, reason) {
      ws?.close(code, reason);
    },

    get state() { return ws?.readyState === 1 ? "open" : "connecting"; },
  };
}
```

This is illustrative only. A real implementation requires full error and close handling matching the patterns in `WebSocketUpstreamAdapter.ts`.
