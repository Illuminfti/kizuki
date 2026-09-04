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
# Requires, on whatever machine runs this script: a POSIX shell (with
# `awk`/`grep`, assumed present alongside bash itself), plus `tailscale` and
# `curl` on PATH, with this machine already authenticated onto the same
# tailnet as the target box under a *different* node identity. That is the
# full dependency list on purpose: an earlier version of this script also
# needed `nc` and `jq`, and on this branch's own operator machine (Windows,
# Git Bash) those two are not installed, which would have made the proof
# unrunnable from the one machine most likely to run it. `nc` is replaced by
# a `curl telnet://` connect probe (see `peer_tcp_open` below) and `jq` is
# replaced by narrow `awk` field matching on `tailscale status`'s own
# plain-text columns, not a general JSON parse — `tailscale status --json`'s
# own `--help` text warns its shape is unstable across releases, so avoiding
# it here is not a loss. No path specific to one operating system or one
# operator's machine is hard-coded; use whichever peer has these two tools
# (a Box VM, a Linux peer, or an operator machine with Git Bash and the
# Tailscale CLI on PATH).
#
# Target node: the first argument, or $KIZUKI_TAILNET_NODE, or
# kizuki-m2-proof (this milestone's fixture hostname) as the default.
# Target port: $KIZUKI_TAILNET_PORT, default 8787.
# Box public address (2.10 only): the second argument, or
# $KIZUKI_BOX_PUBLIC_IP. Unlike the tailnet target, this script has no way
# to discover a public IP on its own; whoever provisioned the box must
# supply it.
#
# Prints one `PASS <n> <label>`, `FAIL <n> <label> <reason>` or
# `BLOCKED <n> <label> <reason>` line per check. Does NOT exit non-zero on
# the first failure: later checks that do not depend on an earlier one are
# still worth running and reporting. Tracks whether any check failed or was
# blocked and exits non-zero at the end if so.
set -uo pipefail

TARGET="${1:-${KIZUKI_TAILNET_NODE:-kizuki-m2-proof}}"
PORT="${KIZUKI_TAILNET_PORT:-8787}"
BOX_PUBLIC_IP="${KIZUKI_BOX_PUBLIC_IP:-${2:-}}"
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

for bin in tailscale curl; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "tailnet proof: '$bin' not found on PATH. This script must run from a machine that is itself a tailnet peer (a Box VM, a Linux peer, or an operator machine with the Tailscale CLI installed), not from inside the box under test." >&2
    exit 1
  }
done

STATUS_LINE=""
TS_IP=""

# The one line of `tailscale status --self=false` (peers only, so this
# peer's own entry can never match) whose hostname column equals $TARGET,
# or empty if there is none. `--self=false` is what makes a self-probe
# structurally impossible here, not a hostname string comparison that a
# future edit could get wrong.
peer_line() {
  tailscale status --self=false 2>/dev/null | awk -v h="$TARGET" '$2 == h { print; exit }'
}

# Polls THIS peer's own view of $TARGET for up to 60s. There is no
# "docker compose up" to wait on here: the target is a different machine,
# already started (or not) by its own deployment; this only observes it.
# Tailscale's plain-text status marks a disconnected peer's line with the
# literal word "offline" in its last column (this was not independently
# re-verified against a genuinely offline peer during this work — no such
# peer was available — and is asserted here on the strength of Tailscale's
# documented column semantics; if that ever proves wrong, the practical
# effect is a check that BLOCKs or times out rather than one that passes
# when it should not, since absence of a matching, non-"offline" line is
# exactly what treats a target as unreachable below).
wait_target_online() {
  local attempt line
  for attempt in $(seq 1 60); do
    line="$(peer_line)"
    if [ -n "$line" ] && ! printf '%s' "$line" | grep -qw offline; then
      printf '%s' "$line"
      return 0
    fi
    sleep 1
  done
  return 1
}

# True (exit 0) iff a real TCP connection to host:port was established,
# distinct from curl's own notion of "the telnet operation finished OK".
# curl's telnet:// handler waits for input after connecting and reports the
# same exit code (28, timeout) whether the handshake never completed or it
# completed and then just sat idle waiting for a line to send — so the exit
# code alone cannot tell "open port, no response yet" from "filtered or
# closed port". curl -v's own "Established connection to" line is the real
# TCP-connect signal (confirmed empirically against a known-open and a
# known-closed port on this branch); grepping for it, not the exit code, is
# what actually distinguishes the two. `nc -z` did this directly; this is
# its curl-only replacement so the proof does not need `nc` installed.
peer_tcp_open() {
  local host="$1" port="$2"
  curl --max-time 3 -sS -v "telnet://${host}:${port}" 2>&1 | grep -q 'Established connection'
}

