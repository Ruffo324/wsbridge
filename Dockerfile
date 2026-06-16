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

# ── 1. Copy all workspace manifests + sources in one layer ───────────────────
# pnpm 11 requires the actual source directories to be present before
# `pnpm install` so it can create the correct workspace package symlinks in
# node_modules. Splitting manifest-copy + source-copy breaks workspace linking
# (node_modules/@https2wss/ would not be created and tsc -b would fail with
# "Cannot find module" errors for all workspace dependencies).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY examples/echo/package.json examples/echo/tsconfig.json examples/echo/

# ── 2. Install all workspace deps ─────────────────────────────────────────────
# --ignore-scripts prevents optional native build steps (e.g. esbuild binaries)
# while still correctly linking workspace packages.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── 3. Build packages via tsc project references ──────────────────────────────
# tsc -b on the root tsconfig.json resolves the full dependency graph
# (protocol → client/proxy → adapters/echo) in one pass.
RUN pnpm exec tsc -b

# ── 4. Deploy proxy into a portable production directory ─────────────────────
# pnpm 11 requires --legacy when workspace deps are not injected
# (inject-workspace-packages=true). --legacy uses the classic deploy behaviour
# (symlink → copy) which is correct for Docker images.
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
