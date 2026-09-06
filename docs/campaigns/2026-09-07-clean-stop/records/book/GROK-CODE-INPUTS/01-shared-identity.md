# Shared gate-receipt identity, trust, bounds, freshness

Contract status: **proposed**. Not implemented in `scripts/go-no-go.ts`.
Does not authorize GO, a tag, or mock-to-real promotion.

Existing implemented families stay on their current schemas:

- `kizuki.acceptance-evidence/v1` and `/v2`
- `kizuki.artifact-proof/v1` and `/v2`
- `kizuki.qualification/v1`
- `kizuki.acceptance-report/v2`

Those producers remain local-operator-custody integrity checks. A passing
artifact or fixture row still cannot satisfy any missing required gate.

## 1. Identity object (`kizuki.gate-receipt-identity/v1`)

Every new family receipt has exactly four wrapper keys plus a family payload:

| Key | Rule |
| --- | --- |
| `schema` | Closed family tag; equals `identity.producer` |
| `identity` | Exact eight-key object below |
| `outcome` | `pass` \| `fail` \| `unresolved` |
| `failures` | Array of `{ "code": kebab-id }` only |

`identity` exact keys:

| Key | Grammar |
| --- | --- |
| `candidate_source_sha` | lowercase `[a-f0-9]{40}` |
| `producer` | equals top-level `schema` |
| `producer_revision` | lowercase `[a-f0-9]{64}` of the canonical producer file set; **never null** |
| `producer_files` | 1–32 relative POSIX paths, each 1–256 chars, no `..`, no absolute, sorted unique |
| `source_class` | enum in §2 |
| `actor_class` | enum in §2 |
| `attempt_id` | UUID v4 |
| `recorded_at` | RFC3339 UTC with `Z` |

`outcome: pass` requires `failures: []`. `outcome: fail` requires at least one
`failures[].code`. `unresolved` never credits PASS. Extra keys, duplicate JSON
keys, `passed: true`, `waive`, `owner_authorized`, `skip`, `clock`, and
`merge_authorized` are invalid.

Failed attempts keep their `attempt_id`. A later attempt is a new id and must
list prior ids where the family requires it. Relabeling a failure as pass is
invalid.

## 2. Source and actor classes

### Source classes (what the bytes can attest)

| Class | May establish | Must not establish |
| --- | --- | --- |
| `synthetic-fixture` | Checker self-tests | Any missing required gate |
| `local-operator-custody` | Byte consistency of retained files (current artifact/qualification) | Native execution, actor identity, live account, human acceptance, CI, review, P0 completeness |
| `native-host-attestation` | Named producer ran on matching OS/arch, checkout-separated | Darwin from Linux; human; account; hostile-host truth |
| `candidate-tree-inventory` | Inventory recomputed from the exact-SHA checkout | Docs/API agreement on a different SHA |
| `exact-candidate-ci-snapshot` | Required check identities on that SHA from retained snapshot bytes | Badge, later SHA, selected green rerun, live GitHub at report time |
| `independent-reviewer` | Enrolled reviewer axes at exact head | Self-declared role; merge authority |
| `findings-snapshot` | Completeness of the recorded snapshot | Findings created after the snapshot |
| `live-account-operator` | Authorized live-source evidence | File export standing in for an account |
| `file-import-operator` | Authorized retained export evidence | Live-account gates |
| `local-source-operator` | Authorized local DB/folder source | Live-account or export-as-sync claims |
| `non-author-participant` | Independently established non-author attempt | Author/agent-operated session |
| `independent-witness` | Witnessed human usefulness / eligibility | Self-declared witness |
| `supervised-owner-observation` | Optional post-ready owner rails | Readiness/1.0 credit |
| `paired-estate-observation` | Optional post-ready estate parity | Readiness/1.0 credit |
| `owner-operational-authority` | Separate cutover authorization | Readiness/1.0 credit |

### Actor classes (who may emit the receipt)

`automated-producer` · `retained-ci-snapshot` · `enrolled-reviewer` ·
`authorized-operator` · `independent-witness` ·
`owner-or-delegated-maintainer`

A self-declared string in the receipt is not enrollment. The checker has no
actor directory today; that directory is a freeze dependency for review,
human, account, and cutover families.

## 3. Candidate, artifact, producer identity

All receipts share the report's `candidate_source_sha`. Mismatch is FAIL.

Target-scoped receipts (`native.*`, `lifecycle.*`) use the closed registry:

| `target` | `host_platform` | `host_arch` |
| --- | --- | --- |
| `bun-linux-x64-baseline` | `linux` | `x64` |
| `bun-darwin-arm64` | `darwin` | `arm64` |

