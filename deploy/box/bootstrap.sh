#!/usr/bin/env bash
# M3 Box golden snapshot and one-command setup
# (docs/deploy-box-tailscale.md "M3 Box golden snapshot and one-command
# setup"). Takes a Box API key and a Tailscale auth key, both by path never
# by value, provisions a Box VM (box.ascii.dev), places this repository's
# deploy tree on it at the exact commit this script is run from, brings the
# M1+M2 compose stack up, and reports the box id and the tailnet hostname it
# joined under. Never prints either credential's value.
#
# Usage:
#   deploy/box/bootstrap.sh <box-api-key-file> <ts-authkey-file> [ttl-seconds]
#
# Talks to the Box API over `commands` and `files` (POST /boxes/{id}/commands,
# GET|PUT /boxes/{id}/files) rather than SSH: the hosted box this milestone
# targets deliberately exposes no shell (see the M2 2026-09-04 shell-removal
# finding in docs/deploy-box-tailscale.md), and these two endpoints need none.
#
# The Box `commands` endpoint has a hard ~30s execution budget regardless of
# any client-requested timeout (confirmed empirically: a plain `sleep 45`
# was killed by SIGTERM at 30s even when the request asked for 300000ms).
# Anything slower than that -- the compose build, the image pull, tailscaled
# authenticating -- is started in the background on the box with its own
# output redirected to a log file and a completion marker, and this script
# polls for the marker with its own `commands` calls instead of trying to
# hold one call open.
#
# State: this script is idempotent. It records the box id it created (or
# reused) under deploy/box/.state/<run>/box-id so a second run against the
# same state directory resumes rather than orphaning a box; a state
# directory whose box has since errored or been deleted out from under it is
# discarded and a fresh box is created. On any failure after a box exists,
# the box this run created is deleted before this script exits non-zero,
# unless KIZUKI_BOX_KEEP_ON_FAILURE=1 is set (only meant for interactively
# diagnosing a failure by hand).
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
API_BASE="https://ascii.dev/api/box/v1"

