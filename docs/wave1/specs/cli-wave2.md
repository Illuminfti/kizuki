> **Superseded owner-gate framing, 2026-09-02.** Do not wire `review` /
> `promote` / `reject` as the owner path. Accepted design verbs are `audit`,
> `tell`, `undo`, `context`, `timeline`, `rebuild`, `models`, `serve`. See
> `rfcs/0002-autonomous-canon.md`.

# Lane: cli-wave2 — serving verbs, agent verbs, `mcp`, and the interactive sign-in path on the CLI

## Decision-log deltas (2026-09-02)

- Every wiring of `review`, `promote` and `reject` as the owner path is
  superseded (D9, D10). Do not add them to a help list presented as the
  product's daily surface, and do not add a verb that files anything for a
  person to approve. The accepted verbs are `audit`, `tell`, `undo`,
  `context`, `timeline`, `rebuild`, `models` and `serve` (RFC 0002 §2.5).
- `indexPromotedPage(...)` and the "after `ownerPromote` returns" hook are
  superseded by retrieval refresh on the receipted writer's own write path,
  behind `kizuki.retrieval/v1` (D13, RFC 0002 §4.6, §9.2). Do not index by
  reaching into another component's storage (D16, RFC 0002 §3.2 rule 1).
- "the TUI promotes in-process" is superseded: the TUI's only effect is
  `undo` (D10, RFC 0002 §7.3).
- The frozen-contract list "`kizuki.event/v1`, `kizuki.proposal/v1`" is
  narrowed: `kizuki.event/v1` stays frozen; `kizuki.proposal/v1` becomes
  `kizuki.claim/v1` under migration v3 (RFC 0002 §18.1).
- The MCP surface exposes two write tools, `propose` and `correct` (D14).
- `kizuki init` installs `kizuki serve` as a user service; the CLI must still
  run with the daemon down and declare `degraded` rather than failing
  (D15, RFC 0002 §2.1).

Package: `packages/cli` (plus `README.md`) and two small additive seams in
`packages/core` named in §1.3 and §1.4. Read CONVENTIONS.md first, then
`AGENTS.md`, `packages/cli/AGENTS.md`, `.agents/skills/cli-terminal-ux/SKILL.md`,
`.agents/skills/mcp-tool-design/SKILL.md`,
`.agents/skills/security-privacy-review/SKILL.md`, `docs/architecture.md`
(invariants 2, 3, 6, 7, 8, 10 and the "Sign-in, not setup" paragraph), the
fuller design in `workspace/kizuki-plan/ARCHITECTURE.md` §7 (derived layers),
§8.1–8.3 (agents, MCP, CLI query surface), §11 (verb set) and §12 (gates), and
`packages/core/src/index.ts` — the only core API you may call. Then read every
file this lane composes:

- `packages/core/src/contracts/connector.ts` — `Manifest.auth_modes`,
  `SignInIo`, `SignInDisplay`, `ConnectionStateWriter`, the optional
  `Connector.signIn(io, state)`.
- `packages/core/src/ledger/connection-state.ts` — `ConnectionStateStore`
  (`begin`, `save`, `discard`, `recover`, `read`, `replace`) and
  `enrollConnection`. `packages/core/test/connections.test.ts` shows the
  fixture-connector shape and what the store guarantees.
- `packages/core/src/ledger/connections.ts` — `Connection` (host-minted ULID
  `source_key`; `config` is a fixed envelope; `secret_refs` is `[]` or the
  single `file:connections/<source_key>.state` ref), `getConnection`,
  `listConnections`, `disconnect`, checkpoints.
- `packages/core/src/agents/` — `addAgent`, `authenticate`, `listAgents`,
  `setGrant`, `revokeAgent`, `rotateToken`, `listAudit`, `getAgent`, `TOOLS`,
  `OWNER`, `initAgents`, `AuditRow`, `Grant`, `Principal`.
- `packages/core/src/search/`, `graph/`, `query/timeline.ts`, `derived.ts` —
  `indexPage`, `indexEvent`, `rebuildSearch`, `rebuildGraph`,
  `rebuildDerived`, `initSearch`, `initGraph`, `derived_meta`.
- `packages/core/src/ingest/run.ts` — `runBatch`, `runBackfill`, `runSync`.
- `packages/core/src/staging/promote.ts` — `ownerPromote`, `PromotionReceipt`
  (`page_path` is vault-relative), `readReceiptsLog`.
- `packages/tui/src/ansi.ts` — `sanitize`, `truncate` (already a CLI
  dependency after cli-verbs; reuse, do not re-implement).
- The command-module layout from cli-verbs (`packages/cli/src/main.ts`,
  `args.ts`, `config.ts`, `context.ts`, `output.ts`, `commands/*.ts`,
  `commands/index.ts`) and the serving engine + MCP server from serving-mcp.

Depends on: **cli-verbs** (command modules, config, vault resolution, the
Wave 1 verbs) and **serving-mcp** (`packages/core/src/serving/` and
`packages/mcp`). Both must be merged before this lane starts. Neither is on
main today; every symbol from them is marked NEW below with its intended
location so you can verify it on the branch you start from.

## Already on main (do not re-implement)

