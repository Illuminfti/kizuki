#!/usr/bin/env bash
# Shared validation only. Never read or print a credential's contents.

refuse() {
  printf 'kizuki-chatgpt: %s\n' "$1" >&2
  exit 78
}

absolute_path() {
  [[ "$1" == /* && "$1" != *$'\n'* && "$1" != *$'\r'* ]]
}

check_mcp() {
  [[ "$(id -u)" != 0 ]] || refuse 'run as the vault-owning non-root user'
  absolute_path "${KIZUKI_MCP_BIN:-}" && [[ -f "$KIZUKI_MCP_BIN" && -x "$KIZUKI_MCP_BIN" ]] ||
    refuse 'KIZUKI_MCP_BIN must name an absolute executable'
  absolute_path "${KIZUKI_VAULT:-}" && [[ -d "$KIZUKI_VAULT/.kizuki" && -f "$KIZUKI_VAULT/.kizuki/kizuki.db" ]] ||
    refuse 'KIZUKI_VAULT must name an initialized absolute vault'
  absolute_path "${KIZUKI_AGENT_CREDENTIAL:-}" &&
    [[ -f "$KIZUKI_AGENT_CREDENTIAL" && -r "$KIZUKI_AGENT_CREDENTIAL" && ! -L "$KIZUKI_AGENT_CREDENTIAL" ]] ||
    refuse 'KIZUKI_AGENT_CREDENTIAL must name an existing absolute credential file'
  # Core authenticates custody, enrollment binding and the live grant. These
  # existence checks are not an authentication or authorization decision.
}
