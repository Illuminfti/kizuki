#!/usr/bin/env bash
set +x
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

[[ $# == 1 ]] || refuse 'choose check, doctor or run'
case "$1" in check|doctor|run) mode="$1" ;; *) refuse 'choose check, doctor or run' ;; esac
check_mcp
absolute_path "${TUNNEL_CLIENT_BIN:-}" && [[ -f "$TUNNEL_CLIENT_BIN" && -x "$TUNNEL_CLIENT_BIN" ]] ||
  refuse 'TUNNEL_CLIENT_BIN must name an absolute executable'
[[ "${CONTROL_PLANE_TUNNEL_ID:-}" =~ ^tunnel_[0-9a-f]{32}$ ]] ||
  refuse 'CONTROL_PLANE_TUNNEL_ID is missing or malformed'
[[ -n "${CONTROL_PLANE_API_KEY:-}" && "$CONTROL_PLANE_API_KEY" != *[[:space:]]* ]] ||
  refuse 'CONTROL_PLANE_API_KEY must contain a runtime key'
[[ "$CONTROL_PLANE_API_KEY" != sk-admin-* ]] || refuse 'an admin key cannot run the tunnel'
[[ -z "${OPENAI_ADMIN_KEY:-}" ]] || refuse 'remove OPENAI_ADMIN_KEY from the runtime environment'
absolute_path "${XDG_RUNTIME_DIR:-}" && [[ -d "$XDG_RUNTIME_DIR" && ! -L "$XDG_RUNTIME_DIR" ]] ||
  refuse 'XDG_RUNTIME_DIR must name the user runtime directory'
uid="$(id -u)"
[[ "$(stat -c '%u:%a' -- "$XDG_RUNTIME_DIR")" == "$uid:700" ]] ||
  refuse 'the user runtime directory must be owned by this user with mode 0700'
runtime="$XDG_RUNTIME_DIR/kizuki-chatgpt"
[[ -d "$runtime" && ! -L "$runtime" && "$(stat -c '%u:%a' -- "$runtime")" == "$uid:700" ]] ||
  refuse 'systemd must create the private kizuki-chatgpt runtime directory'
command -v flock >/dev/null || refuse 'flock is required'
[[ -x "$SCRIPT_DIR/mcp.sh" ]] || refuse 'the scoped MCP launcher is not executable'

if [[ "$mode" == check ]]; then
  printf 'kizuki-chatgpt: configuration checks passed; authentication and remote readiness are unverified\n'
  exit 0
fi

if [[ "$mode" == run ]]; then
  lock="$runtime/$CONTROL_PLANE_TUNNEL_ID.lock"
  [[ ! -L "$lock" ]] || refuse 'the tunnel lock is unsafe'
  if [[ -e "$lock" ]]; then
    [[ -f "$lock" && "$(stat -c '%u:%a:%h' -- "$lock")" == "$uid:600:1" ]] || refuse 'the tunnel lock is unsafe'
  fi
  umask 077
  exec 9>"$lock"
  if ! flock --nonblock 9; then
    printf 'kizuki-chatgpt: this user already runs this tunnel\n' >&2
    exit 75
  fi
fi

# The command parser is shellword-based, not a shell. Quote the executable
# path as a single word, including spaces/apostrophes. Never interpolate a
# vault path, credential path or credential value into its logged command.
mcp_command="'${SCRIPT_DIR//\'/\'\\\'\'}/mcp.sh'"

# A closed environment prevents a profile, extra channel, public listener,
# control-plane URL override, proxy or inherited key from changing this route.
# Only this explicitly invoked external process makes outbound HTTPS calls.
exec env -i HOME="${HOME:-}" PATH=/usr/bin:/bin \
  CONTROL_PLANE_API_KEY="$CONTROL_PLANE_API_KEY" \
  KIZUKI_MCP_BIN="$KIZUKI_MCP_BIN" KIZUKI_VAULT="$KIZUKI_VAULT" \
  KIZUKI_AGENT_CREDENTIAL="$KIZUKI_AGENT_CREDENTIAL" \
  "$TUNNEL_CLIENT_BIN" "$mode" \
  --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --control-plane.api-key env:CONTROL_PLANE_API_KEY \
  --control-plane.poll-channel main \
  --mcp.command "$mcp_command" \
  --mcp.max-concurrent-requests 1 \
  --health.listen-addr 127.0.0.1:8080 \
  --log.level warn --log.format json
