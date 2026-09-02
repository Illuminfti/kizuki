# Lane: derived-fixes — confirmed review findings on search, graph, timeline, pages

Package: `packages/core` only — `src/search/`, `src/graph/`, `src/query/`,
`src/vault/pages.ts`, `src/vault/doctor.ts`, `src/derived.ts`,
`src/ledger/purge.ts`, one call-site line in `src/staging/promote.ts` (it
already calls `findPageById`; its behavior changes, its text does not), the
public surface in `src/index.ts`, and their tests. Reconciled against main
at `76930db` (515 tests green, `bun test` 4.1 s). Read CONVENTIONS.md first,
then `docs/architecture.md` (invariants 2, 5, 7, 8), `rfcs/0001-deep-model-
arbitration.md` ("sensitivity lattice with an explicit bottom"; "universal
provenance keeps purge computable"), workspace ARCHITECTURE.md §0 (invariants
2, 5, 8), §7 (derived layers), §8.1 (enforcement at the query engine), §8.3
(timeline), §12 (rebuild equivalence as a test), and every file named above
plus `src/agents/types.ts` (`SENSITIVITY_ORDER`, `Sensitivity`),
`src/util/time.ts` (`isRfc3339`), `src/ledger/ledger.ts` (`replay` yields
events `ORDER BY accepted_at, event_id`), `src/vault/frontmatter.ts`
(`parseFrontmatter` throws `SyntaxError`), `packages/core/AGENTS.md`.

Every item below was re-reproduced on today's main with an inline script
(numbers quoted are from that run). Each keeps a regression test that fails
before the change and passes after; run it both ways and say so in the
commit body. No CLI verb or flag changes; no MCP; no new runtime dependency
(`@kizuki/core` stays dependency-free).

## Already on main (dropped from the old spec; do not redo)

- **Purged events leave the derived layers.** `purgeEvents` calls
  `removeDoc` for every purged id and deletes `graph_edges WHERE src = ? OR
dst = ?` inside its transaction (commit `dcf0d4a`); covered by
  `test/purge.test.ts` "removes matching derived search and graph rows
  through real schemas". `removeDoc` is no longer unused. What remains of
  the old item 5 is folded into §3 (every delete now carries `scope`).
- **Timeline windows compare instants.** `query/timeline.ts` has
  `OCCURRED_AT_INSTANT` (`julianday` over a normalized column; lowercase
  `t`/`z` and the leap second handled) for `day`/`since`/`until` (commit
  `dbd92ad`). What remains is the `ORDER BY`, the unvalidated bounds, and
  reuse of that expression by `search()` (§1, §2, §5).
- **One vault reader for search, graph and purge.** `listCanonPages` /
  `findPageById` in `vault/pages.ts` are used by `search/indexer.ts`,
  `graph/graph.ts`, `ledger/purge.ts` and `staging/promote.ts`
  (reconcile-core rule 8). Only `vault/doctor.ts` still walks on its own
  (§4).
- **Exports.** `CanonPage`, `listCanonPages`, `findPageById` and the
  `Sensitivity` type are exported from `src/index.ts`; the public-surface
  test lists them. Only the NEW names of this lane need adding (§9).

## Still true on main (confirmed by reproduction)

