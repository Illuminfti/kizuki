# Lane: cli-verbs — Wave 1 verb set, config, command modules, opaque connections

Package: `packages/cli` (plus `packages/cli/package.json` and the README
"Status" section). Read CONVENTIONS.md first, then `packages/cli/AGENTS.md`,
`docs/architecture.md` (invariants; "Sign-in, not setup"), workspace plan
ARCHITECTURE.md §1 (layout on disk), §3.1 (connections, checkpoints), §5
(review and promotion), §7 (search is the deterministic floor for `query`),
§8.3 (CLI query surface), §11 (the complete v1 verb list this lane starts).
Then the real API you compose — read every file, not the older specs:

- `packages/core/src/index.ts` (the public surface; the enumerating test is
  `packages/core/test/index.test.ts`) and `packages/core/src/staging/index.ts`
  (`@kizuki/core/staging`).
- `packages/core/src/ledger/connections.ts`, `connection-state.ts`,
  `checkpoints.ts`, `db.ts` (migration v2: the `connections` CHECK
  constraints are the contract), `ingest/run.ts`, `export.ts`, `purge.ts`,
  `contracts/connector.ts`, `contracts/secret-ref.ts`, `search/`, `vault/`.
- `packages/core/test/connections.test.ts` (how the store is driven),
  `packages/core/test/ingest.test.ts`.
- `packages/connectors/src/registry.ts`, `index.ts`, the three connectors.
- `packages/tui/src/index.ts`, `app.ts` (`runReview`, `sanitize`).
- `packages/cli/src/main.ts` and `test/e2e.test.ts` (what you replace).

## Already on main (do not re-implement; the old spec's premises that changed)

- `packages/tui` exports `runReview({ db, vaultPath, batch? }) →
Promise<{ promoted, rejected }>`; it throws when stdin is not a TTY.
- Core has `runBackfill(db, connector, connector_id, source_key)`,
  `runSync(...)`, `runBatch`, `RunResult { stored, duplicates, errors[],
proposals_created, withdrawn, retractions_filed, cursor }`; the runner runs
  `cascadeTombstone` itself.
- `purgeEvents(db, vaultPath, filter, reason) → PurgeOutcome` with
  `PurgeFilter = { event_id } | { connector_id } | { subject_handle }`, plus
  `readHolds`, `isHeld`; purge already removes `search_docs` and `graph_edges`.
- `exportVault(db, vaultPath, outDir) → ExportManifest { files: { [rel]:
{ count, sha256 } } }`; refuses a non-empty `outDir`.
- `ownerPromote(db, vaultPath, id, { sensitivity?, editBody? })` handles
  every `PROPOSAL_KINDS` member; `sensitivity` is optional and inherited for
  edit/merge/deletion/purge_review, required for new pages (core refuses).
  `PromotionReceipt` carries `kind`, `before_hash`, `after_hash`;
  `readPromotion(db, proposalId)` and `readReceiptsLog(vaultPath)` exist;
  `RECEIPTS_PATH = ".kizuki/receipts/promotions.jsonl"`.
- `listCanonPages(vaultPath)`, `findPageById` (one vault walker; note it
  throws `TypeError` on a page without a string `id`), `doctorVault`.
- FTS: `initSearch`, `search(db, text, { scope, limit, ceiling, excludePaths,
... })`, `indexPage(db, CanonPage)`, `indexEvent(db, CaptureEvent)`,
  `removeDoc`, `rebuildSearch`, `rebuildDerived`. Nothing calls
  `indexPage`/`indexEvent` on the write paths yet — this lane does.
- **Connections are opaque.** There is no `saveConnection`. A `connections`
  row is `(connector_id, source_key)` where `source_key` is a core-minted
  ULID; `config` is exactly `{"schema":"kizuki.connection-config/v1",
"state_ref_index":null|0}`; `secret_refs` is `[]` or
  `["file:connections/<source_key>.state"]` — SQLite CHECK constraints
  refuse anything else. The only writer is `ConnectionStateStore.save`
  (via `store.begin()` → `writer.write(bytes)` once → `store.save`), the
  only reader is `store.read(connection) → Uint8Array | null`; the state
  file lives at `<controlDir>/connections/<source_key>.state`, mode 0600.
  `enrollConnection(db, store, connector, io)` is the sign-in variant
  (`Connector.signIn?(io, stateWriter): Promise<SignInDisplay>`; the
  display string is ephemeral by contract and must never be persisted).
  `disconnect(db, connector_id, source_key)`, `listConnections(db,
{ includeDisconnected? })`, `getConnection`, `getCheckpoint`,
  `listCheckpoints` exist. `readCheckpoint`/`writeCheckpoint` are thin
  wrappers main's old CLI used; the new CLI uses the runner instead.
