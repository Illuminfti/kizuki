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

Markdown sources must be separate from the Kizuki vault. See the
[folder boundary and its limits](../../docs/markdown-sources.md).

## The registry

These ids match `defaultConnectorRegistry.ids()` on this revision.

| Registry id              | Reads                                                                                                 | Kind              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------- |
| `kizuki.beeper`          | Local Beeper Desktop API history through an approved token reference; synthetic coverage only          | Live local source |
| `kizuki.gmail`           | Read-only Gmail via operator desktop OAuth client and browser sign-in; live-account qualification unrun | Bounded live source |
| `kizuki.google-calendar` | Explicitly selected read-only Google calendar revisions; native CLI, explicit source consent | Bounded live source |
| `kizuki.ics`             | A local iCalendar file. CLI enrolls the file path; URL sign-in is library surface, not a connect verb | Live local source |
| `kizuki.imap`            | Read-only IMAP mailbox via interactive app-password sign-in                                           | Bounded live source |
| `kizuki.import-chatgpt`  | The `conversations.json` of a ChatGPT data export                                                     | Snapshot importer |
| `kizuki.import-claude`   | The `conversations.json` of a Claude data export                                                      | Snapshot importer |
| `kizuki.import-legacy-events` | Owner-mapped event table or JSONL export; not live sync                                          | Snapshot importer |
| `kizuki.import-legacy-wiki` | Owner-mapped markdown wiki export; not live sync                                                 | Snapshot importer |
| `kizuki.import-omnivore` | An unzipped Omnivore export folder                                                                    | Snapshot importer |
| `kizuki.import-pocket`   | A Pocket CSV export: one `.csv`, or a folder of `part_*.csv`                                          | Snapshot importer |
| `kizuki.import-whatsapp` | An unzipped WhatsApp "Export chat" folder, or the chat `.txt` inside it                               | Snapshot importer |
| `kizuki.import-x-archive` | Owner posts from an unzipped X data archive; local and read-only                                       | Snapshot importer |
| `kizuki.markdown-folder` | A folder of Markdown files, rescanned each run                                                        | Live source       |
| `kizuki.screenpipe`      | A local screenpipe SQLite database, read-only and offline (see that package's README before using it) | Live local source |
| `kizuki.telegram`        | Native Telegram user sign-in; accessible dialogs. Project app credentials required; live-account qualification unrun | Bounded live source |
| `kizuki.x`               | Read-only owner posts through the X API; registered with declared egress; host-composed; live-account qualification unrun | Bounded live source |

In the examples below, `kizuki` stands for `bun packages/cli/src/main.ts` run
from the tree, as in the repository README.

## What the command line can pass an importer

One thing: the path to the export. A stored connection holds nothing else, so
the other keys an importer accepts — `date_order`, `timezone`, `self` and
`chat` below — can be set only by a program that builds the connector itself.
Where a refusal below asks for one of them, there is no flag to answer it with
yet, and this page will say so until there is.

## What a snapshot importer will not do

None of the snapshot importers below is a live sync, and none should be
described as one.

Absence is not deletion. A record in one export and missing from the next may
have been deleted at the source, or the second export may simply cover a
shorter range, a different device, or omit media. The importer cannot tell, so
re-importing a smaller export withdraws nothing and files no retraction. It
stores nothing new either, save for one case each importer states in its own
limits: where an export saved the same url or item id twice, the repeats are
numbered by their position in the file, so an export that dropped the earlier
save re-stores the later one under the bare id. Removing imported data stays
the owner's decision, made with `kizuki purge --event`, `--connector`, or
`--subject ID --connector ID --source KEY`, which deletes the rows
physically and leaves a receipt. An importer's purge plan only reports which
records such a purge would reach; the export file itself is yours and is never
modified.

An edit is a new version. When the same record comes back with different text
or metadata, the ledger stores another row for it. History is appended to,
never rewritten.

No importer opens a zip archive. Unzip the export and point the importer at the
resulting folder; a `.zip` path is refused with a message that says so.

None of the exports below carries a version marker. What an importer supports
is the shape it reads, listed per source; a file of another shape is refused or
reported record by record, never guessed at.

## Markdown folder

Choose a folder of your own notes. It must not be the Kizuki vault, sit inside
one, or contain one; see the [folder boundary](../../docs/markdown-sources.md).

```
kizuki connect markdown-folder --source ./notes
kizuki backfill markdown-folder
```

Each `.md` file becomes one `file` event, labeled `private`, identified by its
path relative to the folder. A later `sync` re-reads the folder: a file whose
bytes changed is a new version, a file that is gone is a tombstone, and an
unchanged file stores nothing. Bytes decide, not modification time, so an
edit that preserved the mtime is still seen.

Known limits:

- Only regular files named `*.md` are read. A symlink inside the folder is
  skipped and reported, whether it points at a file or a directory; a pipe,
  socket or device with a Markdown name is skipped silently. Hidden folders,
  `node_modules` and the like are not entered. The folder itself may be
  reached through a symlink.
- A file past the per-file byte bound, one that is not valid UTF-8, or one the
  process cannot read is reported and skipped; the rest of the folder still
  imports. The scan stops at a fixed depth and a fixed number of files, and
  says so in `health`.
- The connection remembers which folder it watches. A checkpoint from another
  folder, or from the same path after it became a vault, is refused rather
  than replayed.
- A note whose exact bytes match text Kizuki itself wrote is kept but marked
  machine origin by Core, so the loop cannot learn from its own output.

## ChatGPT export

Request a data export from ChatGPT's settings, unzip it, and point the
importer at the `conversations.json` inside.

```
kizuki import import-chatgpt --vault VAULT --source conversations.json
```

The file is a JSON array of conversations. From each the importer reads `id`
(or `conversation_id`), `title` and the `mapping` object; from each mapping
node it reads `message.author.role`, `message.create_time` and
`message.content`, taking `parts` (or `text`) as the message text. Each node
with a message becomes one `message` event, labeled `private`, identified by
the conversation id and node id.

Known limits:

- The roles `user`, `assistant`, `system` and `tool` are read; each is its own
  subject (`chatgpt:self`, `chatgpt:assistant`, `chatgpt:system`,
  `chatgpt:tool`). A node with any other role is reported and not stored.
  Nothing the model said is attributed to you.
- The conversation tree is flattened. A regenerated answer is stored beside
  the answer it replaced, each under its own node id. The node's parent is
  recorded when the export names one. `current_node` is the conversation's
  selected leaf at import time, copied onto every event from that
  conversation; it is not a live pointer. Snapshot hashing ignores metadata,
  so a later export that only moves the leaf does not refresh it on unchanged
  older rows. New messages receive the new leaf; old ones keep the first
  import.
- Image, file and audio parts become attachment references by their asset
  pointer; files listed on the message become references when those fields
  already satisfy the event contract. A `file-service://` pointer and the
  matching file id are stored as one ref. The bytes are not read or fetched.
  Any other structured part, or a listed file that cannot be represented, is
  listed under `unsupported_parts` and reported; the text around it still
  imports.
- A message with no `create_time`, or one with no text and no attachments, is
  reported and not stored. Import time is never substituted for message time.
- Two nodes sharing an id are reported: as a duplicate when they agree, as a
  conflict when they do not, and the first is kept. A conversation or node
  without an id gets a stable content-derived id and is reported as such.
- The file is read in full, bounded by size, record count and nesting depth;
  past any bound the import is refused before a record is stored.

## Claude export

Request a data export from Claude's settings, unzip it, and point the importer
at the `conversations.json` inside.

```
kizuki import import-claude --vault VAULT --source conversations.json
```

The file is a JSON array of conversations. From each the importer reads
`uuid`, `name` and `chat_messages`; from each message it reads `uuid`,
`sender`, `created_at`, `text`, the `content` blocks, and the `attachments`
and `files` lists. Each message becomes one `message` event, labeled
`private`, identified by the conversation uuid and message uuid.

Known limits:

- Only `human` and `assistant` senders are read, as `claude:self` and
  `claude:assistant`. A message with another sender is reported and not
  stored. Who a message quotes does not change who wrote it: a message that
  repeats the other party's words stays with its sender.
- `text` is the message; a `text` block repeating it is stored once, and any
  further `text` block is appended. `image` and `document` blocks and listed
  `attachments` or `files` become name and type refs. Non-empty
  `extracted_content` is appended only while that event stays inside frozen
  ingress limits, including JSON encoding overhead; an oversized extract or
  extra attachment is omitted, listed under `unsupported_parts`, and reported
  as degraded health. The parent message is kept. `tool_use`, `tool_result`
  and `thinking` blocks are listed under `unsupported_parts` and reported.
- A message with no `created_at`, or with no text and no attachments, is
  reported and not stored.
- Two messages sharing a uuid in one conversation are reported, and the first
  is kept. A conversation or message without a uuid gets a stable
  content-derived id and is reported as such.
- The file is read in full, bounded by size, record count and nesting depth.

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
Planning. Those are the raw IDs passed to `kizuki purge --subject` alongside
the emitting `--connector` and enrolled `--source` key. The importer
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

Pocket closed on 2025-07-08 and offered its data export until 2025-10-08. No
new export can be obtained: the only input this importer will ever see is one
saved before that date. It holds one or more `part_NNNNNN.csv` files with the
header `title,url,time_added,tags,status`. Unzip it and point the importer at
the folder or at a single `.csv`.

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

Omnivore closed on 2024-11-15. No new export can be obtained; an export saved
before then holds `metadata_*.json` files, the saved article HTML under
`content/`, and your highlights under `highlights/`. Unzip it and point the
importer at the folder.

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

## X data archive

`kizuki.import-x-archive` reads owner posts from an unzipped X data archive.
It is registered for programmatic use and for the existing generic CLI path:
`kizuki connect import-x-archive --source /path/to/unzipped-archive`, followed
by `kizuki backfill import-x-archive`. See `packages/connector-x/README.md` for
the accepted file names, hard limits, and exact posts-only coverage.

Enrollment validates the complete bounded set of supported post records. A
malformed supported post refuses the archive before connection state is saved;
it cannot defer failure until a later backfill page.

The importer preserves native account and post IDs, post timestamps, links,
mentions, and portable attachment references. It labels every post `personal`
because the archive does not establish whether an account or individual post
was public. It never executes the archive's JavaScript wrappers, reads media
bytes, infers deletion from absence, or contacts X.

Likes are not inspected. Bookmarks, direct messages, ZIP input, live sync, and
X API access are not supported by this bounded importer.

## X API

The separate `kizuki.x` connector is registered for native CLI enrollment and
read-only capture of the authenticated account's own posts. The CLI owns
browser sign-in, the configured fixed loopback callback and protected OAuth
state; source consent is a separate step. See the [X API guide](../connector-x/API.md)
for the enrollment command and prerequisites. Provider enrollment, paid access,
API compatibility and deletion coverage remain unqualified against a real
account. The local archive importer above does not supply that qualification.

## Not here, deliberately

- Live sync of WhatsApp, Pocket, or Omnivore. There is no sanctioned personal
  API for any of the three: the first has none for personal history, and the
  other two are closed services.
- WHOOP. `@kizuki/connector-whoop` exists as a synthetic-tested component and
  is not registered here. Native enrollment, live-account qualification, and
  provider OAuth compatibility are unrun. Local desktop custody of a WHOOP
  Client Secret is not sanctioned.
- The WhatsApp Business API, and Composio as an integration provider. Both were
  deferred by an explicit decision.
- Reading zip archives, downloading or parsing media, and converting saved
  article HTML to text.


## Purge conformance for connector authors

A declared purge planner requires a `purgeFixture` factory in `runConformance`.
The factory creates a fresh connector and disposable synthetic source, names
known selected and unrelated records, and supplies a source snapshot, an
executor, an absence verifier and cleanup. See
[test fixtures](test/purge-fixtures.ts) and the
[adversarial execution tests](test/purge-conformance.test.ts).

The suite refuses a missing factory before calling the configured connector's
`purgeSource`. It checks that planning leaves the source unchanged, requires
`complete: true` and the exact removable/unreachable partition, executes the
admitted plan, verifies every removable ID is absent, checks that unreachable
and unrelated records are unchanged, and replans. Missing completeness,
incomplete continuation, wrong IDs and destructive planning all fail.
Connectors declaring no purge capability must still reject the method with
`not_supported`.

This qualifies the synthetic fixture. It does not call a real provider to delete
data and does not replace Core's separate local erasure protocol. Read-only
export, IMAP and Telegram fixtures have an empty removable set and must prove
that all unreachable records survive; the mutable synthetic fixture proves
actual execution and absence. WhatsApp, Pocket and Omnivore plans report complete
only after reading their full configured exports. Provider planners state their
coverage limits in their own README files.

Run the shared and provider checks with:

```sh
bun test packages/connectors/test packages/connector-imap/test packages/connector-telegram/test
```
