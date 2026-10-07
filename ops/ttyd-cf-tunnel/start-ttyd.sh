#!/usr/bin/env bash
# Start ttyd bound to loopback only. Public exposure is handled by cloudflared.
#
#   ~/.local/bin/ttyd            ttyd static binary
#   ~/.cloudflared/ttyd-cred     username:password file (chmod 600), never in git
#
# Env overrides: TTYD_BIN, TTYD_PORT, TTYD_CRED_FILE, TTYD_LOG, TTYD_SHELL
set -euo pipefail

TTYD_BIN="${TTYD_BIN:-$HOME/.local/bin/ttyd}"
TTYD_PORT="${TTYD_PORT:-7681}"
TTYD_CRED_FILE="${TTYD_CRED_FILE:-$HOME/.cloudflared/ttyd-cred}"
TTYD_LOG="${TTYD_LOG:-/tmp/ttyd.log}"
TTYD_SHELL="${TTYD_SHELL:-/bin/bash}"

[[ -x "$TTYD_BIN" ]] || { echo "ttyd binary not found/executable: $TTYD_BIN" >&2; exit 1; }
[[ -r "$TTYD_CRED_FILE" ]] || { echo "credential file missing: $TTYD_CRED_FILE" >&2; exit 1; }

# Never expose an unauthenticated shell: refuse to start without credentials.
# The file holds two lines: username then password (or a single "user:pass" line).
mapfile -t _cred < <(tr -d '\r' < "$TTYD_CRED_FILE" | sed '/^$/d')
if (( ${#_cred[@]} == 1 )) && [[ "${_cred[0]}" == *:* ]]; then
  cred="${_cred[0]}"
elif (( ${#_cred[@]} >= 2 )); then
  cred="${_cred[0]}:${_cred[1]}"
else
  echo "credential file must contain 'user' and 'pass' lines (or user:pass)" >&2
  exit 1
fi

# Loopback-only bind (-i) is deliberate; the tunnel reaches it over localhost.
nohup "$TTYD_BIN" \
  --interface 127.0.0.1 \
  --port "$TTYD_PORT" \
  --credential "$cred" \
  --writable \
  --max-clients 3 \
  -t fontSize=14 \
  -t 'theme={"background":"#101418","foreground":"#e6e6e6"}' \
  "$TTYD_SHELL" -l \
  >"$TTYD_LOG" 2>&1 &

echo "ttyd pid $! on http://127.0.0.1:$TTYD_PORT (log: $TTYD_LOG)"
