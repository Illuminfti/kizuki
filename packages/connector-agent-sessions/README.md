# `@kizuki/connector-agent-sessions`

Offline, read-only adapter for the session transcripts a coding agent writes to
disk. It registers two connectors that share one parser:

- `kizuki.claude-code-sessions`: Claude Code session JSONL.
- `kizuki.codex-sessions`: Codex rollout JSONL.

Each user prompt and each assistant message with text becomes one private
`message` event. Thinking, tool inputs and tool results are never read. Text is
sanitized and scrubbed of secret-shaped strings before it is emitted, and a
turn carrying Kizuki's own context packet is skipped. The connector emits no
tombstones and makes no network call.

Enrollment, the recommended consent policy, what is captured and the limits
are documented in [docs/connect.md](../../docs/connect.md#coding-session-transcripts).

## Configuration

`getConnector(id, config)` takes:

| Key | Meaning |
| --- | --- |
| `path` | Required. The transcript folder. |
| `include_subagents` | Also read subagent folders and sidechain records. Default `false`. |
| `exclude_cwd` | Absolute directories whose sessions are never captured, such as the vault. |

`kizuki connect` stores only `path`. When the host loads the connector it adds the
vault to `exclude_cwd` for that run, without storing it.

## Cursor

`kizuki.agent-sessions-cursor/v1` holds a source-root digest, a watermark in
milliseconds, the position `{mtime_ms, relpath, line}` inside the current pass
and whether the pass finished. Files are visited in `(mtime, relpath)` order;
every file modified within two minutes of the watermark or later is read again
from its first line, and the ledger deduplicates. One call decodes at most 500
events, 2 MiB of events or 64 MiB of file bytes, so a large first backfill is a
sequence of calls the host repeats.

## Tests

```sh
bun test packages/connector-agent-sessions
```

Fixtures are synthetic and written into temporary directories.
