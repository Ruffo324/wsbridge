# syntax=docker/dockerfile:1.7
#
# Home Assistant Add-on: https2wss
#
# Two-stage build:
#   Stage 1 (proxy-builder): Node 24-alpine; compiles the workspace and deploys the proxy package.
#   Stage 2 (addon runtime): ghcr.io/home-assistant/{arch}-base (Alpine + s6-overlay v3 + bashio).
#
# Base image note:
#   The HA Supervisor provides the arch-specific image via BUILD_FROM at build time.
#   For local testing, pass --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest.
#   The "hassio-addons/base" tag (without arch prefix) does not exist as of 2026;
#   use the arch-namespaced images from ghcr.io/home-assistant/ instead.
#
# Node package:
#   Alpine 3.23 (shipped in HA base) provides "nodejs" (24.14.1) and
#   "nodejs-current" (24.15.0) — both are Node 24, matching the builder stage.
#   We use plain "nodejs" (the LTS slot) for stability.

ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest

# ---------------------------------------------------------------------------
# Stage 1: build the proxy package in a clean Node 24 image
# ---------------------------------------------------------------------------
# node:24-alpine has no linux/arm/v7 manifest on Docker Hub — alpine variants
# are amd64 + arm64 only. node:24 (Debian) covers amd64/arm64/armv7 and is
# fine here since this is a transient builder stage; the runtime stage stays
# small (HA base + apk add nodejs).
FROM node:24 AS proxy-builder

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /repo

# Copy workspace manifests + all source in a single layer.
# pnpm 11 requires source to be present before install so workspace symlinks
# are created correctly (splitting manifest-copy + source-copy breaks linking).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY examples/echo/package.json examples/echo/tsconfig.json examples/echo/

RUN pnpm install --frozen-lockfile --ignore-scripts

RUN pnpm exec tsc -b

# Deploy the proxy into a self-contained production directory.
# --legacy uses classic deploy behaviour (symlink → copy), required when
# inject-workspace-packages is not set.
RUN pnpm --filter @https2wss/proxy deploy --prod /out --legacy

# Sanity-check the deployed dist: a cli.js that cannot be imported at all
# would fail this --help invocation and the image build aborts. Catches
# missing-module / broken-symlink regressions at build time instead of at
# the user's first add-on start.
RUN node /out/dist/cli.js --help > /dev/null

# ---------------------------------------------------------------------------
# Stage 2: the actual add-on image
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM}

# "nodejs" = Node 24.14.x on Alpine 3.23 (the version bundled in HA base:latest).
# Both "nodejs" and "nodejs-current" are Node 24 in Alpine 3.23; we use the
# stable LTS slot.  If a future Alpine version demotes 24 from the stable slot,
# switch to "nodejs-current".
RUN apk add --no-cache nodejs

RUN mkdir -p /opt/https2wss
COPY --from=proxy-builder /out /opt/https2wss

# s6 init scripts and service definitions (rootfs/ mirrors the container root).
# The build context is the repository root, so reference the full path.
COPY addons/https2wss/rootfs /

EXPOSE 8080
# The hassio-addons/base image provides its own CMD/ENTRYPOINT via s6-overlay.
# Do not override — just let it discover the services under /etc/services.d/.
