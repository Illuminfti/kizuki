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

Value options also accept `--key=value`, including `--vault=PATH`. Use that
form when a value starts with `--`; everything after the first `=` is the
literal value. A standalone `--` ends option parsing, including global
`--vault` extraction, so `kizuki query -- --example` searches for `--example`.
Repeated options or flags are errors, even across the two value spellings.
Flags such as `--json` never take a value. Command-specific empty values pass
to their command's validation; `--vault` requires a nonempty value. Missing
values and unknown options are usage errors.

`--json` prints a `kizuki.cli.<verb>/v1` envelope with `status`, `data`,
`degraded`, and `warnings`. Diagnostics stay on stderr.

Exit codes: `0` success, `1` runtime failure, `2` usage / unknown / retired
verb. Promised output is on stdout. Diagnostics go to stderr.

Retired verbs `review`, `promote`, and `reject` exit 2 and point at `audit`,
`undo`, and `tell`. They are not listed as live product.

Binding design for autonomous canon is [RFC 0002](../rfcs/0002-autonomous-canon.md).
This page documents the verbs that exist on this revision.

## app

```text
usage: kizuki app [--no-open] [--no-service]
```

Opens the bundled private local app on a random `127.0.0.1` port. It is a
client of the existing Core and does not start another writer. `--no-open`
starts the diagnostic host without launching a browser; the printed address
alone is not an authenticated session. `--no-service` opts out of installing
the native background service on first-run setup. This is not an OS
application installer. See [the local app](local-app.md).

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

Init ensures the vault's root `.gitignore` contains an effective
`/.kizuki/` exclusion, preserving owner entries and adding the rule after
later inclusion rules when needed. Repeated init keeps it idempotent.
In an enclosing Git repository, init and dry runs refuse already tracked
`.kizuki` entries or an unreadable Git index before writing vault files.
The owner must resolve tracked control files before retrying; init never
changes Git's index or history. Git must be available for this check.

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

Google Calendar supports `connect google-calendar --calendar CANONICAL_ID --fields summary,description,location,attendees,attachments [--source KEY | --new-source] [--json]`. Operator desktop app configuration and separate source consent are required; see [the native Calendar contract and limits](google-calendar.md). Use `--fields none` for baseline metadata and event-resource identity only. `primary` is refused; existing account/calendar/fields and recovery state are preserved during reauthorization.

Gmail and Google Calendar accept `--new-source` for explicit additional enrollment; it cannot be combined with `--source KEY`. Duplicate account identities (Calendar: account plus canonical calendar) refuse even if fields differ or prior consent is revoked. Existing-source reauthorization preserves checkpoints and recovery state. New sources require separate grants; see the provider docs for bounds and refusal semantics.

```text
usage: kizuki connect [--list|status] [--json]
       kizuki connect <connector> --source PATH [--sensitivity public|personal|private]
       kizuki connect beeper --token-ref env:VAR|file:/absolute/path [--endpoint http://127.0.0.1:23373] [--sensitivity public|personal|private] [--json]
       kizuki connect imap [--source KEY] [--sensitivity public|personal|private]
       kizuki connect telegram [--source KEY] [--sensitivity public|personal|private] [--json]
       kizuki connect x-api --fields relationships,links,media|none --history-start RFC3339 [--source KEY | --new-source] [--json]
       kizuki connect recover-x-api --source KEY --fields relationships,links,media|none --history-start RFC3339 [--json]
       kizuki connect gmail --fields text,subjects,headers,labels,attachments [--source KEY | --new-source] [--sensitivity public|personal|private] [--json]
       kizuki connect google-calendar --calendar CANONICAL_ID --fields summary,description,location,attendees,attachments|none [--source KEY | --new-source] [--sensitivity public|personal|private] [--json]
```

Browse sources, inspect saved sync status, or enroll a source. Local Beeper
enrollment checks its authenticated Desktop API before saving a secret
reference. IMAP enrollment uses a local interactive prompt and stores its
opaque connector state in the owner-only connection-state store. File sources
remain supported. `connect telegram` uses native phone/code sign-in and
optional two-step verification in an interactive terminal. Project app
credentials are required; missing credentials refuse before any prompt or
network connection. Re-sign-in preserves account identity and history.
Gmail and Google Calendar use operator desktop clients and browser sign-in;
see the flags above and [connection setup](connect.md). Other account sign-in
connectors except X own-post API are not enrollable through this CLI. None of these sign-in paths
are live-account qualified.

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

