# Release acceptance evidence

Evidence date: 5 September 2026. The checked-in acceptance checker inventories
the fixed RC and 1.0 obligations and validates the supported local evidence.
The current producer set cannot establish release `GO`: independent review,
native installed-service execution, live accounts, unfamiliar-user acceptance,
owner observation and estate cutover lack reviewed evidence adapters.

This is release tooling. It does not add a canon review or promotion step to
the product. The owner corrects beliefs and uses receipt undo.

## Run the checker

Use Bun pinned in `package.json` from a retained checkout. Keep each package,
receipt and the index in a directory under the local operator's exclusive
custody. Paths must be absolute, normalized and free of symlinks in every
component. On systems with aliased temporary directories, use physical paths.
An offline Linux invocation can inspect a retained macOS package and receipt.
It does not claim that macOS was executed on Linux.

```bash
bun run release:acceptance --profile rc --evidence /absolute/evidence/index.json --out /absolute/evidence/new-rc-report.json
bun run release:acceptance --profile 1.0 --evidence /absolute/evidence/index.json --out /absolute/evidence/new-1.0-report.json
```

The parent output directory must already exist. The checker writes a new
private file exclusively, flushes it and its directory, and also emits the
report JSON on stdout. Exit status is `0` for `GO`, `1` for a produced `NO-GO`
report, and `2` for invalid arguments or failure to retain the output. A
corrupt or missing index still yields the complete gate inventory with a
failed index gate. Existing reports are never overwritten. There are no
waivers, actor declarations, skip flags, threshold overrides or clock flags.

## Index schema

`kizuki.acceptance-evidence/v1` has exactly four keys: `schema`,
`candidate_source_sha`, `artifacts` and `fixture_observation`. The candidate
is one lowercase 40-character Git SHA. An empty evidence inventory is valid
and produces missing gates:

```json
{
  "schema": "kizuki.acceptance-evidence/v1",
  "candidate_source_sha": "0000000000000000000000000000000000000000",
  "artifacts": [],
  "fixture_observation": null
}
```

Replace the example SHA with the reviewed candidate. Each of at most two
artifact entries has exactly these keys:

| Key | Required value |
| --- | --- |
| `producer` | `kizuki.artifact-proof/v1` |
| `target` | `bun-linux-x64-baseline` or `bun-darwin-arm64`, each at most once |
| `directory` | Absolute path to the retained native package directory |
| `proof` | Absolute path to the retained artifact proof `receipt.json` |
| `proof_sha256` | Lowercase SHA-256 of those exact receipt bytes |

Generate packages and receipts with the existing [native build and artifact
proof commands](native-build.md). The checker recomputes hashes of `kizuki`,
`kizuki-mcp`, `README.txt`, `BUILD.json` and `SHA256SUMS`; checks the manifest;
and requires candidate SHA, target, Bun version, both binaries and every
package hash to agree with the receipt. The package and proof Bun version
must also equal the repository's `.bun-version`, which is bound into the
policy and verifier identities. The recorded native platform and
architecture must agree with that target. All fourteen producer steps must
appear in their exact order, with their actual command shapes, timeouts and
successful semantic assertions. A failed receipt cannot supply credit.

An optional fixture observation has exactly `producer`, `directory`,
`manifest_sha256`, `genesis_sha256` and `samples_sha256`. Its producer must be
`kizuki.qualification/v1`. Its directory is the original retained observation
directory, and the digests cover `manifest.json`, `genesis.json` and
`samples.jsonl`. Its manifest must reference an artifact and proof explicitly
listed in this index. The checker invokes the existing strict observation
loader between matching bounded snapshots. The inode-bound genesis means
copying these files does not create a valid observation. Standalone status
JSON is not evidence. See [fixture observation](qualification.md).

Unknown producers, schema keys, duplicate targets or JSON keys, noncanonical
paths, digest mismatches and substituted steps fail closed. Limits are 16 KiB
for the index, 1 MiB for a proof, 256 MiB per binary, 64 KiB per package text
file, and 64 MiB for the existing fixture journal. JSON nesting is bounded.
Files must be regular, singly linked and stable during reading; package,
index and proof reads allocate only their bounded initial size. The existing
fixture loader runs under the same exclusive-custody assumption between
matching bounded snapshots. No source text, provider errors, paths,
participant identity or account details are copied into the report.

## Fixed gates

The report always prints all 39 rows. `required` distinguishes the selected
profile's obligations. The three final operational rows are required only
for `1.0`; the fixture diagnostic never supplies release credit. The RC
profile does not accept 1.0.

