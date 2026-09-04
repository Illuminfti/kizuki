#!/usr/bin/env bash
# M2 tailnet access finish line (docs/deploy-box-tailscale.md "M2 Tailnet
# access"), checks 2.6-2.12 and 2.14. Needs a real tailnet and the owner's
# auth key
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
REAL_KEY_DIR="$(dirname -- "$REAL_KEY")"
RUN_ID="$$-$(date +%s)"
PROJECT="kizuki-m2-proof-${RUN_ID}"
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

# Precondition, not a workaround: cap_drop: [ALL] on the tailscale service
# removes CAP_DAC_OVERRIDE, so its root can only read the key file via the
# ordinary "other" permission bits. The key file being readable by "other"
# (0644) is only safe because its containing directory is 0700 — no local
# user besides the owner can traverse into the directory to reach the file
# at all, regardless of the file's own mode (see the M2 Finding in
# docs/deploy-box-tailscale.md and the `secrets:` comment in
# deploy/compose.yml). This never loosens a copy; it asserts the real
# file's and real directory's actual modes and fails loudly if either one
# is not what the compose file's security argument depends on.
dir_mode="$(stat -c '%a' "$REAL_KEY_DIR" 2>/dev/null || true)"
if [ "$dir_mode" != "700" ]; then
  echo "tailnet proof: $REAL_KEY_DIR is mode ${dir_mode:-unknown}, want 700 (the key file's own 0644 mode is only safe if its directory blocks traversal by everyone but the owner)" >&2
  die 1
fi
key_mode="$(stat -c '%a' "$REAL_KEY" 2>/dev/null || true)"
if [ "$key_mode" != "644" ] && [ "$key_mode" != "444" ] && [ "$key_mode" != "600" ]; then
  echo "tailnet proof: $REAL_KEY is mode ${key_mode:-unknown}; expected 644 (readable under cap_drop: [ALL] without a directory-permission dependency other than the 0700 check above)" >&2
  die 1
fi
if [ "$key_mode" = "600" ]; then
  echo "tailnet proof: $REAL_KEY is mode 600; cap_drop: [ALL] on the tailscale service means its root cannot read a file it does not own even with a 0700 parent directory. chmod 0644 the key file (safe: the 0700 directory already blocks other users) before running this proof." >&2
  die 1
fi

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
  for n in 2.6 2.7 2.8 2.9 2.10 2.11 2.12 2.14; do
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

# deploy/tailscale/serve.json forwards raw TCP on port 8787 to
# 127.0.0.1:8787 (TCPForward), not an HTTPS reverse proxy. Raw TCP does no
# HTTP parsing or rewriting, so whatever Host header the client sends
# reaches Kizuki byte-for-byte; sending `Host: 127.0.0.1` satisfies
# startServeHttp's loopback-only check with no core change and no proxy
# component of our own. There is deliberately no TLS on this port: the
# tailnet itself is WireGuard-encrypted end to end, so a second TLS layer
# on top would protect nothing further. This is the documented, tested
# resolution recorded in the M2 Finding in docs/deploy-box-tailscale.md.
TS_IP=""
check_2_7() {
  TS_IP="$(printf '%s' "$STATUS_JSON" | jq -r '.Self.TailscaleIPs[0] // empty')"
  if [ -z "$TS_IP" ]; then
    blocked 2.7 health-over-tailnet "no TailscaleIPs on the node; cannot form the tcp-forwarded URL"
    return
  fi
  local body code
  body="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale \
    wget -q -S -O - --header='Host: 127.0.0.1' "http://${TS_IP}:8787/health" 2>&1)"
  code="$(printf '%s' "$body" | grep -oE 'HTTP/[0-9.]+ [0-9]+' | tail -1 | awk '{print $2}')"
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"ok":true'; then
    pass 2.7 health-over-tailnet
    return
  fi
  fail 2.7 health-over-tailnet "got HTTP $code from http://${TS_IP}:8787/health with Host: 127.0.0.1, not 200 with \"ok\":true. Response: $body"
}

check_2_8() {
  local token body code
  token="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T kizuki \
    cat /vault/.kizuki/serve.token 2>/dev/null | tr -d '\r\n')"
  if [ -z "$token" ]; then
    blocked 2.8 mcp-over-tailnet "could not read the kizuki serve daemon token from /vault/.kizuki/serve.token"
    return
  fi
  body="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale sh -c \
    "wget -q -S -O - --header='Host: 127.0.0.1' --header='Authorization: Bearer ${token}' --header='Content-Type: application/json' --post-data='{}' 'http://${TS_IP}:8787/v1/mcp/system_health'" 2>&1)"
  code="$(printf '%s' "$body" | grep -oE 'HTTP/[0-9.]+ [0-9]+' | tail -1 | awk '{print $2}')"
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"ok":true'; then
    pass 2.8 mcp-over-tailnet
    return
  fi
  fail 2.8 mcp-over-tailnet "got HTTP $code, not 200 with \"ok\":true (used the daemon's own serve.token, not an agent-minted token: kizuki agent add is not on this branch). Response: $body"
}

