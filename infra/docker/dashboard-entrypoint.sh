#!/usr/bin/env bash
#
# Generates /usr/share/nginx/html/config.js from environment variables, so
# the dashboard image is environment-agnostic. The dashboard reads
# `window.__FLOWQ_CONFIG__` at startup; see packages/dashboard/src/config.ts.
#
# Runs from the standard nginx:alpine entrypoint hook directory before
# nginx itself starts.

set -euo pipefail

API_URL="${FLOWQ_API_URL:-${VITE_API_URL:-http://localhost:3000}}"
WS_URL="${FLOWQ_WS_URL:-${VITE_WS_URL:-}}"
API_KEY="${FLOWQ_API_KEY:-${VITE_API_KEY:-}}"

# Default the WS URL from the API URL when not explicitly set.
# http(s)://host[:port][/path]  ->  ws(s)://host[:port][/path]/ws
if [ -z "${WS_URL}" ]; then
  case "${API_URL}" in
    https://*) WS_URL="wss://${API_URL#https://}/ws" ;;
    http://*)  WS_URL="ws://${API_URL#http://}/ws" ;;
    *)         WS_URL="ws://${API_URL}/ws" ;;
  esac
fi

CONFIG_PATH="/usr/share/nginx/html/config.js"

# Escape backslashes and double quotes for safe JS string embedding.
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

cat > "${CONFIG_PATH}" <<EOF
// Generated at container start by dashboard-entrypoint.sh.
// Do not edit — overwritten on every pod restart.
window.__FLOWQ_CONFIG__ = {
  apiUrl: "$(escape "${API_URL}")",
  wsUrl:  "$(escape "${WS_URL}")",
  apiKey: "$(escape "${API_KEY}")"
};
EOF

echo "[flowq-dashboard] wrote runtime config -> ${CONFIG_PATH} (api=${API_URL})"
