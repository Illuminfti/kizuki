# Public authoritative retrieval rebuild

`kizuki rebuild [--layer all] [--json]` reconstructs the configured retrieval
store and the SQLite lexical/search/graph floor from the named vault. With the
default FTS selection, only the existing lexical floor is rebuilt; no second
FTS store is opened. The legacy floor indexes page and event rows; an optional
retrieval port receives the validated projection, including readable live
claims. The report identifies `backend` as `sqlite-floor` or `retrieval-port`.
`documents` counts the actual selected store's corpus, while `floor_documents`
always counts the rebuilt SQLite page/event rows. `store` retains the selected
store ID; `generation` identifies the floor rebuild. The floor's candidate
rows and the port's authorized projection can have different counts; serving
still applies current authority and access checks to either backend's results.
Other
`--layer` values are explicitly refused. RFC 0002 sections 9.6 and 18.3 describe
layer-specific rebuilds; this implementation provides the full reconstruction
path and does not claim partial layers are implemented.

`readRetrievalDocuments(db, vaultPath)` is the shared projection boundary. It
reads current canon bytes and their hash-bound receipt authority, live events
through the serving source resolver, and readable live claims through the same
claim policy used by serving. Held, unlabelled, retracted and unsupported
material is excluded. Invalid or unreadable canon refuses the whole rebuild
before replacing a store. Every emitted document passes the retrieval contract.

Dates describe evidence, not work performed by the rebuild. Events retain
`observed_at`; claims retain `created_at`. Canon uses the timestamp of a receipt
whose after-hash matches the actual bytes, or `null` when no such timestamp is
known. It never substitutes mtime, rebuild time or the Unix epoch. PostgreSQL
migration 2 makes `updated_at` nullable and places unknown dates last in the
embedding queue. FTS uses its existing empty-string storage convention for
unknown dates; the public document contract uses null.

The preflight refuses more than 10,000 combined ledger events, live claims and
canon pages, more than 20,000 filesystem entries, more than 64 MiB of canon
files, or more than 64 MiB of event/claim text. It inspects only the requested
vault, skips `.kizuki` and `archive`, and refuses symbolic links. These bounded
limits are explicit, not silent truncation.

PostgreSQL stages documents and embeddings before one transactional replacement;
source or embedding failure retains the old active index. FTS stages validated
documents before its own SQLite replacement transaction. The legacy lexical
floor prevalidates canon and replaces its search and graph tables transactionally.

Atomicity is per store. PostgreSQL, the FTS port and the legacy lexical floor do
not share a distributed transaction: failure after one store commits may leave
generations different, and the command must be retried. The PostgreSQL writer
lease protects that engine. Source reads use a SQLite read snapshot, but canon
files and later source writes are not globally locked for the duration of
staging or embedding. Run against quiescent source writers for a fixed-corpus
rebuild; concurrent source changes may require another rebuild. These are not
claims of a global point-in-time snapshot or crash-atomic multi-store commit.

Rebuild requires no model or secrets for lexical operation and fetches nothing
at runtime. A store that already contains a configured vector space still
requires its matching embedding port to rebuild that space; the public CLI
refuses when that binding is unavailable instead of discarding vector state.