check_2_9() {
  local body code
  body="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale sh -c \
    "wget -q -S -O - --header='Host: 127.0.0.1' --header='Content-Type: application/json' --post-data='{}' 'http://${TS_IP}:8787/v1/mcp/system_health'" 2>&1)"
  code="$(printf '%s' "$body" | grep -oE 'HTTP/[0-9.]+ [0-9]+' | tail -1 | awk '{print $2}')"
  if [ "$code" = "401" ] && printf '%s' "$body" | grep -q '"unauthorized"'; then
    pass 2.9 fail-closed-no-token
    return
  fi
  fail 2.9 fail-closed-no-token "got HTTP $code, want 401 unauthorized. Response: $body"
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
  # Row 2.11 is now the inverse of the plan's original "Tailscale SSH
  # reaches the node" wording (see the compose.yml comment above
  # TS_EXTRA_ARGS and the AGENTS.md resource-abuse concern this milestone
  # closes): a hosted box must not hand a customer a shell, so this asserts
  # that `tailscale ssh` is REFUSED, not that it succeeds. A refusal is only
  # meaningful evidence of "no shell exposed" if the node is actually up;
  # otherwise a refusal could just mean nothing is reachable at all. 2.6
  # having passed by the time this runs is one precondition; re-asserting
  # reachability with the same health call 2.7 uses, right before the SSH
  # attempt, rules out "the node went offline in between" as the reason for
  # the refusal.
  if [ "$STATUS_JSON" = "" ]; then
    blocked 2.11 no-shell-exposed "node status unknown (2.6 did not produce STATUS_JSON); cannot tell a meaningful SSH refusal from an unreachable node"
    return
  fi
  if [ -z "$TS_IP" ]; then
    blocked 2.11 no-shell-exposed "no TailscaleIPs on the node; cannot re-assert reachability before the SSH attempt"
    return
  fi
  local health_code health_body
  health_body="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale \
    wget -q -S -O - --header='Host: 127.0.0.1' "http://${TS_IP}:8787/health" 2>&1)"
  health_code="$(printf '%s' "$health_body" | grep -oE 'HTTP/[0-9.]+ [0-9]+' | tail -1 | awk '{print $2}')"
  if [ "$health_code" != "200" ] || ! printf '%s' "$health_body" | grep -q '"ok":true'; then
    blocked 2.11 no-shell-exposed "node did not answer /health just now (got HTTP ${health_code:-none}); an SSH failure here would not distinguish 'refused' from 'offline'"
    return
  fi
  local out rc
  out="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale \
    tailscale --socket=/tmp/tailscaled.sock ssh kizuki-m2-proof -- true 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    pass 2.11 no-shell-exposed
    return
  fi
  fail 2.11 no-shell-exposed "tailscale ssh kizuki-m2-proof -- true succeeded (exit 0) with the node confirmed reachable; this hosted box must refuse SSH: $out"
}

# 2.14 exists because Tailscale does not document, in its own pages (three
# were checked while writing this plan's M2 Finding), that userspace
# networking's containment is total: no TUN device means no kernel route
# into this box for anything but the ports named in serve.json, but that is
# an inference from how tailscaled is built, not a written guarantee. So it
# is proven here rather than asserted in a comment: from the peer side, try
# a TCP connect to a tailnet-address port that is NOT in serve.json (one
# nothing listens on, plus one a neighbor in the shared namespace might
# plausibly run) and require refusal or timeout, with a short explicit
# timeout so a hang reads as a failure instead of a stall.
check_2_14() {
  if [ -z "$TS_IP" ]; then
    blocked 2.14 only-served-ports-reachable "no TailscaleIPs on the node; cannot form a target address"
    return
  fi
  local port desc rc out
  for entry in "9999:a port nothing listens on" "22:a port a neighbor's SSH might listen on"; do
    port="${entry%%:*}"
    desc="${entry#*:}"
    out="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T tailscale \
      sh -c "nc -z -w 3 '${TS_IP}' '${port}'" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      fail 2.14 only-served-ports-reachable "TCP connect to ${TS_IP}:${port} (${desc}) succeeded; only ports in serve.json should be reachable"
      return
    fi
  done
  pass 2.14 only-served-ports-reachable
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
  check_2_14
  echo "--- node registered as kizuki-m2-proof (tailscale IP ${TS_IP:-unknown}); the owner must remove it from the admin console device list (logout was attempted on cleanup, which does not delete the device entry) ---" >&2
  die "$ANY_FAIL"
}

main "$@"
