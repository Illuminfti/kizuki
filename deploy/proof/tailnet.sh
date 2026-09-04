#!/usr/bin/env bash
# M2 tailnet access finish line (docs/deploy-box-tailscale.md "M2 Tailnet
# access"), checks 2.6-2.12 and 2.14. Not CI-runnable.
#
# Topology: this script runs FROM a tailnet peer AGAINST an already-running,
# remote kizuki box. It does not bring the box up and does not have docker
# access to it — bringing a box up is the deployment's job (M3), not the
# proof's. An earlier version of this script ran `docker compose up` on the
# same machine that then ran every check, and wrapped peer-side checks in
# `docker compose exec -T tailscale ...`, which runs *inside* the node under
# test's own network namespace. A request from there to the node's own
# tailnet IP can short-circuit locally and never touch the real tailnet data
# path, which made 2.7-2.9, 2.11 and 2.14 close to vacuous: "the node can
# reach itself" is not "a peer can reach it". See the M2 Finding in
# docs/deploy-box-tailscale.md for the full account of why this changed.
#
# Requires, on whatever machine runs this script: a POSIX shell, and
# `tailscale`, `curl`, `nc`, `jq` on PATH, with this machine already
# authenticated onto the same tailnet as the target box under a *different*
# node identity. No path specific to one operating system or one operator's
# machine is hard-coded; use whichever peer has these tools (a Box VM, a
# Linux peer, or an operator machine with Git Bash and the Tailscale CLI on
# PATH).
#
# Target node: the first argument, or $KIZUKI_TAILNET_NODE, or
# kizuki-m2-proof (this milestone's fixture hostname) as the default.
# Target port: $KIZUKI_TAILNET_PORT, default 8787.
#
# Prints one `PASS <n> <label>`, `FAIL <n> <label> <reason>` or
# `BLOCKED <n> <label> <reason>` line per check. Does NOT exit non-zero on
# the first failure: later checks that do not depend on an earlier one are
# still worth running and reporting. Tracks whether any check failed or was
# blocked and exits non-zero at the end if so.
set -uo pipefail

TARGET="${1:-${KIZUKI_TAILNET_NODE:-kizuki-m2-proof}}"
PORT="${KIZUKI_TAILNET_PORT:-8787}"
ANY_FAIL=0

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

for bin in tailscale curl nc jq; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "tailnet proof: '$bin' not found on PATH. This script must run from a machine that is itself a tailnet peer (a Box VM, a Linux peer, or an operator machine with the Tailscale CLI installed), not from inside the box under test." >&2
    exit 1
  }
done

STATUS_JSON=""
TS_IP=""

# Polls THIS peer's own view of $TARGET (via this machine's own `tailscale
# status --json`, never the target's own opinion of itself) for up to 60s.
# There is no "docker compose up" to wait on here: the target is a
# different machine, already started (or not) by its own deployment: this
# only observes it.
wait_target_online() {
  local attempt json peer online
  for attempt in $(seq 1 60); do
    json="$(tailscale status --json 2>/dev/null || true)"
    peer="$(printf '%s' "$json" | jq -r --arg n "$TARGET" \
      '(.Peer // {}) | to_entries[] | select(.value.HostName == $n) | .value' 2>/dev/null || true)"
    online="$(printf '%s' "$peer" | jq -r '.Online // empty' 2>/dev/null || true)"
    if [ "$online" = "true" ]; then
      printf '%s' "$peer"
      return 0
    fi
    sleep 1
  done
  return 1
}

check_2_6() {
  local self_name
  self_name="$(tailscale status --json 2>/dev/null | jq -r '.Self.HostName // empty')"
  if [ -n "$self_name" ] && [ "$self_name" = "$TARGET" ]; then
    blocked 2.6 node-online "target ($TARGET) is this peer's own hostname; this proof must run from a machine other than the node under test, or it re-creates the self-probe it exists to avoid"
    return
  fi
  local peer
  peer="$(wait_target_online)" || {
    fail 2.6 node-online "$TARGET never reported Online:true within 60s, as seen from this peer's own tailscale status"
    return
  }
  STATUS_JSON="$peer"
  TS_IP="$(printf '%s' "$STATUS_JSON" | jq -r '.TailscaleIPs[0] // empty')"
  if [ -z "$TS_IP" ]; then
    fail 2.6 node-online "$TARGET is online but this peer's status has no TailscaleIPs for it"
    return
  fi
  pass 2.6 node-online
  local tags
  tags="$(printf '%s' "$STATUS_JSON" | jq -r '.Tags // empty')"
  if [ -z "$tags" ] || [ "$tags" = "null" ]; then
    echo "  note: $TARGET is untagged in this peer's view of it (no Tags); the plan named a tag:kizuki assertion, the key used for this branch does not carry one" >&2
  else
    echo "  tags: $tags" >&2
  fi
}

