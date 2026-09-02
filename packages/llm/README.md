# @kizuki/llm

The optional model half of the loop, as two ports:

| Port                            | Contract              | What it does                                          |
| ------------------------------- | --------------------- | ----------------------------------------------------- |
| `kizuki.llm.openai-compatible`  | `kizuki.llm/v1`       | One chat completion against the endpoint you configured |
| `kizuki.producer.model`         | `kizuki.producer/v1`  | Turns quoted events into claim drafts using that port  |

`@kizuki/core` does not depend on this package and cannot import it, so the
invariant boundary itself has no way to reach the network. Nothing here runs
until a host binds `ports.llm` and `ports.producer` to these ids; a vault that
binds neither never constructs either port and never makes a request.

## Egress

`src/transport.ts` holds the only `fetch` call in the tree. It is listed, with
its reason, in `scripts/network-allowlist.txt`, and `bun run verify` fails if
that entry goes stale or if any other file grows a network call. The request
goes only to the URL you configured, follows no redirect, sends no identifying
header, and reads a reply that stops at `max_response_bytes` while it arrives
rather than after it has all been buffered.

## Configuration

```toml
[ports]
llm = "kizuki.llm.openai-compatible"

[ports.llm]
base_url   = "https://your-endpoint/v1"
model      = "your-wire-model-id"
secret_ref = "env:KIZUKI_MODEL_KEY"
```

| Key                   | Required | Meaning                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------ |
| `base_url`            | yes      | `https`, or `http` only on loopback. The endpoint is `<base_url>/chat/completions`. |
| `model`               | yes      | Sent verbatim as `model`.                                                       |
| `secret_ref`          | no       | `env:VAR` or `file:/absolute/path`, checked here and resolved by the host at call time. |
| `timeout_ms`          | no       | 1000..600000, default 60000.                                                    |
| `max_retries`         | no       | 0..5, default 2. A call puts at most `1 + max_retries` requests on the wire, and fewer when the caller's allowance is smaller. |
| `requests_per_minute` | no       | 1..600, default 30.                                                             |
| `temperature`         | no       | 0..2, default 0.                                                                |
| `json_mode`           | no       | default `true`; sends `response_format: {"type":"json_object"}`.                |
| `max_response_bytes`  | no       | 1024..8388608, default 1048576.                                                 |

An unknown key is refused rather than ignored, so a typo cannot quietly
disable a bound. A pasted key is refused without being echoed.

## What the producer guarantees

- **No tools.** The request carries no tool definitions. An answer containing
  `tool_calls`, `function_call` or a content part that is not text is
  discarded as `rejected: "tool_call_in_response"`; nothing is returned.
- **Everything from a record is data.** Quoted capture, a subject id and an
  earlier claim's object all appear only in the user role and only inside a
  fence — `<<<KZ-QUOTE <nonce>>>>` for the records, `<<<KZ-CONTEXT <nonce>>>>`
  for what is already known — with 128 fresh random bits per call. Only the
  predicate registry, which the repository owns, sits outside. A string that
  contains a fence-looking marker is escaped first: every run of three or more
  openers is broken between each character. An answer that echoes the nonce or
  a marker is `rejected: "fence_leak"`.
- **A stated size.** One call carries at most eight quoted blocks and
  `EXTRACT_INPUT_CHARS` characters of quoted text, plus a declared
  `EXTRACT_PROMPT_OVERHEAD_CHARS` for the task line, the registry, the fenced
  context and the markers. The escaping, the clipping and the context block
  are all counted against that bound rather than added to it, and a batch that
  would cross it is a fault rather than a silent clip.
- **A record is covered when all of it has been sent.** A record too long for
  one call is quoted across several, and `covered_event_ids` names it only
  once its last piece has gone out, so a caller never checkpoints past text no
  call carried. A run whose budget cannot carry all of it covers none of it
  and says `budget_exhausted`. A record longer than `EXTRACT_MAX_CHUNKS` calls
  is quoted up to there, covered, and named in `truncated_event_ids`, because
  coverage has to keep advancing or one oversized record stalls every later
  one behind it on every pass.
- **Exact schema.** The answer must be one JSON object matching
  `ExtractResponse`. An extra key, a missing key or a value outside a closed
  set is `rejected: "schema_invalid"`, and so is an answer the endpoint cut
  off at the token limit or declined to give. The reply that carries it is
  read for what it must not contain rather than against a key set: a field a
  server adds of its own is read past, while a tool or function call field, a
  content part that is not text, a refusal, or a `finish_reason` that does not
  mean a finished answer (`stop`, `eos`, `end_turn` or nothing) is a
  rejection. A key this package reads is validated: a negative token count or
  a model that is not a string is `schema_invalid`, never a silent estimate.
- **Cited provenance.** Every draft must cite an event id from the request.
  Citing anything else discards the whole call as
  `rejected: "provenance_not_cited"`.
- **A named predicate.** A draft naming a predicate outside the registry the
  caller supplied is dropped on its own. Names in the shape of a registry id
  come back on the result as `dropped_predicates` so the registry can grow
  deliberately; anything else is counted and discarded, because provider text
  must not travel into a log line or a receipt.
- **Silence is not emptiness.** A model that could not be reached returns
  `unavailable`, so the caller leaves its checkpoint where it was. `ok` with
  no claims means the records held nothing durable.
- **A stop is not a loss, and never a silence.** A run stops at the first call
  that fails. The calls that already answered come back as `ok` with
  `covered_event_ids`, which names exactly the events this result accounts
  for; a caller advances its checkpoint that far and re-reads the rest on its
  next pass. `stopped` says why it went no further, or is `null` when it
  worked through everything, so an outage can still be counted and the rail
  still reported degraded. When the first call is the one that failed, nothing
  is covered and the failure is what is returned.

## Budgets

`ProduceInput.budget` is a bound, not an estimate.

| Line                | What it counts                                                                      |
| ------------------- | ----------------------------------------------------------------------------------- |
| `max_calls`         | Requests put on the wire, retries included. What a call may spend on retries is the smaller of the calls left and the input left divided by the prompt, passed to the model port as `max_attempts`; the port reports what it used. |
| `max_input_tokens`  | Reserved before a call at one token per character of the messages — the only ratio that holds for every tokenizer — then charged at what the endpoint says it counted, once per request that went out. |
| `max_output_tokens` | Capped per call by `max_tokens` on the request and charged at what the endpoint reports for the request that answered. |

A run that would cross a line does not start the next call, and a run whose
reported spend has already crossed one stops rather than answering `ok`.
`usage` always reports the true spend, including a call that failed: the port
attaches what a failed call had already put on the wire to the error it
throws, and an outage carries the usage the run accrued before it.

`requests_per_minute` bounds the port, not one call: concurrent calls queue
for a slot in the same sliding window, and a call that fails closed before its
request leaves gives its slot back.

`LlmRequest.deadline_ms` bounds the whole call. Every attempt, every retry
backoff and every wait for the rate window comes out of it, and the call ends
as `PortError("timeout")` once it is spent. The producer gives each batch
sixty seconds, so one `produce` is bounded by its batch count times that
however the endpoint behaves.
