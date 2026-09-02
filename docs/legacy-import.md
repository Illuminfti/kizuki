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
hash travels with each event. Reformatting the file changes nothing;
changing a mapped value re-runs the affected pages.

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
place, owner-readable only, and a path inside the source is refused — a
report written into the wiki would be imported as a page on the next run.

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

Every imported page carries a label. A page whose own label the mapping could
not read carries `sensitivity.default` instead, and the report says which of
the three happened:

| decision | meaning |
| --- | --- |
| `labeled` | the estate's own value mapped to a Kizuki label |
| `unlabeled` | the page carried no label at all; the default applied |
| `unmapped_value` | the page carried a label `sensitivity.values` does not know; the default applied |

A blanket `private` is safe, not useful, so widen `sensitivity.values` until
the report shows no `unmapped_value` rows and no more `unlabeled` than the
estate really left unmarked, then re-import.

`x-legacy-sensitivity` appears only where the mapping really did read a label,
so a defaulted page never looks like a decision the previous system made.

## Honest limits

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