Query and context reads never initialize or repair a vault. They retain the
required owner access-audit rows, while data queries use a logically query-only
ledger connection. SQLite may still update its WAL/SHM metadata. `init` creates
the baseline FTS index; a missing optional index stays missing and is reported
as degraded. An older or incomplete authoritative schema requires explicit
`kizuki init <path>` before reads can proceed.

The embedded retrieval factory currently requires writer initialization. CLI
and app reads therefore use the authorized SQLite floor when it is selected,
reporting `configured-engine-unavailable` and `retrieval-unavailable`. They
preserve the configured engine and do not acquire its writer lease, create its
files, or claim that hybrid retrieval ran. Unknown engine IDs still refuse.

## doctor

```text
usage: kizuki doctor [--json] [--integrity]
```

Vault path, event count, claim counts (filed/live/written/unwritten), live
claim ids (for `tell --claim`), leftover skipped rows, connections,
checkpoints, derived-index freshness, writer ROLE stamps, machine vs human
origin counts, calibration/liveness probes, receipts, holds, serve rails,
and `canon writing: on|off`. Off when no model is configured. The default
report runs SQLite `quick_check` and samples ledger events. `--integrity`
also runs `PRAGMA integrity_check` on the vault ledger; JSON then reports
that result in `ledger.integrity_check` (otherwise `null`). Exit 1 when
the report is not ok. Successful CLI writes seal `.kizuki/ledger-mark` with
the accepted event total, including purge receipts. Reads preserve this file.
A ledger below its sealed floor waits up to 3 seconds for the store to land,
then fails with `vault ledger not ready` before reporting counts. Explicit
init also refuses a ledger below its existing floor. Missing or bounded
malformed private legacy marks remain unsealed until a successful write. After a folder import, expect live claims; the writer
still needs a model before those claims become pages. Loop creates land
under `auto/`; human pages stay where they are.

Doctor validates existing configuration and credentials without constructing a
model runtime. Pending model or connection-state journals remain untouched and
make the report degraded; inspecting the vault does not authorize recovery or
machine-identity adoption. Audit browsing and connection status likewise do not
initialize storage. A confirmed TUI undo closes its reader, acquires a writer
through Core's existing undo path, and then resumes inspection.

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
usage: kizuki context [--purpose session|recall|correction|audit] [--budget N] [--query TEXT] [--since RFC3339] [--until RFC3339] [--json]
```

Purpose-scoped compilation of canon, graph, timeline, and working-knowledge
claims with provenance stamps and a token budget. Same engine as MCP
`context_packet`. Does not write canon. Empty packets keep the machine header
on stdout and offer a next step on stderr. If gathering fails, the CLI returns
exit 1 and reports `degraded` in JSON instead of presenting the header as a
complete packet. Omitting `--since`/`--until` keeps the purpose profile's
recent window (session is seven days). Explicit RFC3339 bounds pass through to
Core's existing request fields; timeline evidence uses each source's
`occurred_at`. Malformed timestamps and an inverted window are usage errors
before the vault is opened. Grant-bound clamping and denial stay in Core.
Claims and derived statements follow the live grant and
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
usage: kizuki models <list [--catalog] | pull <CATALOG_ID | --from PATH|URL [--sha256 HEX] [--bytes N]> | remove NAME>
```

Lists, copies, or removes local GGUF files in the vault models directory.
`list` reports installed regular `.gguf` files. `list --catalog` prints the
local catalog without network access. `pull CATALOG_ID` uses that entry's
pinned URL, hash and size; the shipped fixture has no remote pins.
`remove NAME` deletes one exact installed filename. `--bytes N` checks the
source size before publishing a copy. Direct URL pulls still require
`--sha256` and `--bytes`. The command does not download weights without
those pins.

## purge

```text
usage: kizuki purge (--event ID | --connector ID [--record ID | --subject ID [--source KEY] [--include-aliases]] | --verify RECEIPT) [--reason TEXT] [--dry-run] [--confirm] [--allow-empty] [--json]
```

Physical deletion plus a receipt. `--reason` is required except `--verify`,
and must be a trimmed 1–240 byte note without control characters. A selector
that matches nothing exits nonzero unless `--allow-empty` is set; it never
writes a completion receipt. `--dry-run` prints a bounded plan and writes
nothing. Connector selectors use ledger identity, including retired ids.
Broad subject or connector-only deletes require `--confirm`. Exact `--event`
and `--connector --record` paths stay noninteractive. Purged events are not
resurrected by undo; canon rewrites stay reversible. `--include-aliases` is
retired and refuses before planning or deletion. `--verify` prints per-store
absence proofs and `pending`/`done`/`failed` operation state. While any inert
legacy identity row remains, identity absence is unprovable rather than
successful.

