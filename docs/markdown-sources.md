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