# Shared by 2.7, 2.11 and 2.14: an HTTP GET of /health directly from this
# peer's own network stack, with a short explicit timeout so a hang reads
# as a failure rather than a stall. serve.json forwards raw TCP on $PORT to
# 127.0.0.1:$PORT (TCPForward), not an HTTPS reverse proxy, so whatever Host
# header the client sends reaches Kizuki byte-for-byte; sending
# `Host: 127.0.0.1` satisfies startServeHttp's loopback-only check with no
# core change and no proxy component of our own (see the M2 Finding in
# docs/deploy-box-tailscale.md). Prints "<code>\n<body>"; callers parse both.
peer_health() {
  local out code body
  out="$(curl -sS -m 5 -o - -w '\n%{http_code}' --header 'Host: 127.0.0.1' \
    "http://${TS_IP}:${PORT}/health" 2>&1)"
  code="$(printf '%s' "$out" | tail -1)"
  body="$(printf '%s' "$out" | sed '$d')"
  printf '%s\n%s' "$code" "$body"
}

check_2_7() {
  if [ -z "$TS_IP" ]; then
    blocked 2.7 health-over-tailnet "2.6 did not establish $TARGET's tailnet address; nothing to connect to"
    return
  fi
  local result code body
  result="$(peer_health)"
  code="$(printf '%s' "$result" | head -1)"
  body="$(printf '%s' "$result" | tail -n +2)"
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"ok":true'; then
    pass 2.7 health-over-tailnet
    return
  fi
  fail 2.7 health-over-tailnet "got HTTP $code from http://${TS_IP}:${PORT}/health with Host: 127.0.0.1, not 200 with \"ok\":true. Response: $body"
}

check_2_8() {
  if [ -z "$TS_IP" ]; then
    blocked 2.8 mcp-over-tailnet "2.6 did not establish $TARGET's tailnet address; nothing to connect to"
    return
  fi
  # This peer has no filesystem or docker access to the box (SSH is
  # deliberately refused, per the M2 shell-removal change, and nothing else
  # exposes a shell), so it cannot read the daemon token off the box itself
  # the way an earlier, same-machine version of this script did. The token
  # must be supplied out-of-band by whatever process started the box (the
  # deployment/bootstrap script, which does have local access when it
  # brings the box up) via KIZUKI_DAEMON_TOKEN. This is a real, honest gap
  # in what a peer-only proof can do on its own; see the M2 Finding.
  local token out code body
  token="${KIZUKI_DAEMON_TOKEN:-}"
  if [ -z "$token" ]; then
    blocked 2.8 mcp-over-tailnet "no KIZUKI_DAEMON_TOKEN in this peer's environment; this peer has no other way to learn the box's daemon token (SSH is deliberately refused, see M2's shell-removal change), so the token must come from whatever process started the box"
    return
  fi
  out="$(curl -sS -m 5 -o - -w '\n%{http_code}' --header 'Host: 127.0.0.1' \
    --header "Authorization: Bearer ${token}" --header 'Content-Type: application/json' \
    --data '{}' "http://${TS_IP}:${PORT}/v1/mcp/system_health" 2>&1)"
  code="$(printf '%s' "$out" | tail -1)"
  body="$(printf '%s' "$out" | sed '$d')"
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"ok":true'; then
    pass 2.8 mcp-over-tailnet
    return
  fi
  fail 2.8 mcp-over-tailnet "got HTTP $code, not 200 with \"ok\":true (used the daemon's own serve.token, not an agent-minted token: kizuki agent add is not on this branch). Response: $body"
}

check_2_9() {
  if [ -z "$TS_IP" ]; then
    blocked 2.9 fail-closed-no-token "2.6 did not establish $TARGET's tailnet address; nothing to connect to"
    return
  fi
  local out code body
  out="$(curl -sS -m 5 -o - -w '\n%{http_code}' --header 'Host: 127.0.0.1' \
    --header 'Content-Type: application/json' --data '{}' \
    "http://${TS_IP}:${PORT}/v1/mcp/system_health" 2>&1)"
  code="$(printf '%s' "$out" | tail -1)"
  body="$(printf '%s' "$out" | sed '$d')"
  if [ "$code" = "401" ] && printf '%s' "$body" | grep -q '"unauthorized"'; then
    pass 2.9 fail-closed-no-token
    return
  fi
  fail 2.9 fail-closed-no-token "got HTTP $code, want 401 unauthorized. Response: $body"
}

check_2_10() {
  # "Neither container publishes a port" needed docker inspect access to
  # the box's own containers, which a same-machine version of this script
  # had because it had just started them itself. A peer-only proof has no
  # docker access to a remote box at all, so it cannot observe
  # NetworkSettings.Ports directly; this row is BLOCKED here rather than
  # faked. The real public-IP-is-dark probe belongs to M3, run from outside
  # the box against its actual public IP, which is the assertion this row
  # was always meant to lead to.
  blocked 2.10 public-ip-dark "this peer-only proof has no docker access to the remote box's containers; verifying no port is published on the box's public IP is M3's box-level probe, not something observable from a tailnet peer"
}

