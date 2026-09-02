# Lane: core-spine — checkpoints, connections, ingest runner, promote kinds, purge cascade, export

Package: `packages/core` only (plus its tests). Read CONVENTIONS.md first.

## Objective

Close the Wave 1 core gaps so the CLI can offer the full v1 verb set:
persisted connector connections + checkpoints, one shared ingest runner,
promotion for every proposal kind, a purge cascade that reaches staging and
canon, and an export dump.

## 1. Ledger schema migration v2 (`packages/core/src/ledger/db.ts`)

Add migration `version: 2` creating:

```sql
CREATE TABLE connections (
  connector_id TEXT PRIMARY KEY,
  config       TEXT NOT NULL,      -- JSON, connector-specific, never plaintext secrets
  secret_refs  TEXT NOT NULL,      -- JSON array of secret_ref URIs (env:/file:)
  connected_at TEXT NOT NULL,
  disconnected_at TEXT
) STRICT;

CREATE TABLE checkpoints (
  connector_id TEXT PRIMARY KEY,
  cursor       TEXT,               -- opaque; NULL = exhausted / never run
  mode         TEXT NOT NULL,      -- 'backfill' | 'sync'
  updated_at   TEXT NOT NULL,
  last_run_at  TEXT NOT NULL,
  last_result  TEXT NOT NULL       -- JSON {stored, duplicates, errors, proposals_created, withdrawn}
) STRICT;

CREATE TABLE canon_holds (
  page_path   TEXT NOT NULL,       -- vault-relative
  proposal_id TEXT NOT NULL,       -- the purge_review proposal that lifts the hold
  reason      TEXT NOT NULL,
  held_at     TEXT NOT NULL,
  PRIMARY KEY (page_path, proposal_id)
) STRICT;
```

Test: opening a v1 database upgrades to v2 and keeps existing rows; opening
a v2 database is a no-op (extend the existing migration tests).

## 2. Connections + checkpoints API (`packages/core/src/ledger/connections.ts`)

```ts
export interface Connection {
  connector_id: string;
  config: Record<string, unknown>;
  secret_refs: string[];
  connected_at: string;
  disconnected_at: string | null;
}
export function saveConnection(
  db,
  connector_id,
  config,
  secret_refs,
): Connection;
export function getConnection(db, connector_id): Connection | null;
export function listConnections(
  db,
  opts?: { includeDisconnected?: boolean },
): Connection[];
export function disconnect(db, connector_id): void; // sets disconnected_at, keeps config for purge planning
export interface Checkpoint {
  connector_id;
  cursor: string | null;
  mode: "backfill" | "sync";
  updated_at;
  last_run_at;
  last_result: RunResult;
}
export function saveCheckpoint(
  db,
  connector_id,
  cursor,
  mode,
  result: RunResult,
): Checkpoint;
export function getCheckpoint(db, connector_id): Checkpoint | null;
export function listCheckpoints(db): Checkpoint[];
```

Refuse to save a config containing a value that looks like a plaintext
secret: any string value ≥ 20 chars matching `/^(sk-|ghp_|xox[abp]-|AKIA)/`
or any key named `token|password|secret|api_key` whose value is not a
`secret_ref` URI (`env:` or `file:` prefix) → throw `LedgerError("plaintext
secret refused")`. Test it.

## 3. Ingest runner (`packages/core/src/ingest/run.ts`)

One code path for CLI today and the daemon later:

```ts
export interface RunResult {
  stored: number;
  duplicates: number;
  errors: string[];
  proposals_created: number;
  withdrawn: number;
  cursor: string | null;
}
export function runBatch(db, batch: SyncBatch): RunResult;
// accept() every event; on 'stored': if deleted → withdrawForTombstone, else proposalsForEvent → fileProposal (count 'stored' outcomes only); errors collected, never thrown
export async function runBackfill(
  db,
  connector: Connector,
  connector_id: string,
): Promise<RunResult>;
// connector.backfill(null); runBatch; saveCheckpoint(mode 'backfill')
export async function runSync(
  db,
  connector: Connector,
  connector_id: string,
): Promise<RunResult>;
// getCheckpoint → connector.sync(cursor ?? null); runBatch; saveCheckpoint(mode 'sync')
```

The runner is the ONLY place that composes accept + staging; move the loop
currently duplicated in `packages/cli/src/main.ts` (the `ingest` verb) into
here (do not edit the CLI in this lane — the CLI lane will switch to it).
Tests: fixture connector round-trip; second backfill = all duplicates, zero
proposals; a tombstone withdraws; errors are collected and counted; the
checkpoint row reflects the last run.

## 4. Promotion for every kind (`packages/core/src/staging/promote.ts`)

Today `promote` mints new pages only. Implement all `PROPOSAL_KINDS`:

- `entity`, `claim` (new page): as today. Additionally, if the target page
  already exists, refuse with the existing message (unchanged behavior).
- `edit` (replace body): target page MUST exist, else `PromoteError`. New
  content = existing frontmatter (`id` preserved; `sources` = sorted union
  of existing sources and proposal provenance; proposal frontmatter keys
  overlay, reserved keys still refused) + proposal body (or `editBody`).
  Written with `writePage(path, page, { revision: true })` so the previous
  revision lands in `archive/`.
