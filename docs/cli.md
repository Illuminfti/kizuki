# CLI reference

Run the native `kizuki` executable from the [local build](native-build.md), or invoke from a clone:

```bash
bun packages/cli/src/main.ts <verb> [options]
bun packages/cli/src/main.ts help
bun packages/cli/src/main.ts help <verb>
```

The compiled CLI uses the same commands. `kizuki <verb> --help` also prints
command help without opening a vault. `npm i -g kizuki` is not supported.

Global option: `--vault <path|name>` on every verb. User config is
`$KIZUKI_CONFIG`, else `$XDG_CONFIG_HOME/kizuki/config.toml`, else
`$HOME/.config/kizuki/config.toml`. HOME and XDG paths must be absolute;
an unset environment fails closed instead of writing beside the working
directory. Vault aliases are `[A-Za-z][A-Za-z0-9_-]{0,63}`. Writes are
atomic under a lock. Port, model, budget, and sensitivity selection live
in `<vault>/.kizuki/serve.toml` and appear in `doctor`.

`--json` prints a `kizuki.cli.<verb>/v1` envelope with `status`, `data`,
`degraded`, and `warnings`. Diagnostics stay on stderr.

Exit codes: `0` success, `1` runtime failure, `2` usage / unknown / retired
verb. Promised output is on stdout. Diagnostics go to stderr.

Retired verbs `review`, `promote`, and `reject` exit 2 and point at `audit`,
`undo`, and `tell`. They are not listed as live product.

Binding design for autonomous canon is [RFC 0002](../rfcs/0002-autonomous-canon.md).
This page documents the verbs that exist on this revision.

## init

```text
usage: kizuki init <path> [--default | --no-default] [--no-service] [--adopt] [--dry-run]
```

Creates a vault, writes a vault identity marker, writes `default_vault`
unless `--no-default`, and installs `kizuki serve` as a user service when
a supervisor is present. `--no-service` records an opt-out. With no
supervisor, prints the exact `serve` command. A non-empty directory that
is not already a vault is refused unless `--adopt` is set; `--dry-run`
prints the adoption inventory and writes nothing. Later verbs refuse a
directory that is not a Kizuki vault. Control paths are created owner-only
(`0700` / `0600`). Generated `CANON.md` and `SCHEMA.md` carry
`kizuki.doctrine/v2`; untouched historical templates are upgraded, and
owner edits are left in place.

## import

```text
usage: kizuki import <connector> --source PATH
```

Enrolls a `none`-mode file source and backfills it to exhaustion. For local
Beeper messages, use `connect beeper` followed by `backfill beeper`.

## connect

```text
usage: kizuki connect [--list|status] [--json]
       kizuki connect <connector> --source PATH [--sensitivity public|personal|private]
       kizuki connect beeper --token-ref env:VAR|file:/absolute/path [--endpoint http://127.0.0.1:23373] [--sensitivity public|personal|private] [--json]
```

Browse sources, inspect saved sync status, or enroll a source. Local Beeper
enrollment checks its authenticated Desktop API before saving a secret
reference. File sources remain supported. Other account sign-in flows are
unavailable and labeled in the catalog. See [connection setup](connect.md).

Sensitivity is optional: trusted connector runs resolve each valid event
against that connection's default, floor, owner label, and source hint.
Hints cannot lower the connection policy. A legacy connection without a
recorded policy defaults to private. Direct unlabelled ledger writes remain
withheld, and changing policy does not relabel historical events.

## backfill / sync

```text
usage: kizuki backfill <connector> [--source PATH|KEY]
usage: kizuki sync [connector] [--source PATH|KEY]
```

Historical sweep vs incremental sweep. Each selected connection is drained
until the connector reports exhaustion. `--source` requires an explicit
connector. A named connector with no rows exits `1` (`no_connections`).
One connection failure does not skip the rest.

## query

```text
usage: kizuki query <text> [--scope canon|ledger|all] [--limit N] [--json] [--degraded]
```

FTS floor. Ceiling is `private`. Unlabeled hits are withheld on stderr
(`withheld=N (no sensitivity label)`). A stale or partial index exits `1`
unless `--degraded` is set. Zero labeled hits and zero withheld prints
`0 hits` on stderr.

## doctor

```text
usage: kizuki doctor [--json]
```

