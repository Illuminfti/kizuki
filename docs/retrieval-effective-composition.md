# Effective retrieval composition (#528 RI-01)

Status: inspection of this revision. Not a production-model binding, not a
rerank implementation, and not a corpus-scale performance receipt.

Exact head at the time of this inventory is the commit that lands this file.

## Public consumers

CLI `query`, MCP `search` / `context_packet` / `graph_neighbors`, and the local
app search host all call `dispatchServeTool` in core. Policy lives in
`serveSearch` and friends. Hosts only open a vault and, optionally, a retrieval
port.

Default vault ports (`loadVaultConfig` / `loadConfiguredRetrieval` /
`loadConfiguredEmbedding` when `serve.toml` is absent):

- retrieval: `kizuki.retrieval.fts5`
- embedding: `kizuki.embedding.none`

On that default, both CLI `openConfiguredRetrieval` and MCP `bindRetrieval`
leave the port unbound. Search then uses the deterministic ledger/canon floor
(`searchAuditCandidates`). The FTS5 implementation remains registered in core;
it is not the bound CLI/MCP engine unless a later host change opens it.

An optional enhancement is `kizuki.retrieval.embedded-pg` (`@kizuki/retrieval-pg`).
CLI may also pass an embedding port into that factory. MCP's stdio host does not
register `kizuki.embedding.gguf` when it binds the embedded engine, so a
`--retrieval kizuki.retrieval.embedded-pg` session is still lexical/hybrid/graph
without a vector provider unless some other host wires one.

## Registered versus bound capabilities

`kizuki.retrieval/v1` capabilities are `lexical`, `vector`, `hybrid`, `graph`,
and `provenance-erasure/v1`. There is no `rerank` capability and no rerank
method on `RetrievalPort`. Query `mode` may be `lexical`, `vector`, or `hybrid`.
`validateRetrievalQuery` rejects any other mode, including `rerank`.

| Surface | Registered `supports` | Bound instance |
| --- | --- | --- |
| `kizuki.retrieval.fts5` | `lexical`, `provenance-erasure/v1` | Same. No vector lane. |
| `kizuki.retrieval.embedded-pg` catalog | `lexical`, `vector`, `hybrid`, `graph`, `provenance-erasure/v1` | Drops `vector` unless an embedding port was supplied at open. Hybrid remains listed without a vector provider. |
| Serving nomination | n/a | `retrievalCandidates` always sends `mode: "lexical"`. MCP `search` has no mode field. |

A catalog row is not a configured production model. `@kizuki/embed-gguf`
implements `kizuki.embedding.gguf` behind `kizuki.embedding/v1` when an owner
supplies a local GGUF path. The default embedding id is `kizuki.embedding.none`.
Presence of the package does not mean a vault has a model, weights, or a live
endpoint.

## Embedding-space identity

`EmbeddingSpace.id` is the space identity. The GGUF helper formats it as
`gguf:<sanitized-model>@<dims>` with tokenizer id `gguf:kizuki-whitespace` and
recipe chunk 800/120. A changed space, dimension, or chunk configuration
disables vector retrieval on the embedded engine while lexical retrieval stays
usable. Serving never returns engine snippet text; it rehydrates live evidence.

FTS5 records `space: null`.

## Tokenizer and chunker limits

The embedded engine's inherited chunker splits on whitespace. It records
configured chunk sizes. It does not implement each embedding provider's
tokenizer. That remains a gap against the RFC 0002 tokenizer requirement.
Context packets use a separate `js-tiktoken@1.0.21/cl100k_base` tokenizer;
that is not the retrieval chunker.

## Local GGUF and rerank lane

Local GGUF embedding is the optional `@kizuki/embed-gguf` port above. It loads
an owner-supplied file, refuses runtime network, and does not download weights
on a read path. Transformer GGUF architectures are refused until a native
runtime is bound.

There is no Kizuki-owned rerank operation on this revision: no port method, no
CLI/MCP tool, no serving stage, and no GGUF cross-encoder binding. Upstream
`src/core/search/rerank.ts` is evidence of a pattern under D17. It is not
copied into this tree and is not a configured production model.

RI-02 owns implementing that operation against the accepted contracts. This
file must not be read as that implementation.
