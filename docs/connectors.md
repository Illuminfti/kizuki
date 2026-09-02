# Connectors

What each source gives Kizuki, what it does not, and which sources are decided
but not written. A connector is real only when it appears in the
[Shipped](#shipped) table; everything below that table is a plan.

## The contract

Every connector implements `kizuki.connector/v1`
(see [architecture.md](architecture.md)). The parts that matter to a reader:

**The manifest** declares what the connector is, and the conformance suite
checks that it told the truth.

**`auth_modes`** says how a source is connected, never how it is configured:

- `none` — a path the owner points at. No credential exists.
- `sign_in` — a phone code or an app password, typed in the terminal.
- `oauth` — browser consent through PKCE against a loopback listener.
- `secret_ref` — an existing token the owner already holds, named by an `env:`
  or `file:` reference.

Sign-in, not setup: nothing user-facing ever asks for a client id. Project
credentials are compiled in, and a build without them refuses to sign in rather
than pretending.

**`capabilities`** are promises:

- `backfill` — can read history from the beginning.
- `sync` — can resume from a cursor and read what is new.
- `tombstones` — a deletion at the source becomes a `deleted: true` event, so
  Kizuki learns that a record is gone rather than keeping it forever.
- `purge` — the connector can plan what a subject purge removes at the source.
- `fixture` — ships an offline synthetic sample, so its tests never touch a
  network.

**`emits_sensitivity_hint`** says whether captured events arrive with a
suggested label. The consequence is blunt: an event with no hint is stored and
withheld from every reader, the owner included, until the owner promotes and
labels a page from it. Unlabeled is not a default; it is outside the lattice.

**The conformance suite** (`packages/connectors/src/conformance.ts`) is what an
entry has to pass: fixture round-trip, refusal without credentials, idempotent
double backfill, tombstone emission or a declared absence, a purge plan,
checkpoint resume, and manifest honesty.

**Credential custody.** Credentials live behind secret references. Connection
state is an opaque envelope the connector cannot shape, written under
`<vault>/.kizuki/connections/` with mode 0600 and never stored in SQLite.

**The honesty rule.** Each source is named as one of four things: `live sync`,
`local loopback`, `folder snapshot`, or `export import`. An export importer is
never called sync, however often it is re-read.

## Shipped

Derived from the in-tree registry. `packages/connectors/test/docs.test.ts`
rebuilds this table from `REGISTRY` and each manifest, so a connector that
lands without its row here fails CI.

| connector_id           | auth | kinds                            | backfill | sync | tombstones | purge | fixture | hint | mode            |
| ---------------------- | ---- | -------------------------------- | -------- | ---- | ---------- | ----- | ------- | ---- | --------------- |
| kizuki.import-chatgpt  | none | message                          | yes      | yes  | no         | no    | yes     | no   | export import   |
| kizuki.import-claude   | none | message                          | yes      | yes  | no         | no    | yes     | no   | export import   |
| kizuki.markdown-folder | none | file                             | yes      | yes  | yes        | no    | yes     | no   | folder snapshot |
| kizuki.screenpipe      | none | screen_text, audio_transcription | yes      | yes  | no         | yes   | yes     | yes  | local loopback  |

### kizuki.import-chatgpt

**Captured.** One `message` event per message in a single JSON export file.
`source_record_id` is derived from the conversation and message identity in the
export. Subjects carry the author role. No sensitivity hint, so nothing it
captures is served until the owner promotes and labels a page.

**Cursor.** None. `backfill` and `sync` both re-read the whole file; the ledger
deduplicates on `(connector_id, source_record_id, content_hash)`, so a second
run stores nothing new.

**Deletions and edits.** Not observable. A conversation removed from a later
export simply stops appearing in that file; its earlier events stay in the
ledger until the owner purges them. `tombstones: false` says exactly this.

**Never captured.** Attachments, images, and anything the export omits.

**Purge.** No purge plan: the export file is the owner's, and there is no
source side to call. `kizuki` purge operates on the ledger.

**Limits.** Whatever the export format contains on the day it was produced,
parsed by `parseChatGptExport`.

### kizuki.import-claude

Identical in shape to the export importer above, over the other export format
and `parseClaudeExport`: one `message` event per message in one JSON file, no
cursor, no tombstones, no purge plan, no sensitivity hint.

### kizuki.markdown-folder

**Captured.** One `file` event per `.md` file found recursively under the
configured directory. `source_record_id` is the path relative to that
directory. No sensitivity hint.

**Cursor.** The cursor is the snapshot itself: the set of files and their
content hashes at the last run. `sync` compares a fresh scan against it.

**Deletions and edits.** An edited file arrives as a new event for the same
record. A file that has vanished since the last snapshot becomes a tombstone on
the next `sync`, which withdraws open proposals citing it and files a
retraction for any canon page promoted from it.

**Never captured.** Non-Markdown files, and anything outside the configured
directory. There is no file watching and no daemon; nothing is captured until
the owner runs the connector.

**Purge.** `purge: false`. The folder belongs to the owner and Kizuki does not
delete from it.

**Limits.** A snapshot is only as fresh as the last run.

### kizuki.screenpipe

**Captured.** A read-only adapter over a local screenpipe SQLite database.
Settled `frames.full_text` rows become `screen_text` events; audio
transcription rows become `audio_transcription` events. Subjects identify an
app, a site host, a speaker, or an audio device when that information exists.
This connector does emit a sensitivity hint, and it is `private`.

**Cursor.** Time-based, with a settle window so a row that is still being
written is not read early.

**Deletions and edits.** No tombstones: the local database offers no reliable
deletion signal to observe.

**Purge.** `purge: true` — it can plan what a subject purge removes.

**Never captured.** Screen or audio media. It reads text rows only, never the
files under the media directory, and it never calls screenpipe's HTTP API.

**Limits.** Do not run it while screenpipe is running; that tool prohibits
external SQLite clients on its live database. See
[the package README](../packages/connector-screenpipe/README.md) for the
snapshot procedure and the locking detail.

## Accepted for 1.0, not in the tree

Nothing in this table is working software. These are owner decisions about
which sources 1.0 should reach, recorded with the limits known when the
decision was made.

Provider facts below were recorded on 2026-09-02 from the connector
specifications in this repository. They are not a fresh reading of provider
documentation, and every one of them must be re-verified against primary
sources on the day the connector is implemented.

| connector_id           | auth            | source class  | provider facts and limits (recorded 2026-09-02)                                                                                                                                                                                                                                                                                   | status    |
| ---------------------- | --------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| kizuki.telegram        | sign_in         | live sync     | The account's own dialogs through the MTProto client API, not a bot. No deletion detection without the update stream; edits are re-read within a bounded window. Media as references, never downloads. Secret chats are unreachable. Flood-wait is honoured. Project app credentials are compiled in; placeholders refuse sign-in | specified |
| kizuki.google          | oauth           | live sync     | Mail and calendar, read-only, through an installed-app client with PKCE. Consent-screen verification and workspace admin policy both gate access. Trash and cancellations arrive as tombstones                                                                                                                                    | specified |
| kizuki.imap            | sign_in         | live sync     | App password only. Implicit TLS, no STARTTLS, no provider OAuth; a provider that has retired app passwords is unsupported rather than worked around. Read-only `EXAMINE` and `BODY.PEEK`. Expunges arrive as tombstones                                                                                                           | specified |
| kizuki.ics             | none or sign_in | live sync     | A calendar file or an `https://` URL. A bounded recurrence-rule subset, not the whole specification. A private calendar URL is treated as a credential, because it is one                                                                                                                                                         | specified |
| kizuki.whoop           | oauth           | live sync     | No public-client flow exists, so an owner-registered client behind secret references is the primary path. Deletions arrive by webhook only, so no tombstones from polling. No provider-side delete, so no purge plan. Rate limits of 100 per minute and 10000 per day                                                             | specified |
| kizuki.x               | oauth           | live sync     | Paid, bounded history through user-context sync with PKCE. The account archive is the history path; the API is the tail                                                                                                                                                                                                           | specified |
| kizuki.whatsapp-export | none            | export import | The owner's exported chat files. No sanctioned read API exists for a person's own history                                                                                                                                                                                                                                         | specified |
| kizuki.pocket          | none            | export import | An export file. No live sync is claimed                                                                                                                                                                                                                                                                                           | specified |
| kizuki.omnivore        | none            | export import | An export file. No live sync is claimed                                                                                                                                                                                                                                                                                           | specified |
| kizuki.x-archive       | none            | export import | The account archive, which is where the deep history lives                                                                                                                                                                                                                                                                        | specified |

## Deferred

### Composio

Composio is a meta-connector: one SDK that reaches many providers. Adopting it
would route source traffic for every connected account through a third-party
service, which puts a cloud in the loop of everything Kizuki captures. That
contradicts the zero-phone-home pledge and local credential custody, whatever
the service's own policy says.

Deferred until an owner decision names the boundary: which sources, if any, may
be reached through a broker, and what the owner is told when one is.

### WhatsApp Business API

The Business API serves business accounts through hosted webhooks and platform
review. It is not a read API for a person's own message history, and no
sanctioned one exists.

Deferred. `kizuki.whatsapp-export` above is the supported path: the owner
exports their own chats and imports the files.

## Adding a connector

The checklist is in [CONTRIBUTING.md](../CONTRIBUTING.md), and the long form is
the `connector-work` skill under `.agents/skills/`. The registry entry goes in
last, after the implementation, the conformance run, and the row in the
[Shipped](#shipped) table above.
