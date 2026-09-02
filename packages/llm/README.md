# `@kizuki/llm`

The `kizuki.llm/v1` port. This package is the model transport, not a
producer and not a live vendor client. Tests drive it through a loopback
fake. Canon writing is a later lane that consumes this port.

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
| `max_retries` | no | Default `2`. Retries 429/502/503/504 only. |

`model_ref` recorded by callers is `<port_id>:<model>@<host>`.

## Fail-closed rules

- No tools or function schema are sent.
- A response with `tool_calls`, `function_call`, or a non-text content part
  is discarded as `rejected: tool_call_in_response`.
- Network, timeout, and schema failures throw `PortError`. They are not an
  empty completion.
- Provider bodies and secret values never appear in errors.

## Egress

The only network call site is `src/transport.ts`, listed in
`scripts/network-allowlist.txt`. `@kizuki/core` cannot import this package.
