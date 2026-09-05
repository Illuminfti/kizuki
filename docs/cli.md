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
prints the adoption inventory and writes nothing. Initializing or adopting
an existing owned directory makes the vault root private (`0700`) before
writing control files; refusal and dry runs preserve its permissions.
Later verbs refuse a
directory that is not a Kizuki vault. Control paths are created owner-only
(`0700` / `0600`). Generated `CANON.md` and `SCHEMA.md` carry
`kizuki.doctrine/v2`; untouched historical templates are upgraded, and
owner edits are left in place.

## import

```text
usage: kizuki import <connector> --source PATH [--policy FILE --expected-revision N --operation-id ID]
```

Enrolls a `none`-mode file source and backfills it to exhaustion only with an active
source grant permitting capture. The three policy options must appear together;
they apply explicit consent before reading content. Without a grant, import
enrolls the source, refuses capture, and prints the source key and grant command. For local
Beeper messages, use `connect beeper` followed by `backfill beeper`.

## connect

Google Calendar supports `connect google-calendar --calendar CANONICAL_ID --fields summary,description,location,attendees,attachments [--source KEY] [--json]`. Operator desktop app configuration and separate source consent are required; see [the native Calendar contract and limits](google-calendar.md). Use `--fields none` for baseline metadata and event-resource identity only. `primary` is refused; existing account/calendar/fields and recovery state are preserved during reauthorization.

```text
usage: kizuki connect [--list|status] [--json]
       kizuki connect <connector> --source PATH [--sensitivity public|personal|private]
       kizuki connect beeper --token-ref env:VAR|file:/absolute/path [--endpoint http://127.0.0.1:23373] [--sensitivity public|personal|private] [--json]
       kizuki connect imap [--source KEY] [--sensitivity public|personal|private]
```

Browse sources, inspect saved sync status, or enroll a source. Local Beeper
enrollment checks its authenticated Desktop API before saving a secret
reference. IMAP enrollment uses a local interactive prompt and stores its
opaque connector state in the owner-only connection-state store. File sources
remain supported. `connect telegram [--source KEY] [--json]` uses native
phone/code sign-in and optional two-step verification in an interactive terminal.
Project app credentials are required; missing credentials refuse before any
prompt or network connection. Re-sign-in preserves account identity and history.
Other account sign-in flows are unavailable and labeled in
the catalog. See [connection setup](connect.md).

Sensitivity is optional: trusted connector runs resolve each valid event
against that connection's default, floor, owner label, and source hint.
Hints cannot lower the connection policy. A legacy connection without a
recorded policy defaults to private. Direct unlabelled ledger writes remain
withheld, and changing policy does not relabel historical events.

## Source consent

Enrollment stores connection state; credentials never imply permission to use
captured evidence. New sources require an explicit owner grant. Existing retained
sources are not silently migrated. `connect status --source KEY --json` shows the
current grant, revision, policy digest, and physical purge blockers. All-source
`connect status` keeps sync state and consent state separate. Disconnect still
stops sync; revoking consent is a separate operation.

Save a policy you intend to authorize in a regular JSON file, at most 16 KiB,
without symlinks or secret fields. The file must belong to the effective user
and must not be group/world writable (`0600` preferred; `0644` allowed).
Each ancestor must be a real directory owned by root or the effective user,
without group/world write permission; root-owned sticky directories such as
`/tmp` are allowed. The bounded directory chain and open file are checked
before and after reading. This is a POSIX local-owner boundary: the same user
is trusted, and unsupported permission semantics are refused. For example, this policy permits local capture
and owner recall of text and its provenance:

```json
{
  "purposes": ["capture", "recall", "session", "derive"],
  "allowed_fields": ["text", "subjects", "attachments", "metadata"],
  "retention": "persistent_owned_until_revoked",
  "egress": "local_only",
  "sensitivity_floor": "private"
}
```

Purposes are `capture`, `recall`, `session`, `correction`, `audit`, `derive`,
`extract`, and `export`; choose only the uses you authorize. Populated fields
outside `allowed_fields` refuse capture. `extract` does not make an untrusted
model local. There is currently no native local model capability in the CLI.
Managed `local_only` sources refuse extraction through the generic
OpenAI-compatible HTTP adapter, including loopback endpoints; granting
`extract` does not override that boundary. Owner recall remains available
without a model.

To authorize extraction through the one configured OpenAI-compatible model,
replace `local_only` with an exact destination object. `model_endpoint` is the
final chat-completions URL, while `[ports.llm].base_url` remains the configured
base. HTTPS is required except for explicit loopback local-model fixtures.
The endpoint and model must match the running host binding exactly after URL
canonicalization:

```json
{
  "purposes": ["capture", "recall", "derive", "extract"],
  "allowed_fields": ["text", "subjects", "attachments", "metadata"],
  "retention": "persistent_owned_until_revoked",
  "egress": {
    "model_endpoint": "https://models.example.test/v1/chat/completions",
    "model": "example-model",
    "external_retention": "provider_managed"
  },
  "sensitivity_floor": "private"
}
```

This consent covers one destination. It contains no secret and does not bind a
transport by itself. The trusted CLI host binds the actual configured model;
an endpoint path or model mismatch sends no source payload. Revocation stops
future calls and discards a result if policy changes while a call is pending.
Owned purge removes Kizuki's retained source and derived payload, but cannot
retract data already sent to a provider. Provider-side retention and deletion
remain governed by that provider.
Once a provider decision is durably journaled, a later narrowed or revoked
grant leaves that decision pending without resending source data or advancing
the extraction cursor. Restoring the required purpose, fields, and exact
destination lets a later pass file the original decision under its original
model reference; source purge removes affected pending derived work.
Export requires the explicit `export` purpose and refuses pending revocations.

