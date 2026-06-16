# syntax=docker/dockerfile:1.7
# Multi-stage build for the https2wss proxy image.
#
# Stage 1 (builder): installs all workspace deps, builds all packages, then
#   uses `pnpm deploy` to produce a self-contained production install of the
#   proxy package in /out.
# Stage 2 (runtime): copies /out into a minimal non-root image.
#
# The config file is NOT baked in — mount it at runtime:
#   docker run -v /path/to/config.yml:/app/config.yml:ro \
#              -e HTTPS2WSS_TOKEN=secret \
#              https2wss-proxy

FROM node:24-alpine AS builder

# Enable and activate pnpm via corepack (pinned version matches packageManager field)
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /repo

# ── 1. Copy manifest files first for cache-friendly layer ordering ────────────
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./

COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/
COPY packages/client/package.json packages/client/tsconfig.json packages/client/
COPY packages/proxy/package.json packages/proxy/tsconfig.json packages/proxy/
COPY packages/adapters/home-assistant/package.json packages/adapters/home-assistant/tsconfig.json packages/adapters/home-assistant/
# Copy examples/echo manifest+tsconfig so `tsc -b` can follow the root tsconfig reference.
# Only the config files are needed; source is not compiled for the proxy image.
COPY examples/echo/package.json examples/echo/tsconfig.json examples/echo/

# Install all workspace deps.
# --ignore-scripts prevents optional native build steps (e.g. esbuild binaries);
# the workspace-linked packages (protocol, client, proxy) don't need build scripts.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── 2. Copy source ────────────────────────────────────────────────────────────
COPY packages packages

# ── 3. Build packages in dependency order via tsc project references ──────────
# Build protocol first (no upstream deps), then client + proxy (both depend on protocol),
# then adapters. Running tsc -b on each package individually ensures the prior package's
# dist/ is available before the next compilation starts.
RUN pnpm exec tsc -b packages/protocol && \
    pnpm exec tsc -b packages/client && \
    pnpm exec tsc -b packages/proxy && \
    pnpm exec tsc -b packages/adapters/home-assistant

# ── 4. Deploy proxy into a portable production directory ─────────────────────
# pnpm 11 requires --legacy when workspace deps are not injected (inject-workspace-packages=true).
# --legacy uses the classic deploy behaviour (symlink → copy) which is correct for Docker images.
RUN pnpm --filter @https2wss/proxy deploy --prod /out --legacy

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder --chown=app:app /out /app

USER app

ENV NODE_ENV=production

EXPOSE 8080

# busybox wget is available in node:24-alpine
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:8080/healthz" > /dev/null 2>&1 || exit 1

CMD ["node", "dist/cli.js", "--config", "/app/config.yml"]