- `parseSecretRef`/`isSecretRef` exist (`env:` | `file:` grammar only).
- `Bun.TOML.parse` exists on the pinned Bun (CI pins 1.3.x); JSON imports
  typecheck under the repo tsconfig without changes (verified).

Consequences for this lane: the `--secret NAME=env:VAR` flag of the old
spec is gone (a user-supplied ref has nowhere to live under the CHECK
constraints — see non-goals); `--source` no longer _is_ the source key; the
CLI is the trusted host that mints the opaque state for `none`-mode
connectors.

## Objective

Replace the single-file CLI with a command-module layout and ship the Wave 1
verb set exactly: `init connect backfill sync import review promote reject
query doctor purge export version`. Remove `ingest` and `proposals` (pre-alpha,
no aliases). Nothing else is wired (no `agent`, `mcp`, `serve`, `context`,
`timeline`, `entity`, `graph`, `rebuild`, `disconnect` — other lanes own
those). Every state change goes through the public core API; the CLI never
writes the database or the vault directly.

## 1. Layout

```
packages/cli/src/
  main.ts            # dispatch only: global --vault, verb lookup, run, map errors → exit codes
  args.ts            # parseArguments, UsageError
  config.ts          # config.toml resolution, read, write, ConfigError
  context.ts         # resolveVault, assertVault, openVaultDb, withVault
  connections.ts     # NEW: host state envelope, enrollment through the opaque store, selection, loadConnector
  derived.ts         # NEW: index freshness after ingest / promote (search only)
  output.ts          # table, jsonLine, clean
  commands/
    init.ts connect.ts backfill.ts sync.ts import.ts review.ts promote.ts
    reject.ts query.ts doctor.ts purge.ts export.ts version.ts
    index.ts         # COMMANDS registry: readonly Command[]
packages/cli/package.json   # add "version": "0.1.0" and "@kizuki/tui": "workspace:*"
```

```ts
// commands/index.ts
export interface CliIo {
  env: Record<string, string | undefined>;
  vaultOverride: string | null; // the global --vault value
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  out(line: string): void; // stdout: promised output only
  err(line: string): void; // stderr: diagnostics, progress, notes
}
export interface Command {
  name: string;
  usage: string; // one line, e.g. "connect <connector> --source PATH"
  summary: string; // one line for help
  run(io: CliIo, args: string[]): Promise<number>; // exit code
}
export const COMMANDS: readonly Command[]; // the 13 above, this order
```

