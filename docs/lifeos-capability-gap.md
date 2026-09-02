# LifeOS to Kizuki capability-gap audit

Audit date: 2026-09-01  
Method: read-only source, unit-definition, and service-state inspection  
Privacy boundary: no personal records, message bodies, databases, logs,
credentials, tokens, or private endpoint values were read or copied

## Purpose

This audit identifies useful capabilities already proven in the owner's
LifeOS estate that are absent or incomplete in Kizuki. It is not a request to
copy the estate. Kizuki should reuse sound product and security patterns while
remaining a portable, local-first product with neutral fixtures and no private
deployment assumptions.

Evidence below uses repository-relative, non-sensitive paths. Private service
names, deployment paths, and provider configuration are intentionally omitted.

## Status vocabulary

- **Live:** source exists and a corresponding local service was observed
  running.
- **Implemented:** code and tests exist, but a live deployment was not proven.
- **Configured only:** a unit or configuration exists without a running
  capability.
- **Absent in Kizuki:** no working public surface was found in Kizuki.

## Ranked capability matrix

| Priority | Verified LifeOS capability | Non-sensitive evidence | Observed state | Kizuki gap | Decision | Porting boundary |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Purpose-scoped context compilation with provenance, deterministic budgets, and retained-prefix/delta delivery | `apps/lifeos-kernel/src/lifeos_next/context.py`, `kernel.py`, `integrations/localhost.py` | Live, localhost, read mode | Kizuki has search, graph, timeline, and grants, but no context compiler or serving package | **PORT** | Filter below the prompt layer; label sources and sensitivity; never inject captured text as trusted prose |
| 2 | Authenticated scoped recall, per-call authorization, audit, and short-lived evidence receipts | `apps/lifeos-kernel/src/lifeos_next/auth.py`, `ports.py`, `store.py` | Live through a hardened local boundary | Kizuki has agent identities, grants, token hashing, rate checks, and audit primitives, but no serving boundary | **ADAPT** | Keep local transport and Kizuki-native identities; do not copy deployment credentials, token files, or endpoint conventions |
| 3 | Approval bound to an exact intent digest, with immutable approval records and a disconnected action plane | `apps/lifeos-kernel/src/lifeos_next/constitution.py`, `auth.py`, `store.py`, `kernel.py` | Implemented and test-covered; live service remained read-only | RFC 0002 removed the owner review queue. Kizuki writes canon autonomously with receipts and undo; it still has no authenticated exact-intent approval system for general high-impact actions | **ADAPT SELECTIVELY** | Keep receipts, budgets, and correction. Do not restore an owner review queue. Do not add an action executor to Kizuki now |
| 4 | Correction-aware, bi-temporal working knowledge separated from durable truth | `apps/lifeos-kernel/src/lifeos_next/models.py`, `store.py`, `kernel.py` | Core model is live; broader automatic write loops were not proven live | Kizuki has evidence and leftover proposals, but no reversible claims, aliases, conflict sets, confidence, or supersession layer yet | **PORT THE PATTERN** | Preserve source links, reversibility, and purge. Claims and canon are one receipted path. Owner correction outranks every other source. |
| 5 | Hybrid retrieval combining lexical and semantic signals with query expansion (Superseded in part 2026-09-02, see `docs/decision-log.md` D13 and RFC 0002 §9: retrieval is a versioned port whose implementation may own a rebuildable store under `<vault>/.kizuki/retrieval/`) | Implementation and focused automated tests exercised lexical fallback, semantic scoring, rank fusion, and expansion; private estate paths are omitted | Implemented and test-covered; no broad live service was claimed | Kizuki has deterministic FTS, graph, and timeline, but no embeddings or hybrid ranker | **PORT** | Embeddings must be optional and local by default; FTS remains the zero-model fallback; no silent model egress |
| 6 | Graph projection with provenance sanitization, epoch/staleness checks, and a local fallback | `apps/lifeos-kernel/src/lifeos_next/adapters/` | External projection services were observed masked and inactive | Kizuki graph edges are rebuildable but lack validity time, sensitivity, and freshness receipts | **ADAPT LATER** | Improve the local graph first; do not present the inactive external graph deployment as a shipped dependency |
| 7 | Connector and ambient-capture recipes across a wider source set | Implementations and focused tests exercised source normalization, checkpointed ingestion, stable identities, and deletion handling; provider setup is omitted | Code and test surface only; live provider coverage was not verified | Kizuki currently proves export-import and folder ingestion, not live personal-service breadth | **DEFER PER CONNECTOR** | Require consent, stable source identity, fixtures, checkpoint recovery, tombstones, purge, sensitivity, and structural secret custody before registry entry |
| 8 | Proactive briefs, maintenance jobs, and scheduled analysis (Superseded in part 2026-09-02, see `docs/decision-log.md` D15: `kizuki init` installs the daemon, so the scheduler is no longer deferred behind the serving work) | Implementations and focused tests exercised evidence-bounded brief generation, scheduled maintenance, and failure receipts; private scheduler names are omitted | Implemented and test-covered; a broad proactive daemon was not verified running | Kizuki describes proactive serving but has no scheduler, notifier, quiet hours, or liveness receipts | **DEFER** | Context packets and working knowledge come first; notifications require consent and must remain non-actioning |
| 9 | Goal, project, habit, metric, recovery, and backup primitives | `apps/lifeos-local-core/src/lifeos_local_core/`, including `product_backup.py`, `goal_recovery.py`, `habit_ledger.py`, `metric_registry.py` | Implemented; only a local backup timer was observed active | Kizuki has no goal or metric authority and no verified restore regimen | **ADAPT NARROWLY** | Reuse evidence-backed prioritization and restore patterns, not a second mutable source of canonical commitments |
| 10 | Scenario and risk packets constrained by policy | `apps/lifeos-kernel/src/lifeos_next/kernel.py`, `gauntlet.py`, `constitution.py` | Implemented in the read-only kernel; predictive quality was not evaluated | Kizuki has no scenario or prediction output contract | **DEFER** | Require assumptions, horizon, confidence, evidence bounds, uncertainty, and no autonomous action |
| 11 | Reproducible release, backup, restore, and recovery verification | `apps/lifeos-local-core/scripts/verify-product-release.sh`, `verify-reproducible-release.sh`; recovery modules under `lifeos_local_core/` | Implemented patterns; private backup contents were not inspected | Kizuki has export-import connectors and purge receipts but no complete backup/restore or operational health proof | **ADAPT** | Verify restore into a separate target; exclude credentials; never auto-discover or migrate owner data |

