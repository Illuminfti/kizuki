# Embed-GGUF package instructions

These rules apply under `packages/embed-gguf` in addition to the root
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

This optional package implements `kizuki.embedding.gguf` behind
`kizuki.embedding/v1`. It loads an owner-supplied GGUF from a configured
absolute path, records the resolved space identity, and embeds in-process.
It does not write canon, own retrieval, or download weights on a read path.

## Rules

- Context and batch sizes are pinned in config. Refuse auto-sizing.
- Embedding is single-flight. Never shell out per query.
- An unresolved, unreadable, or unsupported GGUF is a hard error, not an
  empty vector list and not a silent download.
- Zero-padding or truncating a vector to a different width is forbidden.
  A space or dimension mismatch throws `PortError("space_mismatch")`.
- Write only under `ctx.data_dir`. Never import `bun:sqlite` or name
  `kizuki.db`.
- Runtime network access is forbidden. `installGgufModel` copies a local
  file and verifies a hash; it does not fetch.
- Transformer GGUF architectures are refused until a native runtime is
  bound. Table-embedding GGUF files (including the test fixture) are the
  supported local path.
- Keep fixtures synthetic. Do not vendor third-party model weights.

## Tests

Prove space identity, pinned context/batch, missing-model denial, space
mismatch, single-flight, RSS ceiling, local install hash verification,
shared embedding conformance, and isolation. Then run package tests,
typecheck, and the full repository gate.
