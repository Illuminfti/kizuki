# Current direction (2026-09-02)

Binding intent is RFC 0002 — Autonomous canon (`rfcs/0002-autonomous-canon.md`).
It is DRAFT until that file is merged. After merge it binds and amends
`docs/architecture.md` invariants 3, 5, 9, RFC 0000, `AGENTS.md`,
`docs/product-context.md`, and the README.

## What the product is

Local-first memory substrate. Not a harness. Hosts no agents. Canon is
Markdown on the owner disk. A loop writes canon autonomously. Every write
has provenance, confidence, sensitivity, a writer stamp, and before/after
hashes. Every write is reversible from its receipt.

There is no owner review queue, and there never will be one. The TUI
survives as audit and undo only. Conversational correction (`kizuki tell` /
MCP `correct`) is the update path a person actually uses.

## What is stale

Owner-only promote, `kizuki review` as the 1.0 daily surface, and
"nothing writes canon except an owner-invoked promote".
`docs/wave1/specs/llm-producer.md` and `docs/wave1/specs/serve-daemon.md`
are VOID as written.

## What still holds

Frozen ingress `kizuki.event/v1`. Zero phone-home. Fail closed. No fake
surface. MIT. TypeScript on Bun. Stranger proof AND owner cutover for 1.0.

## Decision log

See `docs/decision-log.md`. D1-D8 Gate 0 (2026-09-01). D9-D16 autonomy
(2026-09-02). RFC 0002 is the implementation brief for D9-D16.
