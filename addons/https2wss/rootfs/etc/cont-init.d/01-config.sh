#!/command/with-contenv bashio
# shellcheck shell=bash
# -----------------------------------------------------------------------------
# 01-config.sh — Render /data/config.yml from add-on options before services start.
#
# Options are read directly from /data/options.json (written by the HA Supervisor
# before the container starts, or pre-created manually for local testing).
# We use jq directly rather than bashio::config because bashio::config contacts
# the Supervisor HTTP API for each key, which causes ~10 s timeouts per key when
# running outside a full HA Supervisor environment.
#
# bashio is still used for its structured log helpers.
#
# Token handling:
#   - If "token" in options.json is non-empty, use it.
#   - If "token" is empty or absent, check /data/generated-token.txt:
#       * exists  → reuse the previously generated token (stable across restarts)
#       * missing → generate a new 48-char URL-safe random token, write it
#                   (mode 0600), and log it at WARNING level so the user can
#                   retrieve it from the add-on log.
#
# SECURITY: the token value is logged ONLY when first generated.
#   On subsequent starts the file is read silently.
# -----------------------------------------------------------------------------
set -e

OPTIONS_FILE="/data/options.json"

# Require options file — the HA Supervisor always provides it; for local tests
# create it manually before starting the container.
if [ ! -f "${OPTIONS_FILE}" ]; then
  bashio::log.fatal "Options file ${OPTIONS_FILE} not found. Cannot render config."
  exit 1
fi

# ---------------------------------------------------------------------------
# Helper: read a string value from options.json; print empty string if absent.
# ---------------------------------------------------------------------------
opt_str() { jq -r --arg key "$1" '.[$key] // ""' "${OPTIONS_FILE}"; }
opt_bool() { jq -r --arg key "$1" '.[$key] // false' "${OPTIONS_FILE}"; }
opt_int()  { jq -r --arg key "$1" '.[$key] // 0' "${OPTIONS_FILE}"; }

# ---------------------------------------------------------------------------
# Resolve bridge token
# ---------------------------------------------------------------------------
TOKEN="$(opt_str 'token')"

if [ -z "${TOKEN}" ]; then
  if [ -f /data/generated-token.txt ]; then
    TOKEN="$(cat /data/generated-token.txt)"
    bashio::log.info "Using previously generated token from /data/generated-token.txt"
  else
    # Generate a 48-character URL-safe random token from /dev/urandom.
    TOKEN="$(tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 48; echo)"
    # Write with restrictive permissions (umask 0177 → mode 0600).
    old_umask="$(umask)"
    umask 0177
    printf '%s\n' "${TOKEN}" > /data/generated-token.txt
    umask "${old_umask}"
    # Log the generated token — ONLY at generation time.
    bashio::log.warning "No token configured — generated a random one."
    bashio::log.warning "Token: ${TOKEN}"
    bashio::log.warning "Saved to /data/generated-token.txt (readable only by this add-on)."
    bashio::log.warning "Set this value in the add-on 'token' option to make it explicit."
  fi
fi

# ---------------------------------------------------------------------------
# Read remaining options
# ---------------------------------------------------------------------------
UPSTREAM_PROFILE="$(opt_str 'upstream_profile_name')"
UPSTREAM_URL="$(opt_str 'upstream_url')"
UPSTREAM_ALLOW_PRIVATE="$(opt_bool 'upstream_allow_private_network')"
LOG_LEVEL="$(opt_str 'log_level')"
IDLE_TIMEOUT="$(opt_int 'idle_timeout_ms')"
MAX_FRAME="$(opt_int 'max_frame_bytes')"
FRONTEND_PROXY_ENABLED="$(opt_bool 'frontend_proxy_enabled')"
FRONTEND_PROXY_PATH="$(opt_str 'frontend_proxy_path')"
FRONTEND_PROXY_UPSTREAM="$(opt_str 'frontend_proxy_upstream_url')"
FRONTEND_PROXY_INJECT="$(opt_bool 'frontend_proxy_inject_websocket_shim')"
if ! jq -e 'has("frontend_proxy_inject_websocket_shim")' "${OPTIONS_FILE}" >/dev/null; then
  FRONTEND_PROXY_INJECT=true
