# LLM package instructions

These rules apply under `packages/llm` in addition to the root `AGENTS.md`.

## Binding context

`docs/CURRENT.md`, `docs/decision-log.md` and `rfcs/0002-autonomous-canon.md`
override this file and the root `AGENTS.md` wherever they conflict. Read them
before editing anything here. No change in this package may restate or
reintroduce a superseded policy: owner-invoked promotion or an owner review
queue or approval step (D9, D10), owner labeling of sensitivity (D11), a
zero-model floor that writes canon (D12), a SQLite-only rule for derived
retrieval (D13), or an owner-started daemon (D15).

## Responsibility

Two port implementations and nothing else:

- `kizuki.llm.openai-compatible` implements `kizuki.llm/v1` over an
  OpenAI-compatible chat-completions endpoint.
- `kizuki.producer.model` implements `kizuki.producer/v1` by asking that port
  to extract claim drafts from quoted events.

The package owns no schema, no table, no vault file and no CLI verb. It never
writes canon; it returns drafts to whoever bound it.

## Rules

- `src/transport.ts` holds the only `fetch` in the tree. Adding a second
  network call site anywhere fails `bun run verify`.
- A provider answer is attacker-controlled input. Validate it against a closed
  key set before reading a value out of it; a tool call, a non-text content
  part or an unknown key is a rejection, never a warning.
- Captured text goes only in the user role, only inside the nonce fence, and
  never into the request's structure.
- Credentials are `secret_ref` URIs resolved through `ctx.secrets` at call
  time. Never read a key from the environment here, never store one, never let
  one reach a message, a log line or a test fixture.
- Bound every allocation the endpoint or the capture can drive: response
  bytes, prompt characters, claim counts, retries and waits.
- A model that did not answer is `unavailable`, not `ok` with no claims. The
  distinction is what stops a caller advancing a checkpoint over lost work.
