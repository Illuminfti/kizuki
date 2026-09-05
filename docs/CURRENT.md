# Current direction (2026-09-02)

Binding intent is RFC 0002 — Autonomous canon (`rfcs/0002-autonomous-canon.md`).
It is BINDING. It amends `docs/architecture.md` invariants 3, 5, 9, RFC 0000,
`AGENTS.md`, `docs/product-context.md`, and the README.

Read [README.md](../README.md) for what this revision actually runs, then
[cli.md](cli.md), then [architecture.md](architecture.md), then this file.

## What the product is

Local-first memory substrate. Not a harness. Hosts no agents. Canon is
Markdown on the owner disk. A loop writes canon autonomously. Every write
has provenance, confidence, sensitivity, a writer stamp, and before/after
hashes. Every write is reversible from its receipt.

There is no owner review queue, and there never will be one. The TUI
survives as audit and undo only. Conversational correction (`kizuki tell` /
MCP `correct`) is the update path a person actually uses.

## What this revision ships

The public CLI, a Linux x64 baseline local native package, file ingest, FTS
query, doctor, tell/undo/audit, serve loopback, context packets, and MCP stdio
adapter. Capture never writes canon. Local files and exports are enrollable;
an opt-in Beeper Desktop connection reads local history through an approved
token reference. IMAP supports local sign-in and re-enrollment that preserves
the existing mailbox identity and checkpoint. Other sign-in connectors are not
enrollable through this CLI.
After
`import`, claims are live and `tell --claim` can name them. Canon writing
still requires a configured model; without one the sync rail leaves live
claims unwritten and doctor says so. 1.0 is still stranger proof plus
estate cutover (C1, RFC 0002 §1.3). Neither proof is in this tree. The
automated `scripts/stranger-proof.ts` artifact isolation check is a
deterministic release prerequisite, not a human stranger proof.

## What is stale

Owner-only promote, `kizuki review` as the 1.0 daily surface, and
"nothing writes canon except an owner-invoked promote".
`docs/wave1/specs/llm-producer.md`, `docs/wave1/specs/serve-daemon.md`,
`docs/wave1/specs/stranger-proof.md`, and
`docs/wave1/specs/security-docs.md` are VOID as written.

## What this does not prove

The native package is a local Linux x64 baseline build, not a signed or
published installer. The Beeper connector has synthetic coverage only; this
tree makes no claim that a live account was tested. Stranger proof, estate
cutover, and 1.0 are not complete.

## What still holds

Frozen ingress `kizuki.event/v1`. Zero phone-home. Fail closed. No fake
surface. MIT. TypeScript on Bun. Stranger proof AND owner cutover for 1.0.

## Decision log

See `docs/decision-log.md`. D1-D8 Gate 0 (2026-09-01). D9-D16 autonomy
(2026-09-02). RFC 0002 is the implementation brief for D9-D16.
