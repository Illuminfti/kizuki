# Release evidence receipt schemas

Evidence date: 7 September 2026. Parent: #403. Issue: #541. This inventory
tracks the composed evaluator and its online collector. A supported schema does
not establish that a candidate has passed its gate. See [release acceptance](../release-acceptance.md)
for invocation, custody, limits and the current release obligations.

## Current schemas

| Schema | Role | Checked by |
| --- | --- | --- |
| `kizuki.acceptance-evidence/v4` | Index of current package proofs and gate receipt references | `scripts/go-no-go.ts` |
| `kizuki.artifact-proof/v3` | Copied seven-file package, sixteen ordered steps, effective engines and distribution identity | `scripts/artifact-proof.ts` |
| `kizuki.release-build/v2` | Package build identity and distribution material inventory | `scripts/release-artifacts.ts` |
| `kizuki.sqlite-runtime/v1` | Observed child SQLite identity | `scripts/artifact-engine.ts` |
| `kizuki.sqlite-engine-policy/v2` | Exact supported runtime identities | `scripts/artifact-proof.ts` |
| `kizuki.native-service-lifecycle/v2` | Original native service checks, seventeen qualification phases and owned fixture cleanup | `scripts/native-lifecycle-proof.ts` |
| `kizuki.github-collection/v1` | Retained live GitHub collection and source inventories | `scripts/github-release-evidence.ts` |
| `kizuki.acceptance-report/v2` | Offline acceptance verdict and all gate rows | `scripts/go-no-go.ts` |
| `kizuki.online-acceptance-report/v1` | Offline verdict plus qualified live GitHub observations | `scripts/github-release-evidence.ts` |

The v4 index has exactly `schema`, `candidate_source_sha`, `artifacts`,
`fixture_observation` and `gate_receipts`. Each artifact reference has exactly
`producer`, `target`, `directory`, `proof` and `proof_sha256`. A target appears
at most once. Current seven-file builds require v3 proofs; source, package,
proof, distribution and runtime bindings must all agree.

## Historical and diagnostic schemas

Index v1 and v2 remain readable without gate receipt references; v3 adds those
references. Only v4 admits v3 artifact proofs. Historical artifact proofs v1
and v2 bind the older package inventory; v1 has no effective-engine proof.
These formats do not upgrade an older observation into current native credit.

`kizuki.qualification/v1`, `kizuki.qualification-genesis/v1` and
`kizuki.qualification-status/v1` describe optional fixture observation. Their
manifest, genesis and sample hash chain must match the index and candidate.
They never grant release credit or restore elapsed-day prerequisites.

A native lifecycle v1 receipt remains diagnostic. Full lifecycle credit requires
the closed v2 phase inventory, distinct fixed baseline and candidate binaries,
historical recovery bindings, preserved event-text joins, model observations,
and complete owned-unit cleanup.

## Online authority

The offline checker leaves required CI, native execution and lifecycle
observations unverifiable. The online collector can establish those gates only
from current, successful, exact-candidate GitHub attempts and freshly downloaded
artifacts. Both source closures, workflow jobs, authored steps and artifact
identities are checked before and after collection. Saved API JSON is not an
authority input. Both indexed native packages must match all seven downloaded
package digests and the copied-package proof digest.

Baseline qualification is a candidate-to-candidate upgrade from the fixed
reviewed source. It is not evidence of upgrading a published release. Model
fixtures use a controlled local endpoint; their dependency-offline scenario is
not a claim of host network isolation or downloaded model weights.

## Gates still requiring separate evidence

Independent review, current P0 disposition, capabilities and documentation,
eight complete release journeys, fifteen real connector qualifications and
unfamiliar-user onboarding retain their own evidence requirements. See the
[finding inventory ledger](finding-inventory-ledger.md) and the actual evaluator
for each adapter's availability. Schema checklists cannot supply missing facts.

Reports never overwrite an existing destination. A retained complete report
with a publication cleanup or durability error must not be mistaken for a
successful invocation. `release_1_0_accepted` is true only when every required
gate passes under the 1.0 profile. Seven-day observation, estate parity and
operational cutover remain optional for release readiness under D19.

## Verification

The authoritative contracts are the checked-in parsers and collector linked
above, together with `docs/release-acceptance.md`. Changes to those contracts
require this inventory to be reviewed again. No release `GO` is claimed here.
