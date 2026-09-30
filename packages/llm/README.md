# `@kizuki/llm`

The `kizuki.llm/v1` model transport port. The producer consumes text from this
port; the receipted writer owns canon. Tests use a loopback fake endpoint.

## Implementations

| Id | Behavior |
| --- | --- |
| `kizuki.llm.none` | Default. `model_ref` is null. `health` is unavailable. `complete` throws `PortError("unavailable")` and never returns empty text. |
| `kizuki.llm.openai-compatible` | One `fetch` to `<base_url>/chat/completions`. Configured by the owner. |
| `kizuki.systemone.jev` | Optional typed-decision port. One `fetch` to `<base_url>/systemone`. Never generates claims. |

## Config (`[ports.llm]`)

| Key | Required | Notes |
| --- | --- | --- |
| `base_url` | yes (openai-compatible) | `http` or `https` only. No userinfo, query, or fragment. |
| `model` | yes (openai-compatible) | Wire model id, sent as `model`. |
| `secret_ref` | no | `env:` or `file:` only. A literal key is a startup failure. |
| `timeout_ms` | no | Default `60000`, at most `600000`. It is the only limit on a request: the transport turns off Bun's own five-minute fetch cutoff, so a value above `300000` is honoured. |
| `max_retries` | no | Default `2`, at most `8`. Bounded retries for network failures, timeouts and HTTP 429/502/503/504 share the request deadline. |
| `reasoning_effort` | no | `none`, `minimal`, `low`, `medium` or `high`, sent as the chat-completions `reasoning_effort`. Absent sends nothing. Hidden reasoning counts against the output reservation, so a lower effort leaves more of it for the answer. Providers accept different subsets; an unsupported value is refused by the provider. |
| `temperature` | no | A number from `0` to `2`, sent as `temperature`. Absent sends nothing and the provider default (often 0.8 to 1.0) applies. Extraction wants `0`. |
| `json_mode` | no | `true` sends `response_format: {"type": "json_object"}`. Absent or `false` sends nothing. The endpoint must support it; one that does not refuses the request. |
| `retention` | no | The class the owner declares for this destination: `zero_retention`, `logged_no_training` or `logged_and_trained`. Never sent on the wire. Source consent compares it with the class each grant accepts (see the [retention classes](#retention-classes)). Absent means undeclared, which counts as `logged_and_trained`. |

The request body carries `temperature`, `response_format` and `provider` only when they are configured, so a config that sets none of them sends the same bytes as before.

### Retention classes

A declaration is only as strong as what the request asks for. Unless `base_url`
is a loopback address, where nothing leaves the machine:

- `zero_retention` needs `[ports.llm.provider]` with `zdr = true` and
  `allow_fallbacks = false`, so the router cannot fall back to an endpoint that
  keeps prompts.
- `logged_no_training` needs `data_collection = "deny"` or `zdr = true`.
- `logged_and_trained` needs nothing; it is the loosest claim.

Anything else is a startup failure. The declaration is the owner's statement, not
proof: Kizuki cannot see what a provider does with a prompt.

Classes are ordered from strictest to loosest: `zero_retention`,
`logged_no_training`, `logged_and_trained`. A source grant states the loosest
class it accepts in `egress.external_retention` (the same three values, plus the
older `provider_managed`, which accepts any model). Text is sent to the model
only when the model's declared class is at least as strict as the class the
grant accepts. A model that declares nothing counts as `logged_and_trained`, so a
grant that accepts only `zero_retention` or `logged_no_training` holds its events
until the configuration declares a class that satisfies it. A grant that names
`provider_managed` keeps working unchanged. The declared class is part of the
model binding, so changing it re-checks deferred work.

A configured `kizuki.systemone.jev` judge is sent the same events and the
extracted claims, so it is model egress too. The serving host treats it as a
second destination of the producer. Events are sent only when the source grant
consents to it: `egress` names the judge as `judge_endpoint`
(`<base_url>/systemone`) and `judge_model`, beside the extraction model. The
judge declares no retention class, so the grant must accept `logged_and_trained`
or `provider_managed`. A grant without the pair holds those events instead of
sending them; nothing is kept as an empty result, and `kizuki doctor` names the
hold.

### Provider privacy controls (`[ports.llm.provider]`)

Optional. An allow-listed table that is sent unchanged as the request's
`provider` object, for OpenAI-compatible routers that understand it (OpenRouter
is the reference). Absent, nothing is sent. An unknown key, a wrong type or an
empty, oversized or malformed list is a startup failure.

| Key | Type | Notes |
| --- | --- | --- |
| `data_collection` | `"allow"` or `"deny"` | `deny` asks the router to route only to providers that do not collect or train on prompts. |
| `zdr` | boolean | `true` asks for zero-data-retention endpoints only. |
| `order` | list of provider names | Providers to try first, in order. |
| `only` | list of provider names | Providers the router may use; no others. |
| `ignore` | list of provider names | Providers the router must not use. |
| `allow_fallbacks` | boolean | `false` stops the router falling back outside `order`/`only`. |

Lists hold one to 32 names of up to 64 characters (letters, digits, `.`, `_`,
`/`, `:`, `-`).

```toml
[ports.llm]
id = "kizuki.llm.openai-compatible"
base_url = "https://openrouter.ai/api/v1"
model = "vendor/model"
secret_ref = "env:OPENROUTER_API_KEY"

[ports.llm.provider]
data_collection = "deny"
zdr = true
```

Kizuki forwards these controls; the router enforces them. Kizuki cannot see or
prove what a provider does with a prompt, and an endpoint that ignores
`provider` ignores the request. The controls are not part of the model binding
that source consent names: consent binds the endpoint, the model and the declared
retention class, so tightening or loosening the table does not invalidate a grant,
but a declared class the table cannot back is refused at startup. The controls choose among the
providers behind the endpoint the owner already consented to; they never change
where the request is sent. `kizuki connect status` shows the controls each
grant would run under, so a loosened table is visible.

A retry waits for the provider's `Retry-After`, or backs off exponentially from
two seconds without one; every wait is capped at 30 seconds. A wait the
deadline cannot cover fails the request with the provider's status instead of
sleeping into a timeout. An HTTP 200 body that carries an `error` object and no
choices, as some gateways send when generation fails after the response
started, is that HTTP failure (its `code`, or 502 without a usable one), never
a completion.

`model_ref` recorded by callers is `<port_id>:<model>@<host>`.
`reasoning_effort` and `provider` change only the request body. Neither is part of
`model_ref`, run or canon receipts, or source consent, which binds the
endpoint and model. `doctor` and `serve status` show it next to the bound
model, or `provider-default` when unset, and `doctor` names a value outside
the list above as `model configuration invalid`. Some endpoints make reasoning
mandatory and answer `none` with HTTP 400.

## Config (`[ports.systemone]`)

Optional. Absent config leaves extraction unchanged.

| Key | Required | Notes |
| --- | --- | --- |
| `id` | yes | Must be `kizuki.systemone.jev`. |
| `base_url` | no | Default `https://api.typesafe.ai/v1`. Same URL rules as LLM. |
| `model` | no | Default `jev-latest`. |
| `secret_ref` | no | `env:` or `file:` only. |
| `timeout_ms` | no | Default `30000`. |
| `max_retries` | no | Default `2`. |

The producer asks Jev whether each extracted draft is supported. Jev never
writes canon and never replaces LLM extraction. A configured but dead port
is unavailable, not an empty keep.

## Fail-closed rules

- No tools or function schema are sent.
- A response whose `tool_calls`, `function_call`, `function_calls`,
  `tool_call_id`, audio, image, file, attachment or data field carries any
  value, or with a non-text content part, is discarded as
  `rejected: tool_call_in_response`. A null field or an empty list, which many
  compatible servers echo, is absence.
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
