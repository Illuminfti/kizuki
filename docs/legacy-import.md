# Importing a previous knowledge estate

Kizuki ships two importers for an estate you already have on disk: a markdown
wiki and an event table. Both are **export importers, not live sync**. They
read files you exported or copied yourself, they never reach the network, and
every page or event they produce is evidence in the append-only ledger.
Neither importer writes a page into your vault, and neither one decides what
your canon ends up saying: an importer's whole job is to carry the estate over
as evidence, with a record of every decision the mapping made on the way.

- `kizuki.import-legacy-wiki` reads a directory of markdown pages with
  arbitrary frontmatter and stages one typed page per file.
- `kizuki.import-legacy-events` reads a SQLite table or a JSONL file and
  appends `kizuki.event/v1` rows to the ledger.

Neither importer guesses. What a legacy field means is a decision you write
down in a mapping file, and everything the mapping could not carry over is
listed in a lossy-mapping report.

## The mapping file

Both importers take their mapping from a JSON file beside the source, so no
extra flag is needed to run them:

| source | default mapping path |
| --- | --- |
| a wiki directory `/w/wiki` | `/w/wiki/kizuki-mapping.json` |
| an export file `/w/legacy.db` | `/w/legacy.db.kizuki-mapping.json` |

A missing mapping file is a refusal that names the path it looked for. So is
an unknown key: a typo that quietly changed which pages were labelled private
would be the worst failure this code could have, so every key is checked.

The mapping is hashed (canonical JSON, keys sorted at every depth) and the
hash travels with each event as `mapping_hash`, for the record. Reformatting
the file changes nothing. Each wiki event also carries `plan_sha256`, a digest
of what the migration decided about that page: its text, labels, target and
fields, and not the mapping's hash or a file time. A changed mapping re-emits
exactly the pages whose digest changed, so a mapping edit that decides nothing
new, and the revert of any edit, emit no events for the pages they leave
alone. A page keeps the target it was first emitted with, so a mapping edit
never places a second copy of a page; a new `dir` mapping applies to pages
added afterwards. Pages an earlier release stored carry no digest and are
trusted until the page itself changes.

A page the changed mapping no longer imports — an excluded type, or a path the
`ignore` list now matches — is withdrawn on the next run: the wiki importer
emits a tombstone carrying `excluded_by_mapping`, which retracts the proposal
the earlier run filed. The file itself is untouched, and the record does not
claim a deletion that never happened. A page the walk could not read is
neither imported nor withdrawn — it stays in the cursor until a run can tell.

### The wiki follows its source

A sync brings the ledger to where the wiki is, in both directions:

- **Restore and revert are new state.** The ledger stores an event once per
  content hash, so a page that comes back after a deletion, or returns to text
  it had before, would otherwise be dropped as a duplicate. When the source
  record has earlier events and a page is emitted because its state changed,
  the event carries `revision_epoch`, the count of events the record already
  has. The staged page carries it as `x-source-revision`, so the claim is a new
  claim, not a repeat of the old one. A record the ledger already holds
  unchanged is not emitted, so the next sync after a restore emits nothing.
  When a returned page's earlier deletion archived its canon page, the
  writer's sync pass reverts that archive receipt while the page still holds
  the bytes the archive left; a page changed since stays as it is.
- **A rename is one event.** A page that vanishes while a new page appears with
  exactly the same bytes is a rename when that pairing is unique (one vanished
  name and one new name for those bytes; empty files never pair). The new page
  is emitted once with `moved_from` naming the old path and the old page's
  target, so it keeps the same target. The old path gets no tombstone; the ledger treats it as moved from
  then on. Two identical files that both move are not guessed at, and are
  withdrawn and re-added as before.
- **A mass withdrawal is held, not applied.** When one pass would withdraw
  more than the larger of 20 pages and 20 percent of the source's pages, it
  emits no tombstones and ends `unavailable` with the typed state
  `mass_withdrawal_held: N of M`. An emptied root, an unmounted volume or a
  half-restored tree is the likely cause. The hold appears as `hold` on the
  source in `kizuki connect status` and in `kizuki doctor` (which then fails),
  and clears when the next sync no longer needs it. If the wiki really lost
  those pages, release it once with
  `kizuki sync import-legacy-wiki --source KEY --confirm-withdrawals N`, where
  N is the reported count; a pass that would withdraw more than N stays held.
  The release covers that run only.
- **A capture drain plans once.** Successful backfill pages reuse one bounded
  tree scan and plan on the same connector instance. A changed root or restarted
  drain scans again; edits made during a drain are captured by the next sync.

