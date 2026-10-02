# Retrieval-pg package instructions

These rules apply under `packages/retrieval-pg` in addition to the root
`AGENTS.md`.

## Binding context

`docs/CURRENT.md`, `docs/decision-log.md` and `rfcs/0002-autonomous-canon.md`
override this file and the root `AGENTS.md` wherever they conflict. Read them
before editing anything here. No change in this package may restate or
reintroduce a superseded policy: owner-invoked promotion or an owner review
queue or approval step (D9, D10), owner labeling of sensitivity (D11), a
zero-model floor that writes canon (D12), a SQLite-only rule for derived
retrieval (D13), or an owner-started daemon (D15).

## Responsibility

This optional package implements `kizuki.retrieval.embedded-pg` behind
`kizuki.retrieval/v1`. It owns a rebuildable store under
`ctx.data_dir` (`<vault>/.kizuki/retrieval/<port-id>/`), the entity graph,
the writer lease, and the retrieval recipe (reciprocal rank fusion at
`k = 60`, layered near-duplicate post-filter, authority-weighted
finalization, declared degradation). The recipe and graph walk are a
permitted fork under `vendor/` of the public-tip algorithm files named in
that directory's NOTICE. Hybrid is the search path when an embedding port
is bound; otherwise the port degrades to lexical and declares
`vector-skipped`. When the embedding call fails or times out, hybrid answers
by keyword and declares `vector-unavailable`; only a vector-only search throws.
Chunks hold body text sized by the embedding port's tokenizer when it has one;
the title travels beside each chunk. The engine refuses a corpus above
`max_text_bytes` (default 4 MiB) whole, before touching the active index, and
records the refusal in `engine.json` for `kizuki doctor`. Fixed document,
metadata, subject-link and chunk caps also bound expansion. These workload
limits do not promise a measured RSS ceiling. `kizuki.retrieval.fts5` remains the zero-model default.
It does not write canon, own correction, label sensitivity, install a
daemon, or implement purge totality. Rerank and local GGUF stay out of
this package.

## Rules

- Write only under `ctx.data_dir`. Never import `bun:sqlite` or name
  `kizuki.db`.
- `requires_lease` is true. One writer per vault. A live holder's lease is
  never stolen. A dead holder's stale lease is reclaimed with a receipt.
- The ceiling is applied in the store. Unlabeled documents are never
  served. An empty scope returns nothing and is declared, never widened.
- Degradation is declared. Unavailable is not empty.
- No store transaction may span an embedding call.
- Runtime network access is forbidden. No hosted server.
- Do not name the upstream retrieval engine here. Credit lives only in
  `README.md` and `docs/upstream-policy.md`.
- Keep fixtures synthetic.

## Tests

Prove shared retrieval conformance, the eleven named contention cases in
RFC 0002 §9.7, isolation, ceiling enforcement, graph neighbors, verified
deletion, and restart. Then run package tests, typecheck, and the full
repository gate.
