# Cooperating vault mutations

Core canon writers now acquire the existing native writer flock once at their public operation boundary. Nested work receives a live internal scope and uses the captured database and resolved vault root. The scope is held through asynchronous work, cascade undo, receipt updates, reservation settlement, and awaited cleanup. A deadline can finish the caller response while the actual operation still owns the writer.

The internal scope validates the exact database object and root pair. File-only init, notifier, and vault identity operations use a target without a database. The scope does not assert that a database file physically belongs to a root. Nested maintenance under a database-bound scope must preserve that complete target.

The caller-owned `CanonFiles` capability opens inside the scope and closes before scope release. A private registry binds frozen canon I/O snapshots to that live scope and exact descriptor root. Public I/O objects carry no capability field. Canon page preimages and native writes borrow the same capability through the operation. Receipt streams retain their existing bounded descriptor protocols under the same writer; the page adapter's one-MiB bound is not applied to a receipt stream.

| Public operation | Owned work |
| --- | --- |
| Canon apply | Stable inputs, page publication, receipts, ledger/index and derived updates |
| Undo | Recursive cascade, archive restoration, retrieval reversal and receipt/index updates |
| Local and serving correction | Correction recording, claim work and nested canon publication |
| Write pass | Extraction/replay, nested canon writes and reservation settlement |
| Purge, verification and resume | Durable discovery, store proof, hold rewriting and owned store close |
| Source payload erasure | Canon and archive erasure, receipt stream rewriting and store cleanup |
| Retrieval rebuild | Late rebuild completion and authorization cleanup |
| Init | Existing-root permission repair, doctrine and init-journal writes |
| Vault identity | Minting, adoption and machine-change reminting |
| File notifier | Brief/notification creation and replacement |
| Export | Existing inventory/capture/progress/publication orchestration |

Source access denial still commits independently before the separately fenced erasure stages. No database transaction is held across an await. Existing non-mutating init dry runs and already bound vault-ID reads remain available while a writer is active. A failed fresh init leaves its incomplete root available for repair so the active writer inode is never removed.

Public operations do not reenter an existing owner. Contention uses bounded domain errors: canon/undo/correction `writer_busy`, purge `canon_changed`, write-pass `lock:busy`, notifier/rebuild retryable `unavailable`, and serving correction its existing generic retry response. Export and vault-ID mutation expose the internal typed busy error. An export progress callback that invokes a public writer receives that contention result.

Export now begins a top-level immediate SQLite capture before its authoritative inventory, selected file copies, metadata and database streams. Progress runs outside the transaction with the same cooperating owner retained; a final immediate transaction checks source admission, purge recovery, identities and the staged artifact before owned no-replace publication. See [export inclusion and recovery limits](export-inventory.md) for unnamed database compatibility and the inventory preview contract. Manual filesystem edits, full crash recovery, backup recovery authority, cross-platform native qualification, and release acceptance remain separate gates.
