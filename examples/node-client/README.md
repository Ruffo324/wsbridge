# https2wss — Node.js Client Example

A minimal Node.js script demonstrating how to use `@https2wss/client` from Node.

## Prerequisites

A running https2wss proxy with an `echo` upstream profile. The easiest way is
to use the `examples/echo` demo:

```bash
# Terminal 1 — run echo server + proxy
STANDALONE=1 HTTPS2WSS_TOKEN=dev-token-1234 \
  pnpm --filter @https2wss/echo-demo proxy &
HTTPS2WSS_TOKEN=dev-token-1234 \
  pnpm --filter @https2wss/echo-demo echo
```

## Run

```bash
HTTPS2WSS_TOKEN=dev-token-1234 \
  BRIDGE_URL=http://localhost:8080 \
  pnpm --filter @https2wss/node-client-example start
```

Expected output: `hello from node`
