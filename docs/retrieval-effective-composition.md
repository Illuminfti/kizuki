# Effective retrieval composition (#528 RI-01)

Status: inspection of this revision. Not a production-model binding and not a
corpus-scale performance receipt.

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
Every host that binds it also binds the vault's configured embedding port
(`kizuki.embedding.local-http` or `kizuki.embedding.gguf`) and passes it to the
factory: the CLI in `openConfiguredRetrieval`, the MCP stdio host in
`bindRetrieval`, and therefore the daemon, which runs on the CLI's binding. A
process that writes the engine without the embedder would cut chunks for another
tokenizer, so configured hosts carry the embedder with the engine.
`kizuki query` and `kizuki context` bind it when an embedding port is selected
and its writer lease is free. Where a live host holds it, they use the floor and
say so.

## Registered versus bound capabilities

`kizuki.retrieval/v1` capabilities are `lexical`, `vector`, `hybrid`, `graph`,
and `provenance-erasure/v1`. There is no `rerank` capability and no rerank
method on `RetrievalPort`. Query `mode` may be `lexical`, `vector`, or `hybrid`.
`validateRetrievalQuery` rejects any other mode, including `rerank`.

| Surface | Registered `supports` | Bound instance |
| --- | --- | --- |
| `kizuki.retrieval.fts5` | `lexical`, `provenance-erasure/v1` | Same. No vector lane. |
| `kizuki.retrieval.embedded-pg` catalog | `lexical`, `vector`, `hybrid`, `graph`, `provenance-erasure/v1` | Drops `vector` unless an embedding port was supplied at open. Hybrid remains listed without a vector provider. |
| Serving nomination | n/a | `retrievalCandidates` sends `mode: "hybrid"` when the bound descriptor lists both `vector` and `hybrid`, and `mode: "lexical"` otherwise. MCP `search` has no mode field: the host chooses. When the vault configures an embedding port and the answer was not vector-ranked, it carries `retrieval-vector-unavailable` (engine unavailable, no vector lane, embedding server down or space mismatch) or `retrieval-vector-partial` (some chunks have no vector yet). Other engine strings are `retrieval-degraded`. |

A catalog row is not a configured production model. `@kizuki/embed-local-http`
implements `kizuki.embedding.local-http` behind `kizuki.embedding/v1`: it calls an
embedding server the owner runs on a loopback address and is the local model path.
`@kizuki/embed-gguf` implements `kizuki.embedding.gguf` for the small table
format used by tests and refuses real transformer models. The default embedding
id is `kizuki.embedding.none`. Presence of a package does not mean a vault has a
model, weights, or a live endpoint. Configuration is in
[the CLI reference](cli.md#semantic-retrieval-embedding-port).

## Embedding-space identity

`EmbeddingSpace.id` is the space identity. The GGUF helper formats it as
`gguf:<sanitized-model>@<dims>` with tokenizer id `gguf:kizuki-whitespace`,
recipe chunk 800/120 and prompts that are slots only (`{q}`, `{title}\n{text}`),
because a table embedder averages every word it is given. The local HTTP port
formats it as `local-http:<sanitized-model>@<dims>#<digest>`, where the digest
covers the model, width, both prompts, the tokenizer id and chunk parameters, so a prompt change
is a new space. A changed space, dimension, or chunk configuration
disables vector retrieval on the embedded engine while lexical retrieval stays
usable. Serving never returns engine snippet text; it rehydrates live evidence.

FTS5 records `space: null`.

## Tokenizer and chunker limits

The embedded engine chunks by whitespace-separated words unless its embedding
port offers `countTokens`, in which case chunk size and overlap are counted in
that port's tokens. The engine never puts the title in a chunk: it hands the
port the document title beside each chunk and the port frames it. The local HTTP
port uses the conservative `kizuki:utf8-bytes-v1` budget, counting UTF-8 bytes
including separators. This bounds byte-level BPE and byte-fallback tokenizers,
but is not an exact model tokenizer; the configured window must also cover any
server-side input expansion. Chunks written by a process that had no embedder are cut again the
first time an embedder is about to use them and nothing has been embedded yet.
Context packets use a separate `js-tiktoken@1.0.21/cl100k_base` tokenizer;
that is not the retrieval chunker.

## Engine memory bound

The embedded engine is opt-in and runs in process. Its conservative workload
bounds are 4 MiB of titles and bodies, 5,000 documents, 10,000 chunks, 20,000
subject links and 16 MiB of serialized document metadata. Both incremental
writes and staged rebuilds check these bounds before modifying the active index;
rebuild checks the whole input before calling the model. A refusal is recorded
in `engine.json`, and doctor names the exceeded resource and limit. A failed
rebuild preserves the prior index and the lexical floor remains usable. Only a
successful authoritative rebuild clears the refusal.

The text cap is configurable with `max_text_bytes` (1 MiB to 1 GiB); the other
caps are fixed. These limits bound the corpus and vector allocation, not the
engine's RSS or disk high-water mark after repeated writes. No measured daemon
capacity or real-model recall claim is made. Keep embeddings off until the local
server and engine fit the service unit's CPU and memory budget. A different
vector-store implementation remains outside this change.

## Local GGUF and rerank lane

Local GGUF embedding is the optional `@kizuki/embed-gguf` port above. It loads
an owner-supplied file, refuses runtime network, and does not download weights
on a read path. Transformer GGUF architectures are refused until a native
runtime is bound.

D17 GGUF cross-encoder rerank is still unimplemented: no `RetrievalPort`
method, no CLI/MCP tool, no serving stage, and no GGUF cross-encoder binding.
Upstream `src/core/search/rerank.ts` is evidence of a pattern under D17. It is
not copied into this tree and is not a configured production model.

Core also exports `rerankWithSystemOne`, an optional D20 System One helper
after an FTS5 or embedding shortlist. It is not a `kizuki.retrieval/v1`
capability, not a query `mode`, and not a serving or CLI/MCP stage. An
unconfigured port keeps the shortlist order. A configured but dead port is
unavailable, never a silent empty success. That helper is not RI-02 and is
not D17 GGUF rerank.

RI-02 still owns a bounded rerank operation against the accepted retrieval
port and model contracts. This file must not be read as that implementation.