usage() {
  echo "usage: $0 <box-api-key-file> <ts-authkey-file> [ttl-seconds] [state-dir]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
BOX_API_KEY_FILE="$1"
TS_AUTHKEY_FILE="$2"
TTL_SECONDS="${3:-1800}"
STATE_DIR="${4:-$ROOT/deploy/box/.state/default}"

[ -r "$BOX_API_KEY_FILE" ] || { echo "bootstrap: cannot read box API key file: $BOX_API_KEY_FILE" >&2; exit 1; }
[ -r "$TS_AUTHKEY_FILE" ] || { echo "bootstrap: cannot read ts authkey file: $TS_AUTHKEY_FILE" >&2; exit 1; }

BOX_API_KEY="$(cat -- "$BOX_API_KEY_FILE")"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true
STATE_BOX_ID_FILE="$STATE_DIR/box-id"
STATE_TOKEN_FILE="$STATE_DIR/daemon-token"

BOX_ID=""
CREATED_BY_THIS_RUN=0

log() { printf '[bootstrap] %s\n' "$1" >&2; }

# ---- Box API helpers -------------------------------------------------

api() {
  # api METHOD PATH [DATA]
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer $BOX_API_KEY" -H "Content-Type: application/json" \
      --data-binary "$data" "$API_BASE$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $BOX_API_KEY" "$API_BASE$path"
  fi
}

# Extracts a top-level string field's raw JSON-encoded value (no unescaping)
# from a JSON blob using only sed, so this script needs no jq. Fine for the
# flat, known-shape responses this API returns.
json_str() {
  # json_str FIELD <<<"$json"
  local field="$1"
  sed -n "s/.*\"$field\":\"\\([^\"]*\\)\".*/\\1/p" | head -1
}

json_bool_or_null() {
  local field="$1"
  sed -n "s/.*\"$field\":\\([a-z0-9_]*\\).*/\\1/p" | head -1
}

box_state() {
  api GET "/boxes/$1" | json_str state
}

box_ip() {
  api GET "/boxes/$1" | json_str ip
}

# Runs a command with the API's own short synchronous budget. Prints stdout
# on success (exit 0), fails loudly with stderr+exitCode on non-zero.
run_cmd() {
  local box="$1" cmd="$2" resp success stdout stderr exitcode
  local escaped
  escaped="$(printf '%s' "$cmd" | sed 's/\\/\\\\/g; s/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')"
  resp="$(api POST "/boxes/$box/commands" "{\"command\":\"$escaped\"}")"
  success="$(printf '%s' "$resp" | json_bool_or_null success)"
  stdout="$(printf '%s' "$resp" | sed -n 's/.*"stdout":"\(.*\)","stderr".*/\1/p')"
  # Undo JSON's own escaping of a literal double quote inside the command's
  # real stdout (`\"` -> `"`). Needed the moment a command's own output is
  # itself JSON (e.g. curl'ing a Kizuki endpoint from inside the box) --
  # without this, a caller's `case "$out" in *'"ok":true'*)` never matches,
  # because the extracted text still reads `\"ok\":true` at that point.
  stdout="$(printf '%s' "$stdout" | sed 's/\\"/"/g')"
  # The API JSON-encodes a trailing newline in the command's real stdout as
  # a literal two-character `\n` (backslash, n) rather than an actual
  # newline byte, since this extraction never runs through a real JSON
  # decoder (see the module comment on json_str). Strip it so a caller
  # comparing e.g. `[ "$mode" = "644" ]` is not comparing against "644\n".
  while [ "${stdout: -2}" = '\n' ]; do
    stdout="${stdout%\\n}"
  done
  if [ "$success" != "true" ]; then
    stderr="$(printf '%s' "$resp" | sed -n 's/.*"stderr":"\(.*\)","stdoutTruncated".*/\1/p')"
    log "command failed: $cmd"
    log "stdout: $stdout"
    log "stderr: $stderr"
    return 1
  fi
  printf '%s' "$stdout"
}

# Starts a long-running command detached, with its own log file and a
# completion marker this script polls for, working around the commands
# endpoint's own ~30s execution budget (see the header note).
run_cmd_bg() {
  local box="$1" cmd="$2" logfile="$3" marker="$4"
  local wrapped
  wrapped="( $cmd ; echo \$? > $marker ) > $logfile 2>&1 < /dev/null & disown; sleep 1; echo started"
  run_cmd "$box" "$wrapped" >/dev/null
}

wait_marker() {
  # wait_marker BOX MARKER TIMEOUT_SECONDS -> prints the marker's exit code
  local box="$1" marker="$2" timeout="$3" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if run_cmd "$box" "cat $marker 2>/dev/null" 2>/dev/null | grep -qE '^[0-9]+$'; then
      run_cmd "$box" "cat $marker" 2>/dev/null
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

put_file_b64() {
  # put_file_b64 BOX REMOTE_PATH LOCAL_PATH
  local box="$1" remote="$2" local_path="$3" b64 tmp_body
  b64="$(base64 -w0 -- "$local_path" 2>/dev/null || base64 -- "$local_path" | tr -d '\n')"
  tmp_body="$(mktemp)"
  printf '{"path":"%s","content":"%s","encoding":"base64"}' "$remote" "$b64" > "$tmp_body"
  api PUT "/boxes/$box/files" "@$tmp_body" >/dev/null
  rm -f "$tmp_body"
}

put_file_b64_data() {
  # put_file_b64_data BOX REMOTE_PATH BASE64_CONTENT -- content already
  # base64-encoded by the caller, so a credential's plaintext never touches
  # a shell command line or an on-disk temp file in decoded form more than
  # the read below already requires.
  local box="$1" remote="$2" b64="$3" tmp_body
  tmp_body="$(mktemp)"
  printf '{"path":"%s","content":"%s","encoding":"base64"}' "$remote" "$b64" > "$tmp_body"
  api PUT "/boxes/$box/files" "@$tmp_body" >/dev/null
  rm -f "$tmp_body"
}

# ---- Cleanup -----------------------------------------------------------

delete_box() {
  local box="$1"
  curl -sS -X DELETE -H "Authorization: Bearer $BOX_API_KEY" -H "X-Ascii-Confirm-Delete: $box" \
    "$API_BASE/boxes/$box" >/dev/null 2>&1 || true
}

cleanup_on_failure() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$CREATED_BY_THIS_RUN" = "1" ] && [ -n "$BOX_ID" ]; then
    if [ "${KIZUKI_BOX_KEEP_ON_FAILURE:-0}" = "1" ]; then
      log "leaving box $BOX_ID up for inspection (KIZUKI_BOX_KEEP_ON_FAILURE=1)"
    else
      log "bootstrap failed; deleting box $BOX_ID rather than leaving it running"
      delete_box "$BOX_ID"
      rm -f "$STATE_BOX_ID_FILE" "$STATE_TOKEN_FILE"
    fi
  fi
  exit "$rc"
}
trap cleanup_on_failure EXIT

# ---- Steps ---------------------------------------------------------------

acquire_box() {
  local usable="provisioned|cloning|ready|idle|running"
  if [ -s "$STATE_BOX_ID_FILE" ]; then
    local existing state
    existing="$(cat -- "$STATE_BOX_ID_FILE")"
    state="$(box_state "$existing" 2>/dev/null || true)"
    if printf '%s' "$state" | grep -qE "^($usable|provisioning)$"; then
      log "reusing existing box $existing (state=$state)"
      BOX_ID="$existing"
      return
    fi
    log "state file names $existing but it is state='$state'; discarding and creating a new box"
    rm -f "$STATE_BOX_ID_FILE" "$STATE_TOKEN_FILE"
  fi

  log "creating a new box (ttlSeconds=$TTL_SECONDS)"
  local resp
  resp="$(api POST /boxes "{\"ttlSeconds\":$TTL_SECONDS}")"
  BOX_ID="$(printf '%s' "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$BOX_ID" ] || { log "box creation did not return an id: $resp"; return 1; }
  CREATED_BY_THIS_RUN=1
  printf '%s' "$BOX_ID" > "$STATE_BOX_ID_FILE"
}

wait_box_usable() {
  local timeout=120 waited=0 state
  while [ "$waited" -lt "$timeout" ]; do
    state="$(box_state "$BOX_ID")"
    case "$state" in
      idle|running|ready) log "box $BOX_ID is $state"; return 0 ;;
      error) log "box $BOX_ID entered state=error"; return 1 ;;
    esac
    sleep 3
    waited=$((waited + 3))
  done
  log "box $BOX_ID did not become usable within ${timeout}s (last state=$state)"
  return 1
}