- `merge` (append): target MUST exist. Body = existing body + `\n\n` +
  proposal body. Same frontmatter treatment as edit.
- `deletion`: target MUST exist. Move the file to
  `archive/<stem>.deleted-<ms>.md` with `status: archived` set in its
  frontmatter, then the original path no longer exists. Uses the vault
  layer: add `archivePage(path): string` to `packages/core/src/vault/write.ts`
  (returns archive path) so promote stays the only caller of vault writes.
- `purge_review`: target MUST exist. Rewrite the page with `sources` minus
  the proposal's provenance ids (the purged event ids), body = `editBody` if
  the owner supplied one else the existing body, revision write. Then
  delete the matching `canon_holds` row(s) for that page in the same
  transaction as the promotions row.

Sensitivity: for new pages `opts.sensitivity` is required (as now). For
edit/merge/deletion/purge_review, `opts.sensitivity` is optional and
defaults to the existing page's label; if the existing page has no valid
label AND none was supplied → `PromoteError` (fail closed).

Receipt (`PromotionReceipt`) gains `kind: ProposalKind`, `before_hash:
string | null` (sha256 of the prior file content, null for new pages) and
`after_hash` (rename of `page_hash`; keep `page_hash` out — update the
promotions table via migration v2: add columns `kind TEXT NOT NULL DEFAULT
'claim'`, `before_hash TEXT`; rename by adding `after_hash` and copying).
The JSONL receipts log line carries the same fields.

Crash ordering stays: file write → JSONL receipt → DB row. Keep the
existing "invokedBy owner" gate and its tests untouched.

Tests (extend `packages/core/test/staging/promote.test.ts`): each kind
happy path; edit/merge/deletion/purge_review refuse a missing target; edit
preserves `id` and unions `sources`; deletion leaves an archived copy with
`status: archived` and no original; purge_review lifts the hold; default
sensitivity inheritance and fail-closed when the page is unlabeled; receipt
hashes before/after are correct sha256 of file contents.

## 5. Purge cascade (`packages/core/src/ledger/purge.ts`)

`purgeEvents(db, filter, reason)` becomes
`purgeEvents(db, vaultPath, filter, reason): PurgeOutcome`:

```ts
export interface PurgeOutcome {
  receipts: PurgeReceipt[];
  withdrawn_proposals: string[];
  canon_holds: { page_path: string; proposal_id: string }[];
}
```

Inside one transaction: (1) as today, delete events + insert receipts;
(2) withdraw every pending proposal whose provenance intersects the purged
ids (reuse `withdrawForTombstone` semantics); (3) scan the vault's canon
pages (reuse the walker pattern in `vault/doctor.ts`, extract to
`vault/pages.ts` as `listCanonPages(vaultPath): { path, relPath, data, body }[]`)
and for every page whose `sources` intersects the purged ids: file a
proposal `{ kind: 'purge_review', target: <page id>, body: existing body,
frontmatter: {}, provenance: <purged ids on that page>, producer:
'deterministic', confidence: 1 }` (bypass suppression; `target` here is the
page's frontmatter `id`, and `pageRelPath` must map an id-target back to
that page — extend `pageRelPath` to accept an optional lookup so an id that
matches an existing page id resolves to that page's path; add
`findPageById(vaultPath, id)` in `vault/pages.ts`) and insert a
`canon_holds` row `(page_path, proposal_id, reason)`.
Also delete `search_docs` rows for purged events if that table exists
(`SELECT name FROM sqlite_master WHERE name='search_docs'`) — a sibling lane
adds it; guard with the existence check so this lane stays independent.

`readHolds(db): CanonHold[]` and `isHeld(db, page_path): boolean` exported.

Tests: purge withdraws open proposals citing the event and leaves others;
purge of an event cited by a promoted page files exactly one purge_review
proposal targeting that page and one hold; re-running purge with no matches
files nothing; the promoted page is unchanged on disk until the owner acts.

## 6. Export dump (`packages/core/src/export.ts`)

```ts
export function exportVault(db, vaultPath, outDir): ExportManifest;
```

Writes into `outDir` (must not exist or must be empty; refuse otherwise):
`vault/` (recursive copy of every file except `.kizuki/`), `ledger/events.jsonl`
(every event via `replay`), `ledger/event_purges.jsonl`,
`staging/proposals.jsonl` (all statuses), `staging/promotions.jsonl`,
`staging/rejections.jsonl`, `connections.jsonl` (config + secret_refs only —
never resolved secrets), `checkpoints.jsonl`, and `manifest.json` with
counts per file and a sha256 per written file. Return the manifest. Tests:
manifest counts match; every listed sha256 matches the file; `.kizuki/` is
not copied; refusal on a non-empty outDir.

## 7. Exports

Export every new public function/type from `packages/core/src/index.ts`
(and `@kizuki/core/staging` where it belongs). Update the
`re-exports every runtime value` test if it enumerates exports.

## Acceptance

```
bun run typecheck            # exit 0
bun test                     # all green; ≥ 25 new tests in packages/core/test
scripts/verify.sh must stay green (denylist produces no output)
git status --porcelain       # empty
```
