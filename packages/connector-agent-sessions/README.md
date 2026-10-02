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
| `include_headless` | Capture recorded print/SDK/exec runs. Default `true`. |

`kizuki connect` stores `path` and explicitly supplied capture filters. Repeatable
`--exclude-cwd DIR` replaces the saved list on reconnect; omitted filters retain
their saved values. `--include-headless false` skips recorded non-interactive
runs. The host also excludes the vault for each run, without storing its path.
Changing filters keeps existing evidence; use explicit ledger purge to erase it.

## Cursor

`kizuki.agent-sessions-cursor/v1` holds a source-root digest, a watermark in
milliseconds, the position `{mtime_ms, relpath, line}` inside the current pass
and whether the pass finished. Files are visited in `(mtime, relpath)` order;
files modified within two minutes of the watermark or later are considered.
Complete-line byte offsets, file identity, bounded prefix/boundary hashes and a
headless classification bit live in the existing transactional host cursor map.
An unchanged prefix and identity let an appended transcript seek directly to its
unconsumed bytes. A replacement, truncation, changed check hash or same-size
mtime change restarts the file; recovery rereads deduplicate in the ledger.
The map retains the rescan window and evicts older entries to stay within 1 MiB
and 10,000 entries, preserving a paused file. Missing/evicted offsets reread
safely; callers without a host map retain legacy rescans. An append combined
with an unsampled interior rewrite can evade these bounded checks. Codex reads
its first metadata line again, bounded at 4 MiB.

One call decodes at most 500
events, 2 MiB of events or 64 MiB of file bytes, so a large first backfill is a
sequence of calls the host repeats.

## Tests

```sh
bun test packages/connector-agent-sessions
```

Fixtures are synthetic and written into temporary directories.
