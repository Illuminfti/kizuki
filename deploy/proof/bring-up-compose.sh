#!/usr/bin/env bash
# One compose write path after a box resume (issue #446).
#
# After POST /boxes/{id}/resume, images and named volumes survive but
# containers do not. dockerd then recreates containers on its own, often
# before the compose secret mount exists. Those leftovers hold the names
# (`deploy-tailscale-1`) and never authenticate:
#   tailscale entrypoint: missing secret file /run/secrets/ts_authkey
# `docker compose up -d` racing that wave either Conflicts or retries
# against the secretless container. Neither converges.
#
# This script owns the container set before it creates anything:
#   1. require the host secret file (never print it)
#   2. wait until docker answers
#   3. `compose down --remove-orphans` without `-v` (volumes stay)
#   4. remove any named leftover, including a secretless one
#   5. require the secret again, then `compose up -d`
# A secretless container is replaced, not retried against. Two attempts.
#
# Usage (from the compose project directory, typically deploy/):
#   KIZUKI_TS_AUTHKEY_FILE=/path/to/key ./proof/bring-up-compose.sh
#
# Remote box.sh `bring_up_compose` should run this same command on the box:
#   cd /home/user/kizuki-src/deploy && \
#   KIZUKI_TS_AUTHKEY_FILE=/home/user/.config/kizuki/ts-authkey \
#   ./proof/bring-up-compose.sh
#
# Live 10-cycle box proof is an operator run. The in-repo proof is
# deploy/proof/bring-up-compose.test.ts (stubbed docker, no credentials).
set -euo pipefail

SECRET_MOUNT="/run/secrets/ts_authkey"
MISSING_SECRET="missing secret file ${SECRET_MOUNT}"
WAIT_SECS=10

project_name() {
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s' "$COMPOSE_PROJECT_NAME"
    return
  fi
  basename "$(pwd)"
}

PROJECT="$(project_name)"
TAILSCALE_CONTAINER="${PROJECT}-tailscale-1"
KIZUKI_CONTAINER="${PROJECT}-kizuki-1"

compose() {
  docker compose "$@"
}

require_secret() {
  if [ -z "${KIZUKI_TS_AUTHKEY_FILE:-}" ]; then
    echo "bring-up-compose: KIZUKI_TS_AUTHKEY_FILE is unset" >&2
    return 1
  fi
  if [ ! -r "$KIZUKI_TS_AUTHKEY_FILE" ]; then
    echo "bring-up-compose: secret file is not readable" >&2
    return 1
  fi
  if [ ! -s "$KIZUKI_TS_AUTHKEY_FILE" ]; then
    echo "bring-up-compose: secret file is empty" >&2
    return 1
  fi
}

wait_docker() {
  local waited=0
  while ! docker info >/dev/null 2>&1; do
    if [ "$waited" -ge "$WAIT_SECS" ]; then
      echo "bring-up-compose: docker is not ready" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

container_ids() {
  local name="$1"
  docker ps -aq --filter "name=${name}" 2>/dev/null || true
}

running_id() {
  local name="$1"
  docker ps -q --filter "name=${name}" --filter "status=running" 2>/dev/null || true
}

names_busy() {
  [ -n "$(container_ids "$TAILSCALE_CONTAINER")" ] && return 0
  [ -n "$(container_ids "$KIZUKI_CONTAINER")" ] && return 0
  return 1
}

# Take names away from dockerd's own recreate wave. Never `-v`.
wait_names_free() {
  local waited=0
  while names_busy; do
    docker rm -f "$TAILSCALE_CONTAINER" "$KIZUKI_CONTAINER" >/dev/null 2>&1 || true
    if ! names_busy; then
      return 0
    fi
    if [ "$waited" -ge "$WAIT_SECS" ]; then
      echo "bring-up-compose: named containers still present after reconcile" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

reconcile() {
  compose down --remove-orphans || true
  wait_names_free
}

tailscale_is_secretless() {
  local id
  id="$(container_ids "$TAILSCALE_CONTAINER" | head -1)"
  [ -n "$id" ] || return 1
  if docker logs "$id" 2>&1 | grep -qF "$MISSING_SECRET"; then
    return 0
  fi
  if ! docker inspect -f '{{range .Mounts}}{{.Destination}}{{println}}{{end}}' "$id" 2>/dev/null \
    | grep -qx "$SECRET_MOUNT"; then
    return 0
  fi
  return 1
}

stack_healthy() {
  [ -n "$(running_id "$TAILSCALE_CONTAINER")" ] || return 1
  [ -n "$(running_id "$KIZUKI_CONTAINER")" ] || return 1
  if tailscale_is_secretless; then
    return 1
  fi
  return 0
}

bring_up() {
  require_secret
  wait_docker
  local attempt
  for attempt in 1 2; do
    reconcile
    require_secret
    compose up -d || true
    if stack_healthy; then
      return 0
    fi
  done
  echo "bring-up-compose: stack did not come up healthy with its secret" >&2
  return 1
}

bring_up
