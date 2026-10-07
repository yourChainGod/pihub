#!/usr/bin/env bash
# Run the Cloudflare named tunnel that fronts the local ttyd.
#
#   ~/.local/bin/cloudflared     cloudflared binary
#   ~/.cloudflared/tunnel-token  tunnel token from the CF Zero Trust dashboard (chmod 600)
#
# The token is passed through the TUNNEL_TOKEN environment variable so it never
# shows up in `ps` output or in the shell history.
#
# Env overrides: CF_BIN, CF_TOKEN_FILE, CF_LOG
set -euo pipefail

CF_BIN="${CF_BIN:-$HOME/.local/bin/cloudflared}"
CF_TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/.cloudflared/tunnel-token}"
CF_LOG="${CF_LOG:-/tmp/cloudflared.log}"

[[ -x "$CF_BIN" ]] || { echo "cloudflared binary not found/executable: $CF_BIN" >&2; exit 1; }
[[ -r "$CF_TOKEN_FILE" ]] || { echo "token file missing: $CF_TOKEN_FILE" >&2; exit 1; }

TOKEN="$(tr -d '\r\n' < "$CF_TOKEN_FILE")"
[[ -n "$TOKEN" ]] || { echo "token file is empty" >&2; exit 1; }

export TUNNEL_TOKEN="$TOKEN"
nohup "$CF_BIN" tunnel --no-autoupdate --loglevel info run >"$CF_LOG" 2>&1 &

echo "cloudflared pid $! (log: $CF_LOG)"
echo "watch:  tail -f $CF_LOG | grep -Ei 'registered|connIndex|ERR|WRN'"