check_2_11() {
  # Row 2.11 is the inverse of the plan's original "Tailscale SSH reaches
  # the node" wording (see the compose.yml comment above TS_EXTRA_ARGS and
  # the resource-abuse concern this milestone closes): a hosted box must
  # not hand a customer a shell, so this asserts that `tailscale ssh` is
  # REFUSED, not that it succeeds. A refusal is only meaningful evidence of
  # "no shell exposed" if the node is actually up; otherwise a refusal
  # could just mean nothing is reachable at all. 2.6 having passed is one
  # precondition; re-asserting reachability with the same health call 2.7
  # uses, right before the SSH attempt, rules out "the node went offline in
  # between" as the reason for the refusal. The SSH attempt itself already
  # runs from this peer's own `tailscale` binary — there is no node-side
  # wrapper left to remove.
  if [ -z "$TS_IP" ]; then
    blocked 2.11 no-shell-exposed "2.6 did not establish $TARGET's tailnet address; cannot assert a meaningful SSH refusal"
    return
  fi
  local result health_code health_body
  result="$(peer_health)"
  health_code="$(printf '%s' "$result" | head -1)"
  health_body="$(printf '%s' "$result" | tail -n +2)"
  if [ "$health_code" != "200" ] || ! printf '%s' "$health_body" | grep -q '"ok":true'; then
    blocked 2.11 no-shell-exposed "$TARGET did not answer /health just now (got HTTP ${health_code:-none}); an SSH failure here would not distinguish 'refused' from 'offline'"
    return
  fi
  local out rc
  out="$(tailscale ssh "$TARGET" -- true 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    pass 2.11 no-shell-exposed
    return
  fi
  fail 2.11 no-shell-exposed "tailscale ssh $TARGET -- true succeeded (exit 0) with the node confirmed reachable; this hosted box must refuse SSH: $out"
}

# 2.14 exists because Tailscale does not document, in its own pages (three
# were checked while writing this plan's M2 Finding), that userspace
# networking's containment is total: no TUN device means no kernel route
# into this box for anything but the ports named in serve.json, but that is
# an inference from how tailscaled is built, not a written guarantee. So it
# is proven here rather than asserted in a comment: from a real peer, try a
# TCP connect to a tailnet-address port that is NOT in serve.json (one
# nothing listens on, plus one a neighbor in the shared namespace might
# plausibly run) and require refusal or timeout, with a short explicit
# timeout so a hang reads as a failure instead of a stall. This needs the
# same reachability precondition as 2.11: an unreachable node would make
# every port look "contained" for the wrong reason.
check_2_14() {
  if [ -z "$TS_IP" ]; then
    blocked 2.14 only-served-ports-reachable "2.6 did not establish $TARGET's tailnet address; cannot form a target address"
    return
  fi
  local result health_code health_body
  result="$(peer_health)"
  health_code="$(printf '%s' "$result" | head -1)"
  health_body="$(printf '%s' "$result" | tail -n +2)"
  if [ "$health_code" != "200" ] || ! printf '%s' "$health_body" | grep -q '"ok":true'; then
    blocked 2.14 only-served-ports-reachable "$TARGET did not answer /health just now (got HTTP ${health_code:-none}); an unreachable node would make every port look contained for the wrong reason"
    return
  fi
  local port desc rc out
  for entry in "9999:a port nothing listens on" "22:a port a neighbor's SSH might listen on"; do
    port="${entry%%:*}"
    desc="${entry#*:}"
    out="$(nc -z -w 3 "$TS_IP" "$port" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      fail 2.14 only-served-ports-reachable "TCP connect to ${TS_IP}:${port} (${desc}) succeeded; only ports in serve.json should be reachable"
      return
    fi
  done
  pass 2.14 only-served-ports-reachable
}

check_2_12() {
  # This peer-only proof does not own the box's lifecycle: it has no docker
  # compose access to the remote box to trigger a restart itself, unlike an
  # earlier same-machine version of this script. What it can still honestly
  # assert, from this peer's own tailscale status, is that the node id it
  # observed in 2.6 is unchanged right now. A true restart-survives-identity
  # assertion needs the restart to happen out of band (an operator, or M3's
  # box bootstrap) while this id is compared before and after; composing
  # that is a follow-up gap this script does not paper over by pretending
  # to restart a box it does not control.
  if [ -z "$STATUS_JSON" ]; then
    blocked 2.12 restart-keeps-identity "2.6 did not establish node status; nothing to compare"
    return
  fi
  local id_before id_after peer
  id_before="$(printf '%s' "$STATUS_JSON" | jq -r '.ID // empty')"
  if [ -z "$id_before" ]; then
    blocked 2.12 restart-keeps-identity "no node ID in $TARGET's status as seen from this peer"
    return
  fi
  peer="$(wait_target_online)" || {
    fail 2.12 restart-keeps-identity "$TARGET is not observable from this peer right now"
    return
  }
  id_after="$(printf '%s' "$peer" | jq -r '.ID // empty')"
  if [ "$id_before" != "$id_after" ]; then
    fail 2.12 restart-keeps-identity "node id changed: $id_before -> $id_after"
    return
  fi
  pass 2.12 restart-keeps-identity
  echo "  note: this peer-side proof does not trigger the box's restart itself (no docker/compose access to a remote box); it only confirms the node id is unchanged right now. A real restart-survives-identity run needs the restart to happen out of band while this comparison runs before and after." >&2
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
  exit "$ANY_FAIL"
}

main "$@"
