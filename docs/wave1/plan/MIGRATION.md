# Estate → Kizuki migration (Wave 6)

> **Superseded in part on 2026-09-02.** `docs/CURRENT.md`, `docs/decision-log.md`
> and `rfcs/0002-autonomous-canon.md` are binding: autonomous canon with no
> owner review gate, auto-labeled sensitivity, a configured model required for
> the world model, retrieval behind a port, an MCP `correct` tool, an always-on
> daemon installed at init, and a modular monolith with pluggable ports. This
> document is a historical record; where it conflicts, the binding documents win.

The private LifeOS estate migrates onto Kizuki and retires. the personal harness does NOT
migrate — it re-points to Kizuki MCP and stays its own stack forever
(decision 11). Nothing here blocks public visibility (Wave 5); the 1.0 tag
waits for both (decision 13).

## What migrates

| Estate asset                                               | Destination              | Mechanism                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the owner-wiki canon (~2258 pages, `LifeOS/apps/the owner-wiki`) | Kizuki vault             | `kizuki import estate-wiki`: type mapping to the closed enum, unknown fields → `x-*`, per-page sensitivity REQUIRED (the estate's ~40% coverage gap is closed during import via owner review batches in the TUI — unlabeled pages land as proposals, not canon). Superseded 2026-09-02, see `docs/decision-log.md` D10, D11: there are no owner review batches and no owner labeling. Sensitivity resolves automatically from the connector default and model refinement, upward only, defaulting to `private`; unlabeled is outside the lattice and is never served |
| tg-ingest / capture databases                              | Kizuki ledger            | Backfill importers emitting `kizuki.event/v1`; ledger dedupe makes re-runs safe                                                                                                                                                                                 |
| the attributed fork/retrieval indexes                                   | dropped                  | Derived layers rebuild from vault + ledger (invariant 2)                                                                                                                                                                                                        |
| lifeos-kernel context packets                              | `kizuki context`         | the personal harness/CC hooks re-point; 450-token bound and fail-closed-to-empty semantics carried                                                                                                                                                                            |
| Ingest rails (timers, scripts)                             | `kizuki serve` schedules | Recreated as scheduler jobs with receipts; old units retired                                                                                                                                                                                                    |
| Lessons (survey slices, incident history)                  | already in plan          | Encoded as lessons-as-tests; no content migrates                                                                                                                                                                                                                |

**Proof artifact:** the importer emits a lossy-mapping report — every page,
every dropped/renamed field, every sensitivity decision — reviewed by the owner
(Superseded 2026-09-02, see `docs/decision-log.md` D10, D11: the mapping
report stays, as evidence to read, not as a queue to approve; sensitivity is
auto-assigned)
before cutover.

## The airlock (public-repo protection, carried floor)

The migration runs on the box, in the private vault. Nothing estate-derived
enters the public repo except through the laundering gate: synthetic-only
bodies, shape not content (counts, schemas re-authored, failure modes), no
shared git history, gitleaks + estate-identifier denylist in CI, and every
lesson-derived PR names its private source path + revision in the PR body
only if the reference itself is safe. Cloud/codex workers never see estate
paths; importer development uses synthetic estate-shaped fixtures.

## Sequence

1. **Pre-flight:** estate survey refresh (the 2026-09-01 slices in
   `../lifeos-oss-rebuild/` are the baseline); freeze estate canon writes
   during final import.
2. **Import:** wiki + event backfills into a private Kizuki vault; review the
   unlabeled/ambiguous batches in the TUI; lossy-mapping report signed off.
   Superseded 2026-09-02, see `docs/decision-log.md` D10, D11: there is no
   batch review step. Import lands evidence, the loop writes canon under
   receipts, sensitivity is auto-assigned, and anything wrong is corrected
   with `kizuki tell` and reversed with `kizuki undo`.
3. **Parallel run (14 days):** Kizuki `serve` rails run alongside estate
   rails. Parity checks: daily brief content, context-packet responses
   (the personal harness asks both, diff logged), receipt liveness, query spot-checks.
4. **Re-point:** the personal harness context calls + CC hooks → Kizuki MCP/context; estate
   kernel and the attributed fork-scoped stay up but unconsumed.
5. **Cutover:** estate rails stopped, units disabled, data archived (archive,
   never delete — verified copy before any removal). Estate repos marked
   retired with pointers.
6. **Proof:** 14-day parity log, retirement inventory, and the personal harness running a
   normal week on Kizuki alone. This closes the 1.0 gate's second half.

## Rollback

Parallel-run design means rollback = re-point the personal harness/hooks back and re-enable
estate units at any step before archive. Nothing is deleted at cutover;
archives carry md5 manifests per the standing archive rule.