Subject purges use an exact raw `subject_id` in its emitting connector's
namespace: `--subject ID --connector ID`. Bare subject IDs are refused,
even when only one connector currently matches. For source-bound events,
also supply `--source KEY` with the enrolled source key shown by
`kizuki connect status`. Connector, raw subject and source filters are
intersected; role and display name do not expand the subject's identity.
Without `--source`, connector-plus-subject selection is allowed only when
all matching events are legacy unbound evidence. Any matching source-bound
event causes refusal, including matches beyond the printed preview limit.
The same scope check runs again inside the deletion transaction.

`--dry-run` displays the complete selector and bounded matched event IDs;
`--json` retains the scope in `data.filter`. The Core `PurgeFilter` uses
`{ connector_id, subject_handle, source_key? }` for this operation and reports
`PurgeError` codes `subject_namespace_required` or `subject_source_required`
for incomplete scope. `--source` is a subject qualifier, not a source-wide
purge command. `--subject` cannot be combined with `--event` or `--record`.

## export

```text
usage: kizuki export --out DIR
```

Dumps vault files and ledger tables into an empty directory as
`kizuki.backup/v3`. The destination must sit outside the source vault.
Agent identities, grants, authentication audit, enrollment receipts and `.kizuki`
credential files are excluded. Restored vaults require explicit agent enrollment.

## restore

```text
usage: kizuki restore --from DIR [--into DIR] [--verify]
```

Verifies a `kizuki.backup/v3` directory and accepts `kizuki.backup/v1` and
`kizuki.backup/v2` as legacy restore inputs. With `--into` it restores into an
empty target after that verification. `--from DIR` alone, or with `--verify`,
checks hashes and completeness without writing.

Current backups include the bounded deferred-input queue and any one pending
model decision, so a restore can resume without sending the source text to the
model again. Backups whose serve schema predates version 8 did not carry this
recovery state; restore reports that limitation instead of inventing a pending
decision.

## recover

```text
usage: kizuki recover [--json]
```

Resumes interrupted memory writes and their retrieval updates. Exits 0 when
nothing remains pending. If recovery is still pending, stderr names the
reason when known and points at `kizuki doctor --json`. Existing holds stay
in place.

## rebuild

```text
usage: kizuki rebuild [--layer all|graph] [--port ID] [--prune-old] [--json]
```

Reconstructs derived retrieval from the vault. `--layer all` rebuilds the
configured retrieval store and the SQLite search/graph floor. `--layer graph`
rebuilds only the SQLite graph floor and does not refresh search; a configured
retrieval engine refuses that partial layer and exits 1. `--prune-old` removes
inactive owned retrieval generations under `.kizuki/retrieval/` and leaves the
currently configured engine, or the SQLite floor when no engine is bound.
`--port ID` names the bound store (`kizuki.retrieval.fts5` for the SQLite floor,
or the configured engine id) and refuses any other id. Other layers are not
implemented and exit 2. `--prune-old` cannot be combined with `--layer` or
`--port`.

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
bun packages/mcp/src/bin.ts --vault PATH (--owner | --token-env VAR | --token-ref file:/absolute/path) [--retrieval ID]
```

Stdio adapter. Tokens never travel on argv.
Select exactly one authentication method. Core resolves a private credential
file at startup and checks its enrollment binding and current agent authority.
Subsequent calls use the current stored grant and revocation state. Deleting a
file does not revoke an existing session; use `agent revoke`.

MCP uses the vault's configured retrieval engine when `--retrieval` is omitted.
If that optional engine is temporarily busy or unavailable, the session starts
with the authorized SQLite lexical floor. Stderr reports the degradation;
search results and context packets include `retrieval-unavailable`. The session
does not steal another process's lease or reconnect the engine mid-session.
An explicit `--retrieval ID` remains required. Unknown engines and invalid
configuration refuse startup. No model is needed for the lexical floor.

## agent

```text
usage: kizuki agent add NAME --grant FILE --token-ref file:/absolute/path --operation-id ID [--dry-run] [--json]
       kizuki agent revoke NAME [--json]
