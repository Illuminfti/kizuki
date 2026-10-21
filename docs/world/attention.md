# Attention

Attention projects goal-aware cues through the shared world-card reader. It is
read-only knowledge: dismissing or snoozing a cue changes delivery bookkeeping,
never a claim, confidence, authority, canon approval or execution permission.

## Read and act

```sh
kizuki attention --json
kizuki world --operation attention --json
kizuki attention dismiss CUE
kizuki attention snooze CUE --until 2026-10-23T09:00:00Z
```

Core, CLI, MCP `world_view`, authenticated HTTP and the App World → Attention
tab use the same `attention` operation. Its request is
`{operation:"attention",valid:{kind:"all"},knownAt:{kind:"current"}}`.
Historical knowledge and past-valid attention return `unavailable/history`;
current dispositions are not historical facts. Only the owner CLI and owner
App route can dismiss or snooze. Agents receive no new write tool.

The providers require an explicit asserted objective. They read blockers,
uncertainty, stale summaries and exact overdue commitments from the shared
Situation v2 projection. Conflicting or missing due evidence stays unknown.
Reported completion remains `claimed_done`; owner-confirmed or independently
verified completion follows the Situation reader. Mention counts and retrieval
frequency never enter candidate identity or priority.

## Delivery and recovery

Cue keys bind the principal namespace, provider, visible subject and visible
semantic basis. Owner dispositions do not appear in agent namespaces. Hidden
changes do not affect visible candidate ordering or measured projection work.
`quiet`, `missing_coverage`, `stale_consolidation` and `provider_failure` are
distinct states. Delivery waits for current complete coverage.

The existing brief rail sends at most four new cues per pass through the file
notifier. There is no outward channel. Candidate enumeration is capped at 16
after a 32-situation scan; capped reads report a coverage gap and do not deliver.
Each cue writes one line in `dashboards/attention-CUE.md`. Repeating identical
delivery reports `duplicate:true` and leaves the file unchanged. A delivery
with more than 100 source-event dependencies is refused instead of producing
an invalid page.

`world_attention_state` is schema slot 43 bookkeeping. Export/restore and world
rebuild preserve it; source revocation, relevant claim changes and purge erase
affected rows. Delivered cue files retain source-event provenance. Purge erases
their whole derived message through the existing canonical erasure writer;
the normal archived tombstone remains. Doctor reports pending cues and last
delivery. Its read-only probe reuses existing refs and keeps missing refs only
in a synchronous diagnostic scope, returning counts rather than capabilities.

## Verification

The real consumer tests are `core/test/world/attention*.test.ts`,
`cli/test/attention.test.ts`, the Attention case in `cli/test/app-client.test.ts`,
and `mcp/test/attention.test.ts`. They bind the quiet, coverage and dismissal
RFC oracles and exercise exact deadlines, owner correction, scoped output/work
noninterference, queued-cue revalidation, migration, real export/restore, purge,
file deduplication, read-only diagnostics and shipped App buttons.

The fixture entry point is `core/test/helpers/attention-fixture.ts`. Its
`ATTENTION_WHEN` and `envelope(ctx)` provide the exact public request for the
central verification matrix. This lane adds no producer activation or model
qualification claim.
