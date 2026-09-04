# CLI reference

Invoke from a clone. Nothing is packaged.

```bash
bun packages/cli/src/main.ts <verb> [options]
bun packages/cli/src/main.ts help
bun packages/cli/src/main.ts help <verb>
```

If a bin alias `kizuki` is on `PATH`, it is the same entry
(`packages/cli/src/main.ts`). `npm i -g kizuki` is not supported.

Global option: `--vault <path|name>` on every verb. Config is
`$KIZUKI_CONFIG`, else `$XDG_CONFIG_HOME/kizuki/config.toml`, else
`$HOME/.config/kizuki/config.toml`.

Exit codes: `0` success, `1` runtime failure, `2` usage / unknown / retired
verb. Promised output is on stdout. Diagnostics go to stderr.

Retired verbs `review`, `promote`, and `reject` exit 2 and point at `audit`,
`undo`, and `tell`. They are not listed as live product.

Binding design for autonomous canon is [RFC 0002](../rfcs/0002-autonomous-canon.md).
This page documents the verbs that exist on this revision.

## init

```text
usage: kizuki init <path> [--default | --no-default] [--no-service]
```

Creates a vault, writes `default_vault` unless `--no-default`, and installs
`kizuki serve` as a user service when a supervisor is present. `--no-service`
records an opt-out. With no supervisor, prints the exact `serve` command.

## import

```text
usage: kizuki import <connector> --source PATH
```

Enrolls a `none`-mode source and backfills it. Sign-in connectors refuse with
`sign-in for <id> is not wired yet`.

## connect

```text
usage: kizuki connect <connector> --source PATH [--sensitivity public|personal|private]
```

Enroll only. Sensitivity is optional; unlabeled evidence is not served.

## backfill / sync

```text
usage: kizuki backfill <connector> [--source PATH|KEY]
usage: kizuki sync [connector] [--source PATH|KEY]
```

Historical sweep vs incremental sweep. `sync` with no connector runs every
active connection.

## query

```text
usage: kizuki query <text> [--scope canon|ledger|all] [--limit N] [--json]
```

FTS floor. Ceiling is `private`. Unlabeled hits are withheld on stderr
(`withheld=N (no sensitivity label)`). Zero labeled hits and zero withheld
prints `0 hits` on stderr.

## doctor

```text
usage: kizuki doctor [--json]
```

Vault path, event count, claim counts (filed/live/written/unwritten), live
claim ids (for `tell --claim`), leftover skipped rows, connections,
checkpoints, derived-index freshness, receipts, holds, serve rails, and
`canon writing: on|off`. Off when no model is configured. Exit 1 when the
report is not ok. After a folder import, expect live claims; the writer
still needs a model before those claims become pages.

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
`context_packet`. Does not write canon.

## undo

```text
usage: kizuki undo <receipt_id> [--cascade]
```

Restores prior canon bytes from a write receipt.

## audit

```text
usage: kizuki audit [--since TIME] [--page PATH] [--writer NAME] [--contested] [--ambiguous] [--reverted] [--json]
```

Lists receipted writes. A TTY without `--json` / `--list` opens the audit
TUI. The only effect that TUI may emit is `undo`.

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
usage: kizuki purge (--event ID | --subject ID [--include-aliases] | --connector ID [--record ID] | --verify RECEIPT) [--reason TEXT]
```

Physical deletion plus a receipt. `--reason` is required except `--verify`.

## export

```text
usage: kizuki export --out DIR
```

Dumps vault files and ledger tables into an empty directory.

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
