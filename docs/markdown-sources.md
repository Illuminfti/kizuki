# Markdown source boundaries

Choose a source folder separate from the Kizuki vault. The folder connector
refuses a vault root, a child of a vault (including canon, archives and control
data), or a scan which encounters a nested vault. It recognizes the `.kizuki`
control marker before exclusions; an alias or dangling marker symlink does not
remove that boundary. Independent sibling source folders remain supported.

The refusal is `source_contains_kizuki_vault`. No batch is returned, no capture
checkpoint advances, and files hidden by the refusal are not tombstones. If a
previously enrolled source becomes a vault, sync refuses it until an independent
source is selected. This prevents Kizuki's own managed output entering that
same folder capture as new external evidence.

Core also marks captured text as machine origin when its exact UTF-8 bytes
match a retained loop-write receipt or a durable intent registered before the
loop publishes a file. This catches unchanged generated text copied into a
separate source folder. These events remain in the ledger but cannot support
model extraction or new model claims. A one-byte change is a different text
hash; the check does not prove general authorship. See
[Event identity and origin](event-identity-origin.md) for the separate Core
check and its limits. The folder marker check does not close concurrent
ancestor replacement by itself. The final file open verifies the listed parent
directory's device and inode, then reads the child through a descriptor-relative
`openat` of that held parent on the supported native platforms (Linux x64 and
Darwin arm64). There is no pathname fallback when that primitive is unavailable;
the file is left unread rather than opened by name. A replaced parent is not
published as source bytes and does not become a tombstone. A path-only
realpath precheck is not that guarantee. Listing still uses path `readdir`; this
boundary does not claim that every replacement race on every platform is closed.

Native CLI and app capture injects an optional factory dependency,
`committedFiles`, after source capture admission. That reader returns this
source's latest live `kizuki.markdown-folder` identities as
`[relativePath, {sha256, size}]` from the ledger, never event text. Host-backed
resume tokens keep the existing root, options, phase, after, and exhausted
header plus a `committed_identities` marker; they do not carry the inventory.
A null cursor still never tombstones. Compact tokens fail closed if the reader
is missing. Standalone factory calls keep the packed identity cursor, and old
packed tokens remain readable. Protected connection state and portable restore
stay path-only; restored capture reconstructs identities from the restored
ledger. Emitted pages clamp to Core's 1000-event batch bound.

## Following the folder

The folder is identified by its configured path and by its files' content, not
by the device and inode it sits on. A host-backed resume token names no files
and no device, so a disk migration, a restore from backup or a recreated folder
at the same path keeps its checkpoint: the next sync compares the files with
the ledger's committed identities and emits only real differences. A token
that carries its own file snapshot (a standalone factory call) still belongs
to the real path it was taken from and is refused for another; tokens minted
by earlier releases, which also pinned the device and inode, are still read.
Moving the folder to a new path is a different source: enroll the new path.

Each sync brings the ledger to where the folder is:

- A file deleted and later restored with the same bytes, or edited and later
  reverted, is emitted again with `revision_epoch` (the number of events the
  record already has), because the ledger would otherwise drop the returning
  text as a duplicate. Once the ledger holds the file unchanged, the next sync
  emits nothing.
- A file that vanishes while exactly one new file with the same bytes appears
  is a rename: one event at the new path with `moved_from`, and no tombstone
  for the old path. Empty files and ambiguous pairs are never treated as
  renames.
- A pass that would withdraw more than the larger of 20 files and 20 percent
  of the source's files emits no tombstones and ends `unavailable` with
  `mass_withdrawal_held: N of M`. `kizuki connect status` and `kizuki doctor`
  show the hold, and restoring the folder clears it. To accept the deletion
  release it once with
  `kizuki sync markdown-folder --source KEY --confirm-withdrawals N`.
- A batch emits up to `page_size` files (default 1,000, the largest batch Core
  accepts) and walks the folder once. A resume token taken at another
  `page_size` still resumes; a changed `exclude` list does not.
- Within one sync a batch does not read files an earlier batch already hashed
  while their size, modification time, change time and inode are unchanged and
  the file was quiet for two seconds before it was read; only the emitted page
  of files is read for its text. A backfill of thousands of files costs
  work proportional to the files, plus one metadata walk per batch.
