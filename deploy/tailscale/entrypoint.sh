#!/bin/sh
# M2 tailnet sidecar entrypoint (docs/deploy-box-tailscale.md "M2 Tailnet
# access"). The tailscale/tailscale image's real entrypoint, containerboot,
# reads its auth key from the TS_AUTHKEY environment variable. Setting that
# variable in compose would put the plaintext key in `docker inspect`
# output, which AGENTS.md forbids as a plaintext-credential leak. Instead
# the key reaches the container as a Docker Compose secret file, and this
# wrapper reads it, exports it as TS_AUTHKEY only inside this process's own
# environment (never written to a file, log, or layer), and execs
# containerboot so the leak surface never exists.
#
# Command substitution `$(...)` strips trailing newlines on its own, which
# is how the key's trailing newline (present in the source file) is removed
# without ever printing or re-deriving the value.
set -eu

SECRET_FILE="${TS_AUTHKEY_FILE:-/run/secrets/ts_authkey}"
if [ ! -r "$SECRET_FILE" ]; then
  echo "tailscale entrypoint: missing secret file $SECRET_FILE" >&2
  exit 1
fi

TS_AUTHKEY="$(cat "$SECRET_FILE")"
export TS_AUTHKEY

exec /usr/local/bin/containerboot "$@"
