# `@kizuki/connectors`

Adapters that turn a source the owner authorized into `kizuki.event/v1`
evidence. Nothing here writes canon: events land in the append-only ledger,
where the receipted writer picks them up. The owner's leverage over what is
written is correction and undo.

Two kinds of adapter live in this package:

- A **live source** is re-read at its own pace. It can see that a record is
  gone and say so, so it emits tombstones.
- A **snapshot importer** reads a file the owner exported once. It cannot tell
  a deleted record from a shorter export, so it never emits a tombstone.

## The registry

| Registry id              | Reads                                                                                                 | Kind              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------- |
| `kizuki.markdown-folder` | A folder of Markdown files, rescanned each run                                                        | Live source       |
| `kizuki.screenpipe`      | A local screenpipe SQLite database, read-only and offline (see that package's README before using it) | Live local source |
| `kizuki.import-chatgpt`  | The `conversations.json` of a ChatGPT data export                                                     | Snapshot importer |
| `kizuki.import-claude`   | The `conversations.json` of a Claude data export                                                      | Snapshot importer |
| `kizuki.import-whatsapp` | An unzipped WhatsApp "Export chat" folder, or the chat `.txt` inside it                               | Snapshot importer |
| `kizuki.import-pocket`   | A Pocket CSV export: one `.csv`, or a folder of `part_*.csv`                                          | Snapshot importer |
| `kizuki.import-omnivore` | An unzipped Omnivore export folder                                                                    | Snapshot importer |

In the examples below, `kizuki` stands for `bun packages/cli/src/main.ts` run
from the tree, as in the repository README.

## What a snapshot importer will not do

None of the three importers below is a live sync, and none should be described
as one.

Absence is not deletion. A record in one export and missing from the next may
have been deleted at the source, or the second export may simply cover a
shorter range, a different device, or omit media. The importer cannot tell, so
re-importing a smaller export stores nothing, withdraws nothing, and files no
retraction. Removing imported data stays the owner's decision, made with
`kizuki purge --event`, `--subject` or `--connector`, which deletes the rows
physically and leaves a receipt. An importer's purge plan only reports which
records such a purge would reach; the export file itself is yours and is never
modified.

An edit is a new version. When the same record comes back with different text
or metadata, the ledger stores another row for it. History is appended to,
never rewritten.

No importer opens a zip archive. Unzip the export and point the importer at the
resulting folder; a `.zip` path is refused with a message that says so.

## WhatsApp chat export

Open a chat, choose Export chat, and pick with or without media. Unzip the
result. The folder holds one chat text file, plus the media files if you kept
them.

```
kizuki import import-whatsapp --vault VAULT --source EXPORT_DIR
```

Each message becomes one `message` event, hinted `private`. Its subjects are
the sender and the chat. The importer references media without opening or
copying it: a file present beside the chat is recorded by name, type and size.

Known limits:

- System notices, the lines with a timestamp but no sender, are skipped. They
  have no author and make no claim worth writing, so a capture note for each
  would be noise rather than evidence. They are not counted anywhere.
- A message continues onto the following lines until the next timestamped
  line. A continuation line that itself starts with something shaped like a
  timestamp splits the message. Every parser of this format shares that limit.
- The export has no time zone: the timestamps are the exporting device's local
  clock. The host's zone is assumed and recorded in the event metadata. Two
  machines in different zones therefore import the same file to different
  instants. Pass `timezone` in the connector config for a portable result.
- The date order is settled by evidence, or by the fact that a chat runs
  forwards in time. When neither settles it, the import is refused with a
  message asking for `date_order` rather than guessing.
- An export with media and one without name the same photo differently, so the
  two exports store that message twice.
- Whether the media file was found beside the chat is part of the message. If
  you import before copying the media folder in, importing again afterwards
  stores a second version of that message, this time carrying the reference.
- The chat name comes from the export file name and is part of every event.
  Re-exporting the same chat under a different file name re-stores each message
  as a new version. Pass `chat` to pin the name.

## Pocket CSV export

Pocket closed in 2025 and left a data export: one or more
`part_NNNNNN.csv` files with the header `title,url,time_added,tags,status`.
Unzip it and point the importer at the folder or at a single `.csv`.

```
kizuki import import-pocket --vault VAULT --source EXPORT.csv
```

Each row becomes one `bookmark` event, hinted `personal`, identified by the
saved url together with the moment it was saved, with the tags and status kept
as metadata.

Known limits:

- Only the final CSV export format is read. The older `ril_export.html` is
  refused: a CSV without a `url` and a `time_added` column is not a Pocket
  export.
- Columns are found by header name, so their order does not matter, and any
  other column is ignored rather than stored.
- The same url saved twice is two records, one per save. Nothing about a
  record's identity depends on where its row sat in the file, so a shorter
  export brings the same records back rather than new ones.

## Omnivore export

Omnivore closed in 2024 and left an export holding `metadata_*.json` files, the
saved article HTML under `content/`, and your highlights under `highlights/`.
Unzip it and point the importer at the folder.

```
kizuki import import-omnivore --vault VAULT --source EXPORT_DIR
```

Each item becomes one `bookmark` event, hinted `personal`, whose text is the
title, url, description and highlights of that item.

Known limits:

- Highlights travel inside the item's text and have no ids of their own, so a
  single highlight cannot be cited or purged on its own.
- A highlights file that is present but unreadable, because it is not UTF-8 or
  is past the per-record size limit, refuses the import. An item stored
  without your notes would look like an item that never had any.
- The saved article HTML is referenced by name and size only. Kizuki does not
  read it, convert it to text, or copy it into the vault. Whether it was found
  is part of the item, so an export that gains its `content/` folder later
  stores a second version carrying the reference.
- `updatedAt` and `readingProgress` are deliberately not stored: they change on
  every export and would fork the history of an item that did not change.
- An item is identified by the id Omnivore gave it. Two entries carrying one
  id are that item's history, not two bookmarks.

## Not here, deliberately

- Live sync of WhatsApp, Pocket or Omnivore. There is no sanctioned personal
  API for any of the three: the first has none for personal history, and the
  other two are closed services.
- The WhatsApp Business API, and Composio as an integration provider. Both were
  deferred by an explicit decision.
- Reading zip archives, downloading or parsing media, and converting saved
  article HTML to text.
