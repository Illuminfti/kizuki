# RFC 0005: Optional System One admission

Status: **Accepted**. Date: 2026-09-17. Owner: Kizuki core.

This RFC records D20. It does not replace RFC 0002, RFC 0000, or the
zero-model floor. [RFC 0002](0002-autonomous-canon.md),
[RFC 0000](0000-constraints.md), and the
[decision log](../docs/decision-log.md) remain binding.

## Problem

Ordinary OpenAI-compatible models generate claim JSON. They do not return
typed confidence over a closed question. TypeSafe Jev (System One) does the
opposite: it evaluates a state against `noul`, `choice`, or `score` questions
and returns typed answers. Stuffing Jev into `kizuki.llm/v1` would either
fake a chat completion or let a decision model write claims. Both break the
producer contract.

Owners with Jev access should get a fail-closed admission judge. Owners
without Jev must keep the current extraction path.

## Decision

Add an optional port kind `systemone` with contract `kizuki.systemone/v1`.
The in-tree implementation is `kizuki.systemone.jev`. It is not an LLM.

Call site one: after LLM extraction and local schema/predicate/subject
checks, `admitExtractedClaims` asks one noul question per draft. High noul
keeps the draft. Low noul drops it as `systemone_rejected`. The receipted
writer is unchanged.

Unconfigured is a no-op keep. A configured but dead or schema-invalid judge
is `unavailable` or `rejected`, never an empty keep.

## Forbidden

- Jev must not generate claims JSON or replace `kizuki.llm/v1`.
- Jev must not write canon, ledger, or Markdown.
- Core must not import `@kizuki/llm`.
- There is still exactly one `fetch`, in `packages/llm/src/transport.ts`.
- No provider SDK. No owner review queue. No phone-home.
- Credentials remain `secret_ref` only.

## Config

```toml
[ports.systemone]
id = "kizuki.systemone.jev"
base_url = "https://api.typesafe.ai/v1"
model = "jev-latest"
secret_ref = "env:TYPESAFE_API_KEY"
```

Absent `[ports.systemone]` leaves `systemone` unbound.

## Later slices (not this PR)

Conflict arbitration, sensitivity labeling, and brief ranking may bind the
same port. They are not required to merge this RFC.