| #   | Finding                                                                                                      | Evidence on main                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sanitizeToken` deletes `-`, `:`, `^`, `+`, `~` and brackets inside a token; control characters pass through | `toFtsQuery("2026-02-03")` → `"20260203"`; `"person:ada"` → `"personada"`; `"e-mail"` → `"email"`; `"10:30"` → `"1030"`; a NUL in the query makes `search()` throw `SQLiteError: unterminated string`                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | `bm25(search_docs, 4.0, 1.0)` weights `doc_id` and `scope` (UNINDEXED); title and body both get 1.0          | the term in one title vs. one body ties at `-0.00000116`, order falls to `doc_id` (body doc first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3   | `search()` `since`/`until` compare raw strings                                                               | `2026-02-02T23:30:00-02:00` (= 01:30Z) is dropped from a `since: 2026-02-03T00:00:00Z` window; canon (`occurred_at = ''`) is dropped by any `since`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | `timeline` `ORDER BY occurred_at` is the raw string; bounds unvalidated                                      | events at 23:30-02:00, 00:30Z, `02:00:00z` come back in that order; `since: "garbage"` returns `[]` silently; the leap-second test enshrines `[23:59:60Z, 12:00Z]`                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | one malformed `.md` aborts every reader                                                                      | `facts/stray.md` without frontmatter: `listCanonPages`, `findPageById`, `rebuildSearch`, `rebuildGraph`, `purgeEvents` and `ownerPromote` (via `readExisting`) all throw `SyntaxError: frontmatter must begin with an exact --- line`                                                                                                                                                                                                                                                                                                                                       |
| 7   | `doc_id` collides across scopes                                                                              | indexing a canon page with the id of an indexed ledger doc deletes the ledger row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | `text_preview` slices UTF-16 units                                                                           | 159 × `x` + U+1F600 → preview ends in lone `0xD83D`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | `rebuildSearch` is O(n²) (per-doc `DELETE` on an UNINDEXED FTS5 column)                                      | 2000 events 588 ms, 4000 events 2240 ms, 6000 events 5073 ms; the same rows inserted directly: 17 / 33 / 51 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | `neighbors` loads the whole edge table per call and re-sorts with `localeCompare`                            | `graphEdges()` selects every row; fan-out unbounded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11  | duplication                                                                                                  | `stringArray` in `search/indexer.ts` and `graph/graph.ts`; `derived_meta` DDL and upsert in both `search/schema.ts`/`graph/schema.ts` and both rebuilds; `CEILING_RANK` + the `CASE` lattice in `search/query.ts` and `query/timeline.ts` while `SENSITIVITY_ORDER` exists in `agents/types.ts`; a second walker in `vault/doctor.ts`; `tempVault` in `test/search/helpers.ts` and `test/staging/helpers.ts`, `temporaryVault` in `test/purge.test.ts`, `writeCanon` in three tests; dead `scope: row.scope` (`search/query.ts:182`); edges counted twice in `rebuildGraph` |

## Objective

Make the deterministic floor (invariant 5) correct and rebuild-equivalent
(invariant 2) for real-world queries: literal dates/handles/times search as
typed, titles outrank bodies, time windows are instants everywhere, purge and
tombstones never leave a searchable ghost, one hand-written note never takes
the vault offline, and derived state is disposable at linear cost. Ceiling
enforcement stays in SQL (§8.1); unlabeled stays outside the lattice.

## 1. Shared SQL helpers — `src/query/sql.ts` (NEW)

One instant expression and one lattice expression, used by both `search()`
and `timeline()`. Nothing else in core may spell these out again.

```ts
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";

/**
 * `julianday(...)` over an RFC3339 column normalized the way the frozen event
 * contract allows: lowercase `t`/`z` upper-cased, a leap second `:60` mapped
 * to `:59.999` of its own minute. `column` MUST be a column reference; it is
 * substituted several times, so a `?` placeholder is not allowed here.
 */
export function instantSql(column: string): string;

/**
 * Validates a caller-supplied bound with `isRfc3339` (RangeError
 * `${label} must be an RFC3339 timestamp` otherwise) and returns the same
 * instant as `YYYY-MM-DDTHH:MM:SS.sssZ`, applying exactly the normalization
 * `instantSql` applies to a column, so `julianday(?)` on the result equals
 * `instantSql(column)` on the original string.
 */
export function instantBound(value: string, label: string): string;

/**
 * `CASE <column> WHEN 'public' THEN 0 WHEN 'personal' THEN 1 WHEN 'private'
 * THEN 2 ELSE NULL END <= ?` built from SENSITIVITY_ORDER (never a third
 * copy of the lattice). The caller binds `SENSITIVITY_ORDER[ceiling]`.
 * ELSE NULL is the explicit bottom: unlabeled never compares ≤ any ceiling.
 */
export function ceilingSql(column: string): string;
```