## What should not be ported

- Private deployment paths, unit names, provider credentials, endpoints, or
  personal records.
- Broad automatic Markdown mutation without receipts. Kizuki's durable
  canon is human-owned Markdown written by a receipted, reversible loop.
  There is no owner review queue.
- The inactive external graph deployment. Its useful freshness and provenance
  patterns should strengthen Kizuki's local graph first.
- Connector claims based only on configuration or source files. A connector
  is real only after conformance and credential-free fixture proof.
- A second canonical goal or commitment authority inside Kizuki.
- An execution plane disguised as a memory feature.

## Ordered follow-on work

1. **Close connection secret custody structurally and land the core spine.**
   Arbitrary connector configuration cannot be made safe with a blacklist of
   credential-looking names. Persist only values that are safe by
   representation and require credentials to remain behind `secret_ref` URIs.
2. **Define the reversible working model.** Add source-linked claims, aliases,
   conflict sets, confidence, supersession, conversational correction, and
   purge semantics beneath canon.
3. **Define portable skill and taste context.** Model reusable agent skills,
   working conventions, demonstrated creative standards, accepted/rejected
   outputs, scope, confidence, evidence, revision, and expiry without turning
   taste into a fixed personality label.
4. **Implement MCP over stdio.** Enforce existing identity, grant, rate, and
   audit policy at the adapter boundary. Defer a standing loopback daemon.
5. **Implement deterministic context packets.** Apply task scope, sensitivity,
   provenance, freshness, fixed budgets, and retained-prefix/delta behavior.
6. **Expand `kizuki doctor`.** Report connection, checkpoint, derived-index,
   schedule, backup, and recovery freshness without exposing private text.
7. **Add optional local semantic retrieval.** Combine it with the existing
   FTS fallback and make all model/network use explicit.
8. **Strengthen graph semantics.** Add edge provenance, occurrence and
   validity time, sensitivity, authorization, and rebuild/staleness receipts.
9. **Expose the connection lifecycle in the CLI.** Connect, backfill, sync,
   inspect health, revoke, and purge through public core APIs.
10. **Prove backup and restore.** Produce deterministic archives, exclude
    credentials, verify hashes, and restore into a separate clean target.
11. **Ship one consented connector beyond export/folder sources.** Require the
    complete conformance and custody contract before adding another.
12. **Define proactive output contracts.** Briefs, insights, priorities,
    scenarios, and predictions remain evidence-backed drafts with quiet
    hours, notification consent, and approval rails. Superseded in part
    2026-09-02, see `docs/decision-log.md` D9 and D10: there are no approval
    rails. What bounds an autonomous write is a per-run and per-day budget, a
    calibration band asserted in code, resolvable provenance, and reversal by
    receipt. Quiet hours and notification consent are unchanged, and a
    notifier still never acts.

## Conclusion

The valuable inheritance is not the private estate itself. It is a set of
proven patterns: scoped retrieval, provenance, receipts, fail-closed
authorization, correction-aware working knowledge, reversible derived state,
and explicit human approval for consequential truth. Superseded 2026-09-02,
see `docs/decision-log.md` D9, D10 and D14: the last pattern is not
inherited. A gate whose only consumer is the owner has zero throughput
(RFC 0002 §1.1). What replaces it is autonomy plus reversibility — budgeted,
attributable, receipted writes that the owner outranks with a sentence and
reverses with one command. Kizuki should reproduce
those properties through public, local-first contracts and neutral evidence,
while leaving private infrastructure and unverified automation behind.
