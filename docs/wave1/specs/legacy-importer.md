# Lane: legacy-importer — migrate a previous personal-knowledge estate through mapping files, on synthetic fixtures only

Packages: `packages/connectors` (two NEW in-tree connectors under
`src/import-legacy-wiki/` and `src/import-legacy-events/`, one NEW shared
directory `src/legacy/`, registry + index + conformance test), `packages/core`
(one NEW contract file `src/contracts/page-candidate.ts`, one NEW staging file
`src/staging/page-candidate.ts`, a ten-line change to
`src/staging/producers.ts`, a constant extraction in `src/staging/promote.ts`,
exports, the public-surface test), NEW `docs/legacy-import.md`, one line in
the root `README.md`. Nothing else. No CLI verb or flag (the CLI lanes own
those; §8 says what they need).

Reconciled against `main` @ `76930db` (2026-09-02; `bun test` = 515 pass /
41 files; Bun 1.3.14 locally, CI pins 1.3.10). Every path and symbol below
was grepped on that revision; anything not on main is marked NEW with its
intended location.

Read first, in order: CONVENTIONS.md; `docs/architecture.md` (invariants 1,
3, 5, 7, 8, 10; the `kizuki.event/v1` block; "Storage" for the frontmatter
schema: closed type enum, required `sensitivity`, `x-*` extension namespace);
`rfcs/0000-constraints.md` §1 (ingress frozen), §2 (egress is the proposal),
§4, §6, §7; `rfcs/0001-deep-model-arbitration.md` ("explicit bottom": unlabeled
is never served, owner included); `AGENTS.md`, `packages/connectors/AGENTS.md`
("archives and export files are hostile input"; "do not call an export
importer a live connector"); `.agents/skills/connector-work/SKILL.md`,
`dependency-evaluation/SKILL.md`, `security-privacy-review/SKILL.md`. Then the
code you compose: `packages/core/src/contracts/{event,connector,proposal}.ts`;
`src/vault/{schema,frontmatter,write,pages}.ts` (`validatePage`: required
`id title type status sensitivity`, known `sources`, everything else must
start with `x-`; `serializePage`: values are strings, finite numbers, booleans
or string arrays); `src/staging/{proposals,producers,promote}.ts`
(`ProposalInput`, `FrontmatterValue`, `fileProposal` idempotency on
`(kind, coalesce(target,''), body_hash)`, `proposalsForEvent`,
`pageRelPath` + `PATH_SEGMENT`/`MAX_SEGMENTS`/`MAX_SEGMENT_LENGTH`,
`RESERVED_KEYS`); `src/ingest/run.ts` (`runBackfill` runs ONE batch per call
and hands `checkpoint.cursor` back to `backfill`; `runSync` passes it to
`sync`; a thrown error keeps the previous cursor); `src/util/hash.ts`
(`observed_at`, `attachments` and `sensitivity_hint` are outside the content
hash; `metadata` is inside it); `packages/connectors/src/{conformance,
registry,index,ledger,util,errors}.ts`, `src/markdown-folder/index.ts` (the
snapshot-cursor + tombstone shape to mirror), `src/import-chatgpt/index.ts`
(the in-tree importer shape), `packages/connectors/test/*.test.ts`;
`packages/core/test/staging/{helpers,producers.test,promote.test}.ts`,
`packages/core/test/index.test.ts` (pins the sorted runtime export list);
`packages/tui/src/app.ts` (`toItem`: `targetPath` is null for a target page
that does not exist yet) and `src/model.ts` (`batchEligible`: deterministic
`entity`/`claim` with `targetPath === null` — so every new-page migration
proposal is batch-promotable). Design: workspace plan ARCHITECTURE.md §3.1
("Graveyard importers ship as connectors too"), §3.2 (conformance), §4.1
(deterministic floor: "file imports → source-faithful pages"), §5 (batch
accept, two-key), §6 (frontmatter schema; "`x-*` namespace free for private
extensions (estate importer uses it; lossy-mapping report at migration)"),
§10, §12.

## Ground truth on main that shapes this lane

- The CLI on main (`packages/cli/src/main.ts`, verb `ingest`) constructs a
  connector as `getConnector(id, { path: sourcePath })` and nothing else;
  cli-verbs' `decodeHostState` (NEW there) accepts exactly `{ path }` too.
  Consequence: the mapping file must be findable from `path` alone (§2.1),
  or the importer is unusable from any CLI in flight.
- `proposalsForEvent` (core) is the only thing that turns a stored event
  into proposals, and `runBatch` is the only caller. A connector cannot file
  a typed page proposal itself; the floor must know how to (§1).
- `promote` refuses proposal frontmatter carrying `id status sensitivity
sources`; `type` must be in `PAGE_TYPES`; `title` is required by
  `validatePage` at write time. `sensitivity` for a NEW page comes only
  from `opts.sensitivity` — an owner keystroke — never from the proposal.
- `fileProposal` dedupes on the body hash: re-importing an unchanged page
  is a `duplicate`, an edited page is a second pending proposal for the same
  target (promote then refuses the second: "already exists; supersede it
  with an edit proposal"). Honest; the report cannot see the vault.
- `bun:sqlite` accepts `new Database(path, { readonly: true })`.
- `scripts/verify-network.ts` scans every tracked `packages/**/*.ts`
  (tests included) for `fetch`, `Bun.serve`, `node:net`, …; there is no
  allowlist on main and this lane needs none.
- `packages/core/test/staging/invariants.test.ts` scans every
  `packages/*/src` for `promote(` call sites and `invokedBy`; name nothing
  `promote`.

## Dependency decision: zero (evaluated 2026-09-02, `npm view`)

| candidate     | version / license                                                              | verdict                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yaml`        | 2.9.0 / ISC, no deps                                                           | rejected: the frontmatter dialect a markdown wiki emits (block maps, block lists, flow lists, quoted and block scalars) is a bounded subset; anything outside it is reported `unparsed` per page, which the report must say anyway |
| `js-yaml`     | 5.4.1 / MIT (+ `argparse`)                                                     | rejected: same reason; also `!!js/function` history                                                                                                                                                                                |
| `gray-matter` | 4.0.3 / MIT (+ `js-yaml` 3.x, `kind-of`, `section-matter`, `strip-bom-string`) | rejected: four transitive packages for a fence split                                                                                                                                                                               |

Everything is `node:fs`, `node:path`, `bun:sqlite`, `Bun.CryptoHasher`.
`packages/connectors/package.json` keeps `"@kizuki/core": "workspace:*"` as
its only dependency; `@kizuki/core` stays dependency-free; `bun.lock` does
not change.

## Objective

Two connectors with `auth_modes: ["none"]` that pass the shared conformance
suite and move a previous estate into Kizuki without inventing anything the
owner did not decide:

- **legacy-wiki** (`kizuki.import-legacy-wiki`): a markdown folder with
  arbitrary frontmatter, an owner-written mapping file → one ledger event per
  page → one typed page proposal per page (type mapped onto the closed enum,
  unknown fields renamed into `x-*`, sensitivity taken only from a mapped
  field). Every page lands in staging; nothing lands in canon. A page whose
  mapping yields no sensitivity is an unlabeled proposal: never served from
  the ledger (RFC 0001 bottom), and promotable only when the owner picks a
  label. A lossy-mapping report lists every page, every dropped or renamed
  field, and the sensitivity decision.
- **legacy-events** (`kizuki.import-legacy-events`): a generic SQLite table
  or JSONL file, an owner-written column-to-field mapping →
  `kizuki.event/v1` backfill in bounded pages with a keyset cursor;
  re-running is idempotent by construction (stable `source_record_id`,
  spine-computed hash, cursor resume); rows flagged deleted at the source
  become tombstones.

Developed and tested only on synthetic fixtures (`ada`, `grace`, `linus`,
`acme`). No estate-specific field names, paths, hosts, product names or
people anywhere in code, fixtures, docs, tests or commit messages.

## Non-goals

No CLI verb or flag; no TUI change; no LLM; no network; no `wm_*`; no
default sensitivity in the wiki mapping (a label is a per-page owner decision
— the TUI's `--batch` key applies one label to a whole eligible group in two
keystrokes, which is the designed path for a large unlabeled import); no
wikilink rewriting (bodies are source-faithful; the graph layer resolves
`[[Title]]` by title); no `edit` proposals for pages already promoted (the
connector cannot see the vault); no attachment/asset copying (image links
stay as text); no compiled-in app credentials (not an authenticated source);
no change to `kizuki.event/v1`, `kizuki.proposal/v1`, `kizuki.connector/v1`,
any migration, `validatePage`, `pageRelPath`'s rules, or
`docs/architecture.md`.

## 1. Core: the page-candidate seam (the only core change)

### 1.1 Contract (`packages/core/src/contracts/page-candidate.ts`, NEW)

An event may carry, under one well-known `metadata` key, a page candidate:
a typed page the deterministic floor should stage instead of the generic
source capture note. The ingress contract is untouched (`metadata` is
`Record<string, unknown>`, persisted verbatim, inside the content hash);
this is a downstream convention the floor validates strictly, because
metadata is attacker-controlled by policy.

```ts
import type { FrontmatterValue } from "../staging/proposals"; // type-only; contracts stay db-free
import { PAGE_TYPES } from "../vault/schema";
import type { PageType } from "../vault/schema";

export const PAGE_CANDIDATE_SCHEMA = "kizuki.page-candidate/v1" as const;
export const PAGE_CANDIDATE_KEY = "page_candidate" as const; // metadata key
/** Types whose candidate files as `entity`; every other PageType files as `claim`. */
export const ENTITY_PAGE_TYPES = [
  "person",
  "org",
  "project",
  "place",
  "topic",
] as const;

export interface PageCandidate {
  schema: typeof PAGE_CANDIDATE_SCHEMA;
  type: PageType;
  title: string; // 1..200 chars after trim; no control chars except none (U+0000–U+001F, U+007F refused)
  target: string; // pageRelPath grammar (below): 1..8 segments joined by "/"
  extensions: Record<string, FrontmatterValue>; // keys /^x-[A-Za-z0-9][A-Za-z0-9_-]*$/, ≤ 64 keys;
  // string values ≤ 4096 chars; arrays ≤ 256 strings each ≤ 4096; numbers finite
  confidence: number; // 0..1
}

/** The rule `pageRelPath` applies to a target; null when usable. Moved here from promote.ts. */
export function targetProblem(target: string): string | null;
// segments = target.split(/[:/]/); > 8 → "target: more than 8 path segments";
// any segment > 64 chars or not /^[A-Za-z0-9][A-Za-z0-9._-]*$/ → `target: unusable path segment ${JSON.stringify(segment)}`

export function validatePageCandidate(
  metadata: Record<string, unknown>,
): ValidationResult<PageCandidate> | null;
// null when metadata[PAGE_CANDIDATE_KEY] is absent; { ok: false, errors } when present but invalid
// (schema mismatch, type ∉ PAGE_TYPES, title/target/extensions/confidence rules above,
// any extension key in `id status sensitivity sources type title` or not x-prefixed).
```

`packages/core/src/staging/promote.ts`: delete its private `PATH_SEGMENT`,
`MAX_SEGMENTS`, `MAX_SEGMENT_LENGTH`; `pageRelPath` calls `targetProblem`
and throws `PromoteError(problem)` — same messages, same tests, no behavior
change.

### 1.2 Producer (`packages/core/src/staging/page-candidate.ts`, NEW; `producers.ts` edit)

```ts
export function pageCandidateProposal(
  event: CaptureEvent,
  candidate: PageCandidate,
): ProposalInput;
```

Returns:

```ts
{
  kind: ENTITY_PAGE_TYPES.includes(candidate.type) ? "entity" : "claim",
  target: candidate.target,
  body: event.text,               // verbatim: the owner's own prose from the previous estate;
                                  // the review step is the trust boundary, exactly as `editBody` is
  frontmatter: {
    type: candidate.type,
    title: candidate.title,
    ...candidate.extensions (keys sorted),
    "x-connector": event.connector_id,
    "x-capture-kind": event.kind,
    "x-source-record-id": event.source_record_id,
  },
  provenance: [event.event_id],
  subjects: distinct event.subjects[].subject_id (event order),
  producer: "deterministic",
  confidence: candidate.confidence,
}
```

The three `x-connector`/`x-capture-kind`/`x-source-record-id` keys win over
same-named extensions (the floor stamps provenance; a candidate cannot forge
it). `proposalsForEvent` (`producers.ts`) becomes:

```ts
export function proposalsForEvent(event: CaptureEvent): ProposalInput[] {
  if (event.deleted) return [];
  const proposals = entity candidates per distinct subject (unchanged);
  const candidate = validatePageCandidate(event.metadata);
  if (candidate !== null && candidate.ok) {
    proposals.push(pageCandidateProposal(event, candidate.value));
  } else {
    proposals.push(captureNoteProposal(event)); // unchanged; an INVALID candidate falls back to the
                                                // blockquoted capture note (fail closed: bad metadata
                                                // never becomes a typed page)
  }
  return proposals;
}
```

A body with a `---` line stays inert after promote (the frontmatter fence
written by `serializePage` closes first; already tested on main for the
capture note). `renderPage(proposal, sensitivity, body)` + `validatePage`
must accept every proposal this function produces (tested, §7).

### 1.3 Exports

`packages/core/src/index.ts` adds runtime exports `ENTITY_PAGE_TYPES`,
`PAGE_CANDIDATE_KEY`, `PAGE_CANDIDATE_SCHEMA`, `targetProblem`,
`validatePageCandidate` and the type `PageCandidate`;
`packages/core/test/index.test.ts` adds the five names in sort order.
`packages/core/src/staging/index.ts` adds `pageCandidateProposal`.
(serving-mcp defines an identical list as `ENTITY_TYPES` under
`src/serving/`; whichever lands second imports the other's — open question.)

## 2. Shared plumbing (`packages/connectors/src/legacy/`, NEW)

### 2.1 Mapping files (`mapping-file.ts`)

```ts
export interface LoadedMapping {
  raw: unknown; // parsed JSON
  hash: string; // sha256 hex of canonical JSON (keys sorted at every depth) — whitespace changes do not re-emit
  source: "file" | "inline";
}
export function defaultMappingPath(
  sourcePath: string,
  kind: "directory" | "file",
): string;
// directory → join(sourcePath, "kizuki-mapping.json"); file → `${sourcePath}.kizuki-mapping.json`
export function loadMapping(
  mapping: string | Record<string, unknown> | undefined,
  fallbackPath: string,
  connectorId: string,
): LoadedMapping;
// string → readFileSync(path) (≤ 1 MiB, else misconfigured); undefined → fallbackPath; object → inline.
// Missing file → KizukiError("misconfigured", `${connectorId}: mapping file not found: ${path}; see docs/legacy-import.md`)
// Malformed JSON → KizukiError("parse_error", `${connectorId}: mapping file is not valid JSON: ${path}`)
```

The sibling-default convention is what makes `kizuki ingest <id> --source
PATH` (main) and `kizuki import <id> --source PATH` (cli-verbs) work with
no new flag; §8 asks the CLI lanes for `--mapping`/`--report` later.

### 2.2 Coercion and sanitising (`coerce.ts`) — pure, table-tested

```ts
export function sanitizeLine(value: string, max: number): string;
// strips U+0000–U+001F and U+007F, collapses whitespace, trims, truncates by code points
export function slug(value: string, max = 64): string;
// NFKC → lowercase → runs of [^a-z0-9._-] → "-" → collapse "--" → trim "-" and "." at both ends
// → strip leading non-alphanumerics → truncate → "" becomes "page". Result satisfies PATH_SEGMENT.
export function subjectId(namespace: string, value: string): string | null;
// `${namespace}:${sanitizeLine(value, 200).toLowerCase()}` with "[[" / "]]" and a "|alias" suffix stripped
// first; null when the remainder is empty
export type Coerced =
  | {
      ok: true;
      value: FrontmatterValue;
      note: "kept" | "array_stringified" | "json_stringified" | "truncated";
    }
  | { ok: false; reason: "null" | "empty_array" | "unrepresentable" };
export function toFrontmatterValue(raw: unknown): Coerced;
// string → kept (> 4096 chars → truncated); finite number/boolean → kept; string[] → kept (> 256 → truncated);
// array of scalars → strings (array_stringified); array with nested / plain object → JSON.stringify ≤ 4096
// (json_stringified, then truncated); null/undefined → null; [] → empty_array; anything else → unrepresentable
export type TimestampFormat =
  | "rfc3339"
  | "sqlite_datetime"
  | "date"
  | "unix_seconds"
  | "unix_millis"
  | "js_date";
export function parseLegacyTimestamp(
  raw: unknown,
  format: TimestampFormat,
): string | null;
// rfc3339: isRfc3339(raw) → raw; sqlite_datetime: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/ → "T…Z";
// date: /^\d{4}-\d{2}-\d{2}$/ → "T00:00:00.000Z"; unix_*: finite number or numeric string → toISOString();
// js_date: new Date(raw) when finite → toISOString(). Anything else → null. Never throws.
export function matchesGlob(relpath: string, pattern: string): boolean;
// `*` = within one segment, `**` = any number of segments, `?` = one char; anchored; forward slashes only
```

### 2.3 Report files (`report-file.ts`)

```ts
export function resolveReportPath(
  report: string | undefined,
  sourcePath: string,
  connectorId: string,
): string | null;
// undefined → null; else resolve() absolute; refuses (misconfigured) a path inside the source directory
// (a .md report inside the wiki would be imported as a page next run) and any path under a "/.kizuki/" segment
export function writeReport(
  path: string,
  document: unknown,
  markdown: () => string,
): void;
// `.json` suffix → JSON.stringify(document, null, 2); anything else → markdown(); written to `${path}.<ulid>.tmp`
// with mode 0600 then renameSync (atomic replace); parent must exist (misconfigured otherwise)
```

## 3. `kizuki.import-legacy-wiki`

Layout (each file < 400 lines): `src/import-legacy-wiki/index.ts`
(connector, factory, id, manifest), `mapping.ts`, `frontmatter.ts`,
`scan.ts`, `plan.ts`, `report.ts`, `fixture.ts`.

### 3.1 Manifest

```ts
export const LEGACY_WIKI_CONNECTOR_ID = "kizuki.import-legacy-wiki" as const;
// { schema: "kizuki.connector/v1", connector_id, version: "0.1.0", kinds: ["page"],
//   capabilities: { backfill: true, sync: true, tombstones: true, purge: false, fixture: true },
//   required_secrets: [], emits_sensitivity_hint: true, auth_modes: ["none"] }
```

### 3.2 Config and mapping (`mapping.ts`)

```ts
export interface LegacyWikiConfig {
  path: string; // the wiki root directory
  mapping?: string | LegacyWikiMapping; // path, or inline; default defaultMappingPath(path, "directory")
  report?: string; // absolute path; .json → JSON, else Markdown; default: no file (report still in lastReport() and metadata)
}

export const LEGACY_WIKI_MAPPING_SCHEMA =
  "kizuki.legacy-wiki-mapping/v1" as const;
export interface LegacyWikiMapping {
  schema: typeof LEGACY_WIKI_MAPPING_SCHEMA;
  title: { field: string }; // default { field: "title" }
  type: {
    field: string; // default "type"
    values: Record<string, PageType | null>; // legacy value → enum; null = skip the page; default {}
    default: PageType; // REQUIRED
  };
  sensitivity: {
    field: string; // default "sensitivity"
    values: Record<string, PageSensitivity>; // default {}; identity for "public" | "personal" | "private"
    // NO default: an unmapped or absent value is an unlabeled page, by design
  };
  occurred_at: { field: string; format: TimestampFormat } | null; // default null → file mtime
  fields: Record<string, string | null>; // legacy key → "x-…" name or null (drop); default {}
  subjects: { field: string; role: SubjectRole; namespace: string } | null; // default null
  target: {
    mode: "flat" | "mirror"; // default "flat"
    directories: Record<PageType, string>; // default DEFAULT_DIRECTORIES; each value 1..7 valid segments
  };
  ignore: string[]; // glob subset over relpath; default []
}
export const DEFAULT_DIRECTORIES: Record<PageType, string> = {
  person: "entities",
  org: "entities",
  project: "entities",
  place: "entities",
  topic: "entities",
  fact: "facts",
  event: "events",
  source: "sources",
  rollup: "dashboards",
};
export function parseLegacyWikiMapping(raw: unknown): LegacyWikiMapping;
// KizukiError("misconfigured", `${LEGACY_WIKI_CONNECTOR_ID}: mapping.<json path>: <rule>`), e.g.
// "mapping.type.default: must be one of person | org | …", "mapping.fields.created: must be an x-* name or null",
// "mapping.subjects.namespace: must match /^[a-z][a-z0-9-]{0,31}$/", "mapping: unknown key foo".
// Unknown top-level or nested keys are refused (an owner's typo must not silently change the outcome).
// `fields` values must match /^x-[A-Za-z0-9][A-Za-z0-9_-]*$/ and be distinct; a `fields` key equal to the
// title/type/sensitivity/occurred_at/subjects field is refused ("already consumed by mapping.<x>.field").
```

### 3.3 Tolerant frontmatter (`frontmatter.ts`) — pure, bounded

```ts
export interface LegacyFrontmatter {
  status: "parsed" | "absent" | "unparsed";
  data: Record<string, unknown>; // {} unless parsed
  body: string; // text after the closing fence; the whole file when absent; the whole file when unparsed
  // and no closing fence exists
  problems: string[]; // human rules that fired (never field values)
}
export function parseLegacyFrontmatter(markdown: string): LegacyFrontmatter;
```

Detection: optional BOM, then a first line exactly `---`; the block ends at
the next line exactly `---` or `...`; no closing line → `unparsed`
("no closing fence"). Block ≤ 64 KiB else `unparsed` ("frontmatter exceeds
64 KiB"). Supported YAML subset: block mappings (`key: value`, keys
`[^\s:#][^:]*` trimmed), nested mappings and block sequences by space
indentation (depth ≤ 8, ≤ 500 keys total; tabs in indentation → `unparsed`),
sequences of scalars or of mappings (`- key: value` starts a mapping item),
single-line flow sequences `[a, "b", 'c']` and flow mappings `{a: 1}` (no
nesting inside flow, no multi-line flow), scalars: `"double"` with JSON
escapes, `'single'` with `''`, `true|false` (case-insensitive) → boolean,
`null|~|` (empty) → null, integers and decimals matching
`/^-?(0|[1-9]\d*)(\.\d+)?$/` → number, everything else (dates, times, bare
words, `0x…`, `1e3`) → the string verbatim; block scalars `|`, `|-`, `|+`,
`>`, `>-`, `>+` (literal / folded with the three chomping modes); `#`
comments outside quotes; a duplicate key keeps the first and records a
problem. Anchors `&`, aliases `*`, tags `!`, `? ` complex keys, directives
`%`, a second document → `unparsed` with the rule named. Never throws.

### 3.4 Scan (`scan.ts`)

```ts
export interface LegacyWikiFile {
  relpath: string; // forward slashes, relative to the root
  content: string; // utf-8 (fatal decode; a non-UTF-8 file is skipped)
  mtimeMs: number;
  size: number;
}
export interface ScanResult {
  files: LegacyWikiFile[]; // sorted by relpath (code-unit order)
  skipped: {
    relpath: string;
    reason:
      "symlink" | "not_utf8" | "too_large" | "unreadable" | "ignored" | "depth";
  }[];
  truncated: boolean; // MAX_FILES reached
}
export const MAX_FILES = 50_000;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_DEPTH = 16;
export async function scanLegacyWiki(
  root: string,
  ignore: string[],
): Promise<ScanResult>;
```

Walks with `readdir(withFileTypes)`; dot-entries (`.git`, `.obsidian`, …)
and the mapping file are never entered or listed; symlinks are skipped and
reported (never followed: a link out of the wiki is a traversal); only
`.md` and `.markdown` files; `ignore` globs via `matchesGlob`. Relpaths in
reports pass through `sanitizeLine(…, 200)` (file names are hostile).

### 3.5 Plan (`plan.ts`) — pure and deterministic

```ts
export interface PlanOptions {
  observedAt: string;
  mappingHash: string;
}
export function planLegacyWiki(
  scan: ScanResult,
  mapping: LegacyWikiMapping,
  opts: PlanOptions,
): { events: CaptureEventInput[]; report: LegacyWikiReport };
```

Per file, in relpath order:

1. `parseLegacyFrontmatter(content)`.
2. **Type**: `data[type.field]` → string (numbers stringified). Present and
   in `values` → `mapped` (null → skip page, reason `type_excluded`); present
   but not in `values` → `default` with decision `unmapped_value` and
   confidence 0.5; absent → `default`, decision `defaulted`, confidence 0.75;
   mapped → confidence 1. Non-string, non-number value → treated as absent
   with a field note `unusable`.
3. **Title**: `data[title.field]` string → `sanitizeLine(…, 200)`
   (`source: "field"`); else the first `# ` heading of the body
   (`"heading"`); else the file stem (`"filename"`).
4. **Sensitivity**: `data[sensitivity.field]` string → `values[v] ??
(v ∈ {public,personal,private} ? v : null)`. A label → decision
   `labeled`, `sensitivity_hint` on the event, `x-legacy-sensitivity` in the
   extensions; absent → `unlabeled`; present but unmapped → `unmapped_value`
   (no hint; the raw value, sanitised ≤ 64, appears in the report so the
   owner can extend `values`).
5. **occurred_at**: `parseLegacyTimestamp(data[occurred_at.field], format)`
   → else `new Date(mtimeMs).toISOString()` with a note `occurred_at:
mtime`. (A copied wiki changes mtimes and therefore hashes; mapping a
   date field is the stable choice — say so in the doc.)
6. **Subjects**: when `mapping.subjects` is set, `data[field]` string or
   string[] → `subjectId(namespace, v)` each, deduped, ≤ 200, `display_name
= sanitizeLine(v, 120)`, `role` from the mapping.
7. **Fields**: every remaining key of `data` (the consumed title/type/
   sensitivity/occurred_at/subjects fields are recorded `mapped`): `fields[key]
=== null` → `dropped: by_mapping`; `fields[key]` string → that name; else
   `x-${slug(key)}` with note `renamed`; a name already produced by another
   key → `dropped: name_conflict`; the value through `toFrontmatterValue`
   (`kept` / `coerced:<note>` / `dropped:<reason>`). Keys that slug to `x-`
   (empty) → `dropped: unnameable`. Values are never in the report; names,
   outcomes and reasons are.
8. **Target**: `dir = mapping.target.directories[type]`; `flat` →
   `${dir}/${slug(stem)}`; `mirror` → `${dir}/${legacy dirs slugged}/${slug(stem)}`
   (falls back to flat with note `target: flattened` when the mirror would
   exceed 8 segments). `targetProblem(target)` must be null (it is, by
   construction of `slug`; asserted). A target already taken in this run →
   `-2`, `-3`, … (note `target_collision`).
9. **Event**:

```ts
{
  schema: "kizuki.event/v1", connector_id: LEGACY_WIKI_CONNECTOR_ID,
  source_record_id: relpath, kind: "page",
  occurred_at, observed_at: opts.observedAt,
  text: frontmatter.body,           // ≤ 262 144 code points; beyond → truncated, metadata.text_truncated: true
  subjects, ...(hint ? { sensitivity_hint: hint } : {}),
  deleted: false, attachments: [],
  metadata: {
    relpath, size, mapping_hash: opts.mappingHash,
    frontmatter_status: "parsed" | "absent" | "unparsed",
    frontmatter: data (JSON-safe copy, ≤ 64 KiB serialized else omitted with frontmatter_omitted: "size"),
    page_candidate: {                 // PAGE_CANDIDATE_KEY; validated by core's validatePageCandidate before emit (asserted)
      schema: "kizuki.page-candidate/v1", type, title, target, confidence,
      extensions: { ...x-fields, "x-legacy-path": relpath, "x-legacy-type"?: raw type value ≤ 64,
                    "x-legacy-sensitivity"?: label, "x-legacy-title-source": "field" | "heading" | "filename" },
    },
    migration: <this page's LegacyWikiPageReport minus relpath>,   // the decision record travels with the evidence
  },
}
```

10. Skipped pages (type excluded, scan skips) produce no event and one
    report entry with `outcome: "skipped"`.

Determinism: two calls with equal inputs return deep-equal outputs (test).
Nothing here touches the filesystem.

### 3.6 Report (`report.ts`)

```ts
export const LEGACY_WIKI_REPORT_SCHEMA =
  "kizuki.legacy-wiki-report/v1" as const;
export interface LegacyWikiFieldReport {
  key: string; // legacy key, sanitised ≤ 120
  outcome: "mapped" | "renamed" | "kept" | "coerced" | "dropped";
  to?: string; // "title" | "type" | "sensitivity" | "occurred_at" | "subjects" | "x-…"
  note?:
    | "array_stringified"
    | "json_stringified"
    | "truncated"
    | "by_mapping"
    | "name_conflict"
    | "unnameable"
    | "null"
    | "empty_array"
    | "unrepresentable"
    | "unusable";
}
export interface LegacyWikiPageReport {
  relpath: string;
  outcome: "imported" | "skipped";
  skip_reason?: "type_excluded" | ScanResult["skipped"][number]["reason"];
  target: string | null;
  kind: "entity" | "claim" | null;
  frontmatter: { status: "parsed" | "absent" | "unparsed"; problems: string[] };
  type: {
    legacy: string | null;
    mapped: PageType | null;
    decision: "mapped" | "defaulted" | "unmapped_value" | "excluded";
  };
  title: { source: "field" | "heading" | "filename" };
  sensitivity: {
    legacy: string | null;
    label: PageSensitivity | null;
    decision: "labeled" | "unlabeled" | "unmapped_value";
  };
  occurred_at: "field" | "mtime";
  subjects: number;
  fields: LegacyWikiFieldReport[];
  notes: string[]; // "target_collision", "target: flattened", "text_truncated", …
}
export interface LegacyWikiReport {
  schema: typeof LEGACY_WIKI_REPORT_SCHEMA;
  generated_at: string;
  mapping_hash: string;
  counts: {
    files: number;
    imported: number;
    skipped: number;
    labeled: number;
    unlabeled: number;
    unmapped_sensitivity: number;
    types: Record<PageType, number>;
    type_defaulted: number;
    type_unmapped: number;
    fields_renamed: number;
    fields_dropped: number;
    fields_coerced: number;
    frontmatter_unparsed: number;
    scan_truncated: boolean;
  };
  pages: LegacyWikiPageReport[]; // relpath order
}
export function renderLegacyWikiReport(report: LegacyWikiReport): string; // Markdown: a counts table, then one
// "## <relpath>" section per page with decision lines and a field table; every string through sanitizeLine;
// "|" in cells escaped; no absolute path anywhere
```

The report carries page titles? No: titles are owner prose and the report
may sit outside the vault. It carries relpaths, legacy field NAMES, the raw
type and sensitivity VALUES (≤ 64 chars each — they are vocabulary, not
content), decisions and counts. Nothing else from the pages.

### 3.7 Connector (`index.ts`)

```ts
export class LegacyWikiConnector implements Connector {
  readonly path: string;
  readonly mapping: LegacyWikiMapping;
  readonly mappingHash: string;
  readonly reportPath: string | null;
  constructor(config: LegacyWikiConfig); // requirePathConfig; loadMapping; parseLegacyWikiMapping; resolveReportPath —
  // all synchronous, all before any I/O on the wiki
  manifest(): Manifest;
  health(): Promise<HealthReport>; // pathHealth(path, "directory"); "ok" → after a run whose scan had
  // unreadable/not_utf8 skips → "degraded" with detail "<n> file(s) skipped; see the report" (counts only)
  connect(_: SecretResolver): Promise<void>; // no-op (nothing to resolve)
  backfill(cursor: Cursor | null): Promise<SyncBatch>;
  sync(cursor: Cursor | null): Promise<SyncBatch>;
  revoke(): Promise<void>; // no-op
  purgeSource(subject_id: string): Promise<PurgePlan>; // empty plan (the files are the owner's; purge is ledger-side)
  fixture(): Promise<CaptureEventInput[]>;
  lastReport(): LegacyWikiReport | null; // from the most recent backfill/sync in this instance
}
export function createLegacyWikiConnector(
  config: LegacyWikiConfig,
): LegacyWikiConnector;
```

Cursor (`cursor.ts` section of `index.ts` or its own file if > 400 lines):

```ts
interface LegacyWikiCursor {
  schema: "kizuki.legacy-wiki-cursor/v1";
  mapping_hash: string;
  files: Record<string, string>; // relpath → sha256 hex of content
}
```

- `backfill(cursor)`: validate the cursor shape when non-null
  (`parse_error` "malformed cursor" on any deviation; contents otherwise
  ignored — a backfill is always a full walk); `scanLegacyWiki` →
  `planLegacyWiki` → write the report file when configured → return
  `{ events, cursor: snapshot }`. The cursor is never null (markdown-folder
  precedent: `sync(null)` must not forget the walk). `backfill(null)` twice
  → identical events (`observed_at` is outside the hash).
- `sync(cursor)`: null → `backfill(null)`. Else full scan + plan; when
  `cursor.mapping_hash !== mappingHash` → emit every page (the decisions
  changed; the ledger dedupes unchanged content by hash only if the
  metadata is identical, and it is not — that is the point) with
  `report.notes` containing `mapping_changed`; otherwise emit only pages
  whose content hash differs from the snapshot or that are new; a relpath
  in the snapshot that is gone → tombstone
  `{ …, source_record_id: relpath, kind: "page", occurred_at: observedAt,
observed_at: observedAt, text: "", subjects: [], deleted: true,
attachments: [], metadata: { relpath } }`. Events sorted by
  `source_record_id`; return the new snapshot.
- Any `KizukiError` propagates (the runner keeps the previous cursor).

### 3.8 Fixture (`fixture.ts`)

```ts
export const LEGACY_WIKI_FIXTURE: {
  mapping: LegacyWikiMapping;
  files: LegacyWikiFile[];
};
```

Nine synthetic pages under `people/`, `orgs/`, `notes/`, `journal/`,
`templates/`, run through the REAL `scan`-shaped input + `planLegacyWiki`
with `observedAt "2026-03-01T00:00:00.000Z"` and fixed mtimes:
`people/ada.md` (`type: Person`, `visibility: friends` → personal,
`born: 1815`, `aliases: [Ada L.]`, `tags:` block list, body with a
`[[acme]]` wikilink); `people/grace.md` (`visibility: secret` → private,
`links:` nested mapping → json_stringified); `people/linus.md` (no
sensitivity → unlabeled, `type` absent → defaulted); `orgs/acme.md`
(`type: Company` → org, `visibility: public`); `notes/plan.md` (`type:
Plan` → unmapped_value → default topic, `description: |` block scalar,
`draft: true`); `notes/no-frontmatter.md` (absent); `notes/broken.md`
(`&anchor` → unparsed, still imported with heading title);
`journal/2026-01-01.md` (`created: 2026-01-01` → occurred_at field,
`visibility: nope` → unmapped_value); `templates/person.md` (`type:
Template` → null → skipped). Mapping: `type.values { Person: person,
Company: org, Template: null }`, `default: topic`, `sensitivity.field:
visibility` with `{ friends: personal, secret: private, public: public }`,
`fields { created: "x-created", draft: null }`, `occurred_at { field:
created, format: date }`, `subjects { field: people, role: about,
namespace: legacy-wiki }` (only `notes/plan.md` has `people: [Ada, Grace]`),
`ignore: ["templates/**"]`… no: `templates/person.md` must reach the
type-exclusion path, so `ignore: ["drafts/**"]` and one `drafts/x.md` file
that is ignored. `fixture()` returns the eight imported events.

## 4. `kizuki.import-legacy-events`

Layout: `src/import-legacy-events/index.ts`, `mapping.ts`, `source.ts`,
`rows.ts`, `report.ts`, `fixture.ts`.

### 4.1 Manifest

```ts
export const LEGACY_EVENTS_CONNECTOR_ID =
  "kizuki.import-legacy-events" as const;
// { schema, connector_id, version: "0.1.0",
//   kinds: sorted union of kindsOf(this.mapping) and kindsOf(LEGACY_EVENTS_FIXTURE.mapping),
//   capabilities: { backfill: true, sync: true, tombstones: mapping.deleted !== null, purge: false, fixture: true },
//   required_secrets: [], emits_sensitivity_hint: mapping.sensitivity_hint !== null, auth_modes: ["none"] }
export function kindsOf(mapping: LegacyEventsMapping): string[]; // const, or values ∪ default
```

`kinds` is instance-derived: this connector emits exactly the kinds the
owner's mapping can produce plus the fixture's (`message`, `note`); the
fixture must validate against the same manifest (conformance checks
`kind ∈ manifest.kinds` on fixture events). Stated in the doc.

### 4.2 Config and mapping (`mapping.ts`)

```ts
export interface LegacyEventsConfig {
  path: string; // .db | .sqlite | .sqlite3 → sqlite; .jsonl | .ndjson → jsonl; else `format` is required
  format?: "sqlite" | "jsonl";
  mapping?: string | LegacyEventsMapping; // default defaultMappingPath(path, "file")
  report?: string;
}
export const LEGACY_EVENTS_MAPPING_SCHEMA =
  "kizuki.legacy-events-mapping/v1" as const;
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/; // table and column names; interpolated only as "quoted" identifiers
export const KIND = /^[a-z][a-z0-9_]{0,31}$/;
export type ColumnRef = { column: string };
export interface LegacyEventsMapping {
  schema: typeof LEGACY_EVENTS_MAPPING_SCHEMA;
  table: string | null; // sqlite only; REQUIRED for sqlite; must be null/absent for jsonl
  source_record_id: ColumnRef; // REQUIRED; string | number → String(v); "" / null → row skipped
  kind:
    | { const: string }
    | {
        column: string;
        values: Record<string, string>;
        default: string | null;
      }; // REQUIRED
  occurred_at: ColumnRef & { format: TimestampFormat }; // REQUIRED
  observed_at: (ColumnRef & { format: TimestampFormat }) | null; // default null → import time
  text: { column: string } | { columns: string[]; join: string }; // REQUIRED; null cells → ""; join ≤ 8 chars
  subjects: {
    column: string;
    role: SubjectRole;
    namespace: string;
    split: string | null;
  }[]; // default []
  sensitivity_hint:
    | { const: PageSensitivity }
    | { column: string; values: Record<string, PageSensitivity> }
    | null; // default null
  deleted: {
    column: string;
    true_values: (string | number | boolean)[];
  } | null; // default null
  metadata: { columns: "rest" | string[] }; // default { columns: "rest" }
}
export function parseLegacyEventsMapping(
  raw: unknown,
  format: "sqlite" | "jsonl",
): LegacyEventsMapping;
// misconfigured with the json path and rule; unknown keys refused; every column name must match IDENTIFIER;
// kind values and default must match KIND; a column may be consumed by at most one of
// source_record_id/kind/occurred_at/observed_at/text/deleted/sensitivity_hint ("column X is consumed twice");
// subjects may share columns with nothing but each other; `__rowid` is refused as a column name
```

### 4.3 Sources (`source.ts`)

```ts
export interface LegacyRow {
  position: number; // sqlite: rowid; jsonl: byte offset just past the line's "\n"
  values: Record<string, unknown> | null; // null when the line is not a JSON object / too long / malformed
  problem?: "malformed_json" | "not_an_object" | "line_too_long";
}
export interface LegacyRowSource {
  kind: "sqlite" | "jsonl";
  columns: string[] | null; // sqlite: PRAGMA table_info names; jsonl: null
  read(after: number, limit: number): LegacyRow[]; // strictly increasing positions, ≤ limit rows
  size(): number; // sqlite: max(rowid) or 0; jsonl: file byte length
  close(): void;
}
export function openSqliteSource(path: string, table: string): LegacyRowSource;
// new Database(path, { readonly: true }); table must exist (PRAGMA table_info non-empty, else misconfigured
// "table not found"); probe `SELECT rowid FROM "t" LIMIT 0` — failure → misconfigured "table has no rowid;
// export it to JSONL"; read = `SELECT rowid AS __rowid, * FROM "<t>" WHERE rowid > ? ORDER BY rowid LIMIT ?`;
// the identifier is validated by IDENTIFIER and embedded with doubled double-quotes; no other SQL exists
export function openJsonlSource(path: string): LegacyRowSource;
// openSync/readSync in 1 MiB chunks from `after`; split on "\n" (a trailing "\r" stripped); a line > 1 MiB
// → { values: null, problem: "line_too_long" } and the reader skips to the next "\n"; a final unterminated
// line is a row whose position is the file size; UTF-8 decoded with fatal: false (replacement chars, no throw)
export const BATCH_ROWS = 1000;
```

SQLite cell values: `number`, `string`, `null`, `bigint` (→ decimal string),
`Uint8Array` (blob → dropped from metadata with `metadata.__blobs: [column]`
and a report count; never the bytes). `readonly: true` means an inaccessible
WAL side file surfaces as `misconfigured` with the sqlite message (which
names no row content).

### 4.4 Rows to events (`rows.ts`) — pure

```ts
export type RowSkipReason =
  | "malformed_json"
  | "not_an_object"
  | "line_too_long"
  | "source_record_id_missing"
  | "occurred_at_invalid"
  | "observed_at_invalid"
  | "kind_unmapped";
export function rowToEvent(
  row: LegacyRow,
  mapping: LegacyEventsMapping,
  opts: { observedAt: string; mappingHash: string },
):
  | { event: CaptureEventInput }
  | { skipped: { position: number; reason: RowSkipReason } };
```

- `source_record_id`: `String(v)` for string/number/bigint; ≤ 512 chars
  (longer → sha256 hex of the value with `metadata.__source_record_id_hashed:
true`); empty → skipped.
- `kind`: `const`, or `values[String(v)] ?? default`; null → skipped.
- `occurred_at` / `observed_at` via `parseLegacyTimestamp`; invalid →
  skipped (`observed_at` falls back to `opts.observedAt` only when the
  mapping has no `observed_at`).
- `text`: the column, or the columns joined with `join` after dropping
  null/empty parts; ≤ 262 144 code points (`metadata.text_truncated`).
- `subjects`: per entry, the cell as string, or JSON array of strings, or
  split by `split`; each → `subjectId(namespace, part)` with `display_name`
  when the trimmed part differs from the id's local part; dedupe by
  `(subject_id, role)`; ≤ 200.
- `sensitivity_hint`: `const`, or `values[String(v)]`; unmapped → no hint.
- `deleted`: `true_values.some(t => t === v || String(t) === String(v))` →
  tombstone: `text: ""`, `subjects: []`, `attachments: []`, `metadata:
{ legacy_deleted: true, mapping_hash }`, `occurred_at` as mapped.
- `metadata` (non-tombstone): `{ mapping_hash, ...rest }` where `rest` =
  every column not consumed by the mapping (or the listed columns), values
  JSON-safe (blobs dropped as above; strings > 16 384 chars truncated with
  `__truncated: [column]`); `__rowid` never included.

### 4.5 Connector, cursor, report (`index.ts`, `report.ts`)

```ts
export class LegacyEventsConnector implements Connector {
  readonly path: string;
  readonly format: "sqlite" | "jsonl";
  readonly mapping: LegacyEventsMapping;
  readonly mappingHash: string;
  readonly reportPath: string | null;
  constructor(config: LegacyEventsConfig);
  manifest(): Manifest;
  health(): Promise<HealthReport>; // pathHealth(path, "file"); after a run with skipped rows
  // → "degraded", detail "<n> row(s) skipped; see the report"
  connect(_: SecretResolver): Promise<void>;
  backfill(cursor): Promise<SyncBatch>;
  sync(cursor): Promise<SyncBatch>;
  revoke(): Promise<void>;
  purgeSource(subject_id): Promise<PurgePlan>;
  fixture(): Promise<CaptureEventInput[]>;
  lastReport(): LegacyEventsReport | null;
}
export function createLegacyEventsConnector(
  config: LegacyEventsConfig,
): LegacyEventsConnector;

interface LegacyEventsCursor {
  schema: "kizuki.legacy-events-cursor/v1";
  mapping_hash: string;
  position: number; // last consumed position
  done: boolean;
}
export const LEGACY_EVENTS_REPORT_SCHEMA =
  "kizuki.legacy-events-report/v1" as const;
export interface LegacyEventsReport {
  schema: typeof LEGACY_EVENTS_REPORT_SCHEMA;
  generated_at: string;
  mapping_hash: string;
  format: "sqlite" | "jsonl";
  run: {
    from_position: number;
    to_position: number;
    done: boolean;
    restarted: "mapping_changed" | "source_shrank" | null;
  };
  counts: {
    rows: number;
    events: number;
    tombstones: number;
    skipped: number;
    blobs_dropped: number;
    kinds: Record<string, number>;
  };
  skipped: { position: number; reason: RowSkipReason }[]; // first 1000; positions only, never values
  columns: {
    consumed: string[];
    metadata: string[] | "rest";
    unknown_in_mapping: string[];
  }; // sqlite: mapped columns
  // absent from PRAGMA table_info are listed here AND make backfill throw misconfigured before reading a row
}
export function renderLegacyEventsReport(report: LegacyEventsReport): string;
```

- `backfill(cursor)`: `null` → `position 0`; else decode (`parse_error`
  on deviation). Restart from 0 when `mapping_hash` differs
  (`restarted: "mapping_changed"`) or `position > source.size()`
  (`"source_shrank"`; a rewritten export). `read(position, BATCH_ROWS)` →
  `rowToEvent` each → `done = rows.length < BATCH_ROWS` → write the report
  when configured → `{ events, cursor: { …, position: last row position or
unchanged, done } }`. When `done` and no rows: `{ events: [], cursor }`
  unchanged. So `runBackfill` invoked repeatedly pages through the table
  (it hands the checkpoint cursor back to `backfill`), and `backfill(null)`
  twice yields the same first page.
- `sync(cursor)`: `null` → `backfill(null)`; else exactly `backfill(cursor)`
  (rows appended after the last position are new evidence; a row flagged
  deleted is a tombstone). There is no other change detection: an in-place
  edit of an already-imported row is invisible until the owner re-imports
  from scratch (disconnect + connect, or a mapping change), and the doc says
  so. This is an export importer, not live sync.
- `purgeSource`: empty plan; `revoke`/`connect`: no-ops.

### 4.6 Fixture (`fixture.ts`)

```ts
export const LEGACY_EVENTS_FIXTURE: {
  mapping: LegacyEventsMapping; // table "events", kind values { msg: message, note: note } default null,
  // occurred_at { column: ts, format: unix_seconds }, text { columns: [subject, body], join: "\n\n" },
  // subjects [{ column: sender, role: from, namespace: legacy }, { column: recipients, role: to, namespace: legacy, split: "," }],
  // sensitivity_hint { column: visibility, values: { pub: public, priv: private } }, deleted { column: is_deleted, true_values: [1, true, "1"] }
  rows: Record<string, unknown>[]; // 12 rows: ada→grace message, grace→[ada,linus] message with priv, a note,
  // a row with an unmapped kind (skipped), a row with ts "soon" (skipped), a row with an empty id (skipped),
  // a deleted row (tombstone), a row with a JSON-array recipients cell, a row with a 20k-char body (truncated),
  // a row with extra columns (→ metadata), a row with a null body, a row with a bigint-looking id
  columns: string[]; // for the sqlite CREATE TABLE in tests
  sql: string; // `CREATE TABLE events (id TEXT, type TEXT, ts INTEGER, subject TEXT, body TEXT, sender TEXT,
  // recipients TEXT, visibility TEXT, is_deleted INTEGER, extra TEXT, payload BLOB)` + INSERTs — used by tests
  // and the acceptance script to build the synthetic database with bun:sqlite
};
export function fixtureRows(): LegacyRow[]; // rows with positions 1..n
```

`fixture()` = `fixtureRows()` through `rowToEvent` with `observedAt
"2026-03-01T00:00:00.000Z"`: nine events (including the tombstone).

## 5. Registry, index, conformance

- `packages/connectors/src/registry.ts`: `REGISTRY` gains
  `[LEGACY_WIKI_CONNECTOR_ID]: createLegacyWikiConnector` and
  `[LEGACY_EVENTS_CONNECTOR_ID]: createLegacyEventsConnector`; `getConnector`
  gains the two overloads. Added LAST, after §7's conformance passes
  (connector-work skill step 7).
- `packages/connectors/src/index.ts` re-exports: the two ids, factories,
  classes, config types, `LEGACY_WIKI_FIXTURE`, `LEGACY_EVENTS_FIXTURE`,
  `parseLegacyWikiMapping`, `parseLegacyEventsMapping`,
  `parseLegacyFrontmatter`, `planLegacyWiki`, `rowToEvent`,
  `renderLegacyWikiReport`, `renderLegacyEventsReport`, the mapping/report
  types.
- `packages/connectors/test/conformance.test.ts` (extend the single "all
  registry connectors pass conformance" test so the registry count stays
  derived, never asserted): legacy-wiki on a temp copy of
  `LEGACY_WIKI_FIXTURE.files` + mapping file at the default path, tombstone
  hooks `prepare = backfill(null).cursor`, `mutate = unlink one page`;
  legacy-events twice — sqlite (temp db built from `LEGACY_EVENTS_FIXTURE.sql`,
  mapping at `<db>.kizuki-mapping.json`, `prepare` loops `backfill` until
  `done`, `mutate` inserts a row with `is_deleted = 1`) and jsonl (temp
  file, `mutate` appends a deleted line). All five results
  `{ pass: true, failures: [] }`.

## 6. Documentation

`docs/legacy-import.md` (NEW): what each importer is (an export importer,
not live sync), the sibling mapping-file convention, both mapping schemas
with every key, default and rule, the complete fixture mappings as the
worked examples (copied verbatim from `LEGACY_WIKI_FIXTURE.mapping` and
`LEGACY_EVENTS_FIXTURE.mapping` — a test parses every ```json block in the
doc through the matching parser so the examples cannot rot), the report
formats, what "unlabeled" means and how the owner labels a group with
`kizuki review --batch` (main's TUI), the honest limits (§4.5 in-place
edits; mtime-based `occurred_at`; frontmatter subset; no wikilink rewrite;
no attachments), and the run recipe using the verbs on main (`init`,
`ingest <id> --source`, `proposals`, `promote --sensitivity`), with a note
that cli-verbs renames `ingest` to `import`. Neutral names only.

Root `README.md`, "Status" section, one added sentence: "Two migration
importers for a previous personal-knowledge estate (a markdown wiki, a
SQLite/JSONL event table) ship as connectors driven by owner-written mapping
files; see `docs/legacy-import.md`." Nothing else (cli-verbs and serving-mcp
rewrite other sections).

## 7. Tests

Baseline 515. Add ≥ 95. Synthetic fixtures only; `mkdtempSync` temp dirs;
no network; nothing read outside the worktree.

`packages/core/test/`:

- `page-candidate.test.ts` (NEW, ≥ 14): `validatePageCandidate` returns
  null when the key is absent; accepts the wiki fixture candidates; refuses
  wrong schema, `type` outside `PAGE_TYPES`, empty/201-char/control-char
  title, target with `..`, a 9-segment target, a 65-char segment, an
  extension key without `x-`, an extension named `x-` only, a reserved key
  smuggled as extension (`sensitivity`), 65 extension keys, a 4097-char
  string, a non-string array, confidence 1.5; `targetProblem` messages
  equal promote's former strings.
- `staging/producers.test.ts` (extend, ≥ 6): an event with a valid
  candidate yields entity stubs per subject plus ONE `entity` (person) or
  `claim` (fact) proposal with `target`, verbatim body, frontmatter
  `{ type, title, ...x-…, "x-connector", "x-capture-kind",
"x-source-record-id" }` and no reserved key; an extension `x-connector`
  is overwritten by the floor's value; an INVALID candidate falls back to
  the blockquoted capture note; a tombstone yields nothing; `renderPage` +
  `validatePage` accept the produced proposal for every sensitivity;
  refiling the same page is `duplicate`.
- `staging/promote.test.ts` (extend, 2): a candidate proposal promotes to
  `<target>.md` with `title`, `type`, the `x-*` keys and `sources`; a
  second candidate proposal for the same target after promotion is refused
  with "already exists".
- `index.test.ts`: the five new names.
- `staging/invariants.test.ts`: unchanged and green (the new files contain
  no `promote(` call).

`packages/connectors/test/`:

- `legacy-coerce.test.ts` (≥ 14): `slug` vectors (unicode, leading
  symbols, length, empty → `page`, result always passes `targetProblem`);
  `toFrontmatterValue` per branch; `parseLegacyTimestamp` per format plus
  rejects; `matchesGlob` (`*`, `**`, `?`, anchoring, no backslash);
  `subjectId` strips wikilink brackets and aliases.
- `legacy-wiki-frontmatter.test.ts` (≥ 18): every construct in §3.3 with
  exact expected objects; BOM; CRLF; `...` closer; duplicate key keeps
  first + problem; tabs → unparsed; anchor/alias/tag/second document →
  unparsed with the rule named; 64 KiB + 1 → unparsed; 501 keys → unparsed;
  depth 9 → unparsed; no closing fence → unparsed with the whole file as
  body; a body starting with `---` after a valid block stays body; never
  throws on 200 random byte strings (fuzz, fixed seed).
- `legacy-wiki-mapping.test.ts` (≥ 10): defaults applied; every refusal in
  §3.2 with its exact message prefix; `fields` targeting a consumed field
  refused; inline object and file forms give the same `hash`; whitespace
  changes keep the hash; missing file names the default path.
- `legacy-wiki-plan.test.ts` (≥ 20): the fixture's nine pages → literal
  expectations for target, kind, hint, `x-*` keys (values included — this
  is the connector's own test), confidence, `frontmatter_status`, and the
  full `LegacyWikiPageReport` of `people/ada.md`, `notes/plan.md`,
  `notes/broken.md`, `templates/person.md`; determinism (deep-equal on two
  runs); collision suffixing; mirror mode and its 8-segment fallback;
  `unmapped_value` sensitivity produces no hint; every emitted event
  passes `validateEventInput` and its candidate passes
  `validatePageCandidate`; the report JSON contains no page body text
  (assert a sentinel phrase from a fixture body is absent) and no absolute
  path; `renderLegacyWikiReport` escapes `|` and control sequences.
- `legacy-wiki-connector.test.ts` (≥ 12): constructor refuses a missing
  mapping with the default path in the message; `backfill(null)` on a temp
  copy of the fixture; `sync` emits only changed/new pages and a tombstone
  for a removed one, with the exact tombstone shape; a mapping change
  re-emits every page and the report notes it; symlink to a file outside
  the wiki is skipped and reported, never read (place a sentinel outside
  and assert it is absent from every event); a non-UTF-8 file is skipped;
  a 4 MiB + 1 file is skipped; the report file is written 0600, atomically
  (no `.tmp` left), as JSON for `.json` and Markdown otherwise; a report
  path inside the wiki is refused; `health` `ok` then `degraded` after a
  run with unreadable skips; `lastReport()` equals the written JSON.
- `legacy-events-mapping.test.ts` (≥ 10): defaults; every refusal in
  §4.2; `kindsOf`; `__rowid` refused; sqlite requires `table`, jsonl
  refuses it.
- `legacy-events-source.test.ts` (≥ 12): sqlite: table not found; `WITHOUT
ROWID` refused with the JSONL hint; keyset paging across 2 500 rows in
  pages of 1 000 with strictly increasing positions and no row twice;
  bigint and blob cells; jsonl: chunk boundary inside a line; CRLF; a 1 MiB
  - 1 line skipped and the next line read; final unterminated line;
    malformed line reported by position; `size()`.
- `legacy-events-rows.test.ts` (≥ 12): the twelve fixture rows → literal
  expectations (nine events incl. the tombstone shape, three skips with
  reasons); JSON-array and split subjects; sensitivity const/values;
  `metadata` "rest" vs listed; blob dropped with `__blobs`; long id hashed;
  text truncation; no `__rowid` in metadata; every event passes
  `validateEventInput`.
- `legacy-events-connector.test.ts` (≥ 12): paging through
  `runBackfill`-style repeated `backfill(cursor)` until `done`; `backfill
(null)` twice equal; `sync` after an appended row emits only it; a
  deleted row → tombstone through `runSync` in a real ledger withdraws the
  pending proposal (`cascadeTombstone` end to end); mapping change and
  shrunken file restart with the report reason; malformed cursor →
  `parse_error`; the report lists skips by position only (assert no cell
  value appears); `health` degraded after skips; the raw report bytes and
  every `KizukiError.message` never contain a row's body text (sentinel);
  columns missing from the table → `misconfigured` before any row is read.
- `docs.test.ts` (≥ 2): every ```json block in `docs/legacy-import.md`
  parses through the parser its preceding heading names; the two fixture
  mappings appear verbatim.
- `conformance.test.ts` (extend, §5) and `registry.test.ts` (unchanged).

## 8. Open coordination (not blockers; listed in the result)

- CLI lanes: `--mapping PATH` and `--report PATH` on `connect`/`import`
  once `HostState.config` is free-form (cli-wave2 §2); until then the
  sibling-default convention carries both importers.
- The TUI's `--batch` applies ONE label to every eligible item; a
  migration with mixed `x-legacy-sensitivity` values would be served better
  by grouping the batch by that key. TUI lane's call.
- serving-mcp's `ENTITY_TYPES` and this lane's `ENTITY_PAGE_TYPES` are the
  same list; the second to land imports the first.
- `KizukiError` moving to core (oauth-core / imap-ics): this lane imports
  it from `../errors`, which both keep valid.

## Acceptance

```
bun install --frozen-lockfile                                            # exit 0; bun.lock unchanged
bun run typecheck                                                        # exit 0
bun test                                                                 # 0 fail; ≥ 610 pass (515 + ≥ 95)
bun test packages/connectors/test/conformance.test.ts                    # 1 pass; five connectors, all { pass: true, failures: [] }
bun run scripts/verify-network.ts                                        # "network source verification passed"
bun run verify                                                           # exit 0 (denylist over tracked text AND reachable commit messages)
git diff --stat main..HEAD -- '*package.json' bun.lock | cat             # empty
grep -rn 'promote(' packages/connectors/src packages/core/src/contracts/page-candidate.ts packages/core/src/staging/page-candidate.ts   # no output
grep -rnE 'fetch\(|Bun\.serve|Bun\.connect|node:(http|https|net|tls|dns)' packages/connectors/src   # no output
grep -rn 'console\.' packages/connectors/src/legacy packages/connectors/src/import-legacy-wiki packages/connectors/src/import-legacy-events   # no output

# --- legacy-wiki through the verbs on main ---
T=$(mktemp -d); mkdir -p $T/wiki/people $T/wiki/notes
printf -- '---\ntitle: Ada\ntype: Person\nvisibility: friends\nborn: 1815\ntags:\n  - math\n  - acme\n---\n# Ada\n\nMet at the [[acme]] library.\n' > $T/wiki/people/ada.md
printf -- '---\ntitle: Plan\nstatus: wip\n---\nAn unlabeled page.\n' > $T/wiki/notes/plan.md
printf '%s\n' '{"schema":"kizuki.legacy-wiki-mapping/v1","type":{"field":"type","values":{"Person":"person"},"default":"topic"},"sensitivity":{"field":"visibility","values":{"friends":"personal"}}}' > $T/wiki/kizuki-mapping.json
W=$T/wiki bun -e 'import { createLegacyWikiConnector } from "./packages/connectors/src"; const c = createLegacyWikiConnector({ path: process.env.W, report: process.env.W + "-report.json" }); const b = await c.backfill(null); console.log(b.events.map(e => `${e.source_record_id}:${e.sensitivity_hint ?? "unlabeled"}:${e.metadata.page_candidate.target}`).join(" ")); const r = c.lastReport(); console.log(r.counts.labeled, r.counts.unlabeled, r.pages.find(p => p.relpath === "notes/plan.md").fields.map(f => `${f.key}->${f.to ?? f.outcome}`).join(","))'
                                                                         # notes/plan.md:unlabeled:facts/plan people/ada.md:personal:entities/ada   (wait: default type topic → entities/plan)
                                                                         # correct expected line: "notes/plan.md:unlabeled:entities/plan people/ada.md:personal:entities/ada" then "1 1 title->title,status->x-status"
ls -l $T/wiki-report.json | awk '{print $1}'                             # -rw-------
grep -c '"Met at the' $T/wiki-report.json                                # 0 (no page text in the report)
bun packages/cli/src/main.ts init $T/vault                               # prints the vault path
bun packages/cli/src/main.ts ingest kizuki.import-legacy-wiki --vault $T/vault --source $T/wiki
                                                                         # events_stored=2 duplicates=0 proposals_created=2 withdrawn=0 retractions_filed=0
bun packages/cli/src/main.ts ingest kizuki.import-legacy-wiki --vault $T/vault --source $T/wiki
                                                                         # events_stored=0 duplicates=0 proposals_created=0 withdrawn=0 retractions_filed=0   (sync: unchanged wiki)
bun packages/cli/src/main.ts proposals --vault $T/vault                  # two rows: one `entity` (Ada), one `claim` (Plan), producer deterministic
ID=$(bun packages/cli/src/main.ts proposals --vault $T/vault | awk '$2=="entity"{print $1}')
bun packages/cli/src/main.ts promote $ID --vault $T/vault; echo $?       # error: --sensitivity is required; 1 (unlabeled never reaches canon by itself)
bun packages/cli/src/main.ts promote $ID --vault $T/vault --sensitivity personal   # page_path=$T/vault/entities/ada.md
grep -E '^(type|title|x-born|x-tags|x-legacy-sensitivity|x-legacy-path|sensitivity):' $T/vault/entities/ada.md
                                                                         # type: "person" / title: "Ada" / x-born: 1815 / x-tags: ["math","acme"] / x-legacy-sensitivity: "personal" / x-legacy-path: "people/ada.md" / sensitivity: "personal"
grep -c '^> ' $T/vault/entities/ada.md                                   # 0 (verbatim body, not a blockquote)
bun packages/cli/src/main.ts doctor --vault $T/vault; echo $?            # events=2 …; 0
rm $T/wiki/notes/plan.md && bun packages/cli/src/main.ts ingest kizuki.import-legacy-wiki --vault $T/vault --source $T/wiki
                                                                         # events_stored=1 duplicates=0 proposals_created=0 withdrawn=1 retractions_filed=0   (tombstone withdrew the unlabeled proposal)

# --- legacy-events through the verbs on main ---
D=$T/legacy.db bun -e 'import { Database } from "bun:sqlite"; import { LEGACY_EVENTS_FIXTURE } from "./packages/connectors/src"; const db = new Database(process.env.D); db.exec(LEGACY_EVENTS_FIXTURE.sql); db.close()'
D=$T/legacy.db bun -e 'import { writeFileSync } from "node:fs"; import { LEGACY_EVENTS_FIXTURE } from "./packages/connectors/src"; writeFileSync(process.env.D + ".kizuki-mapping.json", JSON.stringify(LEGACY_EVENTS_FIXTURE.mapping))'
bun packages/cli/src/main.ts ingest kizuki.import-legacy-events --vault $T/vault --source $T/legacy.db
                                                                         # events_stored=9 duplicates=0 proposals_created=<n> withdrawn=0 retractions_filed=0   (8 live rows + 1 tombstone; 3 rows skipped by the mapping)
bun packages/cli/src/main.ts ingest kizuki.import-legacy-events --vault $T/vault --source $T/legacy.db
                                                                         # events_stored=0 duplicates=0 … (cursor exhausted)
D=$T/legacy.db bun -e 'import { InMemoryLedger, createLegacyEventsConnector } from "./packages/connectors/src"; const c = createLegacyEventsConnector({ path: process.env.D }); const a = await c.backfill(null); const b = await c.backfill(null); const l = new InMemoryLedger(); console.log(l.acceptMany(a.events).every(r => r.status === "stored"), l.acceptMany(b.events).every(r => r.status === "duplicate"), c.manifest().kinds.join(","))'
                                                                         # true true message,note
D=$T/legacy.db bun -e 'import { createLegacyEventsConnector } from "./packages/connectors/src"; const c = createLegacyEventsConnector({ path: process.env.D, report: process.env.D + "-report.md" }); await c.backfill(null); const r = c.lastReport(); console.log(r.counts.rows, r.counts.events, r.counts.tombstones, r.counts.skipped, r.skipped.map(s => s.reason).sort().join(","))'
                                                                         # 12 9 1 3 kind_unmapped,occurred_at_invalid,source_record_id_missing
grep -c 'kettle\|library' $T/legacy.db-report.md                         # 0 (fixture body words never reach the report)
bun test packages/connectors/test/docs.test.ts                           # pass (doc examples parse)
git status --porcelain                                                   # empty
```

The parenthetical "(wait: …)" line in the wiki block is not part of the
expected output; the line beneath it is. Expected first line:
`notes/plan.md:unlabeled:entities/plan people/ada.md:personal:entities/ada`,
second line `1 1 title->title,status->x-status`.
