# `@kizuki/llm`

The `kizuki.llm/v1` model transport port. The producer consumes text from this
port; the receipted writer owns canon. Tests use a loopback fake endpoint.

## Implementations

| Id | Behavior |
| --- | --- |
| `kizuki.llm.none` | Default. `model_ref` is null. `health` is unavailable. `complete` throws `PortError("unavailable")` and never returns empty text. |
| `kizuki.llm.openai-compatible` | One `fetch` to `<base_url>/chat/completions`. Configured by the owner. |

## Config (`[ports.llm]`)

| Key | Required | Notes |
| --- | --- | --- |
| `base_url` | yes (openai-compatible) | `http` or `https` only. No userinfo, query, or fragment. |
| `model` | yes (openai-compatible) | Wire model id, sent as `model`. |
| `secret_ref` | no | `env:` or `file:` only. A literal key is a startup failure. |
| `timeout_ms` | no | Default `60000`. |
| `max_retries` | no | Default `2`. Bounded retries for network failures, timeouts and HTTP 429/502/503/504 share the request deadline. |

`model_ref` recorded by callers is `<port_id>:<model>@<host>`.

## Fail-closed rules

- No tools or function schema are sent.
- A response with `tool_calls`, `function_call`, or a non-text content part
  is discarded as `rejected: tool_call_in_response`.
- Network, timeout, and schema failures throw `PortError`. They are not an
  empty completion.
- Provider bodies and secret values never appear in errors.

## Provider response compatibility

The result carries assistant text, the model name and numeric usage. `reasoning` and
`reasoning_content` may be string or null. The three documented
`reasoning_details` record types (summary, text and encrypted) are accepted
with known keys and scalar values, then discarded. Reasoning strings are
bounded to 262,144 characters each; details have at most 128 records and
262,144 total string characters. Annotations may be absent, null or empty.
Reasoning and annotations are never forwarded as claims, prompts or logs.

Unread assistant-message keys are discarded without being copied into the
result. Malformed named passive metadata fails with `unsupported_metadata`.
Audio, image, file and tool payloads are refused, including additional data
fields hidden beside a text content part. Every returned choice is validated
before the first choice supplies text. Refused, truncated and incomplete
completions have distinct failure classes. These response failures are
terminal for that call and are not retried. The extraction claim payload
inside assistant text remains an exact schema.

Run receipts preserve a content-free `model.diagnostic` when available:
response/transport class, or claim schema field/rule/type/count, or a budget
dimension with used/requested/limit. `doctor` distinguishes these outcomes and
reports the latest failed attempt and last usable success independently for the
current model. New receipts bind the original model reference through a
`model_ref_sha256` digest before display redaction, so long model names cannot
collide in doctor history. Older receipts whose reference was already redacted
without a digest remain explicitly unattributed; they do not count as current
model success or failure. Lossless older references still match exactly.
`current_failure` reflects the newest attributable attempt and controls model
health; a later usable success clears it while preserving `last_failure`.
An unrelated model or a run without a model attempt cannot clear a failure.
`history_unverified` remains true when a potentially matching unattributed
attempt is newer than every attributable attempt. A later current-model
attempt establishes its state; a later success retains the history warning
without failing health. Durable receipt ordering handles equal timestamps.
Model history uses an indexed window of the newest 10,000 sync receipts,
independently of other rails. `history_truncated` discloses when historical
success/failure fields and counts cover only that selected window. If runs
without a current-model attempt fill the window and hide the deciding attempt,
current health stays unverified. This includes a flood of other models' runs.
Unreadable selected history also remains unknown until a later valid attempt
establishes current state. The index includes run id so even a large group of
equal timestamps preserves bounded selection and deterministic ordering.
Diagnostics contain no provider prose, rejected field names, predicate values
or raw responses. The claim JSON schema remains exact.

The extraction pass still permits at most 2 calls, 8,000 estimated input tokens
and 2,000 reserved output tokens. A refused prompt now identifies that budget;
this change does not make every character-bounded batch fit those limits.

Primary schema references checked 2026-09-05:
[OpenRouter reasoning metadata](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
and [DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/).

## Verification

```bash
bun test packages/llm/test packages/core/test/producer
bun test packages/cli/test/model-compatibility.test.ts packages/core/test/serve/model-diagnostics.test.ts
bun run typecheck
```

## Egress

The only network call site is `src/transport.ts`, listed in
`scripts/network-allowlist.txt`. `@kizuki/core` cannot import this package.