Vault path, event count, claim counts (filed/live/written/unwritten), live
claim ids (for `tell --claim`), leftover skipped rows, connections,
checkpoints, derived-index freshness, writer ROLE stamps, machine vs human
origin counts, calibration/liveness probes, receipts, holds, serve rails,
and `canon writing: on|off`. Off when no model is configured. Exit 1 when
the report is not ok. After a folder import, expect live claims; the writer
still needs a model before those claims become pages. Loop creates land
under `auto/`; human pages stay where they are.

## tell

```text
usage: kizuki tell "<statement>" [--claim CLAIM_ID] [--since TIME] [--until TIME] [--dry-run] [--json] [--verbose]
```

Owner correction. `--claim` is required and must name a **live** claim;
`doctor` lists live ids separately from leftover skipped rows. Rewrites
affected canon in the same pass. No model required. Prints an undo line
when a receipt is minted.

## context

```text
usage: kizuki context [--purpose session|recall|correction|audit] [--budget N] [--query TEXT] [--json]
```

Purpose-scoped compilation of canon, graph, timeline, and working-knowledge
claims with provenance stamps and a token budget. Same engine as MCP
`context_packet`. Does not write canon. Empty packets keep the machine header
on stdout and offer a next step on stderr. If gathering fails, the CLI returns
exit 1 and reports `degraded` in JSON instead of presenting the header as a
complete packet.

## undo

```text
usage: kizuki undo <receipt_id> [--cascade]
```

Restores prior canon bytes from a write receipt.

## audit

```text
usage: kizuki audit [--since TIME] [--page PATH] [--writer NAME] [--contested] [--ambiguous] [--reverted] [--list|--json]
```

Lists receipted writes. A TTY without `--json` / `--list` opens the audit
TUI. The actual change appears first with compact trust details; `d` reveals
full receipt hashes and provenance. Command filters apply throughout paging
and reloads. The only effect that TUI may emit is `undo`.

## serve

```text
usage: kizuki serve [--once] [--no-http] [--port N] [--json] [--install] [--uninstall]
       kizuki serve status [--json]
       kizuki serve stop
       kizuki serve run <rail> [--json]
```

Always-on loop. HTTP is loopback unless `--no-http`. `init` installs the
user service when a supervisor exists. The CLI still runs when the daemon is
down.

## models

```text
usage: kizuki models pull --from PATH [--sha256 HEX]
```

Copies a local GGUF into the vault models directory. Does not download
weights.

## purge

```text
usage: kizuki purge (--event ID | --subject ID [--include-aliases] | --connector ID [--record ID] | --verify RECEIPT) [--reason TEXT] [--dry-run] [--confirm] [--allow-empty] [--json]
```

Physical deletion plus a receipt. `--reason` is required except `--verify`,
and must be a trimmed 1–240 byte note without control characters. A selector
that matches nothing exits nonzero unless `--allow-empty` is set; it never
writes a completion receipt. `--dry-run` prints a bounded plan and writes
nothing. Connector selectors use ledger identity, including retired ids.
Broad subject or connector-only deletes require `--confirm`. Exact `--event`
and `--connector --record` paths stay noninteractive. Purged events are not
resurrected by undo; canon rewrites stay reversible. `--verify` prints
per-store absence proofs and `pending`/`done`/`failed` operation state.

## export

```text
usage: kizuki export --out DIR
```

Dumps vault files and ledger tables into an empty directory as
`kizuki.backup/v1`. The destination must sit outside the source vault.

## restore

```text
usage: kizuki restore --from DIR [--into DIR] [--verify]
```

Verifies a `kizuki.backup/v1` directory. With `--into` it restores into an
empty target after that verification. `--from DIR` alone, or with `--verify`,
checks hashes and completeness without writing.

## version

```text
usage: kizuki version
```

Prints the `@kizuki/cli` package version (`0.1.0` on this revision).

## MCP (not a CLI verb)

```bash
bun packages/mcp/src/bin.ts --vault PATH (--owner | --token-env VAR) [--retrieval ID]
```

Stdio adapter. Tokens never travel on argv.

## Not CLI verbs

`timeline`, `rebuild`, and `agent add` are not registered. Timeline exists
as an MCP / core serving function. Derived rebuild is a library call.
