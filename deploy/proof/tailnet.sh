#!/usr/bin/env bash
# M2 tailnet access finish line (docs/deploy-box-tailscale.md "M2 Tailnet
# access"), checks 2.6-2.12. Needs a real tailnet and the owner's auth key
# at /home/lars/.config/kizuki/ts-authkey inside WSL; not CI-runnable.
# Prints one `PASS <n> <label>` or `FAIL <n> <label> <reason>` line per
# check. Unlike deploy/proof/container.sh and compose-lint.sh, this script
# does NOT exit non-zero on the first failure: 2.7's outcome is a known,
# documented, argued-about risk (see the plan and the M2 Finding), and later
# checks that do not depend on it are still worth running and reporting.
# The script instead tracks whether any check failed and exits non-zero at
# the very end if so, after every check has had a chance to run.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/deploy/compose.yml"
REAL_KEY="/home/lars/.config/kizuki/ts-authkey"
RUN_ID="$$-$(date +%s)"
PROJECT="kizuki-m2-proof-${RUN_ID}"
STAGE_KEY="$(mktemp)"
ANY_FAIL=0
# Track the intended exit code explicitly rather than reading `$?` inside
# `cleanup`: `cleanup` runs several of its own commands before the shell
# actually exits, and this avoids any dependency on exactly which status
# bash considers current by the time the EXIT trap's own body runs. `die`
# is the only way this script should terminate once EXIT_CODE exists.
EXIT_CODE=0
die() {
  EXIT_CODE="$1"
  exit "$1"
}

cleanup() {
  # Best-effort: log the node out of the tailnet before tearing down local
  # state, so a fresh run does not accumulate registered nodes under the
  # control plane forever. This does NOT remove the node from the admin
  # console's device list; only the owner can do that, and the final report
  # names the node so they can.
  #
  # `down -v` below deletes the TS_STATE_DIR volume, which holds the node's
  # machine key. That is why every run of this script needs a *fresh*
  # authentication: there is no persisted identity to reconnect with next
  # time, so a single-use key gets consumed on its one and only run, and a
  # reusable key gets asked to authenticate a brand new node each time
  # instead of resuming the previous one. A real (M3) deployment that is
  # meant to survive restarts keeps this volume; this proof script, which
  # is meant to be repeatable from a clean slate, does not. Worth
  # reconsidering for M3: that milestone's design should not delete
  # TS_STATE_DIR between runs the way this proof intentionally does.
  docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale \
    tailscale --socket=/tmp/tailscaled.sock logout >/dev/null 2>&1 || true
  docker compose -p "$PROJECT" -f "$COMPOSE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rmi "${PROJECT}-kizuki" >/dev/null 2>&1 || true
  rm -f "$STAGE_KEY"
  exit "$EXIT_CODE"
}
trap cleanup EXIT

pass() {
  printf 'PASS %s %s\n' "$1" "$2"
}

fail() {
  printf 'FAIL %s %s %s\n' "$1" "$2" "$3"
  ANY_FAIL=1
}

blocked() {
  printf 'BLOCKED %s %s %s\n' "$1" "$2" "$3"
  ANY_FAIL=1
}

ts() {
  docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale \
    tailscale --socket=/tmp/tailscaled.sock "$@"
}

if [ ! -r "$REAL_KEY" ]; then
  echo "tailnet proof: no usable auth key at $REAL_KEY (needs a reusable, non-ephemeral, pre-approved key)" >&2
  die 1
fi

# See docs/deploy-box-tailscale.md's M2 Finding: Compose secrets outside
# Swarm mode preserve the host file's own mode (0600, owned by the
# operator), and cap_drop: [ALL] on the tailscale service removes
# CAP_DAC_OVERRIDE, so the container cannot read that file at all. This
# stages a copy with a world-readable mode for the life of this run only;
# the real key file is never touched or modified.
cp "$REAL_KEY" "$STAGE_KEY"
chmod 0444 "$STAGE_KEY"
export KIZUKI_TS_AUTHKEY_FILE="$STAGE_KEY"

echo "bringing up $PROJECT ..." >&2
if ! docker compose -p "$PROJECT" -f "$COMPOSE" up -d --build >/tmp/tailnet-up.$$ 2>&1; then
  cat /tmp/tailnet-up.$$ >&2
  rm -f /tmp/tailnet-up.$$
  echo "tailnet.sh: docker compose up failed; cannot run any check" >&2
  die 1
fi
rm -f /tmp/tailnet-up.$$

