# Canon authority projections

Canon location and frontmatter do not grant authority. Serving, search, and
graph resolve the exact bytes read in each `CanonPage.contentHash` against
receipt history. An unmatched owner-controlled page is `owner_authored`.
A matched ordinary write uses its validated receipt authority. Reverts resolve
the target's preceding materialization; purge rewrites inherit the preceding
state. Mutable claim status and `reverted_by` do not affect that resolution.

The writer reloads claims from the ledger and rejects changed producer fields
before budget admission. Receipts and indexes use those stored rows, including
authority, provenance, sensitivity, and subject. Lifecycle updates are read
fresh without requiring callers to refresh their cached claim objects.

Resolution is bounded to 4,096 receipts per page and 128 chain entries.
Overflow, invalid authority, missing revert targets, and cycles fall to
`model_inference`. Reads do not rewrite legacy receipts. New undo and purge
receipts persist the effective restored or preceding authority. Undo refreshes
its derived rows after its receipt is durable.

The page walker hashes the same bytes it parses. Rebuilding `page_index` uses
that snapshot hash, rather than reading the file again. Public consumers that
construct `CanonPage` snapshots must supply the actual content hash.

PR 427 was reconciled at `f4231af586eac97347ca2b4c181eed888358b45b`
(commits `413bc99`, `4982f22`, `f4231af`) against main `644303b`.
This lane reconstructs its distinction between an absent page and an unreadable
page and uses a single read for snapshot bytes. Its broader closed-schema,
walker, archive, serving-refusal, and TUI changes were not adopted here; this
change does not claim to complete that PR.

## Subject typing and markdown identity

Only explicit existing page-kind namespaces establish a page type. For example,
`person:grace` is a `person`; `org:acme` is an `org`. Unknown namespaces are
represented by a generic `topic`, including addresses, calendars, screenpipe
objects, and imported documents. Existing canon revisions retain their existing
explicit type. A model claim missing a type may use its already-grounded
primary subject; this does not create a new subject.

The email-to-person acceptance statement in issue 430 is not implemented:
`SubjectRef` makes no such guarantee, and the predicate registry allows email
contacts for people and organizations. Treating every address as a person
would repeat the unsupported assertion this fix removes.

Markdown events identify the document using SHA-256 of the exact relative
`source_record_id`. The bounded subject ID is independent of contents, mtime,
and lossy slugging. Edits and tombstones carry the same document subject.
The display name remains the file basename. This follows the connector's
existing source-record identity; it does not add a cross-folder identity scheme.