Canon body replacement on a source revision is incomplete in the current
compatibility writer: an edited, reverted, restored or renamed page can retain
earlier source prose. The rules above describe ledger revisions, target identity
and archive reversal; they do not claim that the materialized body already
matches the latest source. Automatic archive reversal requires a configured
model, respects the canon write budget and checkpoints its bounded scan so
edited archives cannot permanently block later returned pages.

## Wiki mapping

Schema tag: `kizuki.legacy-wiki-mapping/v1`.

| key | default | rule |
| --- | --- | --- |
| `title.field` | `"title"` | frontmatter key holding the page title |
| `type.field` | `"type"` | frontmatter key holding the legacy type |
| `type.values` | `{}` | legacy value to a Kizuki page type, or `null` to exclude the page |
| `type.default` | **required** | page type for a page whose type is absent or unmapped |
| `sensitivity.field` | `"sensitivity"` | frontmatter key holding the legacy label |
| `sensitivity.values` | `{}` | legacy value to `public` / `personal` / `private`; those three names also map to themselves |
| `sensitivity.default` | `"private"` | the label for a page the estate carried no label for at all |
| `occurred_at` | `null` | `{ field, format }`; `null` means the file's mtime is used |
| `fields` | `{}` | legacy key to an `x-*` frontmatter name, or `null` to drop it |
| `subjects` | `null` | `{ field, role, namespace }`; the field may hold one name or a list |
| `target.mode` | `"flat"` | `flat` puts every page directly under its type directory; `mirror` keeps the legacy folders |
| `target.directories` | see below | page type to the directory its pages land in, 1..7 path segments |
| `ignore` | `[]` | globs over the relative path; `*` stays inside a segment, `**` spans segments, `?` is one character |

Sensitivity resolves as `max(floor, label or default)` over
`public < personal < private`, and only ever moves up:

- a label the mapping reads is that label;
- a label the mapping cannot read — a value outside `sensitivity.values`, or a
  page whose frontmatter did not parse — is `private`, because unknown and
  unparseable resolve to the top of the lattice, never to a default someone
  widened;
- only a page the estate carried no label for at all takes
  `sensitivity.default`;
- both importers then raise the result to the connector floor. An export of
  the owner's own files, notes and messages sits at default `private`, floor
  `personal`, so a page a previous system called `public` imports as
  `personal` and the report counts it under "sensitivity raised to floor".
  The label the estate wrote is still recorded, in the report's
  `sensitivity.legacy` and in the page's `x-legacy-sensitivity`.

Nothing is left unlabeled, because an unlabeled page is outside the lattice
and is served to nobody at all, the owner included.

Default `target.directories`: `person`, `org`, `project`, `place` and
`topic` go to `entities`; `fact` to `facts`; `event` to `events`;
`source` to `sources`; `rollup` to `dashboards`.

A `format` for `occurred_at` is one of `rfc3339`, `sqlite_datetime`,
`date`, `unix_seconds`, `unix_millis`, `js_date`.

### Wiki mapping: worked example

This is the mapping the built-in fixture uses, verbatim.

```json
{
  "schema": "kizuki.legacy-wiki-mapping/v1",
  "title": {
    "field": "title"
  },
  "type": {
    "field": "type",
    "values": {
      "Person": "person",
      "Company": "org",
      "Template": null
    },
    "default": "topic"
  },
  "sensitivity": {
    "field": "visibility",
    "values": {
      "friends": "personal",
      "secret": "private",
      "public": "public"
    },
    "default": "private"
  },
  "occurred_at": {
    "field": "created",
    "format": "date"
  },
  "fields": {
    "updated": "x-updated",
    "draft": null
  },
  "subjects": {
    "field": "people",
    "role": "about",
    "namespace": "legacy-wiki"
  },
  "target": {
    "mode": "flat",
    "directories": {
      "person": "entities",
      "org": "entities",
      "project": "entities",
      "place": "entities",
      "topic": "entities",
      "fact": "facts",
      "event": "events",
      "source": "sources",
      "rollup": "dashboards"
    }
  },
  "ignore": [
    "drafts/**"
  ]
}
```

## Events mapping

Schema tag: `kizuki.legacy-events-mapping/v1`. Column names must match
`/^[A-Za-z_][A-Za-z0-9_]{0,63}$/` and are only ever interpolated as quoted
SQL identifiers.