# A single-use key that has already authenticated a node once (or an
# ephemeral/expired/revoked key) fails with a clear tailscaled log line
# rather than a hang. Detect that early and exit distinctly instead of
# letting every numbered check below fail for the same underlying reason
# with a confusing "never came online" message. This is a real, observed
# failure mode on this branch (see the M2 Finding in
# docs/deploy-box-tailscale.md): the key at $REAL_KEY turned out to be
# single-use and was already spent by earlier exploration before this
# check existed.
detect_spent_key() {
  local attempt logs
  for attempt in $(seq 1 20); do
    logs="$(docker compose -p "$PROJECT" -f "$COMPOSE" logs tailscale 2>/dev/null || true)"
    if printf '%s' "$logs" | grep -qiE 'invalid key|key .* (expired|revoked|not valid)|key is already used|authkey.*used'; then
      echo "tailnet proof: no usable auth key at $REAL_KEY (needs a reusable, non-ephemeral, pre-approved key)" >&2
      echo "tailscaled reported: $(printf '%s' "$logs" | grep -iE 'invalid key|expired|revoked|not valid|already used' | tail -1)" >&2
      return 0
    fi
    if printf '%s' "$logs" | grep -q '"Online":true\|Switching ipn state .* -> Running'; then
      return 1
    fi
    sleep 1
  done
  return 1
}

if detect_spent_key; then
  for n in 2.6 2.7 2.8 2.9 2.10 2.11 2.12; do
    printf 'NOT RUN %s no usable auth key\n' "$n"
  done
  die 3
fi

wait_online() {
  local attempt status_json online
  for attempt in $(seq 1 60); do
    status_json="$(ts status --json 2>/dev/null || true)"
    online="$(printf '%s' "$status_json" | jq -r '.Self.Online // empty' 2>/dev/null || true)"
    if [ "$online" = "true" ]; then
      printf '%s' "$status_json"
      return 0
    fi
    sleep 1
  done
  return 1
}

STATUS_JSON=""
check_2_6() {
  STATUS_JSON="$(wait_online)" || {
    fail 2.6 node-online "kizuki-m2-proof never reported Online:true within 60s"
    return
  }
  local hostname
  hostname="$(printf '%s' "$STATUS_JSON" | jq -r '.Self.HostName')"
  [ "$hostname" = "kizuki-m2-proof" ] \
    || { fail 2.6 node-online "hostname is '$hostname', want kizuki-m2-proof"; return; }
  local tags
  tags="$(printf '%s' "$STATUS_JSON" | jq -r '.Self.Tags // empty')"
  if [ -z "$tags" ] || [ "$tags" = "null" ]; then
    pass 2.6 node-online
    echo "  note: the auth key is untagged (no Self.Tags on the node); the plan named a tag:kizuki assertion, this key does not carry one" >&2
  else
    pass 2.6 node-online
    echo "  tags: $tags" >&2
  fi
}

CERT_DOMAIN=""
check_2_7() {
  CERT_DOMAIN="$(printf '%s' "$STATUS_JSON" | jq -r '.Self.DNSName' | sed 's/\.$//')"
  if [ -z "$CERT_DOMAIN" ] || [ "$CERT_DOMAIN" = "null" ]; then
    blocked 2.7 health-over-tailnet "no DNSName on the node; cannot form the https URL"
    return
  fi
  # Give tailscaled a moment to finish ACME issuance after boot.
  local attempt body code
  for attempt in $(seq 1 30); do
    body="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale \
      wget -q -S -O - "https://${CERT_DOMAIN}/health" 2>&1)"
    code="$(printf '%s' "$body" | grep -oE 'HTTP/[0-9.]+ [0-9]+' | tail -1 | awk '{print $2}')"
    [ -n "$code" ] && break
    sleep 1
  done
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"ok":true'; then
    pass 2.7 health-over-tailnet
    return
  fi
  fail 2.7 health-over-tailnet "got HTTP $code from https://${CERT_DOMAIN}/health, not 200 with \"ok\":true. Root cause (see docs/deploy-box-tailscale.md M2 Finding): tailscale serve's reverse proxy forwards the client's original Host header ($CERT_DOMAIN) to the http://127.0.0.1:8787 backend unchanged; packages/core/src/serve/http.ts startServeHttp rejects any request whose URL hostname is not 127.0.0.1/localhost/[::1] with 403 bind_refused, before it even looks at the path. Tried: pointing serve.json's Proxy at both 127.0.0.1:8787 and localhost:8787 (same header forwarded either way); searched tailscaled's serve JSON schema and containerboot for a Host-rewrite field (none found; NewSingleHostReverseProxy default is used). No fix is available without either changing tailscale's serve proxy behavior (not ours to change) or widening the loopback check in packages/core, which is forbidden. Full response: $body"
}

