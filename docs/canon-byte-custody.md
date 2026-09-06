# Canon byte custody

Canon page reads and receipt appends use private descriptor capabilities on
Linux x86-64 with glibc and the pinned Bun runtime. The public `CanonIo`,
`readPage`, receipt shapes, and writer entry points are unchanged. These
capabilities are internal modules and confer no ledger or writer authority.

## Page reads

`readPage` borrows the operation's bound canon capability, or opens and closes a
short-lived capability for a standalone read. Hashing and frontmatter parsing
use a copy of the same bounded snapshot. A missing page returns `null`; a final
directory component remains `CanonPageUnreadable` with code `EISDIR`. Other
capability refusals report `EIO`. The existing 1 MiB canon file bound also applies
to standalone reads.

Standalone reads now require the same supported native backend and trusted
directory ancestry as owned reads. Unsupported platforms or unavailable native
support refuse with `CanonPageUnreadable`; there is no pathname byte fallback.

## Receipt appends

The receipt capability holds the vault root, control directory, receipt
directory and fixed `promotions.jsonl` child until closed. Child operations are
descriptor-relative. Each operation checks the original mutation owner, named
directory identities, and the held file's identity, metadata and expected size.
Opened receipt files must be regular, owned, single-link and owner-writable.
Complete writes, file sync and receipt-directory sync precede success.

Ordinary receipts use a write-only append descriptor, preserving existing
write-only logs. The writer can create the fixed receipt directory with mode
0700 and a missing log with mode 0600. It does not read existing receipt bytes
and introduces no total log-size limit. Group- or other-writable existing logs
are refused.

Source-erasure receipts retain their existing 32 MiB read/append limit, which is
separate from the canon page bound. Their parent must already exist. A writable
existing source log is repaired to mode 0600 through its held descriptor;
read-only logs are refused. The domain layer still parses each JSONL line,
accepts exactly one identical same-ID line on retry, and rejects conflicting or
duplicate same-ID lines. It holds a verification/close facade through the
existing SQLite receipt-and-intent transaction.

A failed stream cannot be reused as evidence of success. Closing is idempotent
and attempts to release all held descriptors. Uncertain append bytes are
preserved for domain recovery; the capability does not truncate, delete, invent
a journal, or add another write protocol. Descriptor custody does not provide
compare-and-swap against an uncooperative process running as the same owner.

## Verification scope

`packages/core/test/canon/receipt-stream.test.ts` uses temporary synthetic
vaults and real file-backed ledgers. It covers read/hash/parse agreement,
permissions, limits, retry/conflict, SQLite rollback and commit, retained
references, short writes, stopped writes, sync failure and descriptor cleanup.
Qualification uses the supported pinned Linux runtime and trusted temporary
directory custody. Existing ordinary canon, correction, undo, source erasure
and export consumers provide integration coverage.

Receipt-log readers used by budget/maintenance, receipt sanitization, page
discovery and any broader crash journal remain separate work. This change does
not claim to complete those paths or general release qualification.