```

Enroll a scoped agent with a complete explicit grant and a private credential
file, or revoke its access. The parent directory must already exist and have
private owner custody. Credential delivery requires native local filesystem
custody; a missing native helper reports `unsupported_platform`. Preview validates an existing vault without creating an identity,
credential or configuration. An older ledger reports `migration_required`
without applying that migration during preview. Preview requires a stable,
checkpointed ledger without journal sidecars; otherwise it reports
`enrollment_busy` and leaves the files intact.

Retry the same operation ID and arguments after interruption. A retry reports
the current grant and credential state; it never restores a narrowed grant,
rotates a token or rewrites a completed credential. Setup exits 0 only for a
validated preview or an active identity with its original credential ready.
Invalid arguments or grants exit 2; conflicts and incomplete setup exit 1.
Cancellation may retain an inactive partial file. See the
[agent enrollment guide](agent-enrollment.md) for the complete grant, recovery
states and MCP connection example.

## Not CLI verbs

`timeline` is not registered. Timeline exists
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
after the source is authorized. The first backfill has no date floor: it reads
every listed dialog back to its beginning in batches of at most 500 events,
across at most 5,000 dialogs, and reports degraded health when the listing
bound truncates the view. Each later pass re-reads only the last 200 messages
of a dialog for edits. The connection's opaque protected session holds
provider cooldowns, and the native CLI persists those before returning a wait;
reopening the source checks the cooldown before opening transport. Transport
cleanup never logs out the Telegram session. Source-consent revocation and
provider logout are distinct operations. Telegram deletion detection and remote
message deletion remain unsupported. Synthetic native CLI tests do not qualify
real account access, complete provider history or a live observation period.
Before an authenticated session exists, initial sign-in has bounded attempts
and waits but restart-persistent throttling is unproven. Failed cooldown storage
is a visible failure requiring repair; it is not a successful rate-limit receipt.

## X own-post API enrollment

As of 2026-09-07, `connect x-api` is wired for a public Native App using Core OAuth
S256 PKCE and an exact registered callback. The operator supplies public
`KIZUKI_X_CLIENT_ID` and `KIZUKI_X_REDIRECT_URI`; the callback must be exactly
`http://127.0.0.1:PORT/callback` with an explicit port from 1 through 65535. The
port must be free on the owner's desktop. The listener binds before browser or
provider access; there is no client secret or pasted-token enrollment path.

Enrollment saves the public client ID and exact callback with the protected v2
connection state. A background process uses that saved configuration without
terminal environment variables. Later environment values cannot override it.
Legacy v1 state still requires both variables explicitly; reauthorization or the
first durable refresh intent upgrades it to v2. The catalog checks the
current environment for **new** enrollment, so an unconfigured catalog entry does
not mean an existing v2 source needs those variables.

Select `--fields none` for post text, author identity, and baseline metadata, or
an explicit comma-separated selection from `relationships,links,media`.
`--fields none` does not omit author subjects. Compatible grants always require
`text`, `subjects`, and `metadata`; selecting `media` additionally requires
`attachments`. A narrower grant is refused rather than widened. Set
`--history-start` to an RFC3339 lower bound at or after 2010-11-06,
representable without losing sub-millisecond precision. This is a bounded
own-post API window, not full history: API caps and missing posts report gaps,
media means references, and provider deletion coverage is unavailable.
`--source KEY` reauthorization preserves the app, account, selection, checkpoint,
pending plan and retry state. `--new-source` requires a distinct account/app/selection;
duplicates refuse even after local consent withdrawal. Each new source needs its own
capture grant before `backfill x-api --source KEY` can read protected state or contact X.

Before sending a refresh request, Kizuki durably records a pending intent in the
same native state store. A valid rotated response replaces only that intent. An
explicit rate-limit response stores its cooldown and clears the intent; a lost or
invalid response leaves it pending. Restarting Kizuki does not retry the old token.
Ordinary capture and `connect x-api` then refuse with
`credential_recovery_required`.

Use `connect recover-x-api --source KEY --fields FIELDS --history-start RFC3339`
from an interactive desktop terminal to obtain a new browser grant. Supply the
source's existing fields and history start. Recovery preserves the pending state
until the new grant verifies the same account, app and selection and publishes
against the exact original source state. Failed or competing recovery preserves
the previous state. A late old response cannot replace a recovered generation.
This action preserves capture consent, checkpoints and pending history; it does
not retry old credentials or establish whether the provider invalidated them.
Pending or completed provider revocation cannot use this recovery action.

The developer app must be configured as a public Native App with the exact registered
callback and read scopes `tweet.read users.read offline.access`. X API usage credits
and account eligibility are external prerequisites; no real grant or credit balance
has been qualified by the synthetic test suite. See X's official
[native app setup](https://docs.x.com/fundamentals/developer-apps),
[OAuth authorization code flow](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
and [usage billing](https://docs.x.com/x-api/getting-started/pricing).
