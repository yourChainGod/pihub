#!/usr/bin/env bash
# One-shot idempotent bootstrap for the ttyd + Cloudflare tunnel setup.
# Safe to re-run after the sandbox is recycled: it only fills in what is missing.
#
#   TUNNEL_TOKEN=<token> ops/ttyd-cf-tunnel/bootstrap.sh
#
# If TUNNEL_TOKEN is unset, an existing ~/.cloudflared/tunnel-token is reused;
# if neither exists the tunnel step is skipped with instructions.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CF_DIR="${CF_DIR:-$HOME/.cloudflared}"
CRED_FILE="${TTYD_CRED_FILE:-$CF_DIR/ttyd-cred}"
TOKEN_FILE="${CF_TOKEN_FILE:-$CF_DIR/tunnel-token}"

mkdir -p "$BIN_DIR" "$CF_DIR"
chmod 700 "$CF_DIR"

# --- binaries (static, user-space: this box has no sudo) ---------------------
if [[ ! -x "$BIN_DIR/ttyd" ]]; then
  echo "==> installing ttyd"
  curl -fsSL -o "$BIN_DIR/ttyd" \
    https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64
  chmod +x "$BIN_DIR/ttyd"
fi
if [[ ! -x "$BIN_DIR/cloudflared" ]]; then
  echo "==> installing cloudflared"
  curl -fsSL -o "$BIN_DIR/cloudflared" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$BIN_DIR/cloudflared"
fi
"$BIN_DIR/ttyd" --version
"$BIN_DIR/cloudflared" --version

# --- credentials -------------------------------------------------------------
if [[ ! -s "$CRED_FILE" ]]; then
  umask 077
  pw="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  printf 'ttyd\n%s\n' "$pw" > "$CRED_FILE"
  echo "==> generated ttyd password: $pw   (user: ttyd)"
fi
chmod 600 "$CRED_FILE"

if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  umask 077
  printf '%s\n' "$TUNNEL_TOKEN" > "$TOKEN_FILE"
fi
[[ -s "$TOKEN_FILE" ]] && chmod 600 "$TOKEN_FILE"

# --- start -------------------------------------------------------------------
pkill -f "$BIN_DIR/cloudflared" 2>/dev/null || true
pkill -f "$BIN_DIR/ttyd" 2>/dev/null || true
sleep 1

"$HERE/start-ttyd.sh"
if [[ -s "$TOKEN_FILE" ]]; then
  "$HERE/start-tunnel.sh"
else
  echo "!! no tunnel token: pass TUNNEL_TOKEN=... to also start the tunnel" >&2
fi

sleep 8
echo "==> verify"
curl -s -o /dev/null -w '  local  http://127.0.0.1:7681 -> %{http_code} (401 = auth on)\n' \
  -m 10 http://127.0.0.1:7681/ || true
if [[ -s "$TOKEN_FILE" ]]; then
  grep -c 'Registered tunnel connection' /tmp/cloudflared.log 2>/dev/null \
    | sed 's/^/  tunnel connections: /' || true
fi