`instantSql` is today's `OCCURRED_AT_INSTANT` with the column parameterized;
move it, do not duplicate it. `instantBound` is ~10 lines of string work plus
`new Date(...).toISOString()`; it throws `RangeError`, never `TypeError`
(the derived layer's bound errors are `RangeError` like `validLimit`). Note
that `agents/time.ts` maps a leap second to the _next_ second for grant
windows; that module is out of scope — record the difference in a comment
where `instantBound` handles `:60`.

Both derived modules take `Sensitivity` from `../agents/types` (replace the
`PageSensitivity` import in `search/query.ts` and the `../staging/promote`
import in `query/timeline.ts`; the unions are identical, no caller changes).

## 2. Search query — `src/search/query.ts`

### 2.1 Token sanitizer (finding 1)

Every token is emitted as an FTS5 string literal, inside which operators and
punctuation are inert. Keep only what quoting cannot neutralize. Replace
`sanitizeToken` with this rule, in this order, per token from `tokens()`
(unchanged: quoted phrases stay one token, `""` inside quotes is a literal
quote):

1. Remove control characters: `/[\u0000-\u001f\u007f]/g` → `""` (write the escapes in source; never a raw byte).
2. Drop the token when its upper-case form is `AND`, `OR`, `NOT` or `NEAR`
   (a bare operator word; quoted it would demand the literal word).
3. A single trailing `*` on a token longer than one character marks a
   prefix query; remove every remaining `*`.
4. Drop the token when it contains no character matching `/[\p{L}\p{N}]/u`
   (the unicode61 tokenizer would reduce it to nothing).
5. Emit `"${value.replaceAll('"', '""')}"` plus `*` when prefixed.

`toFtsQuery` joins with a space (implicit AND). Zero usable tokens → `""`,
and `search()` returns `[]` without touching SQLite (unchanged). Exact
vectors the test asserts:

| input                | output                                               |
| -------------------- | ---------------------------------------------------- |
| `2026-02-03`         | `"2026-02-03"`                                       |
| `person:ada`         | `"person:ada"`                                       |
| `e-mail`             | `"e-mail"`                                           |
| `10:30`              | `"10:30"`                                            |
| `c++`                | `"c++"`                                              |
| `a` + U+0000 + `b`   | `"ab"` (and `search()` returns `[]`)                 |
| `"like this" other`  | `"like this" "other"`                                |
| `"say ""hello"""`    | `"say ""hello"""`                                    |
| `alpha OR beta`      | `"alpha" "beta"`                                     |
| `NEAR(beta gamma)`   | `"NEAR(beta" "gamma)"` (changed: literals are inert) |
| `alpha - ^ beta`     | `"alpha" "beta"`                                     |
| `"unfinished phrase` | `"unfinished phrase"`                                |
| `mid*dle`            | `"middle"`                                           |
| `prefix*`            | `"prefix"*`                                          |
| `*`                  | ``                                                   |
| `OR - ^`             | ``                                                   |

Verified on main's SQLite 3.53 FTS5: the literal `"2026-02-03"`,
`"person:ada"`, `"e-mail"`, `"10:30"` each hit a body containing that text
(the tokenizer reads them as adjacent-token phrases), and a
punctuation-only literal matches nothing.

### 2.2 Ranking (finding 2)

FTS5 `bm25()` weights are positional over every declared column, UNINDEXED
ones included. `search_docs` declares ten columns in this order — `doc_id`,
`scope`, `title`, `body`, `path`, `page_type`, `sensitivity`,
`occurred_at`, `connector_id`, `subjects` — so the call becomes
`bm25(search_docs, 0, 0, 4.0, 1.0, 0, 0, 0, 0, 0, 0) AS rank` with a
comment saying why there are ten numbers. `snippet(search_docs, 3, ...)`
already uses the positional body index and stays. `ORDER BY rank, scope,
doc_id`. Remove the dead `scope: row.scope` re-assignment in the row map.

### 2.3 Time window (finding 3)

Canon is timeless: a window applies to ledger documents only; canon
documents stay in `all`/`canon` scope results regardless of `since`/`until`
(`julianday('')` is NULL, so without the guard `since` silently drops all of
canon). With `sql.ts`:

```sql
-- since
(search_docs.scope = 'canon' OR <instantSql("search_docs.occurred_at")> >= julianday(?))
-- until
(search_docs.scope = 'canon' OR <instantSql("search_docs.occurred_at")> <  julianday(?))
```

binding `instantBound(opts.since, "search since")` /
`instantBound(opts.until, "search until")` — an invalid bound throws
`RangeError` before any SQL runs. The ceiling clause becomes
`ceilingSql("search_docs.sensitivity")` bound to
`SENSITIVITY_ORDER[opts.ceiling]`; `CEILING_RANK` is deleted.

`SearchOptions`/`SearchHit` keep their shape (`ceiling?: Sensitivity` now
names the agents type; `SearchHit.scope` uses `DocScope` from §3).

## 3. Search index — `src/search/indexer.ts`

### 3.1 Key on `(scope, doc_id)` (finding 7)

```ts
export type DocScope = "canon" | "ledger";
export function removeDoc(db: Database, scope: DocScope, docId: string): void;
// DELETE FROM search_docs WHERE scope = ? AND doc_id = ?
```

`replacePage` deletes `WHERE scope = 'canon' AND doc_id = ?`; `replaceEvent`
deletes `WHERE scope = 'ledger' AND doc_id = ?`, and its tombstone branch
becomes

```sql
DELETE FROM search_docs
 WHERE scope = 'ledger'
   AND doc_id IN (SELECT event_id FROM events
                   WHERE connector_id = ? AND source_record_id = ?)
```

(the only change is the scope guard; a tombstone still drops every indexed
version of its record, which the CLI lane relies on). The one product call
site, `ledger/purge.ts`, becomes `removeDoc(db, "ledger", eventId)`. FTS5
has no unique constraint; "keyed" means every delete carries both columns
and rebuild inserts at most one row per `(scope, doc_id)` (§3.2).

### 3.2 Linear rebuild (finding 9)

`rebuildSearch` wipes the table then inserts directly — no per-document
DELETE during a rebuild. Delete-then-insert stays only on the incremental
`indexPage`/`indexEvent` paths.

- Canon: `listCanonPagesReport(vaultPath)` (§4) already guarantees one page
  per id (later duplicates are in `skipped`), so `insertDoc` each page.
- Ledger: two passes over `[...replay(db, {})]` (accepted order). Pass one
  records, per record key `${connector_id}\u0000${source_record_id}` (escape text in source), the
  index of its latest tombstone. Pass two inserts event _i_ iff
  `!deleted` and `i > (latestTombstone.get(key) ?? -1)`. This is exactly
  today's observable semantics (a tombstone removes versions accepted before
  it; a version accepted after a tombstone is indexed again) with zero
  deletes.

