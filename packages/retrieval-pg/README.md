# Embedded SQL retrieval port

`openEmbeddedRetrievalPort(ctx, options)` asynchronously acquires the writer
lease and opens one PGlite connection under `ctx.data_dir/store/pgdata`.
A lifetime native advisory lock on a stable lease inode excludes other writers;
process death releases the kernel lock. Holder tokens bind release and heartbeat
to the acquiring instance. Legacy live PID holders remain busy, while dead stale
or interrupted ownerless acquisitions recover with a receipt.
Callers await `close()` before opening that directory again. The deprecated
`createEmbeddedRetrievalPort` export is also asynchronous.

The store uses PostgreSQL weighted text search and GIN trigram indexes,
pgvector HNSW cosine indexes, and the permitted vendored ranking recipe.
Sensitivity and scope predicates are applied in SQL before candidate limits.
Document JSONB preserves the original retrieval contract fields. SQL subject
edges and the `entities` view derive graph provenance from indexed documents
and durable claim identifiers; they do not run entity extraction models.

Embedding calls run outside SQL transactions and the database queue. Pending
chunks persist before model invocation. Each model result is checked against
the chunk revision before commit, so deletion or replacement during a model
call cannot resurrect old content. A changed space receipt, dimension, or
chunk configuration disables vector retrieval while lexical retrieval remains
available. `embedPending()` resumes the durable backlog after interruption.

`rebuildFromDocuments()` accepts an iterable or async iterable of authoritative
`RetrievalDoc` values. It stages documents and all required embeddings in SQL
before replacing active documents, vectors, HNSW and metadata in one transaction.
Source, model and promotion-transaction failures leave the active index unchanged.
Vector-layer rebuild uses the same staging path. Without its embedding provider,
an existing embedded index cannot be replaced by a lexical-only rebuild. Mutations and active embedding work must finish before a rebuild;
conflicts return a retryable error. Legacy JSON is never searched or imported
as trusted data. A legacy store remains unavailable until a successful
explicit authoritative rebuild removes its legacy files.

`engine.json` preserves creation time and projects committed SQL space/rebuild
metadata. Atomic file writes fsync contents and the containing directory; reopen
repairs a projection interrupted after SQL commit. Surface opens wait for an
in-progress close; failed close remains unavailable instead of opening beside it.

PGlite 0.5.8 and pglite-pgvector 0.0.9 are exact dependencies. Five engine assets
are statically imported for Bun compilation and checked against fixed SHA-256
hashes. Extension archives are materialized in a fresh private directory under
the port directory and removed after the connection closes. No runtime asset
download is used.

## Qualification limits

- Native writer locking is qualified on Linux with libc. macOS remains an
  independent qualification gate; Windows is not implemented.

- The inherited chunker splits whitespace. It records its configured chunk
  sizes, but does not implement each embedding provider's tokenizer. This is
  still a gap against the complete RFC 0002 tokenizer requirement.
- Graph retrieval caps its SQL edge window at 10,001 and reports truncation or
  `graph-window` degradation. It does not claim exhaustive large-graph recall.
- Rebuild replacement is atomic, but its final transaction scales with the
  corpus. It is not a constant-time generation-pointer swap.
- No corpus-scale latency, throughput, memory, or recall benchmark is claimed.
- Public CLI/MCP binding, the workspace lock, and complete release artifact
  verification belong to the composition change that accompanies this engine.

## Verification

Run `bun test packages/retrieval-pg/test` with the repository's pinned Bun.
`test/sql-engine.test.ts` proves actual SQL index planning, scoped retrieval,
legacy migration refusal, rebuild rollback, deletion during embedding, and
space mismatch behavior. `test/compiled-engine-smoke.ts` can be compiled with
Bun and run after the checkout dependencies are moved aside; it disables
`fetch` and checks persistent reopen, retrieval, and deletion.

SQL migration 2 preserves existing documents while permitting unknown
`updated_at` values. Unknown dates sort last in the pending embedding queue.
The public `kizuki rebuild --layer all` path supplies authoritative documents;
partial public layers remain explicitly unsupported. See
[`RETRIEVAL-REBUILD.md`](../core/RETRIEVAL-REBUILD.md) for source bounds and the
per-store atomicity and concurrent-writer limitations.

The registration descriptor lists capabilities available from this implementation.
Each bound instance reports `vector` only when an embedding port was supplied.
Without one, hybrid reads declare `vector-skipped`, and claim insertion and owner
correction use structural deduplication while still updating the SQL index. The
current CLI and MCP composition binds lexical retrieval; it does not configure a
production embedding model or claim calibrated vector deduplication.

Native source-revocation maintenance may discard the entire owned `store/`
generation after SQL shutdown while retaining the writer lease. It seals the
old port, stops its watcher, drains queued SQL work, removes SQL/WAL and legacy
payload files, and fsyncs the managed root. Known engine/assets/lease metadata
remain. Unknown files, symlinks and hardlinks refuse deletion. If deletion is
interrupted after SQL closes, the native SQL-free maintenance entry can retry
under the same lease without reopening a partial database. This covers the
application-managed generation, not external copies or arbitrary raw handles.
An empty authoritative rebuild can clear a historical vector generation without
its embedding model; a nonempty rebuild still requires the original model space.

Native disposal now uses a retained directory capability and descriptor-relative
`openat`/`unlinkat` traversal, with native filename bytes, entry/depth limits and
same-directory absence verification. Completion also requires the named managed
root to retain its original identity. Linux x64 glibc is qualified for this
walker; other platforms return pending/unsupported until their ABI is tested.

Erasure stops lease heartbeats and releases only the native lock descriptor;
it leaves a content-free stale holder diagnostic. Reopening can therefore remain
busy until the existing three-heartbeat grace expires (600ms with default
settings). Erasure retains immutable extension assets rather than running a
pathname-based asset finalizer.

A root mismatch detected before shutdown terminally seals the port, rejects
queued/future SQL callbacks and refuses cleanup that could follow the changed
path. The native lock stays held until process exit. The report requires process
restart. **An SQL callback already active during external root replacement is
not contained by this fence.** It is reported as `active_sql_uncontained`, remains
pending, and is not verified erasure or support for live vault moves. The pinned
PGlite build uses awaited durability and has no separate NodeFS background sync
timer; that does not make already-started SQL safe under external path changes.
Stronger runtime containment remains a gate before live estate use.

SQL-free erasure recovery acquires the existing `lease/writer.lock` through
its captured directory descriptor. It neither creates a missing lock nor
writes holder, heartbeat or receipt files. Legacy live owners and fresh
ownership diagnostics still block maintenance. A missing compatible lock
leaves erasure pending. The separate FTS recovery path uses the same
existing-inode rule; ordinary engine startup retains its existing protocol.