check_2_6() {
  local self_line
  self_line="$(tailscale status --peers=false 2>/dev/null | awk -v h="$TARGET" '$2 == h { print; exit }')"
  if [ -n "$self_line" ]; then
    blocked 2.6 node-online "target ($TARGET) is this peer's own hostname; this proof must run from a machine other than the node under test, or it re-creates the self-probe it exists to avoid"
    return
  fi
  local line
  line="$(wait_target_online)" || {
    fail 2.6 node-online "$TARGET never showed as online in this peer's own 'tailscale status' within 60s"
    return
  }
  STATUS_LINE="$line"
  TS_IP="$(printf '%s' "$line" | awk '{print $1}')"
  if [ -z "$TS_IP" ]; then
    fail 2.6 node-online "$TARGET is listed but this peer's status has no address for it"
    return
  fi
  pass 2.6 node-online
  echo "  as seen by this peer: $line" >&2
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
  # "Public IP is dark" never actually needed docker: that was only how a
  # same-machine version of this script happened to approximate it, by
  # inspecting NetworkSettings.Ports on containers it had just started
  # itself. The real assertion is peer-testable directly: given the box's
  # public address, try to connect to it and require refusal. Tailscale
  # being installed on this peer does not route an arbitrary public IP
  # through the tailnet (that address is not a tailnet address at all), so
  # a direct probe genuinely exercises the public path, not the tailnet one.
  # This BLOCKs only for a missing input, not by construction: it becomes a
  # real check the moment whoever provisioned the box (M3) passes the
  # address in.
  if [ -z "$BOX_PUBLIC_IP" ]; then
    blocked 2.10 public-ip-dark "no public address supplied (second argument or \$KIZUKI_BOX_PUBLIC_IP); whoever provisioned the box must supply its public IP, since a tailnet peer has no way to discover it on its own"
    return
  fi
  if peer_tcp_open "$BOX_PUBLIC_IP" "$PORT"; then
    fail 2.10 public-ip-dark "TCP connect to ${BOX_PUBLIC_IP}:${PORT} (the box's public address) succeeded; nothing should be reachable off the tailnet"
    return
  fi
  pass 2.10 public-ip-dark
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
  local port desc
  for entry in "9999:a port nothing listens on" "22:a port a neighbor's SSH might listen on"; do
    port="${entry%%:*}"
    desc="${entry#*:}"
    if peer_tcp_open "$TS_IP" "$port"; then
      fail 2.14 only-served-ports-reachable "TCP connect to ${TS_IP}:${port} (${desc}) succeeded; only ports in serve.json should be reachable"
      return
    fi
  done
  pass 2.14 only-served-ports-reachable
}

check_2_12() {
  # This peer-only proof does not own the box's lifecycle: it has no docker
  # compose access to the remote box to trigger a restart itself, unlike an
  # earlier same-machine version of this script. Without a JSON parser it
  # also has no access to Tailscale's own stable NodeID field (dropping the
  # `jq` dependency traded that away — see the M2 Finding); the tailnet
  # address from the plain-text `tailscale status` columns is the narrower
  # identity signal available instead. It survives a normal restart but
  # would very likely change if TS_STATE_DIR were wiped and the node
  # re-registered from scratch, so it is a reasonable, if weaker, proxy for
  # "this is still the same node". A true restart-survives-identity
  # assertion needs the restart to happen out of band (an operator, or M3's
  # box bootstrap) while this address is compared before and after;
  # composing that is a follow-up gap this script does not paper over by
  # pretending to restart a box it does not control.
  if [ -z "$TS_IP" ]; then
    blocked 2.12 restart-keeps-identity "2.6 did not establish $TARGET's address; nothing to compare"
    return
  fi
  local ip_before ip_after line
  ip_before="$TS_IP"
  line="$(wait_target_online)" || {
    fail 2.12 restart-keeps-identity "$TARGET is not observable from this peer right now"
    return
  }
  ip_after="$(printf '%s' "$line" | awk '{print $1}')"
  if [ "$ip_before" != "$ip_after" ]; then
    fail 2.12 restart-keeps-identity "tailnet address changed: $ip_before -> $ip_after"
    return
  fi
  pass 2.12 restart-keeps-identity
  echo "  note: this peer-side proof does not trigger the box's restart itself (no docker/compose access to a remote box); it only confirms the tailnet address is unchanged right now. A real restart-survives-identity run needs the restart to happen out of band while this comparison runs before and after." >&2
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