```ts
export interface SearchRebuildResult {
  pages: number;
  events: number;
  skipped: SkippedPage[]; // NEW — from listCanonPagesReport
  rebuilt_at: string;
}
```

The stamp goes through `stampDerived(db, "search", rebuiltAt, pages +
events)` (§7). The local `stringArray`/`text`/`pageSensitivity` helpers:
`stringArray` moves to `src/vault/pages.ts` as `export function
stringArray(value: unknown): string[]` (same body, used by the indexer and
the graph); the other two stay private.

## 4. Vault reader — `src/vault/pages.ts`, `src/vault/doctor.ts` (finding 6)

```ts
export interface CanonPage {
  // unchanged
  id: string;
  path: string;
  relPath: string;
  data: Record<string, unknown>;
  body: string;
}
export interface SkippedPage {
  relPath: string;
  reason: string;
} // NEW
export interface CanonPageReport {
  pages: CanonPage[];
  skipped: SkippedPage[];
} // NEW
export function listCanonPagesReport(vaultPath: string): CanonPageReport; // NEW
export function listCanonPages(vaultPath: string): CanonPage[]; // = listCanonPagesReport(vaultPath).pages
export function findPageById(vaultPath: string, id: string): CanonPage | null; // first page with that id, tolerant
export function stringArray(value: unknown): string[]; // moved here (§3.2)
```

The walker is the existing `markdownFiles` (skips `.kizuki/`, `archive/`,
`CANON.md`, `SCHEMA.md`) with one change: entries sort by code point
(`a.name < b.name ? -1 : 1`), not `localeCompare`, so "first seen" and every
rebuild are deterministic across locales. A file lands in `skipped` when

- `parseFrontmatter` throws → `reason` = the `SyntaxError` message;
- `data.id` is not a non-empty string → `reason` = `id: must be a non-empty
string` (the `validatePage` wording);
- the id was already seen → `reason` = `duplicate id "<id>"; first seen at
<relPath>` — the first file in walk order is the page, later ones are
  skipped.

