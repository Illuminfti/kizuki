# `@kizuki/connectors`

Adapters that turn a source the owner authorized into `kizuki.event/v1`
evidence. Nothing here writes canon: events land in the append-only ledger,
where the receipted writer picks them up. The owner's leverage over what is
written is correction and undo.

Sensitivity is assigned, never asked for. Every importer here declares two
things in its manifest: the label its records carry, and the least sensitive
label they may ever carry. A hint from a source is honored only upward, so
nothing an export says can talk a record down into being served more widely,
and a record whose sensitivity cannot be worked out is private rather than
unlabeled.

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

## What the command line can pass an importer

One thing: the path to the export. A stored connection holds nothing else, so
the other keys an importer accepts — `date_order`, `timezone`, `self` and
`chat` below — can be set only by a program that builds the connector itself.
Where a refusal below asks for one of them, there is no flag to answer it with
yet, and this page will say so until there is.

## What a snapshot importer will not do

None of the three importers below is a live sync, and none should be described
as one.

Absence is not deletion. A record in one export and missing from the next may
have been deleted at the source, or the second export may simply cover a
shorter range, a different device, or omit media. The importer cannot tell, so
re-importing a smaller export withdraws nothing and files no retraction. It
stores nothing new either, save for one case each importer states in its own
limits: where an export saved the same url or item id twice, the repeats are
numbered by their position in the file, so an export that dropped the earlier
save re-stores the later one under the bare id. Removing imported data stays
the owner's decision, made with `kizuki purge --event`, `--subject` or
`--connector`, which deletes the rows
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

Each message becomes one `message` event, labeled `private` by the importer's
own policy rather than by you. Its subjects are the sender and the chat, filed
under the name shortened into a readable handle: `whatsapp:ada` for a
participant called Ada, `whatsapp:chat:acme-planning` for a chat called Acme
Planning. Those are the ids `kizuki purge --subject` takes. The importer
references media without opening or copying it: a file present beside the chat
is recorded by name, type and size.

Known limits:

- System notices, the lines with a timestamp but no sender, are skipped. They
  have no author and make no claim worth writing, so a capture note for each
  would be noise rather than evidence. They are not counted anywhere. A notice
  is recognized by having nothing before its first colon-and-space, so a notice
  that contains one — a subject change, which reads `Ada changed the subject
  to: …` — is indistinguishable from a message and is captured as one, with
  the text before the colon standing in for a sender.
- A placeholder for a message that was deleted at the source stays ordinary
  text: nothing is withdrawn and no deletion is inferred. It is recognized by
  its bracketed shape, which is also the shape of "media omitted", so such a
  message is recorded as having had media left out of the export. The text
  itself is exact; the media note beside it is not.
- A message continues onto the following lines until the next timestamped
  line. A continuation line that itself starts with something shaped like a
  timestamp splits the message. Every parser of this format shares that limit.
- The export has no time zone: the timestamps are the exporting device's local
  clock. The host's zone is assumed and recorded in the event metadata. Two
  machines in different zones therefore import the same file to different
  instants. A program that builds the connector can pin `timezone` for a
  portable result; from the command line the host's zone is what you get.
- The date order is settled by evidence — a day past the twelfth — or by the
  fact that a chat runs forwards in time. A chat covering a single day, or a
  short one whose dates never pass the twelfth, settles neither, and the
  import is refused rather than guessing which half of `1/4` is the month.
  The refusal asks for `date_order`, which today only a program building the
  connector can supply: from the command line such an export cannot be
  imported at all.
- An export with media and one without name the same photo differently, so the
  two exports store that message twice.
- A message is what it says, not what sits beside it. Whether the media file
  was found is recorded on the event but is not part of the message's identity,
  so copying the media folder in after an import — or pruning it afterwards —
  re-stores nothing. Put the media beside the chat file before you import, or
  the references stay missing until you purge those events and import again.
- The chat name comes from the export file name and is part of every event.
  Re-exporting the same chat under a different file name re-stores each message
  as a new version. A program building the connector can pin `chat`; from the
  command line, keep the export file's name the same between exports.
- A participant is whoever the export calls them. Two contacts sharing one
  display name are one subject, and one contact renamed between exports is
  two; an export carries nothing else to tell them apart, so the importer does
  not pretend otherwise. Shortening a name into a handle loses more: two names
  that differ only in punctuation, and any two names with no letters or digits
  at all, become one handle and therefore one subject, which a purge aimed at
  that handle reaches together. The display names are kept whole on every
  event, so the evidence still says who wrote what.

## Pocket CSV export

Pocket closed in 2025 and left a data export: one or more
`part_NNNNNN.csv` files with the header `title,url,time_added,tags,status`.
Unzip it and point the importer at the folder or at a single `.csv`.

Only `part_NNNNNN.csv` is picked up from a folder, because a file name found
inside an export is not something Kizuki will repeat back to you in an error.
A CSV you renamed still imports: pass the file itself instead of its folder.

```
kizuki import import-pocket --vault VAULT --source EXPORT.csv
```

Each row becomes one `bookmark` event, labeled `personal`, identified by the
url it saved, with the tags and status kept as metadata.

Known limits:

- Only the final CSV export format is read. The older `ril_export.html` is
  refused: a CSV without a `url` and a `time_added` column is not a Pocket
  export.
- Columns are found by header name, so their order does not matter, and any
  other column is ignored rather than stored.
- The same url saved twice is two records: the second and later saves are
  numbered `#2`, `#3` in the order the file wrote them, so a doubled export
  cannot collapse two saves into one. The number is a position, so an export
  that drops the earlier save of a repeated url stores the later one again
  under the bare url. Nothing is lost; there is simply one extra record.

## Omnivore export

Omnivore closed in 2024 and left an export holding `metadata_*.json` files, the
saved article HTML under `content/`, and your highlights under `highlights/`.
Unzip it and point the importer at the folder.

```
kizuki import import-omnivore --vault VAULT --source EXPORT_DIR
```

Each item becomes one `bookmark` event, labeled `personal`, whose text is the
title, url, description and highlights of that item.

Known limits:

- Highlights travel inside the item's text and have no ids of their own, so a
  single highlight cannot be cited or purged on its own.
- A highlights file that is present but unreadable, because it is not UTF-8 or
  is past the per-record size limit, refuses the import. An item stored
  without your notes would look like an item that never had any.
- The saved article HTML is referenced by name and size only. Kizuki does not
  read it, convert it to text, or copy it into the vault. The reference is not
  part of the item's identity, so unzipping the `content/` folder after an
  import re-stores nothing. Unzip the whole export before you import it.
- `updatedAt` and `readingProgress` are deliberately not stored: they change on
  every export and would fork the history of an item that did not change.
- An item is identified by the id Omnivore gave it. Two entries carrying one
  id are two records, the second numbered `#2`, so a doubled export cannot
  collapse them. As with a repeated bookmark, that number is a position: an
  export that drops the earlier entry stores the later one under the bare id.

## Not here, deliberately

- Live sync of WhatsApp, Pocket or Omnivore. There is no sanctioned personal
  API for any of the three: the first has none for personal history, and the
  other two are closed services.
- The WhatsApp Business API, and Composio as an integration provider. Both were
  deferred by an explicit decision.
- Reading zip archives, downloading or parsing media, and converting saved
  article HTML to text.
