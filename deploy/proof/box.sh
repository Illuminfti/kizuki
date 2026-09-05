#!/usr/bin/env bash
# M3 Box lifecycle finish line (docs/deploy-box-tailscale.md "M3 Box golden
# snapshot and one-command setup"). Not CI-runnable: it provisions and tears
# down real Box VMs (box.ascii.dev) and bills per second. Prints one
# `PASS <n> <label>`, `FAIL <n> <label> <reason>` or `BLOCKED <n> <label>
# <reason>` line per check; does not stop at the first failure (later
# checks that do not depend on an earlier one are still worth running), and
# exits non-zero if anything failed or was blocked.
#
# Usage:
#   deploy/proof/box.sh <box-api-key-file> <ts-authkey-file> [ttl-seconds]
#
# Every box this script creates is deleted before it exits, success or
# failure, and the fleet is confirmed empty at the end (printed, not
# asserted as a numbered check, since "the account has no other boxes right
# now" is a precondition of a clean run rather than a property this proof
# itself establishes).
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
API_BASE="https://ascii.dev/api/box/v1"
BOOTSTRAP="$ROOT/deploy/box/bootstrap.sh"

usage() {
  echo "usage: $0 <box-api-key-file> <ts-authkey-file> [ttl-seconds]" >&2
  exit 2
}
[ $# -ge 2 ] || usage
BOX_API_KEY_FILE="$1"
TS_AUTHKEY_FILE="$2"
TTL_SECONDS="${3:-1800}"
BOX_API_KEY="$(cat -- "$BOX_API_KEY_FILE")"

STATE_DIR="$(mktemp -d)"
ANY_FAIL=0
CREATED_BOXES=""

pass() { printf 'PASS %s %s\n' "$1" "$2"; }
fail() { printf 'FAIL %s %s %s\n' "$1" "$2" "$3"; ANY_FAIL=1; }
blocked() { printf 'BLOCKED %s %s %s\n' "$1" "$2" "$3"; ANY_FAIL=1; }

api() {
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer $BOX_API_KEY" -H "Content-Type: application/json" \
      --data-binary "$data" "$API_BASE$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $BOX_API_KEY" "$API_BASE$path"
  fi
}
json_str() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -1; }

# A command's stdout, as JSON-embedded by the commands endpoint, with the
# double escaping this script never runs through a real JSON decoder for
# (see bootstrap.sh's own run_cmd for the identical fix and why): literal
# `\"` unescaped to `"`, and a trailing literal `\n` (backslash, n) -- the
# API's encoding of a real trailing newline -- stripped rather than left as
# two extra characters a `[ "$x" = "events=3" ]` comparison would never match.
cmd_stdout() {
  local raw
  raw="$(sed -n 's/.*"stdout":"\(.*\)","stderr".*/\1/p' | sed 's/\\"/"/g')"
  while [ "${raw: -2}" = '\n' ]; do
    raw="${raw%\\n}"
  done
  printf '%s' "$raw"
}

box_state() { api GET "/boxes/$1" | json_str state; }
box_vault_id() {
  # /vault is a path inside the kizuki container's own volume, not on the
  # box's host filesystem -- this must go through `docker compose exec`,
  # the same as every other in-container read this script does.
  api POST "/boxes/$1/commands" \
    '{"command":"cd /home/user/kizuki-src/deploy 2>/dev/null && docker compose exec -T kizuki cat /vault/.kizuki/vault-id 2>/dev/null || true"}' \
    | cmd_stdout | head -c 200
}
box_event_count() {
  # doctor's own "events=N" line, read the same way check_1_8 in
  # deploy/proof/container.sh reads it: from `kizuki doctor` output, not
  # from a query (see the M1 sensitivity finding in the plan doc for why a
  # query hit is not a usable signal here).
  api POST "/boxes/$1/commands" \
    "{\"command\":\"cd /home/user/kizuki-src/deploy 2>/dev/null && docker compose exec -T kizuki kizuki doctor --vault /vault 2>/dev/null | grep -o 'events=[0-9]*'\"}" \
    | cmd_stdout
}

