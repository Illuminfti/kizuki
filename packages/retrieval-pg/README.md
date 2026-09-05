# Embedded SQL retrieval port

`openEmbeddedRetrievalPort(ctx, options)` asynchronously acquires the writer
lease and opens one PGlite connection under `ctx.data_dir/store/pgdata`.
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
`RetrievalDoc` values. It stages documents in SQL and replaces the active
derived rows in one transaction. Source failure leaves the active index
unchanged. Mutations and active embedding work must finish before a rebuild;
conflicts return a retryable error. Legacy JSON is never searched or imported
as trusted data. A legacy store remains unavailable until a successful
explicit authoritative rebuild removes its legacy files.

PGlite 0.5.8 and pglite-pgvector 0.0.9 are exact dependencies. Five engine assets
are statically imported for Bun compilation and checked against fixed SHA-256
hashes. Extension archives are materialized in a fresh private directory under
the port directory and removed after the connection closes. No runtime asset
download is used.

## Qualification limits

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