A read error other than parsing (permissions, I/O) still throws: that is an
environment fault, not a malformed note. Call sites:

- `rebuildSearch` / `rebuildGraph`: use the report; return `skipped`.
- `doctorVault`: use `listCanonPagesReport` and delete its private walker.
  `pages` → `validatePage(page.data)` errors as today; `skipped` →
  `[`frontmatter: ${reason}`]`. Merge, sort by code point, count as today
  (`DoctorPageResult`/`DoctorVaultResult` unchanged, so the CLI `doctor`
  lines keep their format). Deliberate behavior change: doctor no longer
  walks `archive/` — prior revisions copied by `writePage(..., { revision:
true })` are not canon and are never served, and `listCanonPages` already
  excluded them; a stale revision must not fail `doctor`.
- `purgeEvents`: read the report first thing inside its transaction and
  refuse before any write when `skipped.length > 0`:
  `throw new Error(`purge refused: cannot read canon page(s) ${relPaths.join(", ")}`)`.
  Rationale: the cascade is computed from page `sources`; a page whose
  frontmatter cannot be read might cite a purged event, and a purge that
  misses a hold would serve purged content (invariant 8, RFC 0001
  "provenance keeps purge computable"). Today's behavior is also an abort,
  just with an opaque parser error and after the deletes (rolled back).
- `staging/promote.ts` `readExisting` keeps calling `findPageById`; because
  it is now tolerant, a stray note no longer blocks promotion. If the
  malformed file _is_ at the derived target path, `parseFrontmatter` in
  `readExisting` still throws before any write (fail closed); `writePage`'s
  `wx` flag still refuses clobbers.

## 5. Timeline — `src/query/timeline.ts` (findings 4, 8)

- `ORDER BY <instantSql("events.occurred_at")>, events.event_id` — the same
  expression the window uses; `OCCURRED_AT_INSTANT` moves to `sql.ts`.
- `since`/`until` pass through `instantBound(value, "timeline since" |
"timeline until")`; an invalid bound throws `RangeError`, never returns
  `[]`. `day` keeps its own `RangeError`s; when `day` and `since`/`until`
  are both given they still AND (unchanged).
- Ceiling: `ceilingSql("events.sensitivity_hint")` bound to
  `SENSITIVITY_ORDER[opts.ceiling]`; local `CEILING_RANK` deleted.
- `preview(text)` slices code points:
  `Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 160).join("")`.
  `TimelineEntry.text_preview` is "≤ 160 code points" (doc comment).

`TimelineOptions`/`TimelineEntry` keep their shape.

## 6. Graph — `src/graph/graph.ts` (finding 10)

```ts
export interface NeighborOptions {
  depth?: 1 | 2;
  kinds?: GraphEdgeKind[];
  limit?: number; // NEW: max edges returned; default 1000; non-negative integer else RangeError
}
export interface NeighborResult {
  id: string;
  edges: GraphEdge[];
  truncated: boolean; // NEW: true when more edges were adjacent than `limit`
}
```

`neighbors`: no full-table load. Per round, query the frontier in chunks of
at most 500 ids:

```sql
SELECT src, dst, kind FROM graph_edges
 WHERE (src IN (?, …) OR dst IN (?, …)) [AND kind IN (?, …)]
 ORDER BY src, dst, kind
```

Collect at most `limit + 1` distinct edges across rounds (SQL order, then
round order, so the collected set is deterministic), set `truncated =
collected.length > limit`, slice to `limit`, then sort the result by code
point on `(src, dst, kind)` with plain `<` comparisons — `localeCompare` is
gone. The existing depth-1, depth-2 and kind-filter expectations remain
valid under this order; the "unknown id" test gains `truncated: false`.

`rebuildGraph`: use `listCanonPagesReport` (return `skipped`), `stringArray`
from `vault/pages.ts`, count edges once (the in-transaction count is the
result; delete the second query), stamp through `stampDerived(db, "graph",
rebuiltAt, edges)`.

```ts
export interface GraphRebuildResult {
  pages: number;
  edges: number;
  skipped: SkippedPage[]; // NEW
  rebuilt_at: string;
}
```

## 7. Derived meta — `src/derived-meta.ts` (NEW; finding 11)

