# Lane: derived-layers — FTS5 search, graph edges, timeline, rebuild

Package: `packages/core` only, new directories `src/search/`, `src/graph/`,
`src/query/`. Read CONVENTIONS.md first. Do NOT edit `ledger/`, `staging/`
or `vault/` beyond adding exports (a sibling lane is changing them; you will
be merged after it). Do NOT wire any CLI verb.

## Objective

The deterministic query floor (architecture §7, §8.3): SQLite FTS5 over
canon + ledger, a wikilink/subject graph, a timeline, and a one-command
rebuild, all derived and rebuildable from vault + ledger.

## 1. Search (`src/search/`)

Schema (create in `initSearch(db)`; idempotent; call it from wherever
`initStaging` is called in tests — do not modify `openLedger`):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(
  doc_id UNINDEXED,        -- page id (canon) or event_id (ledger)
  scope UNINDEXED,         -- 'canon' | 'ledger'
  title,                   -- page title or "<connector> <kind>"
  body,
  path UNINDEXED,          -- vault-relative page path or ''
  page_type UNINDEXED,     -- canon: type enum; ledger: event kind
  sensitivity UNINDEXED,   -- canon: label or 'unlabeled'; ledger: hint or 'unlabeled'
  occurred_at UNINDEXED,   -- ledger: occurred_at; canon: '' (canon has no time)
  connector_id UNINDEXED,
  subjects UNINDEXED,      -- JSON array of subject ids
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS derived_meta (
  layer TEXT PRIMARY KEY,  -- 'search' | 'graph'
  rebuilt_at TEXT NOT NULL,
  doc_count INTEGER NOT NULL
) STRICT;
```

API:

```ts
export function initSearch(db): void;
export function indexPage(db, page: { id; relPath; data; body }): void; // delete-then-insert by doc_id
export function indexEvent(db, event: CaptureEvent): void; // skips deleted events; deleted → removeDoc
export function removeDoc(db, doc_id): void;
export function rebuildSearch(
  db,
  vaultPath,
): { pages: number; events: number; rebuilt_at: string };
// wipe search_docs; index every canon page (walk the vault like vault/doctor.ts does — extract nothing from doctor.ts; write your own tiny walker in src/vault/pages.ts ONLY if it does not exist yet on this branch; if `listCanonPages` exists, use it) and every non-deleted ledger event via replay()
export interface SearchOptions {
  scope?: "canon" | "ledger" | "all";
  limit?: number;
  ceiling?: "public" | "personal" | "private";
  types?: string[];
  since?: string;
  until?: string;
  subjects?: string[];
  excludePaths?: string[];
}
export interface SearchHit {
  doc_id;
  scope;
  title;
  path;
  page_type;
  sensitivity;
  occurred_at;
  connector_id;
  subjects: string[];
  snippet: string;
  rank: number;
}
export function search(db, query: string, opts?: SearchOptions): SearchHit[];
export function toFtsQuery(raw: string): string; // exported for tests
```

`toFtsQuery`: split on whitespace, drop empty, strip FTS operators from
tokens except a trailing `*` (prefix), wrap each token in double quotes
(escape inner quotes by doubling), join with spaces (implicit AND). A query
with zero usable tokens returns `[]` without touching SQLite. Quoted phrases
in the raw query (`"like this"`) stay one token.

Ranking: `ORDER BY bm25(search_docs, 4.0, 1.0)` (title weighted). Snippet:
`snippet(search_docs, 3, '[', ']', '…', 24)`.

**Ceiling enforcement lives here, in SQL** (invariant 8, architecture §8.1
"grants filter at the query engine"): when `ceiling` is given, only docs
whose `sensitivity` is ≤ ceiling on the lattice public < personal < private
are returned, and docs with `sensitivity = 'unlabeled'` are NEVER returned
when a ceiling is given. Without a ceiling (owner CLI), everything is
returned including unlabeled. `excludePaths` removes held pages.

Tests (`test/search/`): rebuild indexes pages + events and stamps
`derived_meta`; rebuild twice → same doc_count, no duplicates; `indexPage`
replaces rather than appends; a deleted event is not indexed and a later
tombstone removes it; ceiling `personal` hides a `private` page and an
unlabeled page; `public` hides both personal and private; no ceiling shows
all; `toFtsQuery` neutralizes `OR`, `NEAR(`, `-`, `^`, unbalanced quotes and
a `*` in the middle of a token (assert exact strings); prefix search works;
snippets mark the hit; diacritics-insensitive match (`cafe` finds `café`).

## 2. Graph (`src/graph/`)

```sql
CREATE TABLE IF NOT EXISTS graph_edges (
  src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL,  -- 'wikilink' | 'subject' | 'source'
  PRIMARY KEY (src, dst, kind)
) STRICT;
```

`rebuildGraph(db, vaultPath)`: for every canon page — `[[Target]]` and
`[[Target|alias]]` wikilinks in the body → edge (page id → target text,
'wikilink'); frontmatter `subjects` (if any) → (page id → subject id,
'subject'); frontmatter `sources` → (page id → event id, 'source').
`neighbors(db, id, { depth?: 1|2; kinds?: Kind[] }): { id, edges: Edge[] }`
both directions. `initGraph(db)`. Tests: wikilink parsing (aliases, nested
brackets ignored, code spans ignored), rebuild idempotent, neighbors depth 2,
kind filter.

## 3. Timeline (`src/query/timeline.ts`)

```ts
export interface TimelineOptions {
  day?: string /* YYYY-MM-DD */;
  since?: string;
  until?: string;
  subject?: string;
  connector_id?: string;
  kind?: string;
  ceiling?: Sensitivity;
  limit?: number;
}
export interface TimelineEntry {
  event_id;
  occurred_at;
  connector_id;
  kind;
  subjects: string[];
  sensitivity: string;
  text_preview: string; /* ≤ 160 chars, whitespace-collapsed */
}
export function timeline(db, opts): TimelineEntry[]; // ledger only, non-deleted, ORDER BY occurred_at, event_id; ceiling lattice as in search (hint missing = 'unlabeled' → excluded when a ceiling is given)
```

`day` expands to `[day, day+1)` in UTC. Tests: day window, subject filter via
`json_each(subjects)`, ceiling, limit, deleted excluded.

## 4. Rebuild (`src/derived.ts`)

`rebuildDerived(db, vaultPath): { search, graph }` calls both. Tests: after
deleting the tables it restores identical counts (invariant 2).

## 5. Exports

`packages/core/src/index.ts` exports everything above (types included).

## Acceptance

```
bun run typecheck
bun test                    # green; ≥ 30 new tests
grep -rniE 'illumi|hermes|ika-hetzner|albedo|gbrain' packages/ --include='*.ts'   # no output
git status --porcelain      # empty
```