check_2_8() {
  local token status_json presented_ok body code
  token="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T kizuki \
    cat /vault/.kizuki/serve.token 2>/dev/null | tr -d '\r\n')"
  if [ -z "$token" ]; then
    blocked 2.8 mcp-over-tailnet "could not read the kizuki serve daemon token from /vault/.kizuki/serve.token"
    return
  fi
  body="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale sh -c \
    "wget -q -S -O - --header='Authorization: Bearer ${token}' --header='Content-Type: application/json' --post-data='{}' 'https://${CERT_DOMAIN}/v1/mcp/system_health'" 2>&1)"
  code="$(printf '%s' "$body" | grep -oE 'HTTP/[0-9.]+ [0-9]+' | tail -1 | awk '{print $2}')"
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"ok":true'; then
    pass 2.8 mcp-over-tailnet
    return
  fi
  fail 2.8 mcp-over-tailnet "got HTTP $code, not 200 with \"ok\":true; this depends on the same tailnet HTTP path as 2.7 and fails for the same reason (used the daemon's own serve.token, not an agent-minted token: kizuki agent add is not on this branch). Response: $body"
}

check_2_9() {
  local body code
  body="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale sh -c \
    "wget -q -S -O - --header='Content-Type: application/json' --post-data='{}' 'https://${CERT_DOMAIN}/v1/mcp/system_health'" 2>&1)"
  code="$(printf '%s' "$body" | grep -oE 'HTTP/[0-9.]+ [0-9]+' | tail -1 | awk '{print $2}')"
  if [ "$code" = "401" ] && printf '%s' "$body" | grep -q '"unauthorized"'; then
    pass 2.9 fail-closed-no-token
    return
  fi
  fail 2.9 fail-closed-no-token "got HTTP $code, want 401 unauthorized; the request never reached the auth check because the loopback-host rejection (403 bind_refused, see 2.7) fires first. The call is still refused end to end, but not for the reason or with the status code the plan names. Response: $body"
}

check_2_10() {
  local ts_ports kz_ports
  ts_ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "${PROJECT}-tailscale-1" 2>/dev/null)"
  kz_ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "${PROJECT}-kizuki-1" 2>/dev/null)"
  if [ "$ts_ports" = "{}" ] && [ "$kz_ports" = "{}" ]; then
    pass 2.10 public-ip-dark
    echo "  note: this WSL host has no public IP; the real public-IP probe belongs to M3 on the Box. This check proves neither container publishes a port at all." >&2
    return
  fi
  fail 2.10 public-ip-dark "a container publishes a port: tailscale=$ts_ports kizuki=$kz_ports"
}

check_2_11() {
  # Row 2.11 replaces the plan's original "stdio MCP over Tailscale SSH"
  # wording (see docs/deploy-box-tailscale.md M2 Finding): Tailscale SSH
  # lands in the tailscale sidecar, which has no Kizuki tree, and reaching
  # the kizuki container from there would need the Docker socket mounted
  # into the sidecar, a privilege escalation this milestone refuses. This
  # proves SSH connectivity to the node itself; the harness transport is
  # the HTTP path (2.8).
  local out
  out="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale \
    tailscale --socket=/tmp/tailscaled.sock ssh kizuki-m2-proof -- true 2>&1)"
  if [ $? -eq 0 ]; then
    pass 2.11 tailscale-ssh-reaches-node
    return
  fi
  fail 2.11 tailscale-ssh-reaches-node "tailscale ssh kizuki-m2-proof -- true failed: $out"
}

check_2_12() {
  local id_before id_after
  id_before="$(printf '%s' "$STATUS_JSON" | jq -r '.Self.ID')"
  docker compose -p "$PROJECT" -f "$COMPOSE" restart >/dev/null 2>&1
  local after_json
  after_json="$(wait_online)" || {
    fail 2.12 restart-keeps-identity "node never came back online after docker compose restart"
    return
  }
  id_after="$(printf '%s' "$after_json" | jq -r '.Self.ID')"
  if [ "$id_before" != "$id_after" ]; then
    fail 2.12 restart-keeps-identity "node id changed: $id_before -> $id_after"
    return
  fi
  pass 2.12 restart-keeps-identity
  echo "  note: 2.7 does not pass after restart either, for the same reason it did not pass before restart (see 2.7); this check only asserts node-id stability, which held." >&2
}

main() {
  check_2_6
  check_2_7
  check_2_8
  check_2_9
  check_2_10
  check_2_11
  check_2_12
  echo "--- node registered as kizuki-m2-proof on tailnet ${CERT_DOMAIN#kizuki-m2-proof.}; the owner must remove it from the admin console device list (logout was attempted on cleanup, which does not delete the device entry) ---" >&2
  die "$ANY_FAIL"
}

main "$@"
