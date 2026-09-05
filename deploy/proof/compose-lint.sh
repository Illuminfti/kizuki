#!/usr/bin/env bash
# M2 tailnet access static finish line (docs/deploy-box-tailscale.md "M2
# Tailnet access"). Needs no Docker daemon; CI-runnable. Prints one
# `PASS <n> <label>` or `FAIL <n> <label> <reason>` line per check and
# exits non-zero on the first failure.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/deploy/compose.yml"

pass() {
  printf 'PASS %s %s\n' "$1" "$2"
}

fail() {
  printf 'FAIL %s %s %s\n' "$1" "$2" "$3"
  exit 1
}

[ -f "$COMPOSE" ] || fail 2.0 compose-exists "$COMPOSE does not exist"

# Isolate each service's own block (from its `  <name>:` line up to the next
# line at the same two-space service indent, or a top-level key). Good
# enough for this file's fixed two-space service shape; not a general YAML
# parser.
service_block() {
  local name="$1"
  awk -v svc="  ${name}:" '
    $0 == svc { grabbing = 1; next }
    grabbing && /^  [a-zA-Z0-9_-]+:$/ { grabbing = 0 }
    grabbing && /^[a-zA-Z0-9_-]+:$/ { grabbing = 0 }
    grabbing { print }
  ' "$COMPOSE"
}

check_2_1() {
  local images
  images="$(grep -E '^\s*image:' "$COMPOSE" || true)"
  [ -n "$images" ] || fail 2.1 images-pinned "no image: lines found in $COMPOSE"
  if printf '%s\n' "$images" | grep -qv '@sha256:'; then
    fail 2.1 images-pinned "an image: line lacks @sha256: $(printf '%s' "$images" | grep -v '@sha256:')"
  fi
  pass 2.1 images-pinned
}

check_2_2() {
  # `git grep` scans the tracked tree; the real key never appears there
  # regardless of whether the working tree has an untracked staged copy.
  # The pattern matches a real key's shape (as scripts/verify-secrets.ts's
  # tailscale-authkey rule does), not the bare string "tskey-", which this
  # very document and this script's own comments say in prose.
  if git -C "$ROOT" grep -nEI '\btskey-[a-z]+-[A-Za-z0-9]{10,}\b' -- . >/tmp/compose-lint-tskey.$$ 2>/dev/null; then
    fail 2.2 no-key-in-tree "git grep found a tskey-shaped secret: $(cat /tmp/compose-lint-tskey.$$)"
  fi
  rm -f /tmp/compose-lint-tskey.$$
  # compose.yml must reference the key only via a secret file path, never a
  # literal TS_AUTHKEY value in an environment block.
  if grep -qE '^\s*TS_AUTHKEY:' "$COMPOSE"; then
    fail 2.2 no-key-in-tree "compose.yml sets TS_AUTHKEY directly instead of via a secret"
  fi
  grep -qE '^\s*ts_authkey:' "$COMPOSE" || fail 2.2 no-key-in-tree "no ts_authkey secret declared in compose.yml"
  grep -qE '^\s*file:\s*\$\{KIZUKI_TS_AUTHKEY_FILE' "$COMPOSE" \
    || fail 2.2 no-key-in-tree "ts_authkey secret is not declared as a file: reference"
  pass 2.2 no-key-in-tree
}

check_2_3() {
  local state_dir
  state_dir="$(service_block tailscale | grep -E '^\s*TS_STATE_DIR:' | sed -E 's/^\s*TS_STATE_DIR:\s*//' | tr -d '"'"'"'')"
  [ -n "$state_dir" ] || fail 2.3 state-persists "no TS_STATE_DIR set on the tailscale service"
  local volume_line
  volume_line="$(service_block tailscale | grep -F ":${state_dir}" | grep -E '^\s*-\s*[a-zA-Z0-9_-]+:' || true)"
  [ -n "$volume_line" ] || fail 2.3 state-persists "no volume mounted at TS_STATE_DIR ($state_dir)"
  local volume_name
  volume_name="$(printf '%s' "$volume_line" | sed -E 's/^\s*-\s*//; s/:.*//')"
  grep -qE "^\s*${volume_name}:" <(sed -n '/^volumes:/,/^[a-zA-Z]/p' "$COMPOSE") \
    || fail 2.3 state-persists "volume '$volume_name' mounted at $state_dir is not a named top-level volume"
  pass 2.3 state-persists
}

check_2_4() {
  local block
  block="$(service_block kizuki)"
  printf '%s\n' "$block" | grep -qE '^\s*network_mode:\s*service:tailscale\s*$' \
    || fail 2.4 kizuki-no-own-network "kizuki service lacks network_mode: service:tailscale"
  if printf '%s\n' "$block" | grep -qE '^\s*ports:'; then
    fail 2.4 kizuki-no-own-network "kizuki service declares its own ports:"
  fi
  pass 2.4 kizuki-no-own-network
}

check_2_5() {
  for svc in tailscale kizuki; do
    local block
    block="$(service_block "$svc")"
    printf '%s\n' "$block" | grep -qE '^\s*cap_drop:\s*\[ALL\]\s*$' \
      || fail 2.5 capabilities-empty "$svc service lacks cap_drop: [ALL]"
    if printf '%s\n' "$block" | grep -qE '^\s*cap_add:'; then
      fail 2.5 capabilities-empty "$svc service declares cap_add"
    fi
    if printf '%s\n' "$block" | grep -qE '^\s*devices:'; then
      fail 2.5 capabilities-empty "$svc service declares devices"
    fi
  done
  pass 2.5 capabilities-empty
}

check_2_13() {
  if grep -qE '^\s*TS_AUTHKEY:' "$COMPOSE"; then
    fail 2.13 no-authkey-env "compose.yml sets a TS_AUTHKEY environment variable"
  fi
  pass 2.13 no-authkey-env
}

main() {
  check_2_1
  check_2_2
  check_2_3
  check_2_4
  check_2_5
  check_2_13
}

main "$@"
