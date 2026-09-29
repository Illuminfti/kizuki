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
tokenizer, so none does. `kizuki query` and `kizuki context` bind the engine when
its writer lease is free. Where a live host holds it, they use the floor and
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
covers the model, width, both prompts and the tokenizer id, so a prompt change
is a new space. A changed space, dimension, or chunk configuration
disables vector retrieval on the embedded engine while lexical retrieval stays
usable. Serving never returns engine snippet text; it rehydrates live evidence.

FTS5 records `space: null`.

## Tokenizer and chunker limits

The embedded engine chunks by whitespace-separated words unless its embedding
port offers `countTokens`, in which case chunk size and overlap are counted in
that port's tokens. The engine never puts the title in a chunk: it hands the
port the document title beside each chunk and the port frames it. The local HTTP
port has no model tokenizer to call, so its `countTokens` is the high estimate
`kizuki:estimate-v1` (see the CLI reference); a real tokenizer is not
implemented. Chunks written by a process that had no embedder are cut again the
first time an embedder is about to use them and nothing has been embedded yet.
Context packets use a separate `js-tiktoken@1.0.21/cl100k_base` tokenizer;
that is not the retrieval chunker.

## Engine memory bound

The embedded engine holds its corpus in the daemon's own memory. Measured on
this revision with synthetic 300-word documents, it costs about 0.4 GiB to start
and 130 to 170 MiB more for every MiB of text it indexes, and its resident size
does not shrink after a large write. After the daemon's own working set, a
2 GiB service unit leaves room for roughly 5 to 6 MiB of text (an estimate, not
a measurement of the daemon). The engine therefore accepts
at most `max_text_bytes` of titles and bodies (default 4 MiB, configurable from
1 MiB to 1 GiB under `[ports.retrieval]`) and refuses a larger corpus whole,
before it touches the active index, recording the refusal in its `engine.json`.
`kizuki doctor` reads that record and prints why hybrid ranking is off. A vault
larger than the bound stays on the lexical floor; a SQLite-resident vector lane
would lift the bound and is an open decision, not part of this revision.

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