| key | default | rule |
| --- | --- | --- |
| `table` | — | required for a SQLite source, absent for JSONL |
| `source_record_id.column` | **required** | the stable key of a row; an empty one skips the row |
| `kind` | **required** | `{ const }`, or `{ column, values, default }`; an unmapped kind with a `null` default skips the row |
| `occurred_at` | **required** | `{ column, format }`; an unreadable value skips the row |
| `observed_at` | `null` | `{ column, format }`; `null` means the import time |
| `text` | **required** | `{ column }`, or `{ columns, join }` with empty parts dropped |
| `subjects` | `[]` | `{ column, role, namespace, split }`; a cell may be a name, a JSON array of names, or a `split`-separated list |
| `sensitivity_hint` | `null` | `{ const }`, or `{ column, values }`; an unmapped value falls to the connector default |
| `deleted` | `null` | `{ column, true_values }`; a matching row becomes a tombstone |
| `metadata.columns` | `"rest"` | `"rest"` keeps every column the mapping did not consume; a list keeps exactly those |

A column named after a stamp the importer owns — `mapping_hash`,
`legacy_deleted`, `text_truncated`, `__blobs`, `__truncated`,
`__source_record_id_hashed`, `__reserved_columns`, `__rowid`,
`page_candidate`, `__proto__` — is refused rather than copied, and its name is
listed in the event's `__reserved_columns`. An export cannot claim the
connector's own mapping hash or mark a live row deleted.

One column may fill only one role, so a mapping cannot quietly double-count
it. A column the source does not have is a refusal before any row is read.

Every row leaves labeled, by the same rule the wiki importer follows: the
mapped label, or `private` when nothing maps it, raised to the `personal`
floor. A mapping that says `public` cannot publish an export.

### Events mapping (SQLite): worked example

This is the mapping the built-in fixture uses, verbatim.

```json
{
  "schema": "kizuki.legacy-events-mapping/v1",
  "table": "events",
  "source_record_id": {
    "column": "id"
  },
  "kind": {
    "column": "type",
    "values": {
      "msg": "message",
      "note": "note"
    },
    "default": null
  },
  "occurred_at": {
    "column": "ts",
    "format": "unix_seconds"
  },
  "observed_at": null,
  "text": {
    "columns": [
      "subject",
      "body"
    ],
    "join": "\n\n"
  },
  "subjects": [
    {
      "column": "sender",
      "role": "from",
      "namespace": "legacy",
      "split": null
    },
    {
      "column": "recipients",
      "role": "to",
      "namespace": "legacy",
      "split": ","
    }
  ],
  "sensitivity_hint": {
    "column": "visibility",
    "values": {
      "pub": "public",
      "priv": "private"
    }
  },
  "deleted": {
    "column": "is_deleted",
    "true_values": [
      1,
      true,
      "1"
    ]
  },
  "metadata": {
    "columns": "rest"
  }
}
```

### Events mapping (JSONL): worked example

The same mapping against a JSONL export: the only difference is that there is
no table to name.

```json
{
  "schema": "kizuki.legacy-events-mapping/v1",
  "table": null,
  "source_record_id": {
    "column": "id"
  },
  "kind": {
    "column": "type",
    "values": {
      "msg": "message",
      "note": "note"
    },
    "default": null
  },
  "occurred_at": {
    "column": "ts",
    "format": "unix_seconds"
  },
  "observed_at": null,
  "text": {
    "columns": [
      "subject",
      "body"
    ],
    "join": "\n\n"
  },
  "subjects": [
    {
      "column": "sender",
      "role": "from",
      "namespace": "legacy",
      "split": null
    },
    {
      "column": "recipients",
      "role": "to",
      "namespace": "legacy",
      "split": ","
    }
  ],
  "sensitivity_hint": {
    "column": "visibility",
    "values": {
      "pub": "public",
      "priv": "private"
    }
  },
  "deleted": {
    "column": "is_deleted",
    "true_values": [
      1,
      true,
      "1"
    ]
  },
  "metadata": {
    "columns": "rest"
  }
}
```

## What the report says

Both importers keep a report of the run. Pass `report` in the connector
config to write it to a file: a `.json` suffix writes JSON, anything else
writes Markdown. The file is written to a temporary name and renamed into
place, owner-readable only. A path inside the source is refused — a report
written into the wiki would be imported as a page on the next run — and so is
a path inside a vault: canon is written by the receipted writer, and a
Markdown file no receipt covers has no business in it.

The wiki report (`kizuki.legacy-wiki-report/v1`) lists, for every file: the
target path, the page kind, whether the frontmatter parsed and which rule
fired if it did not, how the type and the sensitivity label were decided,
where the title came from, how many subjects were found, and one row per
legacy field saying whether it was mapped, renamed, kept, coerced or dropped
and why.

