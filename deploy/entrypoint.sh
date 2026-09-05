#!/bin/sh
# M1 container floor entrypoint (docs/deploy-box-tailscale.md "M1 Container
# floor"). Runs as PID 1. There is no systemd in the container, so
# KIZUKI_SUPERVISOR=none forces the "loop runs only while you run it" path
# (packages/core/src/serve/supervisor.ts detectSupervisorKind) and this
# script's `exec kizuki serve` is that "you". Canon is written only by the
# receipted writer through the CLI; this script inits a vault and starts the
# loop, and nothing else touches canon or the derived index.
set -eu

export KIZUKI_SUPERVISOR=none
export KIZUKI_CONFIG="${KIZUKI_CONFIG:-/vault/.kizuki-config.toml}"
# Read-only rootfs (check 1.10): HOME and caches must live on the tmpfs
# mounted at /tmp, not on the image's read-only filesystem.
export HOME="${HOME:-/tmp}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/.cache}"
export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$XDG_CACHE_HOME"

KIZUKI_HTTP_PORT="${KIZUKI_HTTP_PORT:-8787}"

if [ ! -d /vault/.kizuki ]; then
  kizuki init /vault --no-default
fi

# A marker, not a lock: sqlite has no busy_timeout wired through
# `openLedger`, so a `docker exec` that opens the same database file while
# `kizuki init` above is still holding it can hit SQLITE_BUSY. The marker
# lets a caller wait until this script is done touching the database before
# it opens its own connection.
touch /vault/.kizuki/.entrypoint-ready

exec kizuki serve --vault /vault --port "$KIZUKI_HTTP_PORT"
