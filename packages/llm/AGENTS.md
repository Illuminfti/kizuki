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

This package implements `kizuki.llm/v1`. It is the model transport port:
`kizuki.llm.none` and `kizuki.llm.openai-compatible`. It is not a producer,
does not write claims or canon, and does not own extraction prompts.

## Rules

- `@kizuki/core` must not import this package. Reach the model only through
  `kizuki.llm/v1`.
- The only runtime dependency is `@kizuki/core`. No provider SDK.
- Exactly one `fetch` call exists, in `src/transport.ts`. Tests use a
  loopback fake in `test/fake-endpoint.ts`. Both files stay on the network
  allowlist with a reason.
- Unavailable is not empty. `complete` returns a response or throws
  `PortError`. A missing, dead, or rejected model call must never look like
  a successful empty completion.
- Reject `tool_calls`, `function_call`, `function_calls`, `tool_call_id`,
  audio, image, file, attachment and data fields, and any non-text content
  part as `rejected: tool_call_in_response`. Send no tool or function schema.
- Secrets are `secret_ref` URIs resolved at call time. A plaintext key in
  config is a construction failure. Never put a key, provider body, or
  captured text into an error or log line.
- `model_ref` is `<port_id>:<model>@<host>`. It names the model, not a
  credential.
- Do not implement the model producer, fenced prompts, `kizuki tell`,
  sensitivity, retrieval, serve, purge, undo, or audit here.

## Tests

Prove the tri-state (`none` / success / unavailable), tool-call rejection,
allowlisted egress, the core import boundary, and the shared LLM
conformance suite against both in-tree implementations. Then run package
tests, typecheck, and the full repository gate.
