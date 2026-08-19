#!/bin/sh
set -u

: "${PIHUB_E2E_HOST:?Set PIHUB_E2E_HOST to the test server hostname}"
: "${PIHUB_E2E_IP:?Set PIHUB_E2E_IP to the test server IP address}"
HOST="$PIHUB_E2E_HOST"
IP="$PIHUB_E2E_IP"
PORT="${PIHUB_E2E_PORT:-30141}"
BASE="https://${HOST}:${PORT}"
FAILURES=0
TEMP_ROOT=""
TERMINAL_ID=""
SESSION_ID=""

request() {
  curl --fail --silent --show-error --max-time 30 --resolve "${HOST}:${PORT}:${IP}" "$@"
}

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s: %s\n' "$1" "$2"; FAILURES=$((FAILURES + 1)); }

cleanup() {
  if [ -n "$SESSION_ID" ]; then
    request -X DELETE "$BASE/api/sessions/$SESSION_ID" >/dev/null 2>&1 || true
  fi
  if [ -n "$TERMINAL_ID" ]; then
    request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg id "$TERMINAL_ID" '{action:"close",id:$id}')" "$BASE/api/pihub/terminal" >/dev/null 2>&1 || true
  fi
  if [ -n "$TEMP_ROOT" ]; then
    request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg path "$TEMP_ROOT" '{action:"delete",path:$path}')" "$BASE/api/pihub/files" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

SETUP="$(request "$BASE/api/pihub/setup" 2>&1)" || { fail setup "$SETUP"; printf 'FAILURES=%s\n' "$FAILURES"; exit "$FAILURES"; }
if printf '%s' "$SETUP" | jq -e --arg prefix "https://${HOST}" '.security.tailnetOnly == true and .security.binding == "127.0.0.1" and .security.funnelSupported == false and .server.running == true and .pi.installed == true and .provider.installed == true and .tailscale.connected == true and .tailscale.serveEnabled == true and (.tailscale.serveUrl | startswith($prefix))' >/dev/null; then pass setup; else fail setup "unexpected status: $SETUP"; fi

SESSIONS="$(request "$BASE/api/sessions" 2>&1)" && printf '%s' "$SESSIONS" | jq -e '.sessions | type == "array"' >/dev/null && pass sessions || fail sessions "$SESSIONS"
HOME_JSON="$(request "$BASE/api/home" 2>&1)" && REMOTE_HOME="$(printf '%s' "$HOME_JSON" | jq -r '.home // empty')"
if [ -n "${REMOTE_HOME:-}" ]; then pass home; else fail home "$HOME_JSON"; fi

CWD_JSON="$(request -X POST "$BASE/api/default-cwd" 2>&1)" && CWD="$(printf '%s' "$CWD_JSON" | jq -r '.cwd // empty')"
if [ -n "${CWD:-}" ]; then pass default-cwd; else fail default-cwd "$CWD_JSON"; fi

if [ -n "${CWD:-}" ]; then
  VALIDATE="$(request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg cwd "$CWD" '{cwd:$cwd}')" "$BASE/api/cwd/validate" 2>&1)"
  printf '%s' "$VALIDATE" | jq -e '.success == true' >/dev/null && pass cwd-validate || fail cwd-validate "$VALIDATE"

  NEW_SESSION="$(request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg cwd "$CWD" '{cwd:$cwd,type:"ensure_session",toolNames:[]}')" "$BASE/api/agent/new" 2>&1)"
  SESSION_ID="$(printf '%s' "$NEW_SESSION" | jq -r '.sessionId // empty' 2>/dev/null)"
  if [ -n "$SESSION_ID" ]; then
    pass session-create
    SESSION_DETAIL="$(request "$BASE/api/sessions/$SESSION_ID?deferThinking=1&deferMedia=1" 2>&1)"
    printf '%s' "$SESSION_DETAIL" | jq -e --arg id "$SESSION_ID" '.sessionId == $id and .info.id == $id' >/dev/null && pass session-read || fail session-read "$SESSION_DETAIL"
    SESSION_DELETE="$(request -X DELETE "$BASE/api/sessions/$SESSION_ID" 2>&1)"
    if printf '%s' "$SESSION_DELETE" | jq -e '.ok == true' >/dev/null; then pass session-delete; SESSION_ID=""; else fail session-delete "$SESSION_DELETE"; fi
  else
    fail session-create "$NEW_SESSION"
  fi

  TEST_NAME="pihub-e2e-$$"
  TEMP_ROOT="$CWD/$TEST_NAME"
  MKDIR="$(request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg path "$CWD" --arg name "$TEST_NAME" '{action:"mkdir",path:$path,name:$name}')" "$BASE/api/pihub/files" 2>&1)"
  printf '%s' "$MKDIR" | jq -e '.success == true' >/dev/null && pass file-mkdir || fail file-mkdir "$MKDIR"

  TOUCH="$(request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg path "$TEMP_ROOT" '{action:"touch",path:$path,name:"hello.txt",content:"hello-pihub"}')" "$BASE/api/pihub/files" 2>&1)"
  printf '%s' "$TOUCH" | jq -e '.success == true' >/dev/null && pass file-touch || fail file-touch "$TOUCH"

  WRITE="$(request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg path "$TEMP_ROOT/hello.txt" '{action:"write",path:$path,content:"hello-pihub-updated"}')" "$BASE/api/pihub/files" 2>&1)"
  printf '%s' "$WRITE" | jq -e '.success == true' >/dev/null && pass file-write || fail file-write "$WRITE"

  RENAME="$(request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg path "$TEMP_ROOT/hello.txt" '{action:"rename",path:$path,destination:"renamed.txt"}')" "$BASE/api/pihub/files" 2>&1)"
  printf '%s' "$RENAME" | jq -e '.success == true' >/dev/null && pass file-rename || fail file-rename "$RENAME"

  TERMINAL="$(request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg cwd "$CWD" '{action:"create",cwd:$cwd}')" "$BASE/api/pihub/terminal" 2>&1)"
  TERMINAL_ID="$(printf '%s' "$TERMINAL" | jq -r '.id // empty' 2>/dev/null)"
  if [ -n "$TERMINAL_ID" ]; then
    pass terminal-create
    INPUT="$(request -X POST -H 'content-type: application/json' -d "$(jq -nc --arg id "$TERMINAL_ID" '{action:"input",id:$id,data:"printf PIHUB_TERM_OK\\n\n"}')" "$BASE/api/pihub/terminal" 2>&1)"
    printf '%s' "$INPUT" | jq -e '.success == true' >/dev/null && pass terminal-input || fail terminal-input "$INPUT"
    sleep 1
    OUTPUT="$(request "$BASE/api/pihub/terminal?id=$TERMINAL_ID" 2>&1)"
    printf '%s' "$OUTPUT" | jq -e '.output | contains("PIHUB_TERM_OK")' >/dev/null && pass terminal-output || fail terminal-output "$OUTPUT"
  else
    fail terminal-create "$TERMINAL"
  fi
fi

printf 'FAILURES=%s\n' "$FAILURES"
exit "$FAILURES"
