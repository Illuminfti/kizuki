# Embed-local-http package instructions

These rules apply under `packages/embed-local-http` in addition to the root
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

This optional package implements `kizuki.embedding.local-http` behind
`kizuki.embedding/v1`. It sends document and query text to an embedding server
the owner runs on the same machine (an OpenAI-compatible `/v1/embeddings` or an
ollama-compatible `/api/embed` endpoint) and validates what comes back. It
does not start, download or supervise a server or a model. It does not write
canon or own retrieval.

## Rules

- The endpoint must be an IPv4 loopback or `::1` address literal over plain
  `http`. Hostnames, other addresses, credentials, query strings and redirects
  are refused at configuration time. There is no override.
- All traffic goes through `postJson`, which opens a socket to the configured
  address itself. Do not use `fetch` or `node:http`: both send loopback
  requests through an `HTTP_PROXY` set in the environment.
- Model id, dimensions, context size, chunk size and prompts are pinned in
  config. Refuse auto-sizing and defaults for the model, dimensions and context.
- Zero-padding or truncating a vector to a different width is forbidden. A
  wrong width, a wrong count or a non-finite value throws
  `PortError("space_mismatch")`.
- A prompt or tokenizer change changes `space.id`.
- Errors never carry document, query or response text.
- Write only under `ctx.data_dir`. Never import `bun:sqlite` or name
  `kizuki.db`. Never spawn a process.
- Keep fixtures synthetic. The tests run a fake server on 127.0.0.1.

## Tests

Prove the loopback refusal matrix, both wire formats, space identity and
prompt sensitivity, dimension and count mismatch, deadline, oversized response,
proxy bypass, budget refusal, shared embedding conformance, and isolation.
Then run package tests, typecheck, and the full repository gate.