deploy_tree() {
  log "bundling $ROOT at $(git -C "$ROOT" rev-parse --short HEAD)"
  local bundle
  bundle="$(mktemp --suffix=.bundle 2>/dev/null || mktemp)"
  git -C "$ROOT" bundle create "$bundle" HEAD >/dev/null
  put_file_b64 "$BOX_ID" "/home/user/kizuki.bundle" "$bundle"
  rm -f "$bundle"

  log "cloning the bundle into ~/kizuki-src on the box"
  run_cmd "$BOX_ID" "cd /home/user && docker compose -f kizuki-src/deploy/compose.yml down -v >/dev/null 2>&1; rm -rf kizuki-src && git clone -q kizuki.bundle kizuki-src && cd kizuki-src && git log -1 --oneline" >/dev/null
}

place_authkey() {
  log "placing the tailnet auth key (never printed)"
  local b64
  b64="$(base64 -w0 -- "$TS_AUTHKEY_FILE" 2>/dev/null || base64 -- "$TS_AUTHKEY_FILE" | tr -d '\n')"
  run_cmd "$BOX_ID" "mkdir -p /home/user/.config/kizuki && chmod 700 /home/user/.config/kizuki" >/dev/null
  put_file_b64_data "$BOX_ID" "/home/user/.config/kizuki/ts-authkey" "$b64"
  # Docker Compose secrets are a plain bind mount of the host file's own
  # mode; cap_drop: [ALL] on the tailscale service removes CAP_DAC_OVERRIDE,
  # so its root needs the file readable by "other" -- see the M2 Finding in
  # docs/deploy-box-tailscale.md and the matching comment in compose.yml.
  # The containing directory stays 0700, which is what actually keeps the
  # key from any other local account on the box.
  run_cmd "$BOX_ID" "chmod 644 /home/user/.config/kizuki/ts-authkey" >/dev/null
  local mode dirmode
  mode="$(run_cmd "$BOX_ID" "stat -c %a /home/user/.config/kizuki/ts-authkey")"
  dirmode="$(run_cmd "$BOX_ID" "stat -c %a /home/user/.config/kizuki")"
  [ "$mode" = "644" ] || { log "unexpected key file mode $mode"; return 1; }
  [ "$dirmode" = "700" ] || { log "unexpected key directory mode $dirmode"; return 1; }
}