Exactly one DDL, one upsert, one reader for the `derived_meta` table
(unchanged columns: `layer TEXT PRIMARY KEY, rebuilt_at TEXT NOT NULL,
doc_count INTEGER NOT NULL`, `STRICT`).

```ts
export type DerivedLayer = "search" | "graph";
export interface DerivedMeta {
  layer: DerivedLayer;
  rebuilt_at: string;
  doc_count: number;
}
export function initDerivedMeta(db: Database): void; // CREATE TABLE IF NOT EXISTS …; called by initSearch and initGraph
export function stampDerived(
  db: Database,
  layer: DerivedLayer,
  rebuiltAt: string,
  docCount: number,
): void; // the upsert, inside the caller's transaction
export function readDerivedMeta(
  db: Database,
  layer: DerivedLayer,
): DerivedMeta | null; // null when never rebuilt or table absent (tableExists guard from ledger/schema.ts)
```

`search/schema.ts` and `graph/schema.ts` drop their `derived_meta` DDL and
call `initDerivedMeta(db)`. `readDerivedMeta` is exported (§9) because the
serving-health and `doctor` freshness lanes need the stamp without raw SQL.
`src/derived.ts` is unchanged apart from the nested result types now
carrying `skipped`.

No migration: every table here is derived (`CREATE … IF NOT EXISTS`,
rebuildable with `rebuildDerived`); `test/migration.test.ts` is untouched.

## 8. Test helpers — `test/helpers/vault.ts` (NEW; finding 11)

```ts
export function tempVault(prefix?: string): {
  path: string;
  dispose: () => void;
}; // mkdtempSync + initVault
export function writeCanon(
  vaultPath: string,
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): void; // serializePage → writeFileSync
```

`test/search/helpers.ts` and `test/staging/helpers.ts` lose their
`tempVault`; `test/purge.test.ts` loses `temporaryVault`;
`test/search/search.test.ts`, `test/graph/graph.test.ts`,
`test/derived.test.ts` lose their local `writeCanon`. Tests that need a bare
directory (`test/vault.test.ts` `tempDir`, migration, connections, export)
keep theirs. `test/search/helpers.ts` keeps `searchDb` and `storedEvent`.

## 9. Exports — `src/index.ts`

```ts
export {
  findPageById,
  listCanonPages,
  listCanonPagesReport,
} from "./vault/pages";
export type { CanonPage, CanonPageReport, SkippedPage } from "./vault/pages";
export { readDerivedMeta } from "./derived-meta";
export type { DerivedLayer, DerivedMeta } from "./derived-meta";
export type { DocScope } from "./search"; // via search/index.ts
```

`test/index.test.ts` adds `listCanonPagesReport` and `readDerivedMeta` to
the enumerated runtime surface (alphabetical position). `instantSql`,
`instantBound`, `ceilingSql`, `initDerivedMeta`, `stampDerived` and
`stringArray` stay internal; their tests import by path like the rest of
`test/`.

## Non-goals

- No CLI verb, flag or output change; `doctorVault`'s result shape is
  unchanged so `packages/cli/src/main.ts` keeps compiling and its `doctor`
  lines keep their format. (After this lane the CLI note "listCanonPages
  throws on a page without a string id" is no longer true; `doctor` reports
  such pages as `problem <page>: frontmatter: …` instead.)
- No change to `agents/time.ts` (grant windows keep their leap-second
  convention), to `search_docs` columns or tokenizer, to embeddings, to the
  ledger schema, or to `export.ts` (its file copier is not a canon reader).
- No serving or MCP code; `neighbors` gains `limit`/`truncated` only so the
  serving lane has a bounded primitive to build on.

## Sibling-lane interplay (additive; nothing here blocks them)