fi
FRONTEND_PROXY_BRIDGE_URL="$(opt_str 'frontend_proxy_bridge_url')"
FRONTEND_PROXY_NATIVE_TIMEOUT="$(opt_int 'frontend_proxy_native_connect_timeout_ms')"
FRONTEND_PROXY_HEARTBEAT_TIMEOUT="$(opt_int 'frontend_proxy_heartbeat_timeout_ms')"

# Apply defaults if the option file is missing any key (e.g. in older installs).
[ -z "${UPSTREAM_PROFILE}" ]   && UPSTREAM_PROFILE="ha-core"
[ -z "${UPSTREAM_URL}" ]       && UPSTREAM_URL="ws://homeassistant:8123/api/websocket"
[ -z "${LOG_LEVEL}" ]          && LOG_LEVEL="info"
[ "${IDLE_TIMEOUT}" -le 0 ]    2>/dev/null && IDLE_TIMEOUT=120000
[ "${MAX_FRAME}" -le 0 ]       2>/dev/null && MAX_FRAME=1048576
[ -z "${FRONTEND_PROXY_PATH}" ]      && FRONTEND_PROXY_PATH="/"
[ -z "${FRONTEND_PROXY_UPSTREAM}" ]  && FRONTEND_PROXY_UPSTREAM="http://homeassistant:8123"
[ "${FRONTEND_PROXY_NATIVE_TIMEOUT}" -le 0 ]    2>/dev/null && FRONTEND_PROXY_NATIVE_TIMEOUT=1500
[ "${FRONTEND_PROXY_HEARTBEAT_TIMEOUT}" -le 0 ] 2>/dev/null && FRONTEND_PROXY_HEARTBEAT_TIMEOUT=30000

# ---------------------------------------------------------------------------
# Resolve allowed_origins — produce a JSON array string for the YAML block.
# The option is a JSON array in options.json; pass it through jq to normalise.
# ---------------------------------------------------------------------------
ORIGINS_RAW="$(jq -c '.allowed_origins // []' "${OPTIONS_FILE}")"
# If the array is empty produce "[]", otherwise a compact JSON array.
if [ "${ORIGINS_RAW}" = "[]" ] || [ "${ORIGINS_RAW}" = "null" ]; then
  ORIGINS_BLOCK="[]"
else
  ORIGINS_BLOCK="${ORIGINS_RAW}"
fi

# ---------------------------------------------------------------------------
# Render /data/config.yml
# ---------------------------------------------------------------------------
cat > /data/config.yml <<YAML
server:
  host: "0.0.0.0"
  port: 8080
security:
  requireAuth: true
  tokens:
    - value: "${TOKEN}"
  cors:
    allowedOrigins: ${ORIGINS_BLOCK}
    allowCredentials: false
  upstreamPolicy:
    default: deny
    allowDirectUrl: false
    allow:
      - name: "${UPSTREAM_PROFILE}"
        adapter: websocket
        url: "${UPSTREAM_URL}"
        allowedHeaders: ["Authorization"]
        allowPrivateNetwork: ${UPSTREAM_ALLOW_PRIVATE}
sessions:
  idleTimeoutMs: ${IDLE_TIMEOUT}
  maxFrameBytes: ${MAX_FRAME}
transports:
  enabled: ["sse", "long_poll", "poll"]
logging:
  level: "${LOG_LEVEL}"
frontendProxy:
  enabled: ${FRONTEND_PROXY_ENABLED}
  pathPrefix: "${FRONTEND_PROXY_PATH}"
  upstreamUrl: "${FRONTEND_PROXY_UPSTREAM}"
  injectWebSocketShim: ${FRONTEND_PROXY_INJECT}
  bridgeUrl: "${FRONTEND_PROXY_BRIDGE_URL}"
  bridgeToken: "${TOKEN}"
  upstreamProfile: "${UPSTREAM_PROFILE}"
  nativeConnectTimeoutMs: ${FRONTEND_PROXY_NATIVE_TIMEOUT}
  heartbeatTimeoutMs: ${FRONTEND_PROXY_HEARTBEAT_TIMEOUT}
YAML

bashio::log.info "Config rendered to /data/config.yml"
