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
- A provider answer is attacker-controlled input. The model's own JSON is
  validated against a closed key set: an extra key there is a rejection, never
  a warning. The HTTP envelope around it is read for what it must not contain
  instead - a tool or function call field, a content part that is not text, a
  stop that does not mean a finished answer, a refusal - because every server
  adds fields of its own and refusing those would spend a paid request per
  pass while proving nothing. Every key this package does read is validated:
  a malformed count or model is a rejection, not a silent null.
- Every string that came from a record goes only in the user role, only inside
  a nonce fence, and never into the request's structure. That includes the
  context block: a subject id comes from a connector and a known claim's
  object came out of an earlier model answer. Only the predicate registry,
  which this repository owns, may sit outside a fence.
- Credentials are `secret_ref` URIs resolved through `ctx.secrets` at call
  time. Never read a key from the environment here, never store one, never let
  one reach a message, a log line or a test fixture. A reference this package
  cannot resolve is refused at config time without echoing the value.
- Provider and model text never reaches `ctx.logger`. Log a count, or a value
  from a closed set this package defines. A model can reproduce captured text,
  and the logger is stderr or the service journal.
- Bound every allocation the endpoint or the capture can drive: response
  bytes, prompt characters, context length, claim counts, retries and waits.
  A stated bound is a bound on what is sent, after escaping and clipping.
- Budgets bound what goes on the wire, not what was intended: `max_calls`
  counts requests including retries, and tokens are reserved before a call at
  the most conservative ratio and charged at what the endpoint reported. A
  failure is charged too. The port attaches the requests a failed call had
  already made to the error it throws, and the producer charges that rather
  than the single request it could infer; a receipt that under-reports a run
  is a receipt nobody can audit a bill against.
- A `PortError` code says what kind of failure it is, not which one.
  `not_supported` is reserved for calling a capability a port never declared,
  which RFC 0002 §3.3 calls a bug in core, so a provider answer this package
  refuses travels as an unretryable `unavailable` and its `reason` is the
  discriminator a producer switches on.
- A model that did not answer is `unavailable`, not `ok` with no claims. The
  distinction is what stops a caller advancing a checkpoint over lost work,
  and `covered_event_ids` is what tells it how far it may advance when a run
  stopped part way.
