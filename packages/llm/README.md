# @kizuki/llm

An optional producer. It reads events from the ledger, asks a model endpoint
the owner configured to draft a summary, entity candidates and atomic claims,
and files the answers as `kizuki.proposal/v1` drafts stamped
`producer: "llm"` for the owner's review queue.

Nothing here runs unless the owner writes `<vault>/.kizuki/llm.toml`. With no
such file, `runEnrichment` returns `unconfigured` having touched neither the
network nor the database, and the deterministic staging producers in
`@kizuki/core` remain the whole pipeline.

## Egress

`src/transport.ts` holds the only `fetch` call in the tree. It is listed, with
its reason, in `scripts/network-allowlist.txt`, and `bun run verify` fails if
that entry goes stale or if any other file grows a network call. The request
goes only to the URL in `llm.toml`, follows no redirect, sends no identifying
header, and reads a bounded JSON reply.

`@kizuki/core` does not depend on this package and cannot import it, so the
invariant boundary itself has no way to reach the network.

## Configuration

`<vault>/.kizuki/llm.toml`, mode 0600, flat keys only. `parseLlmConfig` is
the single validation path; an unknown key or a `[table]` is refused rather
than silently rewritten.

| Key                     | Required                | Meaning                                                                                                  |
| ----------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `base_url`              | yes                     | `http`/`https` only, no userinfo, query or fragment. The chat endpoint is `<base_url>/chat/completions`. |
| `model`                 | yes                     | Sent verbatim as `model`.                                                                                |
| `api_key`               | no                      | A secret reference (`env:VAR` or `file:/absolute/path`), never the key itself.                           |
| `allow_cloud_inference` | no (default `false`)    | Must be `true` before any non-loopback endpoint is accepted.                                             |
| `sensitivity_ceiling`   | no (default `personal`) | Events hinted above this label are never sent.                                                           |
| `unlabeled`             | no (default `skip`)     | `skip` or `send`, for events with no sensitivity hint.                                                   |
| `json_mode`             | no (default `true`)     | Sends `response_format: {"type":"json_object"}`.                                                         |
| `temperature`           | no (default `0`)        | 0..2.                                                                                                    |
| `timeout_ms`            | no (default `60000`)    | 1000..600000, per request.                                                                               |
| `requests_per_minute`   | no (default `30`)       | 1..600.                                                                                                  |
| `max_requests`          | no (default `60`)       | Per run.                                                                                                 |
| `max_input_chars`       | no (default `400000`)   | Per run, summed over user messages.                                                                      |
| `max_event_chars`       | no (default `8000`)     | Per event; longer text is truncated by code points.                                                      |
| `max_output_tokens`     | no (default `1024`)     | Sent as `max_tokens`.                                                                                    |
| `summary_min_chars`     | no (default `280`)      | The summary producer skips shorter events.                                                               |

Fail-closed rules, each with a test: a pasted key is refused
(`plaintext_key`); a non-loopback host without `allow_cloud_inference` is
refused (`cloud_not_allowed`); plain `http` off the local machine is refused
(`insecure_remote`); a configured key that does not resolve stops the run
before any request (`missing_key`); a key file readable by other users is
refused (`key_file_permissions`).

## Trust posture

Captured text is data, never instruction. It reaches the model only as the
JSON string value `record.text` of one event per request, under a system
prompt that is a byte-identical constant per producer and says so. The reply
is treated as equally hostile: size-capped, JSON-only, schema-validated,
count-capped, sanitized, and never logged or echoed in an error.

The model cannot choose a proposal kind, a target path, a page type, a
frontmatter key, a sensitivity or a producer. Those come from the validated
schema in `drafts.ts`, so no answer can produce an `edit`, `merge`,
`deletion` or `purge_review` proposal, and every draft lands in the review
queue marked as unreviewed machine output, below the deterministic floor's
confidence.

## Limitations

- The protocol is a plain OpenAI-compatible chat-completions endpoint. There
  is no provider SDK, no streaming, and no tool calling. An endpoint that
  needs a field other than `max_tokens` is out of scope.
- One event per request. There are no thread-level or multi-event prompts.
- No embeddings, no scheduled enrichment. `llm_runs` is the receipt a later
  scheduler would read; nothing schedules runs today.
- `llm_enrichments` and `llm_runs` are derived state. Dropping them loses the
  memory of what was already spent, never canon or proposals.