# Brings the compose stack up on a box that is freshly resumed or forked,
# where no container survives from before (see the M3 finding in
# docs/deploy-box-tailscale.md: only images and named volumes do). Retries
# once past the "Conflict ... name ... already in use" race the first
# attempt reliably hits right after a resume/fork, by removing the
# half-created containers and trying again.
bring_up_compose() {
  local box="$1" up_attempt up_resp
  for up_attempt in 1 2 3; do
    up_resp="$(api POST "/boxes/$box/commands" \
      '{"command":"cd /home/user/kizuki-src/deploy && KIZUKI_TS_AUTHKEY_FILE=/home/user/.config/kizuki/ts-authkey docker compose up -d 2>&1 | tail -20"}')"
    case "$up_resp" in
      *Conflict*)
        api POST "/boxes/$box/commands" \
          '{"command":"docker rm -f deploy-tailscale-1 deploy-kizuki-1 2>/dev/null || true"}' >/dev/null
        sleep 3
        continue
        ;;
      *) return 0 ;;
    esac
  done
  return 1
}

delete_all_created() {
  local box
  for box in $CREATED_BOXES; do
    curl -sS -X DELETE -H "Authorization: Bearer $BOX_API_KEY" -H "X-Ascii-Confirm-Delete: $box" \
      "$API_BASE/boxes/$box" >/dev/null 2>&1 || true
  done
}
trap delete_all_created EXIT

# ---- 3.1: one command, five minutes ---------------------------------

# Sets the global LAST_BOX_ID rather than "returning" one via stdout, and
# is called directly rather than as `box_id="$(check_3_1)"`, on purpose:
# bash command substitution runs in a subshell, so an assignment to
# CREATED_BOXES made only inside that subshell (the whole reason 3.1 needs
# to track the box it made) would vanish the instant the substitution
# finished, and this run's own cleanup trap would never see it. An earlier
# version of this script did exactly that and it silently stopped deleting
# the box it created; see the M3 finding in docs/deploy-box-tailscale.md.
LAST_BOX_ID=""
check_3_1() {
  local run_state_dir out rc start end elapsed box_id
  run_state_dir="$STATE_DIR/3.1"
  start="$(date +%s)"
  out="$("$BOOTSTRAP" "$BOX_API_KEY_FILE" "$TS_AUTHKEY_FILE" "$TTL_SECONDS" "$run_state_dir" 2>&1)"
  rc=$?
  end="$(date +%s)"
  elapsed=$((end - start))
  box_id="$(printf '%s' "$out" | sed -n 's/^box_id=//p')"
  [ -n "$box_id" ] && CREATED_BOXES="$CREATED_BOXES $box_id"
  LAST_BOX_ID="$box_id"
  if [ "$rc" -ne 0 ]; then
    fail 3.1 create-to-healthy-under-5min "bootstrap.sh exited $rc after ${elapsed}s: $out"
    return 1
  fi
  if [ "$elapsed" -gt 300 ]; then
    fail 3.1 create-to-healthy-under-5min "took ${elapsed}s, want <= 300s"
    return 1
  fi
  pass 3.1 create-to-healthy-under-5min
  echo "  measured: ${elapsed}s" >&2
}

# ---- 3.2: stop and resume keep the vault -----------------------------

check_3_2() {
  local box="$1"
  if [ -z "$box" ]; then
    blocked 3.2 stop-resume-keeps-vault "3.1 did not produce a usable box"
    return
  fi
  local before after
  # Import the fixtures once so there is ledger state to lose, matching
  # container.sh check 1.6/1.8's own "events=3" signal.
  api POST "/boxes/$box/commands" \
    '{"command":"cd /home/user/kizuki-src/deploy && docker compose exec -T kizuki kizuki import markdown-folder --source /fixtures --vault /vault"}' >/dev/null
  before="$(box_event_count "$box")"
  case "$before" in
    events=3) ;;
    *) fail 3.2 stop-resume-keeps-vault "import before stop did not reach events=3 (got '$before')"; return ;;
  esac

  local stop_resp
  stop_resp="$(api POST "/boxes/$box/stop" '{}')"
  case "$stop_resp" in
    *'"ok":true'*) ;;
    *) fail 3.2 stop-resume-keeps-vault "POST /boxes/$box/stop did not report ok:true: $stop_resp"; return ;;
  esac
  local waited=0 state
  while [ "$waited" -lt 120 ]; do
    state="$(box_state "$box")"
    [ "$state" = "archived" ] && break
    sleep 3; waited=$((waited + 3))
  done
  [ "$state" = "archived" ] || { fail 3.2 stop-resume-keeps-vault "box did not reach state=archived after stop (last: $state)"; return; }

  local resume_resp
  resume_resp="$(api POST "/boxes/$box/resume" '{}')"
  case "$resume_resp" in
    *'"ok":true'*) ;;
    *) fail 3.2 stop-resume-keeps-vault "POST /boxes/$box/resume did not report ok:true: $resume_resp"; return ;;
  esac
  waited=0
  while [ "$waited" -lt 120 ]; do
    state="$(box_state "$box")"
    case "$state" in idle|running|ready) break ;; esac
    sleep 3; waited=$((waited + 3))
  done
  case "$state" in
    idle|running|ready) ;;
    *) fail 3.2 stop-resume-keeps-vault "box did not become usable after resume (last: $state)"; return ;;
  esac

  # The compose stack itself is not part of what "resume" restarts (resume
  # restarts the VM from its snapshot; docker's own restart policy, if any,
  # is unset in compose.yml -- see the finding below), so bring it back up
  # the same way bootstrap.sh does before re-reading doctor.
  bring_up_compose "$box" || true
  waited=0
  while [ "$waited" -lt 120 ]; do
    after="$(box_event_count "$box")"
    [ "$after" = "events=3" ] && break
    sleep 3; waited=$((waited + 3))
  done
  if [ "$after" != "events=3" ]; then
    fail 3.2 stop-resume-keeps-vault "doctor after resume reports '$after', want events=3 with no re-import"
    return
  fi
  pass 3.2 stop-resume-keeps-vault
}