Package identity, when present, is exactly the five artifact files:
`kizuki`, `kizuki-mcp`, `README.txt`, `BUILD.json`, `SHA256SUMS`, each a
lowercase SHA-256. Bun version must equal repository `.bun-version` (`1.3.14`
on this base). Changing evaluator files never upgrades old evidence.

`producer_revision` is SHA-256 of the canonical JSON of
`{ files: [{ path, sha256 }] }` for `producer_files` on the candidate tree.
Unknown, empty, or null revision cannot PASS.

Indexed artifact proofs remain `kizuki.artifact-proof/v1|v2`. New families
reference those proofs by digest; they do not reuse the artifact-proof schema
as native, lifecycle, journey, or human evidence.

## 4. Bounds

| Limit | Value | Notes |
| --- | --- | --- |
| Evidence index | 32768 bytes | v3 raises 16384 because `gate_receipts` plus two artifacts overflow typical absolute paths |
| Family receipt | 65536 bytes except journey/connector 262144 | Proof-class 1 MiB stays for artifact-proof only |
| JSON depth | 32 | Same tokenizer as `parseProofJson` |
| String | 1–4096, no `[\\x00-\\x1f\\x7f]` | Digests and UUIDs have tighter grammars |
| `failures` | 0–32 items | `code` 1–64 kebab `[a-z0-9-]+` |
| `producer_files` | 1–32 | Relative, unique, sorted |
| `gate_receipts` | 0–40 | One row per gate id |
| Nesting objects | exact key sets | Unknown keys fail closed |
| Files | regular, `nlink === 1`, no symlink in any component | Exclusive operator custody |
| Privacy | no source text, provider errors, participant names, account ids, credentials, vault contents | Opaque refs and digests only |

No clock flags, skip flags, waivers, threshold overrides, or actor
declarations on the CLI or index.

## 5. Freshness and invalidation

`POLICY.carry_forward` stays `false`.

| Event | Effect |
| --- | --- |
| Candidate SHA changes | Every new-family receipt invalid |
| Any of the five package hashes changes | Native, lifecycle, install-recover, unfamiliar-user invalid |
| `producer_revision` or producer files change | Receipts from that producer invalid; rerun |
| Head movement after review/P0 snapshot | Those receipts invalid |
| CI snapshot `head_sha` ≠ candidate | `required-checks` FAIL |
| Artifact change while pursuing optional observation | New observation required; no carry-forward (D19) |
| Failed attempt | Retained; new `attempt_id`; cannot be rewritten to pass |
| Evaluator/policy change | Does not upgrade old evidence |
| Offline report | Cannot discover findings after its snapshot; residual is UNVERIFIABLE, not PASS |

The checker still does not consult live GitHub, a review service, or wall
clock. Freshness is snapshot identity plus recorded policy, not "now".

## 6. No mock-to-real promotion (closed)

These substitutions are invalid in every family:

1. `kizuki.artifact-proof/*` PASS → `native.*` or `lifecycle.*`
2. Artifact `--no-service`, `serve --once`, generated plist, fake supervisor, or a successful query → lifecycle
3. Linux native/lifecycle/human → Darwin (and the reverse)
4. `kizuki.qualification/v1` fixture window → owner seven-day rails or estate fourteen-day parity
5. Synthetic connector conformance → live-account or real-export evidence
6. File-import evidence → live-account connector gate
7. X archive import → `connector.x-api`
8. Model-free ledger query → autonomous model-written canon (unfamiliar-user / correct-belief)
9. Completing a template, checking a box, or `owner_authorized: true` → human or cutover
10. Self-declared participant or witness → eligibility
11. Green badge or a rerun on another SHA → `candidate.required-checks`
12. Earlier-head review → current independent review
13. Empty or stale findings snapshot → zero live P0s
14. Constituent unit tests → journey adapter PASS
15. `passed: true` / `waive` / extra index keys → any gate
16. Optional observation `release_credit: true` → readiness or 1.0
17. Cutover receipt → `release_1_0_accepted`

## 7. Index v3

`kizuki.acceptance-evidence/v3` exact keys:
`schema`, `candidate_source_sha`, `artifacts`, `fixture_observation`,
`gate_receipts`.

`gate_receipts[]` exact keys: `producer`, `gate_id`, `target`, `path`,
`sha256`. `target` is `null` when the gate is not target-scoped.

v1/v2 remain readable and must not grow unknown keys. Listing a new producer
on v1/v2 is `unknown-producer`. Until a family validator exists, a well-formed
v3 receipt for that family is still `NOT_IMPLEMENTED` (schema FAIL if
malformed; never PASS).
