#!/usr/bin/env bash
set +x
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

[[ $# == 0 ]] || refuse 'the MCP launcher accepts no arguments'
check_mcp

# The official tunnel client inherits its environment into the child. Give
# Kizuki only the local inputs it needs, never the tunnel runtime or admin key.
# No owner selector, raw token, enrollment, grant change or fallback exists.
exec env -i HOME="${HOME:-}" PATH=/usr/bin:/bin \
  "$KIZUKI_MCP_BIN" --vault "$KIZUKI_VAULT" \
  --token-ref "file:$KIZUKI_AGENT_CREDENTIAL"