```bash
kizuki connect grant --source KEY --policy POLICY.json --expected-revision 0 --operation-id grant-1
kizuki connect status --source KEY --json
kizuki connect revoke --source KEY --expected-revision 1 --operation-id revoke-1
kizuki connect resume-revocation --source KEY --operation-id revoke-1 --json
```

Grant and revoke return durable operation receipts. Retrying the exact operation
returns its original receipt, including after restart; reusing its ID for changed
intent is refused. Supply the exact current revision for a new operation. Status
shows current state, which may be newer than a retried operation's receipt.

Grant, status, and revoke work without opening retrieval. Revocation commits
denial immediately. Physical purge is a separate resumable operation tied to the
same source and revoke ID; it inventories all known owned retrieval stores and
can retry a broken native generation without opening its SQL database. `purge=pending` / JSON `status=degraded` and exit 1 means it is **not
complete**. Any remaining payload or canon blocker remains explicit; retry cannot invent an erasure receipt. A source cannot be
regranted while its purge is pending. `purge=complete` is reported only from the
native completed state with no blockers. Local revocation does not delete the
upstream account or source file.

## backfill / sync

```text
usage: kizuki backfill <connector> [--source PATH|KEY]
usage: kizuki sync [connector] [--source PATH|KEY]
```

Historical capture vs source refresh. Each selected connection is drained
until the connector reports exhaustion. `--source` requires an explicit
connector. A named connector with no rows exits `1` (`no_connections`).
One connection failure does not skip the rest.
Capture through `backfill`, plain `sync`, and `import` does not open the optional
retrieval engine, so an existing MCP retrieval session cannot block ingestion or
source-consent checks. These commands still refresh the local SQLite search
floor. `sync --once` runs the automation tick and retains its configured
retrieval requirements.
The Beeper connector conservatively rescans available history on each completed
sync cycle to observe edits and explicit tombstones; unchanged records deduplicate.

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
complete packet. Claims and derived statements follow the live grant and
[context privacy rules](context-privacy.md), including fail-closed provenance
and bounded audit coverage.

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
down. Before a rail writes canon, `serve` binds the selected LLM port from
`[ports.llm]`; a model name by itself never enables writes. `kizuki doctor`
reports a complete binding as `on` and an incomplete configuration as
`unverified`.

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

Current backups include the bounded deferred-input queue and any one pending
model decision, so a restore can resume without sending the source text to the
model again. Backups whose serve schema predates version 8 did not carry this
recovery state; restore reports that limitation instead of inventing a pending
decision.

## rebuild

```text
usage: kizuki rebuild [--layer all] [--json]
```

Reconstructs the configured retrieval store and the SQLite search/graph floor
from the vault. Only `--layer all` is supported; partial layers exit 2.

The result identifies `backend` (`sqlite-floor` or `retrieval-port`), `store`,
`documents`, `floor_documents`, and the floor's `generation`. With default
retrieval, `documents` equals the actual SQLite floor page/event row count.
With an optional retrieval port, it counts the validated projection sent to
that store, which additionally includes readable live claims. `floor_documents`
always counts the rebuilt SQLite page/event rows. Serving applies current
authority and access checks to results from either backend.

Rebuild is atomic within each store, not across stores. Retry after a failed
rebuild; use quiescent source writers for a fixed corpus. See
[rebuild behavior and limits](../packages/core/RETRIEVAL-REBUILD.md).

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

MCP uses the vault's configured retrieval engine when `--retrieval` is omitted.
If that optional engine is temporarily busy or unavailable, the session starts
with the authorized SQLite lexical floor. Stderr reports the degradation;
search results and context packets include `retrieval-unavailable`. The session
does not steal another process's lease or reconnect the engine mid-session.
An explicit `--retrieval ID` remains required. Unknown engines and invalid
configuration refuse startup. No model is needed for the lexical floor.

## Not CLI verbs

`timeline` and `agent add` are not registered. Timeline exists
as an MCP / core serving function.

Source revocation maintenance inventories both known native retrieval roots under
`.kizuki/retrieval`, including a previously selected engine. Each store has a
vault-scoped stable `local:<implementation-id>` identity that survives a vault
move. Logical clearing is followed by whole-generation native disposal, and
newly opened ports are closed. A busy, unknown, symlinked or otherwise unsafe
root leaves revocation pending; changing the configured engine never proves
absence. Broken native generations can be retried without successful SQL startup.
Reports distinguish owned-store maintenance from external copies, which remain
out of scope. The main ledger, claims and canon have separate core erasure rules;
only a core report with no purge blockers is rendered complete.

A native root identity failure can report `process_restart_required` or
`process_restart_required_active_sql_uncontained`. Stop the affected process and
restore/verify the owned root before retrying; the command has not completed
purge. This does not guarantee containment of SQL already running during an
external path substitution, and does not authorize live vault moves. The
native generation walker is currently qualified only for Linux x64 glibc;
other platforms remain pending for physical generation maintenance.

Telegram enrollment captures no history. Use `backfill telegram --source KEY`
after the source is authorized. The connection's opaque protected session holds
provider cooldowns, and the native CLI persists those before returning a wait;
reopening the source checks the cooldown before opening transport. Transport
cleanup never logs out the Telegram session. Source-consent revocation and
provider logout are distinct operations. Telegram deletion detection and remote
message deletion remain unsupported. Synthetic native CLI tests do not qualify
real account access, complete provider history or a live observation period.
Before an authenticated session exists, initial sign-in has bounded attempts
and waits but restart-persistent throttling is unproven. Failed cooldown storage
is a visible failure requiring repair; it is not a successful rate-limit receipt.