# ---- 3.3: a forked box gets a distinct identity ----------------------

check_3_3() {
  local box="$1"
  if [ -z "$box" ]; then
    blocked 3.3 fork-is-distinct-identity "3.1 did not produce a usable box"
    return
  fi
  local resp fork_id
  resp="$(api POST "/boxes/$box/fork" "{\"ttlSeconds\":$TTL_SECONDS}")"
  case "$resp" in
    *'"ok":true'*) ;;
    *)
      blocked 3.3 fork-is-distinct-identity "POST /boxes/$box/fork did not report ok:true (fork may not be exposed on this plan/account): $resp"
      return
      ;;
  esac
  fork_id="$(printf '%s' "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$fork_id" ] || { blocked 3.3 fork-is-distinct-identity "fork response had no box id: $resp"; return; }
  CREATED_BOXES="$CREATED_BOXES $fork_id"

  local waited=0 state
  while [ "$waited" -lt 120 ]; do
    state="$(box_state "$fork_id")"
    case "$state" in idle|running|ready) break ;; error) break ;; esac
    sleep 3; waited=$((waited + 3))
  done
  case "$state" in
    idle|running|ready) ;;
    *) fail 3.3 fork-is-distinct-identity "forked box $fork_id did not become usable (last: $state)"; return ;;
  esac

  # Neither box has a running kizuki container at this point: the original
  # may not (3.2 may have failed or left it down), and a fork -- like a
  # resume -- restores images and volumes but not live containers (see the
  # M3 finding in docs/deploy-box-tailscale.md). Bring both up before
  # reading vault-id from either.
  bring_up_compose "$box" || true
  bring_up_compose "$fork_id" || true

  local original_vault_id fork_vault_id
  original_vault_id="$(box_vault_id "$box")"
  fork_vault_id="$(box_vault_id "$fork_id")"
  if [ -z "$original_vault_id" ] || [ -z "$fork_vault_id" ]; then
    fail 3.3 fork-is-distinct-identity "could not read vault-id from original ($box) or fork ($fork_id)"
    return
  fi
  if [ "$original_vault_id" = "$fork_vault_id" ]; then
    fail 3.3 fork-is-distinct-identity "fork's vault-id equals the original's ($original_vault_id)"
    return
  fi
  pass 3.3 fork-is-distinct-identity
  echo "  original vault-id: $original_vault_id" >&2
  echo "  fork vault-id:     $fork_vault_id" >&2
}

# ---- 3.4: stranger proof --------------------------------------------

check_3_4() {
  if [ ! -x "$ROOT/scripts/stranger-proof.sh" ]; then
    blocked 3.4 stranger-proof-runs-against-box "scripts/stranger-proof.sh does not exist yet (see docs/CURRENT.md: neither proof is in this tree)"
    return
  fi
  fail 3.4 stranger-proof-runs-against-box "scripts/stranger-proof.sh exists but this proof was not updated to call it; treat this as a bug, not evidence of anything about the box"
}

main() {
  check_3_1
  check_3_2 "$LAST_BOX_ID"
  check_3_3 "$LAST_BOX_ID"
  check_3_4
  echo "--- deleting every box this run created ---" >&2
  delete_all_created
  CREATED_BOXES=""
  local remaining
  remaining="$(api GET /boxes)"
  echo "fleet after cleanup: $remaining" >&2
  exit "$ANY_FAIL"
}

main
