# Capability inventory

Document kind: machine-checked product claim list for humans and agents
Revision this inventory describes: `656502085e3118ed04d1600f9ddeeebbf4bbcdc2` (main, 2026-09-03)
Implementation claim: none of the rows below is a promise about a later commit

When code, tests, and this file disagree, state the mismatch. Do not silently pick the most convenient source.

## Product verbs on the public CLI

Registered in `packages/cli/src/commands/index.ts`:

| Verb | Status on this revision | Notes |
| --- | --- | --- |
| `init` | shipped | Creates a vault, may set `default_vault`, installs `kizuki serve` unless `--no-service` |
| `connect` | shipped | Enrolls one registry connector as an opaque connection |
| `backfill` | shipped | Historical sweep for one connection |
| `sync` | shipped | Incremental sweep |
| `import` | shipped | Connect plus backfill |
| `models` | shipped | `models pull --from PATH` copies a local GGUF; does not download weights |
| `audit` | shipped | Lists receipted writes; opens the TUI when stdin/stdout are a TTY |
| `tell` | shipped | Owner correction; rewrites affected canon in the same pass |
| `undo` | shipped | Reverses a write by receipt |
| `query` | shipped | Full-text search with a `private` ceiling at the CLI edge |
| `doctor` | shipped | Vault, connection, receipt, and rail health |
| `serve` | shipped | Always-on loop, install/uninstall/status/stop, optional HTTP MCP |
| `purge` | shipped | Physical deletion with a receipt |
| `export` | shipped | Dump; not yet a verified restore pair |
| `version` | shipped | Package version |
| `review` | leftover, not product | Still registered. P0 #31. Retirement lane in progress. Use `audit` |
| `promote` | leftover, not product | Still registered. P0 #31. Use the receipted writer / `tell` |
| `reject` | leftover, not product | Still registered. P0 #31 |

Not registered as CLI verbs on this revision: `context`, `timeline`, `rebuild`, `restore`, `agent`.

## MCP tools

`packages/mcp` exists. Tools registered in `packages/mcp/src/server.ts`:

`search`, `get_page`, `query_entities`, `timeline`, `context_packet`, `graph_neighbors`, `system_health`, `propose`, `correct`.

## Connector registry

Authoritative source: `packages/connectors/src/registry.ts`.

| Present | Missing versus campaign C3 |
| --- | --- |
| `kizuki.telegram` | Gmail API |
| markdown-folder | Google Calendar API |
| screenpipe | WHOOP |
| imap | X archive import |
| ics | X paid API sync |
| import-chatgpt | |
| import-claude | |
| import-whatsapp | |
| import-pocket | |
| import-omnivore | |
| import-legacy-wiki | |
| import-legacy-events | |

ICS is a calendar file or URL. It is not Google Calendar sign-in.
IMAP is a mailbox. It is not the Gmail API.
Deferred by C3: Composio, WhatsApp Business API.

## Packages on this revision

`core`, `cli`, `connectors`, `tui`, `embed-gguf`, `connector-telegram`, `connector-imap`, `connector-ics`, `connector-screenpipe`, `llm`, `mcp`, `retrieval-pg`.

## Release surfaces that do not exist on this revision

- `SECURITY.md` at repo root (architecture text already points at it)
- compiled macOS or Linux artifacts, checksums, brew tap, install script
- a `restore` command or verified clean-target restore
- public packaged release
- seven-day proactive-rail proof
- fourteen-day estate-parity / cutover record