`main.ts`: `kizuki help`, `kizuki --help`, `kizuki help <verb>` print help
to stdout, exit 0 (the list is derived from `COMMANDS`, never hand-listed;
`help <verb>` prints that verb's usage). No verb → help on stderr, exit 2.
Unknown verb → `unknown verb: <x>` + help on stderr, exit 2. `UsageError` →
the verb's usage on stderr, exit 2. Any other error → `error: <message>` on
stderr, exit 1. `--vault <path|name>` is accepted by every verb at any
position and removed before the verb parses its own arguments.

```ts
// args.ts
export class UsageError extends Error {}
export interface ArgSpec {
  options?: string[];
  flags?: string[];
}
export interface ParsedArguments {
  options: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}
export function parseArguments(
  tokens: string[],
  spec: ArgSpec,
): ParsedArguments;
// `--opt value` (value may not start with `--`; a repeated option is a UsageError),
// `--flag` (boolean), `--` ends option parsing, anything else starting with `--` is a UsageError.
```

Every list-style verb (`review --list`, `query`) accepts `--json`: one JSON
object per line (NDJSON). `doctor --json` prints one JSON document. Human
output otherwise. Captured text reaching a terminal goes through
`clean()` (`sanitize` from `@kizuki/tui`, whitespace collapsed) — captured
text is attacker-controlled and may carry escape sequences.

## 2. Config and vault resolution (`config.ts`, `context.ts`)

Config file: `$KIZUKI_CONFIG` if set, else `$XDG_CONFIG_HOME/kizuki/config.toml`,
else `$HOME/.config/kizuki/config.toml`. Parsed with `Bun.TOML.parse`.

```toml
default_vault = "/abs/path"

[vaults]
# name = "/abs/path"   (optional named vaults, used by --vault <name>)
```

```ts
export interface KizukiConfig {
  default_vault?: string;
  vaults: Record<string, string>;
}
export class ConfigError extends Error {}
export function configPath(env: Record<string, string | undefined>): string;
export function readConfig(path: string): KizukiConfig;
// missing file → { vaults: {} }; any top-level key other than default_vault/vaults, any
// non-string value, or any non-string under [vaults] → ConfigError naming the path and key
export function serializeConfig(config: KizukiConfig): string;
// deterministic: default_vault line (if set), blank line, `[vaults]`, keys sorted, values JSON.stringify'd
export function writeConfig(path: string, config: KizukiConfig): void;
// parent mkdir -p (mode 0700), file written 0600; refuses (ConfigError) when readConfig(path) throws
```

Honest over lossy: a file with keys this version does not understand is
never rewritten (print the path and the offending key, exit 1).

```ts
// context.ts
export function resolveVault(
  env,
  config: KizukiConfig,
  override: string | null,
): string;
// order: --vault → $KIZUKI_VAULT → config.default_vault → throw
//   "no vault configured; run: kizuki init <path>". A --vault value without a "/" is a name looked
//   up in config.vaults (unknown name → error listing known names); otherwise a path (resolved absolute).
export function assertVault(path: string): string; // `.kizuki/` and `archive/` markers, as today
export function openVaultDb(vaultPath: string): Database; // openLedger(<vault>/.kizuki/kizuki.db); initStaging(db); initSearch(db)
export interface VaultContext {
  configPath: string;
  vaultPath: string;
  db: Database;
  store: ConnectionStateStore;
}
export async function withVault<T>(
  io: CliIo,
  fn: (ctx: VaultContext) => Promise<T>,
): Promise<T>;
// resolves + asserts the vault, opens the db, store = new ConnectionStateStore(join(vaultPath, ".kizuki")),
// runs fn, closes the db in finally
```

`kizuki init <path> [--default | --no-default]`: read the config first (a
`ConfigError` refuses before any side effect), then `initVault(resolve(path))`,
then set `default_vault` when none is set or `--default` was passed (never
with `--no-default`; both flags → `UsageError`). Prints the vault path and,
when the config was written, `default_vault set in <config path>`.

## 3. Connections in the CLI (`connections.ts`, NEW)

The CLI is the trusted host from docs/architecture.md: it mints the source
key and the state file through `ConnectionStateStore` and persists only the
fixed envelope. For the three registered connectors (all
`auth_modes: ["none"]`, config `{ path }`) the state bytes are host-authored:

```ts
export const HOST_STATE_SCHEMA = "kizuki.cli.connection-state/v1" as const;
export interface HostConnectionState {
  schema: typeof HOST_STATE_SCHEMA;
  connector_id: string; // must equal the row's connector_id
  config: { path: string }; // absolute, resolved
}
export class ConnectionError extends Error {}
export function encodeHostState(state: HostConnectionState): Uint8Array; // JSON, UTF-8
export function decodeHostState(
  bytes: Uint8Array,
  connectorId: string,
): HostConnectionState;
// TextDecoder("utf-8", { fatal: true }); exact keys only (no extras), schema and connector_id must match,
// path must be absolute — anything else throws ConnectionError (fail closed; state is on-disk input)
export function resolveConnectorId(input: string): string;
// exact REGISTRY key, else `kizuki.${input}`; unknown → ConnectionError "unknown connector: <input>; known: <sorted keys>"
export async function enrollHostConnection(
  db: Database,
  store: ConnectionStateStore,
  connectorId: string,
  state: HostConnectionState,
): Promise<Connection>;
// store.recover(db); const e = store.begin(); try { await e.writer.write(encodeHostState(state));
//   return store.save(db, connectorId, e.pending); } catch (error) { store.discard(e.pending); throw error; }
export interface HostConnection {
  connection: Connection;
  state: HostConnectionState | null; // null when the state file is missing or undecodable
  problem: string | null; // the reason, for doctor
}
export function listHostConnections(
  db,
  store,
  connectorId?: string,
): HostConnection[]; // active rows only
export function selectConnection(
  db,
  store,
  connectorId: string,
  selector: string | undefined,
): HostConnection;
// selector matching /^[0-9A-HJKMNPQRSTVWXYZ]{26}$/ is a source key (pass `./<name>` to name a directory
// that happens to look like one); any other value is resolve()d and matched against state.config.path;
// undefined → the connector's single active connection, else ConnectionError
//   "several connections for <id>; pass --source <PATH|KEY>" / "no connection for <id>; run: kizuki connect <id> --source PATH".
// A selected connection with state === null throws ConnectionError "<id> source=<key>: <problem>; reconnect it".
export async function loadConnector(
  selected: HostConnection,
): Promise<Connector>;
// getConnector(connector_id, state.config); await connector.connect(refuseSecrets) where
// refuseSecrets: SecretResolver = async (ref) => { throw new ConnectionError(`no secret configured for ${ref}`) }
```

Nothing connector-authored is persisted; the display string returned by a
future `signIn` is not part of this lane. A path is configuration, not a
credential; it lives in the 0600 state file, never in SQLite.

## 4. Index freshness (`derived.ts`, NEW)

Search is a derived layer and must stay consistent with a future
`rebuildSearch` (archived pages are indexed by the rebuild too, so the
incremental path indexes them as well; `query` excludes them at read time).

```ts
export function indexEventsSince(db: Database, since: LedgerCursor): number;
// loops readSince(db, cursor, 500) until exhausted; indexEvent for every event (tombstones included —
// indexEvent for a deleted event drops the record's docs); returns the count
export function indexPagePath(
  db: Database,
  vaultPath: string,
  relPath: string,
): boolean;
// listCanonPages(vaultPath).find(page => page.relPath === relPath) → indexPage; false when absent
export function indexPromotedSince(
  db: Database,
  vaultPath: string,
  at: string,
): number;
// readReceiptsLog(vaultPath).filter(r => r.at >= at) → distinct page_path → indexPagePath
```

Callers: `backfill`/`sync`/`import` take `since = { accepted_at: new
Date().toISOString(), event_id: "" }` immediately before the runner call and
index afterwards (same-process clock; a wall-clock step backwards is
recovered by the `rebuild` verb of a later lane — say so in a comment).
`promote` indexes the receipt's `page_path`; `review` (TUI session) indexes
`indexPromotedSince(sessionStartedAt)` after `runReview` returns.

## 5. Verbs

- `connect <connector> --source PATH` — `resolveConnectorId`; `--source`
  required, resolved absolute. If an active connection of that connector
  already has this path: re-check `health()` and print the line below with
  the existing key (idempotent, exit 0 when `ok`). Otherwise
  `getConnector(id, { path })`; refuse when `manifest().auth_modes` lacks
  `"none"` (`sign-in for <id> is not wired yet`, exit 1 — cannot happen
  with today's registry, keeps the branch honest); `await
connector.connect(refuseSecrets)`; `health()`; state `ok` →
  `enrollHostConnection` and print `connected <id> source=<KEY> path=<abs>
health=ok`; any other state → stderr `error: <id> health=<state>: <detail>`,
  exit 1, nothing persisted (fail closed).
- `backfill <connector> [--source PATH|KEY]` — `selectConnection` →
  `loadConnector` → `runBackfill(db, connector, id, source_key)` →
  `indexEventsSince`. Prints `events_stored=N duplicates=N proposals_created=N
withdrawn=N retractions_filed=N errors=N`; every `errors[]` entry goes to
  stderr as `error: <text>`; exit 1 when `errors.length > 0` (the runner
  keeps the previous cursor on errors, so the run is retryable).
- `sync [connector] [--source PATH|KEY]` — one selected connection, every
  active connection of one connector, or every active connection; `runSync`
  each; one line per connection: `<id> source=<KEY> events_stored=N
duplicates=N proposals_created=N withdrawn=N retractions_filed=N errors=N`;
  a connection with `state === null` prints `<id> source=<KEY> skipped:
<problem>` on stderr and counts as an error. Exit 1 if any error.
- `import <connector> --source PATH` — the stranger shortcut: the `connect`
  step (creating or reusing the connection) then the `backfill` step; same
  output as `backfill`. Running it twice is safe (second run: all duplicates).
- `review [--list] [--batch] [--status pending|promoted|rejected|withdrawn] [--kind K] [--json]`
  — when both stdin and stdout are TTYs and `--list` is absent: record
  `startedAt`, `runReview({ db, vaultPath, batch: --batch })`, then
  `indexPromotedSince`, then print `session promoted=N rejected=N`.
  Otherwise a table (columns `id kind target producer confidence summary`;
  summary = first 160 chars of `clean(body)`) from `listProposals(db,
{ status: --status ?? "pending", kind: --kind, limit: 5000 })`; `--status`
  ∈ `STAGING_STATUSES`, `--kind` ∈ `PROPOSAL_KINDS`, else `UsageError`.
  `--json` prints one `StagedProposal` per line. `--batch` with `--list` is
  a `UsageError`. Do not modify `packages/tui`.
- `promote <proposal_id> [--sensitivity public|personal|private] [--body-file PATH]`
  — `ownerPromote(db, vaultPath, id, { sensitivity?, editBody? })` (pass
  keys only when given; core enforces "required for new pages" and refuses
  an unlabeled inherited page). Then `indexPagePath(receipt.page_path)`.
  Prints `page_path=<abs>`, `receipt_id=<id>`, `kind=<kind>`.
- `reject <proposal_id> --reason TEXT` — `setProposalStatus(db, id,
"rejected", reason)`; prints `proposal_id=<id> status=rejected`.
- `query <text> [--scope canon|ledger|all] [--limit N] [--json]` — the FTS
  floor (§7): `search(db, text, { scope: --scope ?? "all", limit: --limit ?? 20,
ceiling: "private", excludePaths })` where `excludePaths` = every
  `readHolds(db).page_path` ∪ every `listCanonPages(vaultPath)` entry with
  `status === "archived"` (`relPath`). `ceiling: "private"` is the
  fail-closed rule for the owner too: unlabeled pages and events without a
  `sensitivity_hint` are never served. When the same search without
  `ceiling` returns more rows, print `withheld=<n> (no sensitivity label)` to
  stderr so the stranger learns why (the three registered connectors emit no
  hints; promoted pages are labeled). Human lines: `page <doc_id> <path>
<sensitivity> <snippet>` and `event <doc_id> <connector_id> <occurred_at>
<snippet>` (snippet through `clean`). `--json`: one `SearchHit` per line.
  An empty FTS query prints nothing, exit 0. A `listCanonPages` failure
  (malformed page) is an error naming the page (doctor's job to explain).
  `--limit` must be an integer 1..500.
- `doctor [--json]` — lines, in order: `config=<path>`, `vault=<abs>`,
  `events=<count(db)>`, `proposals pending=N promoted=N rejected=N withdrawn=N`
  (four `listProposals` counts, limit 100000), one `connection <id>
source=<KEY> path=<p|-> state=present|missing health=<state>
checkpoint=<last_run_at|never> stored=N errors=N` per active connection
  (rebuild via `loadConnector` and call `health()`; a `state === null`
  connection reports `state=missing health=misconfigured` and the problem),
  `receipts=N orphans=N`, then `orphan receipt <receipt_id> (no promotions
row)` for a JSONL receipt whose `readPromotion(db, proposal_id)` is null
  or has a different `receipt_id`, `orphan promotion <receipt_id> page=<path>
(missing on disk)` for a promoted proposal (`listProposals(status:
"promoted")` → `readPromotion`) whose page file does not exist, `hold
<page_path> proposal=<id>` per `readHolds`, `retraction-pending
<proposal_id> page=<target>.md` per pending `deletion` proposal (main's
  format), `problem <page>: <error>` per `doctorVault` finding. Exit 1 if
  any invalid page, any orphan, or any connection whose health is not `ok`
  (missing state included). Holds and pending retractions are owner
  decisions, not failures. `--json`: one object `{ config, vault, events,
proposals, connections, receipts, orphans, holds, retractions, problems,
ok }`.
- `purge (--event ID | --subject ID | --connector ID) --reason TEXT` —
  exactly one selector else `UsageError`; `--connector` accepts the short
  alias; `purgeEvents(db, vaultPath, filter, reason)` with `{ event_id }`,
  `{ subject_handle }` or `{ connector_id }`. Prints `purged=N withdrawn=N
holds=N`, then `receipt <receipt_id> event=<event_id>` per receipt and
  `hold <page_path> proposal=<id>` per hold.
- `export --out DIR` — `exportVault(db, vaultPath, resolve(DIR))`; prints
  `manifest=<abs>/manifest.json` then `vault_files=N events=N purges=N
proposals=N promotions=N rejections=N connections=N checkpoints=N` derived
  from the manifest counts (vault_files = number of `vault/` entries).
- `version` — `import pkg from "../package.json"` and print `pkg.version`
  (add `"version": "0.1.0"` to `packages/cli/package.json`); never a literal.

## 6. Tests (`packages/cli/test/`)

Shared `helpers.ts`: `runCli(env, ...args)` spawns `src/main.ts` with a
temp `XDG_CONFIG_HOME`/`KIZUKI_CONFIG`, returns `{ exitCode, stdout, stderr }`;
`tempVault()` builds an initialized vault plus a synthetic notes folder
(ada/grace/linus phrases). Every test sets its own config dir; nothing
reads outside the temp tree.

- `e2e.test.ts` (rewrite; the stranger loop): `init` (config written) →
  `import markdown-folder --source notes` (`events_stored=3`, exactly one
  `connections` row with `config.state_ref_index === 0`, `secret_refs ===
["file:connections/<KEY>.state"]`, state file mode 0600) → `query
<phrase>` prints nothing, stderr `withheld=1 (no sensitivity label)` →
  `review --list` shows three pending rows → `promote` without
  `--sensitivity` fails (exit 1, no `captures/`), then succeeds with
  `personal` → `query <phrase>` prints the `page` line without any rebuild →
  `reject` the second → `doctor` exit 0 with `connection ... health=ok` →
  delete two notes, `sync markdown-folder` reports `withdrawn=1
retractions_filed=1` → `doctor` shows `retraction-pending` → promote the
  deletion → `query` prints nothing for the archived page → `purge --event
<the promoted page's source event> --reason test` prints one receipt and
  one hold → `doctor` shows the hold, exit 0 → `review --list --kind
purge_review` shows the proposal → `promote` it → `query` serves the page
  again → `export --out` and assert `manifest.json` counts.
- `connect.test.ts`: unknown connector → exit 1 listing known ids; missing
  directory → exit 1, zero rows, empty `connections/` directory; connect
  twice → same key, one row; `backfill --source <KEY>` and `--source <path>`
  select the same connection; two connections of one connector without
  `--source` → exit 1 "several connections"; a state file replaced with
  garbage → `backfill` exit 1 naming the key, `doctor` exit 1 with
  `state=missing`; the raw `kizuki.db` bytes never contain the source path.
- `query.test.ts`: `--scope ledger` and `--scope canon`; held page never
  returned; archived page never returned; tombstoned record's events never
  returned; `--json` lines parse as `SearchHit`; `--limit 0` and `--limit x`
  are usage errors.
- `config.test.ts`: resolution order (`KIZUKI_CONFIG` > `XDG_CONFIG_HOME` >
  `HOME`), `--vault name` lookup, `KIZUKI_VAULT`, refusal to write a file
  with an unknown key (exit 1, file byte-identical afterwards), `init` sets
  `default_vault` once and `--default` overrides, `--default --no-default`
  usage error, no vault configured → the exact message.
- `doctor.test.ts`: a hand-appended bogus line in
  `.kizuki/receipts/promotions.jsonl` → `orphan receipt`, exit 1; deleting
  a promoted page's file → `orphan promotion`, exit 1.
- `help.test.ts`: `help`, `--help`, no verb (exit 2) and unknown verb (exit
  2); every `COMMANDS` entry appears in help; assert the exact 13-name set
  (import `COMMANDS` directly); `ingest` and `proposals` exit 2.

## 7. README

Replace the "Status" section with "Try it (pre-alpha)": the config file
location, the 13 verbs with one line each, and the stranger loop as a
copy-pasteable sequence (`init`, `import markdown-folder --source`, `review
--list`, `promote --sensitivity personal`, `query`, `doctor`, `export`).
State plainly that unlabeled capture is never served by `query` and that
sign-in connectors are not wired yet. Claim nothing that does not run; add
no product, vendor or person names (the README is under
`bash scripts/verify.sh`'s identifier and attribution gates).

## Non-goals

No `agent`, `mcp`, `serve`, `context`, `timeline`, `entity`, `graph`,
`rebuild`, `disconnect`. No sign-in path (`enrollConnection`,
`store.replace`, `SignInIo` on the terminal) — a following CLI lane wires it
on the same `connections.ts` seam. No `--secret` flags and no
`secret_ref`-mode connectors: a user-supplied ref cannot be persisted under
the opaque-state CHECK constraints; that needs a core decision first. No
config keys beyond the two above (no `[llm]`). No graph indexing on the write
path (the graph has no incremental API on main; `rebuild` owns it). No
changes to `packages/core`, `packages/connectors`, `packages/tui`.

Runtime dependencies: none. `@kizuki/tui` becomes a workspace dependency of
`packages/cli` (`bun install` refreshes `bun.lock`; commit it, CI installs
with `--frozen-lockfile`).

## Acceptance

```
bun install                                                  # bun.lock gains the @kizuki/tui workspace link; commit it
bun run typecheck                                            # exit 0
bun test                                                     # green; packages/cli/test has the six files above
bun packages/cli/src/main.ts help                            # exit 0; exactly 13 verb lines: init connect backfill sync import review promote reject query doctor purge export version
bun packages/cli/src/main.ts; echo $?                        # help on stderr; 2
bun packages/cli/src/main.ts ingest; echo $?                 # 2 (removed)
bun packages/cli/src/main.ts proposals; echo $?              # 2 (removed)
bun packages/cli/src/main.ts version                         # prints the version field of packages/cli/package.json
T=$(mktemp -d); export KIZUKI_CONFIG=$T/config.toml
bun packages/cli/src/main.ts query x; echo $?                # "error: no vault configured; run: kizuki init <path>"; 1
bun packages/cli/src/main.ts init $T/vault                   # prints the vault path and "default_vault set in $T/config.toml"
mkdir $T/notes && printf 'ada met grace at the acme library\n' > $T/notes/a.md
bun packages/cli/src/main.ts import markdown-folder --source $T/notes   # events_stored=1 duplicates=0 proposals_created=1 withdrawn=0 retractions_filed=0 errors=0
ls -l $T/vault/.kizuki/connections/                          # one <KEY>.state, mode -rw-------
bun packages/cli/src/main.ts query acme                      # no stdout; stderr "withheld=1 (no sensitivity label)"
bun packages/cli/src/main.ts review --list --json | head -1  # one JSON proposal
bun packages/cli/src/main.ts promote <id> --sensitivity personal      # page_path=… receipt_id=… kind=claim
bun packages/cli/src/main.ts query acme                      # one "page …" line, no rebuild needed
bun packages/cli/src/main.ts doctor; echo $?                 # connection kizuki.markdown-folder … health=ok; 0
bun packages/cli/src/main.ts purge --event <event_id> --reason test   # purged=1 withdrawn=0 holds=1 + receipt + hold lines
bun packages/cli/src/main.ts export --out $T/export          # manifest=$T/export/manifest.json + counts
bun run scripts/verify-network.ts                            # "network source verification passed"
bash scripts/verify.sh                                       # exit 0 (typecheck, tests, policy tests, network scan, identifier denylist incl. commit messages)
git status --porcelain                                       # empty
```
