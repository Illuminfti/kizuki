# Release evidence receipt schemas

Evidence date: 7 September 2026. Parent: #403. Issue: #541. This catalogs receipt
and index schemas the current release evaluator already understands. It does not
implement missing producers, change `scripts/go-no-go.ts`, or claim release `GO`.

Read [release acceptance](../release-acceptance.md) for how indexes and reports
compose. [Stranger proof](../stranger-proof.md) and [qualification](../qualification.md)
describe how artifact and fixture receipts are produced.

## Implemented schemas (evaluator-readable today)

| Schema                            | Role                            | Producer / writer                  | Evaluator gate                            |
| --------------------------------- | ------------------------------- | ---------------------------------- | ----------------------------------------- |
| `kizuki.acceptance-evidence/v1`   | Historical evidence index       | operator-assembled index file      | `evidence.index` (v1 artifact refs only)  |
| `kizuki.acceptance-evidence/v2`   | Current evidence index          | operator-assembled index file      | `evidence.index`                          |
| `kizuki.artifact-proof/v1`        | Native package fixture receipt  | `bun run proof:artifact`           | `artifact.<target>`; no engine credit     |
| `kizuki.artifact-proof/v2`        | Native package + engine receipt | `bun run proof:artifact`           | `artifact.<target>` and `engine.<target>` |
| `kizuki.release-build/v1`         | Package `BUILD.json` identity   | `bun run build:release`            | checked via artifact proof                |
| `kizuki.sqlite-runtime/v1`        | Child SQLite identity fragment  | observed in v2 proof               | checked via engine gate                   |
| `kizuki.sqlite-engine-policy/v1`  | Accepted engine identities      | `scripts/artifact-proof.ts` policy | checked via engine gate                   |
| `kizuki.qualification/v1`         | Fixture observation manifest    | `scripts/qualification.ts init`    | optional `diagnostic.fixture-observation` |
| `kizuki.qualification-genesis/v1` | Fixture observation anchor      | `scripts/qualification.ts init`    | optional diagnostic only                  |
| `kizuki.qualification-status/v1`  | Fixture observation status JSON | `scripts/qualification.ts status`  | diagnostic display only                   |
| `kizuki.acceptance-report/v2`     | Offline acceptance report       | `bun run release:acceptance`       | output only                               |

## Index schema checklist (`kizuki.acceptance-evidence/v2`)

- [ ] Exactly four top-level keys: `schema`, `candidate_source_sha`, `artifacts`, `fixture_observation`.
- [ ] `candidate_source_sha` is one lowercase 40-character Git SHA for the reviewed head.
- [ ] `artifacts` has at most one entry per supported target (`bun-linux-x64-baseline`, `bun-darwin-arm64`).
- [ ] Each artifact entry has exactly `producer`, `target`, `directory`, `proof`, `proof_sha256`.
- [ ] `producer` matches the referenced proof bytes exactly (`kizuki.artifact-proof/v1` or `v2`).
- [ ] `proof_sha256` is the lowercase SHA-256 of the proof file at `proof`.
- [ ] Optional `fixture_observation` uses producer `kizuki.qualification/v1` with `directory`, `manifest_sha256`, `genesis_sha256`, `samples_sha256`.

## Artifact proof checklist (`kizuki.artifact-proof/v2`)

- [ ] Closed key set: `schema`, `source_sha`, `target`, `host_platform`, `host_arch`, `binary_sha256`, `bun_version`, `package_sha256`, `paths`, `steps`, `failures`, `host_kernel_release`, `engine_observations`.
- [ ] `package_sha256` lists every packaged file hash; matches `BUILD.json` and `SHA256SUMS`.
- [ ] `steps` appear in the exact order required by `scripts/artifact-proof.ts` for the schema version.
- [ ] `failures` is an empty array on any receipt that supplies gate credit.
- [ ] `engine_observations.kizuki` and `engine_observations.kizuki_mcp` bind copied executable digests and matching `kizuki.sqlite-runtime/v1` fragments.
- [ ] Child Bun versions match the package and repository `.bun-version`; SQLite version/source-id pair matches policy.

Historical v1 proofs remain readable with fourteen steps and no engine fields.
V2 indexes may inventory v1 proofs; engine gates stay `MISSING` with
`missing-engine-proof`.

## Fixture observation checklist (`kizuki.qualification/v1`)

- [ ] `manifest.json` references artifact and proof paths explicitly listed in the same evidence index.
- [ ] `genesis.json` binds manifest device/inode before sample one.
- [ ] `samples.jsonl` is a hash chain of bounded receipt digests only.
- [ ] Diagnostic observation never sets `release_credit: true` or advances readiness clocks.

## Report schema checklist (`kizuki.acceptance-report/v2`)

- [ ] Emits all 41 gate rows for the selected profile (`rc` or `1.0`).
- [ ] Records `policy_sha256` and `verifier_sha256` for the evaluator identity on disk.
- [ ] Sets `release_1_0_accepted` only when every required gate is `PASS` under profile `1.0`.
- [ ] Never overwrites an existing report path; failed publication leaves a complete file at the requested output.

## Not implemented (no receipt credit today)

The evaluator enumerates these required gates but has no trusted producer adapter
yet. No issue-shaped checklist here can make them pass.

- [ ] `native.<target>` — trusted producer revision and native execution attestation (`UNVERIFIABLE`).
- [ ] `lifecycle.<target>` — install, upgrade, restart, reboot, uninstall (`NOT_IMPLEMENTED`).
- [ ] `candidate.required-checks` — exact-candidate CI identities (`NOT_IMPLEMENTED`).
- [ ] `candidate.independent-review` — specification/security and regression review (`NOT_IMPLEMENTED`).
- [ ] `candidate.current-p0-disposition` — see [finding inventory ledger](finding-inventory-ledger.md) (`UNVERIFIABLE`).
- [ ] `surface.capabilities-and-docs` — executable capability and docs agreement (`NOT_IMPLEMENTED`).
- [ ] `journey.*` (eight rows) — complete product journeys (`NOT_IMPLEMENTED`).
- [ ] `connector.<id>` (fifteen C3 rows) — per-provider evidence (`NOT_IMPLEMENTED`).
- [ ] `human.unfamiliar-user` — non-author zero-coaching proof (`NOT_IMPLEMENTED`).

Superseded optional gates (`owner.seven-day-rails`, `estate.fourteen-day-parity`,
`owner.final-cutover`) remain listed with `required: false`.

## Done / boundaries

Every schema row above is documented against the checked-in evaluator on the
reviewed candidate. Downstream lanes (connectors, journeys, human proof, P0
inventory) must emit receipts that validate against these contracts before they
can change gate status. Schema documentation alone does not establish release
`GO`.