| Gates | Required proof and current adapter status |
| --- | --- |
| `evidence.index` | Closed index validation; implemented |
| `artifact.<target>` for both targets | Local package and recorded fixture-step consistency; implemented with `automated-fixture-integrity` scope |
| `native.<target>` for both targets | Trusted producer revision and native execution attestation; `UNVERIFIABLE` |
| `lifecycle.<target>` for both targets | Actual normal install, upgrade, restart, reboot and uninstall; `NOT_IMPLEMENTED` |
| `candidate.required-checks` | Exact-candidate required CI/check identities; adapter `NOT_IMPLEMENTED` |
| `candidate.independent-review` | Independent specification/security and regression review; adapter `NOT_IMPLEMENTED` |
| `candidate.current-p0-disposition` | Complete current-head findings and explicit freshness policy; `UNVERIFIABLE` |
| `surface.capabilities-and-docs` | Executable capability/legacy-surface inventory and SECURITY/docs/API agreement; adapter `NOT_IMPLEMENTED` |
| `journey.connect-resume` | Complete connector capability, limit, cursor, sensitivity and account/history/edit/delete/restart evidence |
| `journey.correct-belief` | Correction, supersession, provenance, canon/query/context/MCP agreement and undo |
| `journey.revoke-purge` | Immediate and restarted denial, retained consumers, all owned stores and pending cleanup |
| `journey.retrieve-trustworthily` | Fixed versioned relevance, latency and extraction corpus with declared metrics, citations and abstention |
| `journey.import-estate-slice` | Approved mapping and scope, applied import/recovery, receipts, authority and unresolved loss inventory |
| `journey.daily-loop` | Deployed named contracts, one goal authority, missing data cases and normal-week usefulness |
| `journey.useful-insight` | Named question/insight contracts, insufficient-evidence cases and human usefulness |
| `journey.install-recover` | Both native packages and lifecycles, backup/clean restore and unfamiliar-user proof |
| `connector.<id>` for all fifteen C3 entries | Per-provider/file conformance and applicable real-source evidence; adapters `NOT_IMPLEMENTED` |
| `human.unfamiliar-user` | Non-author, fresh machine, zero coaching and fifteen-minute milestone; adapter `NOT_IMPLEMENTED` |
| `owner.seven-day-rails` | Real supervised owner observation covering 604800000 ms and every due rail; producer `NOT_IMPLEMENTED` |
| `estate.fourteen-day-parity` | Paired real estate evidence covering 1209600000 ms and day-seven owner review; producer `NOT_IMPLEMENTED` |
| `owner.final-cutover` | Current owner authority, reviewed parity/loss record, harness repoint and retained rollback; adapter `NOT_IMPLEMENTED` |
| `diagnostic.fixture-observation` | Existing strict original-directory fixture observer; diagnostic only |

All eight journey adapters remain `NOT_IMPLEMENTED`, even where constituent
product behavior or component tests exist. Adapter status describes acceptance
evidence support, not whether a product feature exists.

The frozen C3 catalogue is Telegram user sign-in, Gmail, Google Calendar,
IMAP, ICS, WHOOP, X API, screenpipe, Markdown folder, ChatGPT export, Claude
export, X archive, WhatsApp export, Pocket and Omnivore. Report entries include
the current connector IDs; X API has `connector_id: null` because this candidate
has no registered API connector. File importers cannot stand in for live
accounts. Composio and WhatsApp Business API remain explicitly deferred.

## Trust and qualification limits

Hashes establish local byte consistency under a trusted operator's custody.
They do not authenticate a person, prove an actual account authorization,
attest that JSON assertions describe an execution, or defend against a
compromised host or a hostile process that controls the evidence directory.
The existing artifact receipt has no producer revision or independent native
attestation; the report records `producer_revision: null` and leaves the
separate native gate unverifiable. A synthetic test package can satisfy byte
consistency only. Its presence never establishes native or human acceptance.

The report records the exact index digest, package/proof digests, closed
policy digest and hashes of the local verifier files. Gate evidence digests
refer only to successfully verified retained bytes; failed rows have no
verified digest, while the index digest binds the submitted claims. All gates
share the report's candidate and verifier
identity. Artifact-proof v1 has no observation interval. Fixture diagnostics
display actual observed and credited duration, last observation and pending
boundary rails, with `release_credit: false`. Nothing advances observation
time, starts a service, opens an account, or calls a model.

The checker has no trusted attempt inventory, actor/account authority source,
current remote CI status, review source or P0 freshness policy. These gaps
cannot be filled by a handwritten passing flag or selecting a green rerun.
Retain failed attempts and unresolved findings with the candidate; future
adapters must validate their complete disposition before granting acceptance.
An offline report cannot discover a finding created after its input snapshot.

Seven and fourteen dated files do not prove those elapsed intervals. Fixture
window completion, synthetic clocks, unit tests and agent concurrency do not
qualify owner rails or estate parity. Artifact changes need a new observation
unless a separate reviewed carry-forward policy exists; none exists here.
The [unfamiliar-user protocol](unfamiliar-user-proof.md) defines a future human
run, and does not itself produce a trusted passing receipt.

## Verification

```bash
bun test scripts/go-no-go.test.ts scripts/stranger-proof.test.ts scripts/release-artifacts.test.ts scripts/release-targets.test.ts scripts/qualification.test.ts
bun run typecheck
bun run verify
```

The evaluator tests use synthetic packages, temporary vaults and hostile
evidence. They verify refusal and enumeration, never live platform, account,
human or elapsed qualification. Retain the exact candidate SHA, commands,
complete results and any failing checks with each implementation review.