- Agent identity, grants, audit and enforcement: `packages/core/src/agents/`
  with tables `agents`, `agent_grants`, `agent_audit` (`initAgents`). Tokens
  are `kzk_` + 52 Crockford chars; only the sha256 is stored; `authenticate`
  returns `null` for unknown, malformed or revoked tokens; `listAudit(db,
name | "owner", { limit, since })`; `recordAudit` hashes free text
  (`shapeArguments`), so audit rows never carry a query string.
- Derived layers: FTS5 `search_docs` + `derived_meta`, `graph_edges`,
  `timeline()`, `rebuildDerived(db, vaultPath)` returning
  `{ search: { pages, events, rebuilt_at }, graph: { pages, edges, rebuilt_at } }`.
  Ceiling enforcement in SQL (`search`/`timeline` `ceiling` option);
  `unlabeled` docs are never returned when a ceiling is given.
- Purge already removes `search_docs` rows and `graph_edges` for purged
  events and files `purge_review` + `canon_holds` (`purgeEvents`,
  `readHolds`, `isHeld`).
- Connections and the opaque-state custody model (commit "Land core spine and
  opaque connector state"): `connections` rows are created only by
  `ConnectionStateStore.save` (directly or via `enrollConnection` /
  `replace`); `source_key` is a core-minted ULID; connector state lives at
  `<vault>/.kizuki/connections/<source_key>.state`, mode 0600, written once
  through a one-shot `ConnectionStateWriter`, swapped atomically with a
  journal; `ConnectionStateStore.read(connection)` is the trusted-host-only
  reader. Nothing connector-authored is persisted except those bytes.
- The connector contract's interactive seam: `manifest.auth_modes` (`none |
sign_in | oauth | secret_ref`), `signIn?(io: SignInIo, state:
ConnectionStateWriter): Promise<SignInDisplay>`; the conformance suite
  already checks that `signIn` exists iff an interactive mode is declared.
- `listCanonPages`, `findPageById`, `parseFrontmatter`, `readReceiptsLog`,
  `exportVault` (copies the vault minus `.kizuki/`; `connections.jsonl`
  carries refs only, never state bytes).

## Stale in the previous draft of this spec → fixed here

- `connector.signIn(io, <vault>/.kizuki/secrets)` returning
  `{ source_key, config, secret_refs, display }` no longer exists. The host
  mints the key and the state filename; the connector returns only an
  ephemeral `display`. §4 rewrites the sign-in path on `enrollConnection` /
  `ConnectionStateStore.replace`. There is no `.kizuki/secrets` directory.
- `saveConnection(db, connector_id, config, secret_refs)` (referenced by the
  cli-verbs draft) does not exist on main and cannot: the `connections` table
  CHECK-constrains `config` and `secret_refs` to the opaque-state envelope.
  §2 states the host-state contract this lane needs from cli-verbs.
- `principalFromToken` / `ownerPrincipal` from `@kizuki/mcp` are redundant
  with core's `authenticate` and `OWNER`, both on main; §6 uses core.
- `--token <value>` on the command line is gone (it lands in shell history
  and `ps`); §6 accepts `env:VAR` and `file:PATH` only.
- The doctor "stale index" judgment cannot be computed honestly from public
  APIs on main; §8 reports facts (`rebuilt_at`, counts) instead.
- The acceptance grep that spelled out the CI denylist is replaced by
  `bun run verify`, which already enforces the denylist on tracked text and
  on every reachable commit message.

## Objective

Finish the v1 verb set (ARCHITECTURE.md §11 minus `serve`, which is the
daemon lane's): `init connect backfill sync import review promote reject query
timeline entity context graph doctor rebuild purge export agent mcp version`
— twenty verbs, every one backed by a working implementation (invariant 10).
The owner's own CLI reads through the same serving gate agents use (§8.1:
enforcement below the prompt layer applies to everyone), the derived layers
stay fresh without the owner remembering `rebuild`, agents get a complete
identity lifecycle, any MCP client can attach over stdio, and `kizuki
connect` carries the interactive sign-in path that the connector lanes
(telegram, google, whoop, x) plug into — against the exact
`ConnectionStateWriter` contract on main.

## 0. Layout (additions to the cli-verbs layout; all NEW unless noted)

```
packages/cli/src/
  context.ts          # cli-verbs; this lane adds the fields in §1.1
  connections.ts      # §2: host-state envelope, connectorFor(), enroll/replace helpers
  signin-io.ts        # §4.1: terminal SignInIo
  derived.ts          # §1.2: ensureDerived(), indexPromotedPage(), indexEventsHook()
  commands/
    query.ts          # cli-verbs; engine replaced per §5.1
    rebuild.ts timeline.ts entity.ts context.ts graph.ts   # §5
    agent.ts          # §7 (subverbs add|list|grant|revoke|rotate|audit)
    mcp.ts            # §6
    connect.ts        # cli-verbs; sign-in branch + --list/--new/--source per §4
    doctor.ts         # cli-verbs; additions per §8
    index.ts          # registry gains the seven new verbs
packages/core/src/ingest/run.ts   # §1.3: optional RunHooks (additive)
packages/core/src/derived.ts      # §1.4: readDerivedMeta (additive)
```

No new SQLite tables or columns. No migration.

## 1. Shared plumbing

### 1.1 `Context` additions (`packages/cli/src/context.ts`, NEW in cli-verbs)

Whatever shape cli-verbs gave `Context`, this lane needs these members so
commands are testable in-process without a TTY or the real registry:

```ts
export interface Context {
  vaultPath: string; // resolved per cli-verbs §2
  configPath: string;
  db(): Database; // lazy; openVaultDb() below; closed by main.ts
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream; // promised output only
  stderr: NodeJS.WritableStream; // diagnostics, prompts, footers
  stdin: NodeJS.ReadStream;
  connectors: { get(id: string, config?: unknown): Connector }; // default: getConnector from @kizuki/connectors
  signInIo(): SignInIo; // default: terminalSignInIo(ctx) (§4.1); tests inject a scripted io
}
```

`openVaultDb(vaultPath)` (cli-verbs) must call, in this order, `openLedger`,
`initStaging`, `initSearch`, `initGraph`, `initAgents` — all idempotent and
all on main — so every verb sees every table. If cli-verbs did not, add the
missing calls here.

Connector ids: accept the registry id (`kizuki.markdown-folder`) and the
short form (`markdown-folder`), as cli-verbs does; the `--json` output and
every stored row use the registry id.

### 1.2 `packages/cli/src/derived.ts` (NEW)

```ts
export function ensureDerived(ctx: Context): DerivedRebuildResult | null;
// readDerivedMeta(db) (§1.4); when either layer has no derived_meta row, run
// rebuildDerived(db, vaultPath), write one line to stderr:
//   derived layers built (first run): search=<pages+events> docs graph=<edges> edges
// and return the result; otherwise return null. Called by query, entity,
// context, graph and mcp before serving. A read verb rebuilding disposable
// derived state writes neither canon nor ledger (invariant 2, 3).

export function indexPromotedPage(
  ctx: Context,
  receipt: PromotionReceipt,
): void;
// Reads exactly the promoted file (join(vaultPath, receipt.page_path)),
// parses it with parseFrontmatter, builds a CanonPage { id, path, relPath,
// data, body } and calls indexPage(db, page). Then rebuildGraph(db, vaultPath)
// — the graph has no incremental API on main; a full graph rebuild is O(pages)
// and acceptable for v1. If rebuildGraph throws (a hand-written note without
// an id makes listCanonPages throw until the derived-fixes lane lands), write
//   graph not rebuilt: <message>; run: kizuki rebuild
// to stderr and return: the promotion succeeded and derived state is
// disposable. indexPage failures propagate (exit 1) — the page is on disk
// and the receipt is written; the error message says so.

export function indexEventsHook(ctx: Context): RunHooks;
// { onStored: (event) => indexEvent(db, event) } — §1.3.
```

Wiring (touches cli-verbs commands; keep their output unchanged):

- `promote`: after `ownerPromote` returns → `indexPromotedPage`.
- `review` (interactive path): after `runReview` resolves with
  `promoted > 0` → `rebuildDerived` (the TUI promotes in-process and the
  summary does not name pages); print the session line as before.
- `backfill`, `sync`, `import`: pass `indexEventsHook(ctx)` as the `hooks`
  argument of `runBackfill` / `runSync`.

### 1.3 `RunHooks` on the ingest runner (`packages/core/src/ingest/run.ts`, NEW, additive)

```ts
export interface RunHooks {
  /** Called once per event the batch stored (tombstones included), after that
   *  event's transaction committed. Never for duplicates or errors. */
  onStored?(event: CaptureEvent): void;
}
export function runBatch(
  db: Database,
  batch: SyncBatch,
  hooks?: RunHooks,
): RunResult;
export async function runBackfill(
  db,
  connector,
  connector_id,
  source_key,
  hooks?: RunHooks,
): Promise<RunResult>;
export async function runSync(
  db,
  connector,
  connector_id,
  source_key,
  hooks?: RunHooks,
): Promise<RunResult>;
```

`processEvent` returns the accepted event alongside the counts so `runBatch`
can invoke the hook outside the transaction. A hook that throws propagates
out of `runBatch` before `saveCheckpoint` runs: the ledger keeps what it
stored, the checkpoint does not advance, the next run re-fetches and dedupes.
Core stays deterministic and dependency-free; the hook is how the daemon lane
will keep the index fresh too. Existing call sites are unchanged (optional
parameter).

### 1.4 `readDerivedMeta` (`packages/core/src/derived.ts`, NEW, additive)

```ts
export interface DerivedLayerMeta {
  rebuilt_at: string;
  doc_count: number;
}
export interface DerivedMeta {
  search: DerivedLayerMeta | null;
  graph: DerivedLayerMeta | null;
}
export function readDerivedMeta(db: Database): DerivedMeta;
// initSearch + initGraph (idempotent DDL) then SELECT layer, rebuilt_at,
// doc_count FROM derived_meta. The only public reader of derived_meta; used by
// ensureDerived and doctor so the CLI never issues raw SQL.
```

Export both from `packages/core/src/index.ts` and add `readDerivedMeta` to
the public-surface list in `packages/core/test/index.test.ts`.

## 2. Connection materialization (`packages/cli/src/connections.ts`)

This module is the CLI's single reader/writer of connection state. cli-verbs
(reconciled against main) owns it for `none`-mode connectors; this lane adds
the sign-in branch. If cli-verbs landed it under another name, extend that
module — do not add a second implementation. The invariants below are what
this lane relies on.

```ts
export const HOST_STATE_SCHEMA = "kizuki.host-connection/v1" as const;
export interface HostState {
  schema: typeof HOST_STATE_SCHEMA;
  connector_id: string; // registry id; must equal the row's
  config: Record<string, unknown>; // what getConnector(id, config) receives;
  // secret-bearing keys hold secret_ref URIs (isSecretRef), never values
}
export function connectionStore(ctx: Context): ConnectionStateStore; // new ConnectionStateStore(join(vaultPath, ".kizuki"))
export async function enrollHostState(
  ctx,
  connectorId,
  config,
): Promise<Connection>;
// store.recover(db); const { pending, writer } = store.begin(); await writer.write(utf8(JSON.stringify(hostState)));
// store.save(db, connectorId, pending); on any throw → store.discard(pending) and rethrow.
export async function connectorFor(
  ctx: Context,
  connection: Connection,
): Promise<Connector>;
export function hostSecretResolver(ctx: Context): SecretResolver;
// env:VAR → ctx.env[VAR] (missing → throw "secret env:VAR is not set");
// file:PATH → PATH must be absolute and mode must not grant group/other bits
// ((mode & 0o077) === 0), else refuse; read utf8, strip one trailing newline.
// Anything else → throw. Values are never logged.
```

`connectorFor` decides by content, then cross-checks the manifest (fail
closed both ways):

1. `bytes = store.read(connection)`; `null` → the row was saved without state
   → `getConnector(id)` with no config, then `manifest().auth_modes` must
   include `none`, else refuse `connection <id> <source_key> has no state`.
2. Parse `bytes` as UTF-8 JSON (`TextDecoder("utf-8", { fatal: true })`); if
   it is a plain object with `schema === HOST_STATE_SCHEMA` and
   `connector_id === connection.connector_id` and a plain-object `config` →
   host-configured: `connector = ctx.connectors.get(id, config)`; require
   `manifest().auth_modes` to include `none` or `secret_ref`; `await
connector.connect(hostSecretResolver(ctx))`.
3. Otherwise the bytes are connector-authored opaque state from a sign-in:
   `connector = ctx.connectors.get(id, { state_ref: connection.secret_refs[0] })`;
   require `manifest().auth_modes` to include `sign_in` or `oauth`, else
   refuse `state envelope does not match connector auth modes`; `await
connector.connect(stateResolver)` where `stateResolver` answers exactly
   `connection.secret_refs[0]` with the UTF-8 decoded bytes and throws
   `secret_ref not granted to this connection` for any other ref. The
   connector never learns a filesystem path; the host never parses its
   bytes.

The `{ state_ref }` factory argument plus `connect(resolve)` is the host→
connector hand-off convention for sign-in connectors. No sign-in connector
exists on main; the fixture in §9 implements it and the connector lanes
must follow it (open question flagged in the result).

`backfill`, `sync`, `import`, `doctor` obtain their connector only through
`connectorFor`. `--source` for a sign-in connection is its `source_key`
(a ULID); `kizuki connect --list` (§4.3) shows them.

## 3. Serving from the CLI (owner principal)

Every read verb in §5 builds `ServeContext { db, vaultPath, principal: OWNER }`
(NEW, serving-mcp §1, `packages/core/src/serving/`) and calls the serving
function; the CLI never calls `search()`, `timeline()` or `neighbors()`
directly. The owner's ceiling is `private`, but the gate still denies
unlabeled pages and unhinted events (`missing_sensitivity`), held pages and
archived pages — the CLI reports how many were withheld instead of pretending
they do not exist. Owner calls are audited under agent id `owner` (core
already does this); `kizuki agent audit owner` shows them.

Rendering rules shared by §5 (put them in `output.ts`):

- Every string that originated in captured text or connector output —
  snippets, quoted text, titles, `display`, health `detail` — passes through
  `sanitize` from `@kizuki/tui` before it reaches a terminal (rule 6 of
  `cli-terminal-ux`); `truncate` long quoted text at 400 columns.
- `--json` prints the envelope as one JSON object on one line (it is a single
  structured document, not a list). Human output prints canon and quoted
  hits on stdout and a footer on stderr:
  `denied=<n> (<reason>:<count> ...)` — only when `n > 0`.

## 4. `connect` — the sign-in path

### 4.1 Terminal `SignInIo` (`packages/cli/src/signin-io.ts`, NEW)

```ts
export interface TerminalIoOptions {
  stdin?: NodeJS.ReadStream; // default process.stdin
  stderr?: NodeJS.WritableStream; // default process.stderr
  launcher?: (url: string) => Promise<void>; // default: platform launcher below
}
export function terminalSignInIo(opts?: TerminalIoOptions): SignInIo;
// throws Error("sign-in needs an interactive terminal") unless stdin.isTTY,
// stderr.isTTY and stdin.setRawMode exist.
```

- `prompt(question, { secret })`: writes `sanitize(question).slice(0, 512) + " "`
  to stderr. Non-secret: `node:readline/promises` `createInterface({ input:
stdin, output: stderr, terminal: true }).question("")`. Secret: raw mode on,
  accumulate bytes until CR/LF; `0x7f`/`0x08` delete the last code point;
  `0x03` (Ctrl-C) or `0x04` (Ctrl-D) → restore the terminal and throw
  `Error("sign-in cancelled")`; nothing is echoed; write `\n` to stderr when
  done; cap input at 4096 bytes. Raw mode is always restored (`finally`).
- `notify(text)`: `sanitize(text)` + `\n` to stderr.
- `openUrl(url)`: parse with `new URL`; only `https:` is launched — anything
  else is notified as `refusing to launch a non-https url` and the call
  resolves. Always notify `open this url in your browser: <url>` first, then
  call the launcher: `Bun.which("xdg-open")` on linux, `open` on darwin,
  `cmd /c start "" <url>` on win32, spawned with all stdio ignored and not
  awaited; a missing launcher or spawn failure is silent because the URL is
  already on screen. Resolves once handed off.

Prompt text and URLs come from connector code and provider config; they are
treated as untrusted display data, never executed through a shell.

### 4.2 Grammar and behavior

```
kizuki connect <connector> [--source PATH] [--secret NAME=env:VAR|file:PATH]...   # none / secret_ref modes (cli-verbs)
kizuki connect <connector> [--source <source_key> | --new]                       # sign_in / oauth modes (this lane)
kizuki connect --list [--json]                                                   # §4.3
```

Mode is decided by the connector's `manifest().auth_modes` (instantiate via
`ctx.connectors.get(id)` without config; for `none`-mode connectors keep
cli-verbs' construction with `--source`). When the manifest includes
`sign_in` or `oauth`:

1. Refuse `--source PATH`-style arguments that are not a ULID and refuse
   `--secret` (usage, exit 2). Refuse when `ctx.signInIo()` throws (not a
   TTY): `error: sign-in needs an interactive terminal`, exit 1, nothing
   persisted.
2. Print to stderr, before any prompt: `signing in to <connector_id>; press
Ctrl-C to cancel; nothing is stored until sign-in succeeds` (rule from
   `packages/cli/AGENTS.md`: provider, destination and cancellation path are
   clear). The vault path is the destination; print it.
3. Enrollment vs re-authentication:
   - `--new`, or no active connection for this connector →
     `enrollConnection(db, store, connector, io)`.
   - exactly one active connection and no `--new` →
     `store.replace(db, connection, connector, io)` (keeps the `source_key`,
     swaps the state file atomically; core refuses when the existing row has
     no state — surface that message and suggest `--new`).
   - several active connections and no `--source`/`--new` → `error: several
connections for <id>; pass --source <source_key> or --new`, exit 1.
   - `--source <source_key>` → `replace` on that row (`getConnection`; unknown
     → exit 1).
4. On success call `connector.health()` and print to stdout:
   `connected <connector_id> source=<source_key> display=<sanitized display> health=<state>`.
   Exit 0 when `state === "ok"`; otherwise also print
   `health detail: <sanitized detail>` to stderr and exit 1 — the row and
   state are kept (the sign-in succeeded; credentials exist), the owner is
   told to retry `sync` or `connect` again.
5. On any throw from `signIn`/`enrollConnection`/`replace`: core has already
   discarded pending state; print `error: sign-in failed: <message>` and exit
   1. The message is connector-authored → `sanitize`. Never print prompt
      answers, state bytes, or the state path.

`display` is ephemeral (`SignInDisplay` docstring): printed once, never
stored, never re-derived.

### 4.3 `connect --list [--json]`

Host-minted keys are opaque, so the owner needs a way to see them:
`listConnections(db)` → table `connector_id  source_key  connected_at  state`
where `state` is `opaque` (sign-in bytes), `host` (host envelope) or `none`
(no state), decided exactly as `connectorFor` does but without constructing
a connector. `--json` = NDJSON of `{ connector_id, source_key, connected_at,
state }`. No display, no refs, no paths.

## 5. Serving verbs

All run `ensureDerived(ctx)` first (§1.2), then serve as OWNER (§3).

### 5.1 `query <text> [--scope canon|ledger|all] [--limit N] [--type T]... [--since TS] [--until TS] [--subject S]... [--json]`

Replaces cli-verbs' substring scan with `serveSearch(ctx, { query, scope,
limit, types, subjects, since, until })` (NEW, serving-mcp §1). Default scope
`canon`; `--limit` default 20, max 50 (serving caps at 50). Human output, one
hit per block:

```
canon <relPath>  <sensitivity>  <title>
  <snippet>
quoted <event_id>  <connector_id>  <occurred_at>
  <text>
```

Exit 0 with empty stdout when nothing matched. The FTS token grammar is
core's (`toFtsQuery`); do not pre-process the text.

### 5.2 `rebuild [--json]`

`rebuildDerived(db, vaultPath)`; prints

```
search pages=<n> events=<m> rebuilt_at=<ts>
graph pages=<n> edges=<e> rebuilt_at=<ts>
```

A `listCanonPages` failure (a note without a string `id`) is reported as
`error: <message>` exit 1 — that is main's behavior until derived-fixes
lands; `doctor` names the page.

### 5.3 `timeline [--day YYYY-MM-DD] [--since TS] [--until TS] [--subject S] [--limit N] [--json]`

`serveTimeline(ctx, { day, since, until, subject, limit })` (NEW). Lines:
`<occurred_at>  <connector_id>  <kind>  <event_id>` then the sanitized text
indented. `--limit` default 100. Footer per §3 — unhinted events are denied
to the owner too; say so: `denied=<n> (missing_sensitivity:<n>)`.

### 5.4 `entity <name> [--type person|org|project|place|topic] [--limit N] [--json]`

`serveEntities(ctx, { name, type, limit })` (NEW). Lines:
`<relPath>  <type>  <sensitivity>  <title>`.

### 5.5 `context [--query Q] [--subject S]... [--budget N] [--include canon,timeline,graph] [--json]`

`serveContextPacket(ctx, { query, subjects, budget_tokens, include })` (NEW).
Prints `data.packet_md` to stdout and nothing else; exit 0 even when the
packet is empty (this is what a harness hook pipes into its context; serving
already fails closed to an empty packet). `--budget` default 450, integer in
`[1, 2000]`, else usage exit 2. Configuration errors (no vault) stay `error:`
exit 1 — a hook can `|| true`; the CLI does not lie about a missing vault.

### 5.6 `graph <page_id> [--depth 1|2] [--kind wikilink|subject|source]... [--json]`

`serveGraph(ctx, { id, depth, kinds })` (NEW). Lines: `<src> -> <dst>  <kind>`
from `data.edges`; footer per §3 (edges to non-servable pages are counted,
not shown).

## 6. `mcp`

```
kizuki mcp --owner
kizuki mcp --agent <name> --token env:VAR|file:PATH
```

- `--owner` with `--agent`/`--token`, or `--agent` without `--token` (and
  vice versa), or a `--token` that is not `env:`/`file:` → usage, exit 2,
  message `--token must be env:VAR or file:PATH (a bare token would land in
shell history)`. Parse with `parseSecretRef` (on main); resolve with
  `hostSecretResolver` (§2) — same rules: absolute path, mode 0600.
- `principal = authenticate(db, token)`; `null` → `error: token rejected
(unknown, malformed, or revoked)` exit 1, stdout untouched, no server
  started. `principal.agent.name !== --agent` → `error: token belongs to a
different agent` exit 1 (explicit identity is a cross-check against a
  mis-wired harness config).
- `--owner` → `OWNER` from core.
- `ensureDerived(ctx)` (its note goes to stderr), then
  `await runStdio({ db, vaultPath, principal })` (NEW, `@kizuki/mcp`,
  serving-mcp §2). stdout is the protocol channel: `main.ts` must print
  nothing for this verb on success; the process exits 0 when the transport
  closes.
- `packages/cli/package.json` gains `"@kizuki/mcp": "workspace:*"`.

README registration snippet (generic; "your MCP client", no harness names):

```json
{
  "mcpServers": {
    "kizuki": {
      "command": "kizuki",
      "args": ["mcp", "--agent", "ada", "--token", "env:KIZUKI_TOKEN_ADA"],
      "env": { "KIZUKI_TOKEN_ADA": "kzk_..." }
    }
  }
}
```

## 7. `agent`

```
kizuki agent add <name> [--ceiling public|personal|private] [--tools a,b] [--types a,b] [--subjects a,b] [--since TS] [--until TS] [--rate N] [--json]
kizuki agent list [--json]
kizuki agent grant <name> (--ceiling C | --tools L | --types L|all | --subjects L|all | --since TS|none | --until TS|none | --rate N)...
kizuki agent revoke <name>
kizuki agent rotate <name> [--json]
kizuki agent audit <name|owner> [--limit N] [--since TS] [--json]
```

- Flag → `Partial<Grant>`: comma lists split and trimmed; `--tools` entries
  must be in `TOOLS` (core validates too); `all` for `--types`/`--subjects`
  and `none` for `--since`/`--until` map to `null`; `--rate` integer ≥ 1.
  Core's `TypeError`/`Error` messages surface as `error: <message>` exit 1.
- `add` → `addAgent(db, name, patch)`. stdout:
  `agent=<name> agent_id=<ulid>` then `token=<kzk_...>`; stderr: `store this
token now; it is not shown again`. `--json`: one object
  `{ name, agent_id, token, grant }`. The token is the only secret the CLI
  ever prints, and only here and in `rotate`.
- `list` → `listAgents`; table `name  ceiling  tools  rate/min  created_at
revoked_at`; `--json` NDJSON of `Agent & { grant }`. Never token hashes.
- `grant` → `setGrant(db, name, patch)`; at least one flag, else usage exit
  2; prints the resulting grant as `key=value` pairs (`--json` prints it).
- `revoke` → `revokeAgent`; prints `agent=<name> revoked=true`; a second
  call is a no-op with the same output (core keeps the first `revoked_at`).
- `rotate` → `rotateToken`; same output shape as `add`; the old token is
  rejected from that moment.
- `audit` → `listAudit(db, name, { limit: N ?? 50, since })`; table
  `at  tool  served  denied  reasons` where `reasons` is the denied-reason
  histogram `reason:count` joined by spaces; `--json` NDJSON of `AuditRow`
  verbatim (query shapes are already hashed by core).

## 8. `doctor` additions

Append to the existing report (and to `--json`):

```
derived search rebuilt_at=<ts|never> docs=<n>
derived graph rebuilt_at=<ts|never> edges=<n>
agents=<n> revoked=<m>
connection_state_pending=<k>
```

- Derived facts from `readDerivedMeta` (§1.4). `never` with pages or events
  present is informational (`hint: run kizuki rebuild, or any query builds
it`), not an exit-1 problem — incremental indexing after promote/sync does
  not touch `rebuilt_at`, so a stale judgment would be a guess.
- Agent counts from `listAgents`.
- `connection_state_pending` counts `*.journal`, `*.tmp` and `*.rollback`
  entries in `<vault>/.kizuki/connections/` (an interrupted swap that the
  next enrollment will repair); `> 0` → `problem connection-state: <k>
interrupted swap file(s); run: kizuki connect <connector>` and exit 1.
- Per-connection health (cli-verbs) now goes through `connectorFor` (§2); a
  connection whose state file is missing is reported as
  `problem connection <connector_id> <source_key>: state missing` with exit 1
  (core's `LedgerError` message, not a path).

## 9. Tests

`packages/cli/test/` (subprocess seam with `Bun.spawnSync` like the existing
e2e; in-process where a TTY or a fixture connector is needed). Every test
uses `mkdtempSync` vaults and `XDG_CONFIG_HOME`/`KIZUKI_CONFIG` pointed at a
temp dir.

- `helpers/fixture-connector.ts`: a `sign_in` connector following §2's
  convention — `signIn(io, state)` consumes scripted prompts (`phone`,
  `code` secret), writes `state.write(utf8("session:<code>"))`, returns
  `{ display: "ada [31m<script>" }`; the factory accepts
  `{ state_ref }`; `connect(resolve)` resolves that ref and records the
  decoded state; `health()` is `ok` after sign-in/connect, `disabled`
  before; `backfill` emits two synthetic events.
- `connect-signin.test.ts` (in-process, injected `ctx.connectors` and
  `ctx.signInIo`): enrollment creates one row with a ULID `source_key`,
  `config.state_ref_index === 0`, a 0600 file under `.kizuki/connections/`;
  stdout line matches `connected fixture source=<ulid> display=ada <script>
health=ok` (escape stripped); the secret answer never appears in stdout,
  stderr, the state file name or the raw database bytes; `signIn` throwing
  leaves no row and an empty `connections/` dir; a second `connect` keeps
  the `source_key` and replaces the state bytes (`store.read`); `--new`
  makes a second row; two rows and no `--source`/`--new` → exit 1 with the
  documented message; `signInIo()` throwing (non-TTY) → exit 1 with
  `sign-in needs an interactive terminal` and nothing persisted; `connect
--list` shows `opaque` for the sign-in row and `host` for a
  markdown-folder row; `backfill fixture` materializes the connector through
  `connectorFor` and the fixture saw exactly its own ref (a request for any
  other ref throws).
- `signin-io.test.ts`: `terminalSignInIo` refuses without a TTY; with a fake
  stream pair marked TTY, secret prompt echoes nothing and honors backspace;
  Ctrl-C throws `sign-in cancelled` and raw mode is restored; `openUrl`
  refuses `http:` and `javascript:` and calls the injected launcher for
  `https:`; prompt text with control sequences is sanitized.
- `query.test.ts`: init → import markdown-folder → `rebuild` → promote
  (personal) → `query <phrase>` prints the `canon` line without another
  rebuild (proves `indexPromotedPage`); add a file → `sync` → `query --scope
ledger` prints the `quoted` line without a rebuild (proves the hook); a
  hand-written page without `sensitivity` is never returned and the footer
  says `denied=1 (missing_sensitivity:1)`; an archived page (deletion
  promoted) is not returned; a held page (after `purge`) is not returned; a
  captured text containing `[2J` reaches stdout stripped; `--json`
  prints one object with `canon`, `quoted`, `denied`; on a fresh vault the
  first `query` writes the `derived layers built (first run)` note to stderr
  and exits 0.
- `serving-verbs.test.ts`: `timeline --day`, `entity`, `graph --depth 2`
  and `rebuild` render the documented lines; `timeline` footer counts an
  unhinted event.
- `context.test.ts`: packet within budget (`tokens_estimate <= budget` from
  `--json`; stdout of the human form equals `packet_md`); markers present;
  empty vault → empty stdout, exit 0; `--budget 0` → exit 2.
- `agent.test.ts`: `add` prints `token=kzk_` once and the warning on stderr;
  the token substring is absent from the raw database file after close;
  `list` hides hashes; `grant --types person --rate 3` round-trips; `rotate`
  invalidates the old token (`mcp --agent ... --token env:OLD` exits 1);
  `revoke` → `mcp` exits 1 with `token rejected`; `audit`: run `query` as
  owner → `agent audit owner` shows a `search` row whose output does not
  contain the query text; drive `mcp --agent ada` with a `tools/call search`
  frame → `agent audit ada` shows one `search` row.
- `mcp.test.ts`: spawn `mcp --owner --vault <tmp>`, write `initialize`,
  `notifications/initialized`, `tools/list` JSON-RPC frames, assert the
  eight tool names, close stdin, exit 0, nothing but JSON-RPC on stdout;
  bare `--token kzk_x` → exit 2; `--token env:MISSING` → exit 1; `--agent
grace` with ada's token → exit 1 `belongs to a different agent`; a
  world-readable `file:` token → exit 1.
- `doctor.test.ts`: the four new lines appear; a stray `x.journal` under
  `.kizuki/connections/` → `problem connection-state` and exit 1; deleting a
  sign-in row's state file → `problem connection ... state missing` exit 1.
- `help.test.ts` (extend): the registry is exactly the twenty verbs in the
  Objective, in that order.
- `packages/core/test/ingest.test.ts` (extend): `onStored` fires once per
  stored event including a tombstone, never for a duplicate or an invalid
  event; a throwing hook propagates from `runBackfill` and the checkpoint is
  unchanged.
- `packages/core/test/derived.test.ts` (extend): `readDerivedMeta` is
  `{ search: null, graph: null }` on a fresh db and mirrors `rebuildDerived`
  afterwards; `packages/core/test/index.test.ts` lists `readDerivedMeta`.

## 10. README

Update "Try it (pre-alpha)": the serving verbs with one line each; the agent
flow `agent add → agent grant → mcp` with the registration snippet from §6;
a paragraph "What an agent sees": canon only, sensitivity ceiling, quoted
capture marked `tainted`, every call audited (`kizuki agent audit <name>`),
one write tool (`propose`). Replace the sentence claiming the MCP layer is
"not built yet". State that `kizuki connect` carries an interactive sign-in
path and that no sign-in connector is in the tree yet — claim nothing that
does not run. Keep the neutral fixture names (`ada`, `grace`, `acme`).

## Non-goals

`serve` (daemon, scheduler, standing HTTP MCP, notifiers); embeddings; the
sign-in connectors themselves (telegram, google, whoop, x) and the OAuth
loopback helper (`packages/core/src/auth/oauth.ts`, oauth-signin lane, not
on main); `secret_ref`-mode persistence beyond the host envelope in §2;
graph incremental indexing; a true index-staleness judgment; RFC 0001
`wm_*` tables; Composio and WhatsApp Business (deferred by decision). No
change to `kizuki.event/v1`, `kizuki.proposal/v1`, `kizuki.connector/v1`,
the `connections` CHECK constraints or any migration.

## Runtime dependencies

No new third-party package. `packages/cli/package.json` adds the workspace
dependency `@kizuki/mcp`, which transitively brings the two runtime packages
serving-mcp introduced (`@modelcontextprotocol/sdk`, `zod`) into the CLI
binary; `@kizuki/core` stays dependency-free. `node:readline` is stdlib. No
`fetch`, `Bun.serve`, sockets or network modules anywhere in `packages/**`
(`scripts/verify-network.ts` scans every tracked source file and is part of
`bun run verify`); the browser launcher is a detached `Bun.spawn` of a local
program with a validated `https:` argument.

## Acceptance

```
bun run typecheck && bun test                      # green; ≥ 45 new tests across packages/cli/test and the two core test files
bun run verify                                     # the full repository gate: install --frozen-lockfile, typecheck, test, policy tests, network scan, denylist on tracked text and reachable commit messages
bun packages/cli/src/main.ts help | grep -E '^  [a-z]+' | wc -l              # 20
bun packages/cli/src/main.ts help | grep -E '^  (init|connect|backfill|sync|import|review|promote|reject|query|timeline|entity|context|graph|doctor|rebuild|purge|export|agent|mcp|version)\b' | wc -l   # 20
bun packages/cli/src/main.ts ingest; echo $?       # usage on stderr, prints 2
V=$(mktemp -d)/vault && bun packages/cli/src/main.ts init "$V" --no-default && \
  printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"acme","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | bun packages/cli/src/main.ts mcp --owner --vault "$V" | grep -o '"name":"[a-z_]*"' | sort -u | wc -l   # 8
bun packages/cli/src/main.ts mcp --agent ada --token kzk_notasecretref --vault "$V"; echo $?             # usage message about env:/file:, prints 2
KIZUKI_TOKEN_ADA=kzk_bogus bun packages/cli/src/main.ts mcp --agent ada --token env:KIZUKI_TOKEN_ADA --vault "$V" | wc -c; echo ${PIPESTATUS[0]}   # 0 bytes on stdout, exit 1
bun packages/cli/src/main.ts agent add ada --vault "$V" | grep -c '^token=kzk_'                             # 1
bun packages/cli/src/main.ts query kettle --vault "$V"; echo $?                                             # empty stdout, "derived layers built (first run)" on stderr, prints 0
bun packages/cli/src/main.ts context --vault "$V" | wc -c; echo ${PIPESTATUS[0]}                            # 0 bytes, exit 0
bun packages/cli/src/main.ts connect markdown-folder --vault "$V" < /dev/null; echo $?                      # cli-verbs path unchanged: needs --source, exit 1 or 2 as cli-verbs defined; never "needs an interactive terminal"
bun packages/cli/src/main.ts doctor --vault "$V" | grep -cE '^(derived (search|graph) rebuilt_at=|agents=|connection_state_pending=)'   # 4
bash scripts/quickstart.sh                         # only when the ci-hardening lane has landed the script; then it must print QUICKSTART_OK. Otherwise state in the handoff that it is absent.
git status --porcelain                             # empty
```