bring_up_stack() {
  log "docker compose up -d --build (backgrounded; this can take longer than the API's ~30s command budget)"
  run_cmd_bg "$BOX_ID" \
    "cd /home/user/kizuki-src/deploy && KIZUKI_TS_AUTHKEY_FILE=/home/user/.config/kizuki/ts-authkey docker compose up -d --build" \
    "/home/user/compose-up.log" "/home/user/compose-up.done"
  local rc
  rc="$(wait_marker "$BOX_ID" "/home/user/compose-up.done" 240)" || {
    log "docker compose up did not finish within 240s"
    run_cmd "$BOX_ID" "tail -c 4000 /home/user/compose-up.log" || true
    return 1
  }
  if [ "$rc" != "0" ]; then
    log "docker compose up exited $rc"
    run_cmd "$BOX_ID" "tail -c 4000 /home/user/compose-up.log" || true
    return 1
  fi
}

wait_health() {
  local timeout=120 waited=0 body
  while [ "$waited" -lt "$timeout" ]; do
    body="$(run_cmd "$BOX_ID" "cd /home/user/kizuki-src/deploy && docker compose exec -T kizuki curl -fsS 127.0.0.1:8787/health" 2>/dev/null || true)"
    case "$body" in
      *'"ok":true'*) log "health check passed"; return 0 ;;
    esac
    sleep 5
    waited=$((waited + 5))
  done
  log "health check never passed within ${timeout}s"
  return 1
}

report() {
  local box_public_ip tailnet_line tailnet_host tailnet_ip token
  box_public_ip="$(box_ip "$BOX_ID")"
  tailnet_line="$(run_cmd "$BOX_ID" "cd /home/user/kizuki-src/deploy && docker compose exec -T tailscale tailscale --socket=/tmp/tailscaled.sock status --peers=false" 2>/dev/null || true)"
  tailnet_ip="$(printf '%s' "$tailnet_line" | awk '{print $1}')"
  tailnet_host="$(printf '%s' "$tailnet_line" | awk '{print $2}')"

  # The daemon token authenticates every MCP call over the tailnet (2.8). A
  # peer with no shell on the box has no other way to learn it (see the M2
  # 2026-09-04 shell-removal finding), so this run's own local access to the
  # commands API is the one place that can read it off the container and
  # hand it to whoever runs the tailnet proof next. Written to a 600 file
  # under this run's own state directory, never to stdout, a log, or a
  # committed path.
  token="$(run_cmd "$BOX_ID" "cd /home/user/kizuki-src/deploy && docker compose exec -T kizuki cat /vault/.kizuki/serve.token" 2>/dev/null | tr -d '\n')"
  if [ -n "$token" ]; then
    printf '%s' "$token" > "$STATE_TOKEN_FILE"
    chmod 600 "$STATE_TOKEN_FILE"
  fi

  echo "box_id=$BOX_ID"
  echo "box_public_ip=$box_public_ip"
  echo "tailnet_hostname=$tailnet_host"
  echo "tailnet_ip=$tailnet_ip"
  echo "daemon_token_file=$STATE_TOKEN_FILE"
}

main() {
  acquire_box
  wait_box_usable
  deploy_tree
  place_authkey
  bring_up_stack
  wait_health
  report
}

main
