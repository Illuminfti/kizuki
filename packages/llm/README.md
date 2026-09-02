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
| `secret_ref`          | no       | `env:VAR` or `file:/absolute/path`, resolved by the host at call time.          |
| `timeout_ms`          | no       | 1000..600000, default 60000.                                                    |
| `max_retries`         | no       | 0..5, default 2. A call puts at most `1 + max_retries` requests on the wire.    |
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
- **Quoted text is data.** Captured text appears only in the user role, only
  between `<<<KZ-QUOTE <nonce>>>>` and `<<<KZ-END <nonce>>>>`, with 128 fresh
  random bits per call. Text that contains a fence-looking marker is escaped
  before it is fenced. An answer that echoes the nonce or a marker is
  `rejected: "fence_leak"`.
- **Exact schema.** The answer must be one JSON object matching
  `ExtractResponse`. An extra key, a missing key or a value outside a closed
  set is `rejected: "schema_invalid"`.
- **Cited provenance.** Every draft must cite an event id from the request.
  Citing anything else discards the whole call as
  `rejected: "provenance_not_cited"`.
- **A named predicate.** A draft naming a predicate outside the registry the
  caller supplied is dropped on its own, and the host is told which ones so
  the registry can grow deliberately.
- **Silence is not emptiness.** A model that could not be reached returns
  `unavailable`, so the caller leaves its checkpoint where it was. `ok` with
  no claims means the records held nothing durable.
