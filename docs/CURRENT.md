# Current direction (2026-09-23)

Binding intent is RFC 0002 — Autonomous canon (`rfcs/0002-autonomous-canon.md`).
It is BINDING. It amends `docs/architecture.md` invariants 3, 5, 9, RFC 0000,
`AGENTS.md`, `docs/product-context.md`, and the README.

Read [README.md](../README.md) for what this revision actually runs, then
[cli.md](cli.md), then [architecture.md](architecture.md), then this file.

## Readiness

The owner's 2026-09-23 steer, recorded in [D23](decision-log.md), makes
1.0.0 a public release today. The launch bar is the world model as built on
the 2026-09-21 launch stack and Telegram native sign-in. Stranger proof,
live-account qualification, independent-review receipts, seven- and
fourteen-day observation, and go/no-go or release-acceptance reports are no
longer release prerequisites. D23 supersedes the
[D19](decision-log.md#owner-amendment-to-readiness-2026-09-05) and
[D21](decision-log.md) readiness text where they conflict.

The release gates are a clean `bunx tsc --noEmit`, a green `bun test`,
`bun run build:release` with the project app credentials compiled in,
`bun run smoke:release`, and a hands-on run of the world model and Telegram
from the built package. The #497 packets that 1.0.0 does not ship stay on the
roadmap and are not claimed. Operational cutover of existing services still
requires separate authorization.

## What the product is

Local-first memory substrate. Not a harness. Hosts no agents. Canon is
Markdown on the owner disk. A loop writes canon autonomously. Every write
has provenance, confidence, sensitivity, a writer stamp, and before/after
hashes. Every write is reversible from its receipt.

There is no owner review queue, and there never will be one. The TUI
survives as audit and undo only. Conversational correction (`kizuki tell` /
MCP `correct`) is the update path a person actually uses.

## What this revision ships

Version 1.0.2.

World model: when a configured model and a source grant that permits
extraction are present, the sync rail runs typed extraction
(`kizuki.producer-response/v2`) and admits source-anchored claims about
Concepts and Situations. `kizuki world` discovers them
(`find_concepts`, `find_situations`) and reads one card (`concept`,
`situation`) with evidence, confidence, uncertainty and coverage. The same
Core projection is served as the MCP `world_view` tool, loopback HTTP
`/v1/world_view`, and the World views in `kizuki app`. `kizuki tell
--world-claim` and MCP `correct` correct a world claim; the correction is
receipted and reversible, and a second authorized client sees it on its next
read. Without a model there are no Concepts or Situations; an empty
discovery says so and points at `kizuki doctor`.

The public CLI including `app`, a Linux x64 baseline local native package, file ingest, FTS
query, doctor, tell/undo/audit, serve loopback, context packets, and MCP stdio
adapter. Capture never writes canon. Local files and exports are enrollable;
an opt-in Beeper Desktop connection reads local history through an approved
token reference. IMAP supports local sign-in and re-enrollment that preserves
the existing mailbox identity and checkpoint. Telegram supports native CLI
sign-in with the project app credentials compiled into the release package and
preserves its account identity and checkpoint. Connect, the first state probe,
`getMe` and sign-out each have a 45-second deadline, and an unreachable network
fails in seconds instead of hanging. Native Gmail and Google Calendar
browser sign-in use operator-configured desktop clients and separate source consent;
Calendar requires one canonical calendar and explicit fields. Their account and artifact
qualification remain separate. ICS enrolls as a local file path; interactive
calendar URL sign-in is library surface, not a `connect` verb. Other sign-in
connectors are not enrollable through this CLI except X own-post API native sign-in.
X requires a public native app, an exact registered fixed loopback callback, explicit
fields and history start, usage credits and separate source consent; real-account
qualification remains unrun. Its v2 protected state saves the public native app
configuration for background use. Unknown refresh outcomes survive restart and
require `connect recover-x-api --source KEY` with the existing fields and history
start to obtain a new browser grant; capture consent remains unchanged. WHOOP
remains an unregistered component. After
`import`, claims are live and `tell --claim` can name them. Canon writing
still requires a configured model; without one the sync rail leaves live
claims unwritten and doctor says so. Optional TypeSafe Jev admission sits
behind `[ports.systemone]` and never replaces that model. The automated
`scripts/stranger-proof.ts` artifact isolation check is a
deterministic release prerequisite, not a human stranger proof.

## What is stale

Owner-only promote, `kizuki review` as the 1.0 daily surface, and
"nothing writes canon except an owner-invoked promote".
`docs/wave1/specs/llm-producer.md`, `docs/wave1/specs/serve-daemon.md`,
`docs/wave1/specs/stranger-proof.md`, and
`docs/wave1/specs/security-docs.md` are VOID as written.

## Known limits

The release package is a Linux x64 baseline build. It is not signed, and
nothing is published to npm or another package registry. macOS and other
platforms run from a source checkout. Telegram, Gmail, Google Calendar, IMAP,
X and Beeper have no recorded live-account qualification on this revision;
the Beeper connector has synthetic coverage only. Revision resume for world
views is not issued yet (fresh cards carry a `not_issued` view marker), and
Atlas, forecasts, World Slice and Diff, outcomes and attention remain on the
roadmap. A vault copied at file level while a canon write is pending refuses
recovery with `receipt_stream_changed` instead of completing it.

## What still holds

Frozen ingress `kizuki.event/v1`. Zero phone-home. Fail closed. No fake
surface. MIT. TypeScript on Bun. Release readiness follows D23 above.

## Decision log

See `docs/decision-log.md`. D1-D8 Gate 0 (2026-09-01). D9-D16 autonomy
(2026-09-02). RFC 0002 is the implementation brief for D9-D16. D21
(2026-09-17) makes the world model the 1.0 launch product. D23 (2026-09-23)
releases 1.0.0 with the world model and Telegram as the launch bar.