The events report (`kizuki.legacy-events-report/v1`) lists the position range
the run covered, whether it finished, whether it restarted and why, counts by
kind, how many blobs were dropped, which columns were consumed, and every
skipped row by position and reason.

Neither report carries page prose, a page title, or a cell value. It carries
relpaths, field names, the raw type and sensitivity vocabulary, positions and
counts. The report may live outside the vault, so it holds only what you need
to fix the mapping.

## Labels the mapping could not read

Every imported page carries a label, and the report says how it was decided:

| decision | meaning |
| --- | --- |
| `labeled` | the estate's own value mapped to a Kizuki label |
| `unlabeled` | the page carried no label at all; `sensitivity.default` applied |
| `unmapped_value` | the page carried a label `sensitivity.values` does not know; `private` applied |
| `unreadable` | the frontmatter did not parse, or the label was not a word; `private` applied |

A blanket `private` is safe, not useful, so widen `sensitivity.values` until
the report shows no `unmapped_value` rows and no more `unlabeled` than the
estate really left unmarked, then re-import.

`x-legacy-sensitivity` appears only where the mapping really did read a label,
so a defaulted page never looks like a decision the previous system made.

## Honest limits

- **A credential-shaped field is dropped, not carried.** A frontmatter field
  or an export column whose *name* reads as a credential — `password`,
  `api_key`, `access_token`, `client_secret`, `cookie` and the like — never
  reaches an event, a page, a target or the report. The ledger is append-only:
  a token copied into it can be purged with a receipt, never edited away. The
  name survives as the record that the field was there: the wiki report lists
  it as `dropped` with note `credential`, and an event from the events
  importer carries the column under `__credential_columns`. The test is the
  name alone, so a field merely called `api_key` is dropped whether or not it
  held one.
- **An in-place edit at the source is invisible.** The events importer pages
  forward through an export; a row rewritten after it was imported is not
  re-read. Re-import from scratch (a fresh source, or a changed mapping) to
  pick it up. The wiki importer does notice an edited page, because it
  compares content hashes on every run.
- **Without a mapped date field, `occurred_at` is the file's mtime.** Copying
  a wiki rewrites mtimes and therefore rewrites event identity. Mapping a date
  field is the stable choice.
- **The frontmatter reader covers a subset.** Block mappings and sequences,
  flow sequences and mappings on one line, block scalars, quoted and plain
  scalars, and comments. Anchors, aliases, tags, complex keys, directives and
  multi-document files are reported as unparsed — the page still imports, with
  the file's heading or name as its title.
- **A page path is ASCII.** File names are slugged into path segments, and a
  name with no ASCII letters or digits slugs to `page`, so an estate written
  entirely in another script lands on `entities/page`, `entities/page-2` and
  so on. The titles survive intact; only the paths carry no information.
- **The ledger keeps a page's first 262,144 characters.** A longer page is
  cut there; its event carries `text_truncated` and the report notes
  `text_truncated` against the relpath.
- **A staged page keeps its first 64,000 characters,** counted in UTF-16
  code units, so an emoji counts as two. That is the longest body staging
  files. A longer page is staged as its head, with its type, title and
  target, and its frontmatter carries `x-body-truncated: true`. Its event
  still holds the whole text for recall and carries `body_truncated`, and the
  report notes `body_truncated` against the relpath. An earlier release
  stored such a page but staged nothing of it; the first sync after an
  upgrade records the page again and stages it. On a wiki of only a few dozen
  pages, that sync still counts the page as imported, so edit the page and
  the next sync stages it.
- **Wiki links are not rewritten.** A `[[Title]]` in a body stays as written.
- **Attachments are not copied.** An image link stays text.
- **No LLM, no network, no credentials.** Both importers declare
  `auth_modes: ["none"]` and require no secrets.

## Running an import

```sh
kizuki init ./vault
kizuki import import-legacy-wiki --source ./wiki --vault ./vault
kizuki sync import-legacy-wiki --vault ./vault
kizuki doctor --vault ./vault
```

`import` enrolls the source and backfills it in one step; `sync` runs the
incremental sweep afterwards, so a page deleted from the wiki arrives as a
tombstone. The events importer reads one bounded page of rows per run, so call
`sync` repeatedly until it stops storing events. Read the migration report
before and after: it is the record of what the mapping could and could not
carry over.

Both connector ids also answer to their short form: `import-legacy-wiki` and
`import-legacy-events`.
