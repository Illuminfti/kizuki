# Repository inventory

The tables below come from the workspace manifests and the central connector
registry. Registration identifies an implementation; it does not establish
real-account qualification, CLI enrollment support or release readiness.

For example, `@kizuki/connector-whoop` exists as a provider package but has no
entry in the default connector registry or CLI enrollment route. Its
[qualification and integration limits](whoop.md) remain separate from the
package inventory.

Screenpipe is an offline, read-only adapter for a stopped SQLite database.
It imports settled screen text and audio transcriptions with a private
sensitivity floor. It does not read media, use the Screenpipe HTTP API, emit
source tombstones or purge the source. Live database access is unsupported.
See its [setup, supported schema range and limits](../packages/connector-screenpipe/README.md).

## Verification

Run `bun scripts/repository-inventory.ts` to regenerate the tables between the
markers. `bun test scripts/repository-inventory.test.ts` compares the published
tables with the current workspace and registry; the full verification gate
runs this test too. Update the prose separately when a connector's limits change.

<!-- inventory:start -->
## Workspace packages (17)

| Package | Manifest |
| --- | --- |
| `@kizuki/cli` | [`packages/cli/package.json`](../packages/cli/package.json) |
| `@kizuki/connector-beeper` | [`packages/connector-beeper/package.json`](../packages/connector-beeper/package.json) |
| `@kizuki/connector-gmail` | [`packages/connector-gmail/package.json`](../packages/connector-gmail/package.json) |
| `@kizuki/connector-google-calendar` | [`packages/connector-google-calendar/package.json`](../packages/connector-google-calendar/package.json) |
| `@kizuki/connector-ics` | [`packages/connector-ics/package.json`](../packages/connector-ics/package.json) |
| `@kizuki/connector-imap` | [`packages/connector-imap/package.json`](../packages/connector-imap/package.json) |
| `@kizuki/connector-screenpipe` | [`packages/connector-screenpipe/package.json`](../packages/connector-screenpipe/package.json) |
| `@kizuki/connector-telegram` | [`packages/connector-telegram/package.json`](../packages/connector-telegram/package.json) |
| `@kizuki/connector-whoop` | [`packages/connector-whoop/package.json`](../packages/connector-whoop/package.json) |
| `@kizuki/connector-x` | [`packages/connector-x/package.json`](../packages/connector-x/package.json) |
| `@kizuki/connectors` | [`packages/connectors/package.json`](../packages/connectors/package.json) |
| `@kizuki/core` | [`packages/core/package.json`](../packages/core/package.json) |
| `@kizuki/embed-gguf` | [`packages/embed-gguf/package.json`](../packages/embed-gguf/package.json) |
| `@kizuki/llm` | [`packages/llm/package.json`](../packages/llm/package.json) |
| `@kizuki/mcp` | [`packages/mcp/package.json`](../packages/mcp/package.json) |
| `@kizuki/retrieval-pg` | [`packages/retrieval-pg/package.json`](../packages/retrieval-pg/package.json) |
| `@kizuki/tui` | [`packages/tui/package.json`](../packages/tui/package.json) |

## Registered connectors (17)

| Connector ID |
| --- |
| `kizuki.beeper` |
| `kizuki.gmail` |
| `kizuki.google-calendar` |
| `kizuki.ics` |
| `kizuki.imap` |
| `kizuki.import-chatgpt` |
| `kizuki.import-claude` |
| `kizuki.import-legacy-events` |
| `kizuki.import-legacy-wiki` |
| `kizuki.import-omnivore` |
| `kizuki.import-pocket` |
| `kizuki.import-whatsapp` |
| `kizuki.import-x-archive` |
| `kizuki.markdown-folder` |
| `kizuki.screenpipe` |
| `kizuki.telegram` |
| `kizuki.x` |
<!-- inventory:end -->