- serving-mcp composes `neighbors()` and applies its own 500-edge cap after
  servability filtering. Core's default `limit` is 1000; a serving call
  should pass `limit` explicitly (or read core's `truncated`) so a hub with
  more than 1000 adjacent edges is not silently under-served. `RangeError`
  from the new bound validation maps to its `invalid_arguments` like the
  existing ones.
- serving-mcp's health reads `derived_meta` with a `tableExists` guard;
  `readDerivedMeta` (§7) does exactly that and may replace the raw SQL.
- Both serving-mcp and cli-verbs assume `listCanonPages` throws on the first
  unparsable page. After this lane it does not: a page with unreadable
  frontmatter is absent from every reader and is listed by `doctor` as a
  `problem` line; serving's fail-closed-to-empty path is no longer reached
  by a stray note (it still covers genuine I/O errors).
- cli-verbs's `derived.ts` relies on `indexEvent` for a tombstone dropping
  every indexed version of the record and on archived-in-place pages being
  indexed by rebuild; both stay true (§3.1, §4).

## Tests

Every behavior item has a named test that fails on main and passes after;
craft items have a test that pins the new shape. Fixture names: `ada`,
`grace`, `linus`, `acme`.

`test/search/search.test.ts`

- `toFtsQuery keeps dates, handles, times and hyphenated words as literals` — the first five rows of the §2.1 table.
- `toFtsQuery drops control characters and search returns [] for a NUL query` — U+0000 and U+0007 inside a token; `search(db, "a" + "\u0000" + "b")` is `[]`, no throw.
- `toFtsQuery neutralization vectors` — the remaining rows of the §2.1 table, exact strings (replaces the current `neutralized` list).
- `a title match outranks a body match` — two pages, term only in one title vs. only in another body → title page first (fails on main: tie → doc_id order).
- `since and until compare instants, not strings` — `2026-02-02T23:30:00-02:00` is inside `since: 2026-02-03T00:00:00Z`; a `2026-02-03t02:00:00z` event obeys `until`.
- `a time window never excludes canon documents` — a canon page matches with `since`/`until` set, in `all` and `canon` scope; ledger docs outside the window are gone.
- `an invalid since or until throws RangeError` — `since: "garbage"`.
- `documents are keyed by scope and id` — a page whose id equals an indexed event id: `indexPage` leaves the ledger row; `removeDoc(db, "canon", id)` leaves the ledger row; `removeDoc(db, "ledger", id)` leaves the page.
- `a tombstone removes only ledger documents of its record` — canon page with id equal to the record's event id survives the tombstone.
- `rebuild inserts without per-document deletes` — 6000 synthetic events via `accept` (outside the timed region), `rebuildSearch` < 1500 ms (main: ~5 s; after: ~50 ms — CI-safe margin both ways).
- `rebuild keeps the first page for a duplicate id and reports the rest` — `facts/B.md` and `facts/a.md` share an id: `B.md` is indexed (code-point order), `result.skipped` names `facts/a.md`, exactly one `search_docs` row.
- `rebuild tolerates a malformed note and reports it as skipped` — a note without frontmatter: rebuild succeeds, `skipped[0].relPath` names it, other pages indexed.
- `rebuild re-indexes a record re-created after its tombstone` — v1, tombstone, v2 of one record → only v2 searchable (locks the two-pass equivalence). Keep the existing "rebuild applies tombstones after earlier source versions".

`test/query/sql.test.ts` (NEW)

- `instantBound and instantSql agree on every contract-valid form` — for `2026-02-02T23:30:00-02:00`, `2026-02-03t02:00:00z`, `2026-06-30T23:59:60Z`, `2026-06-30T23:59:60+05:30`, `2026-01-01T00:00:00.123456Z`, `2026-12-31T23:59:59-00:00`: `SELECT julianday(?)` on `instantBound(v)` equals `SELECT <instantSql("t.v")>` over a temp table holding `v` (verified equal on main's SQLite for all six).
- `instantBound rejects non-RFC3339 input with RangeError` — `"garbage"`, `"2026-02-30T00:00:00Z"`, `""`.
- `ceilingSql ranks the lattice from SENSITIVITY_ORDER and excludes unlabeled` — rows `public/personal/private/NULL/'unlabeled'` under each ceiling.

`test/query/timeline.test.ts`

- `orders entries by instant across offsets and casing` — 23:30-02:00, 00:30Z, `02:00:00z` come back as 00:30Z, 23:30-02:00, 02:00z (fails on main).
- `includes contract-valid lowercase and leap-second timestamps` — fix the expectation to `[lowercase, leap]` (12:00 before 23:59:60).
- `rejects an invalid since or until with RangeError`.
- `bounds the preview by code points so an astral character survives the boundary` — 159 × `x` + U+1F600 + `tail`: preview has 160 code points, ends with U+1F600, no lone surrogate; keep the existing 160-ASCII test.

`test/graph/graph.test.ts`

- `neighbors orders edges by code point, not locale` — ids `Z-node` and `a-node` adjacent to one hub: `Z-node` edge first.
- `neighbors stops at limit and reports truncation` — hub with 5 edges: `limit: 3` → 3 edges, `truncated: true`; `limit: 5` → `truncated: false`; `limit: -1` → `RangeError`.
- `neighbors traverses a frontier larger than one chunk` — 1200 leaves off one hub, depth 2 from a leaf: every sibling reached (exercises chunking).
- `rebuild reports skipped pages and counts edges once` — one malformed note plus a linked page: `result.edges` equals the `graph_edges` row count, `skipped` has one entry.
- Existing tests: update "returns an empty envelope for an unknown id" to include `truncated: false`.

`test/derived.test.ts`

- `derived_meta is created once and read back per layer` — after `rebuildDerived`, `readDerivedMeta(db, "search")` and `("graph")` return the stamps; after `DROP TABLE derived_meta` + rebuild they match again; `readDerivedMeta` on a fresh `openLedger(":memory:")` is `null`.

`test/vault/pages.test.ts` (NEW)

- `listCanonPagesReport skips a note without frontmatter and reports the path`.
- `listCanonPagesReport skips a page without a string id` — reason `id: must be a non-empty string`.
- `listCanonPagesReport reports a duplicate id and keeps the first file in code-point order` — `facts/B.md` before `facts/a.md`.
- `listCanonPages and findPageById tolerate a stray note` — both succeed (fail on main), `findPageById` still finds the good page and returns `null` for a missing one.

`test/vault.test.ts`

- `doctorVault reports skipped notes as frontmatter problems and ignores archive/` — a note without frontmatter → `problem` error `frontmatter: frontmatter must begin with an exact --- line`; an invalid page under `archive/` does not appear and does not count.

`test/purge.test.ts`

- `refuses to purge while a canon page cannot be read` — stray note present: `purgeEvents` throws `/purge refused/` naming the path; `count(db)` unchanged; `event_purges` empty (transaction rolled back).
- Extend "removes matching derived search and graph rows through real schemas": after the purge, `search(db, <purged text>)` is `[]` with no ceiling and with `ceiling: "private"`, and `neighbors(db, "fact:one").edges` is `[]`.

`test/staging/promote.test.ts`

- `promote succeeds while a stray note sits in the vault` — a claim proposal promotes with `facts/stray.md` (no frontmatter) present (fails on main with `SyntaxError`).

`test/index.test.ts` — enumerated surface updated (§9).

## Acceptance

```
bun run typecheck                                  # exit 0
bun test                                           # green; ≥ 545 tests (main: 515), 0 fail
bun test packages/core/test/search packages/core/test/query packages/core/test/graph packages/core/test/vault packages/core/test/derived.test.ts packages/core/test/purge.test.ts packages/core/test/staging/promote.test.ts   # every test named above present and green
git stash -q && bun test packages/core/test/search/search.test.ts packages/core/test/query/timeline.test.ts 2>&1 | tail -3; git stash pop -q   # on main's code the behavior tests above FAIL (typecheck aside): red before, green after
rg -n "localeCompare" packages/core/src/vault packages/core/src/graph packages/core/src/search packages/core/src/query   # no output
rg -n "CREATE TABLE IF NOT EXISTS derived_meta" packages/core/src   # exactly one hit: packages/core/src/derived-meta.ts
rg -n "function stringArray" packages/core/src                      # two hits: vault/pages.ts (this lane) and ledger/connections.ts (different contract, untouched)
rg -n "bm25\(search_docs" packages/core/src/search/query.ts         # one hit with ten weights: 0, 0, 4.0, 1.0, 0, 0, 0, 0, 0, 0
rg -n "removeDoc\(" packages/core/src                               # every call passes a scope: removeDoc(db, "ledger", …) in ledger/purge.ts
rg -n "readdirSync" packages/core/src/vault                          # one hit: vault/pages.ts (doctor.ts no longer walks)
bun run verify                                     # full repository gate: install, typecheck, tests, policy tests, network scan, identifier denylist over tree and commit messages — exit 0
git status --porcelain                             # empty
```
