# Release acceptance evidence

Evidence date: 7 September 2026. The checked-in acceptance checker inventories
the fixed RC and 1.0 obligations and validates the supported local evidence.
The current producer set cannot establish release `GO`: independent review,
live accounts and unfamiliar-user acceptance still need their required evidence.
The online collector can qualify current CI, native packages and complete
installed-service lifecycle receipts under the contracts below. The current readiness bar is a stranger who
can install and use the product, zero live P0 findings, and honest installation.
The [current campaign decision](decision-log.md#owner-amendment-to-readiness-2026-09-05)
supersedes seven- and fourteen-day calendar gates and estate cutover as
readiness or 1.0 tag prerequisites. Longer observation remains an optional
diagnostic after readiness; operational cutover requires its own authority.
Product, connector, model, security, recovery, platform, independent review,
and unfamiliar-human requirements remain.

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

The parent output directory must already exist. Complete private bytes are
synced before atomic publication without replacing an existing destination.
The parent directory is synced even when temporary-file cleanup fails. A
`published-report-cleanup-failed` or `published-report-durability-unconfirmed`
error means complete output exists, but publication did not finish cleanly;
do not retry the same output path. The checker writes a new
private file exclusively, flushes it and its directory, and also emits the
report JSON on stdout. Exit status is `0` for `GO`, `1` for a produced `NO-GO`
report, and `2` for invalid arguments or failure to retain the output. A
corrupt or missing index still yields the complete gate inventory with a
failed index gate. Existing reports are never overwritten. There are no
waivers, actor declarations, skip flags, threshold overrides or clock flags.

### Observe current GitHub checks

The explicit online collector can establish `candidate.required-checks` by
reading GitHub during the evaluation. It resolves the fixed public repository
ID, then orders each candidate workflow by its latest attempt's `run_started_at`.
An older run that was rerun most recently takes precedence over a newer run
number. Missing or tied start times cannot establish order. Any pending required
attempt prevents credit. Earlier failures remain explicit history and review
obligations; they do not permanently veto a later successful attempt. Every
required job and authored step must have succeeded. A second inventory and
latest-attempt read refuses changes during collection.

```bash
bun scripts/github-release-evidence.ts --profile rc --evidence /absolute/evidence/index.json --checkout /absolute/clean-candidate --out /absolute/new-github-evaluation
```

The collector uses existing `gh` read access and performs GET requests only.
Native archive inspection also requires Python 3 with its standard `zipfile`
module in isolated interpreter mode; downloaded executable bytes are never launched by the collector.
The candidate checkout must be clean and match the index SHA. It validates
that checkout's workflow and toolchain files with the current verifier, and
binds invoked package scripts and associated hooks to the collector's reviewed
definitions; it
also binds the collector's separate clean source revision and transitive product
imports. Both source
inventories, raw public API responses, and observation hashes are retained in
the new private output directory alongside `acceptance-report.json`.

There is no repository, host, run, attempt, or passing-facts option. Saved API
JSON is useful for review but cannot be submitted to establish online credit.
The offline checker continues to leave raw CI receipts unverified. This online
path can also establish each `native.<target>` gate from one successful paired
native workflow attempt. Before collecting native evidence, the candidate's
build, smoke and artifact-proof harnesses and their complete resolved product
source closure must match the separately reviewed collector harness bytes.
Both closures and resolution metadata are retained and checked again before
credit. This compares evidence producers; product entrypoints executed as test
subjects may change independently. A changed producer needs a newly reviewed
collector, and otherwise leaves native evidence unverifiable.

Both exact hosted matrix jobs, authored step results,
artifact names, repository/run/source identities and API archive digests must
match. Each artifact's creation and update times must be ordered and fall between
that attempt's successful upload-step start and the same native job's completion.
Artifact backend timestamps can follow the action's recorded step end; no fixed
clock tolerance is added. Jobs, artifacts and attempts are reread after download;
CI is checked again before credit. The archive must contain exactly the seven
current package files, the current artifact proof and the retained lifecycle
diagnostic. Bounded
archive inspection rejects links, paths outside that inventory, duplicates,
truncation and oversized files, then applies the current package/proof parsers.

The online collector evaluates surface receipts against its explicit candidate
checkout. When evaluator and candidate commits differ, the complete transitive
surface implementation, producer, dependency metadata and observed documentation
must match in bytes and modes. Both clean checkouts are checked again before and
after receipt evaluation. A different collector commit alone does not change the
product identity; a changed surface closure remains refused. The offline CLI
continues to evaluate its own checkout by default.

Native credit also requires both packages in the supplied v4 index. Each target's
seven package digests, including `BUILD.json`, and proof digest must equal the
freshly downloaded native evidence. A missing indexed package leaves native
credit unverifiable; any mismatch fails it. Matching source revisions alone do
not bind builds. Artifact and engine gates remain owned by the offline evaluator
and its current parsers; the online path does not override their decisions.

For a first collection without package references, the verified downloaded files
remain under `<out>/<target>/package/` and `<out>/<target>/artifact-proof.json`.
Create a new v4 index referencing both directories and proof files with their
recorded proof digests, then run the online checker again with that index and a
new output directory. The second observation must still find the same current
successful attempt and package bytes. An old or different build cannot supply
artifact or engine credit for the new native observation.

Legacy lifecycle receipts remain diagnostic evidence. The online collector can
establish `lifecycle.<target>` only from the same successful paired native run and
attempt, whose downloaded package and proof digests equal the current offline
index. Its closed v2 receipt must pass all 17 independent phase checks and complete
per-unit cleanup. The collector separately binds the candidate and reviewed
transitive lifecycle producers, baseline builder, recovery and model helpers,
explicit endpoint child, and four fixed historical fixture files.

This contract covers installed candidate lifecycle, a distinct fixed prior
candidate binary upgrade, historical schema 15/16 migration and recovery, five
native states, and synthetic model availability and recovery. Offline recovery
uses an explicitly recorded synthetic sync due-time adjustment while stopped,
then a real scheduled receipt after installed-service restart; it does not claim
that 15 minutes elapsed or an unassisted retry delay was observed. Prior package
hashes and engine identities are reviewed builder observations; prior bytes are
not independently downloaded in this nine-file artifact. Released-version
upgrades, hardware reboot, host network isolation, public distribution, and human
trials are not asserted. Saved JSON alone cannot establish online lifecycle credit.
Accounts, independent review, findings and unfamiliar-human acceptance also
remain separate required evidence. Earlier native failures remain in the history;
a failed paired attempt cannot contribute a single successful platform as a pass.

## Index schema

The current `kizuki.acceptance-evidence/v4` index retains the v3 fields and
limits, and additionally accepts `kizuki.artifact-proof/v3` for seven-file
Build V2 packages. V1, V2 and V3 index producer sets remain unchanged. New
proofs bind the license, notices and closed distribution inventory without
adding release credit for unresolved material or a distribution assessment.

The `kizuki.acceptance-evidence/v3` index extends v2 with a required
`gate_receipts` array. Each reference names its producer, gate, target, absolute
receipt path and SHA-256. V3 accepts at most forty references and 32 KiB of index
bytes. Unsupported evidence families retain their explicit missing-adapter
status; an arbitrary receipt cannot supply release credit.

The implemented `kizuki.surface-inventory/v1` producer is
`scripts/capability-proof.ts`. Its receipt binds the exact candidate's public
commands, MCP tools, connector manifests, C3 inventory and documentation hashes.
The evaluator independently checks the source and receipt before accepting
`surface.capabilities-and-docs`. This gate alone cannot establish release GO.
V1 and v2 remain supported under their original schemas and limits.


`kizuki.acceptance-evidence/v2` has exactly four keys: `schema`,
`candidate_source_sha`, `artifacts` and `fixture_observation`. The candidate
is one lowercase 40-character Git SHA. An empty evidence inventory is valid
and produces missing gates:

```json
{
  "schema": "kizuki.acceptance-evidence/v2",
  "candidate_source_sha": "0000000000000000000000000000000000000000",
  "artifacts": [],
  "fixture_observation": null
}
```

Replace the example SHA with the reviewed candidate. Each of at most two
artifact entries has exactly these keys:

| Key | Required value |
| --- | --- |
| `producer` | `kizuki.artifact-proof/v2`, or historical `kizuki.artifact-proof/v1` with no engine credit |
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
architecture must agree with that target. All sixteen v2 producer steps must
appear in their exact order, with their actual command shapes, timeouts and
successful semantic assertions. A failed receipt cannot supply credit.

V2 includes `host_kernel_release` and an `engine_observations` object with
exactly `kizuki` and `kizuki_mcp`. Each observation binds the copied executable
hash and the closed `kizuki.sqlite-runtime/v1` fragment. CLI records its actual
exit code and doctor status: only 0/ok or 1/error can supply an observation.
MCP requires exit 0 and a successful `system_health` result after a normal
initialize/close session. The two child Bun versions must match BUILD and
policy; their SQLite version/source-ID pairs must agree and match a sourced
policy entry. Unknown identities fail the separate required engine gate.
The kernel-release field does not establish a vendor's OS patch status.
See [the collection contract](stranger-proof.md#effective-sqlite-engine-evidence).

Historical v1 indexes accept only v1 artifact references; their fourteen-step
receipts remain readable as fixture evidence. V2 indexes can inventory either
version, with the reference producer matching the receipt exactly. A v1
receipt leaves `engine.<target>` missing with `missing-engine-proof`. Changing
the evaluator never upgrades old evidence; rerun the compiled binaries for v2.
The report and acceptance policy use explicit v2 schema tags.

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

The report always prints all 41 rows. Both profiles require the same readiness
obligations. The three superseded operational rows and the fixture diagnostic
have `required: false`; they never supply release credit. Only the `1.0` profile
can set `release_1_0_accepted` after every required row passes.

| Gates | Required proof and current adapter status |
| --- | --- |
| `evidence.index` | Closed index validation; implemented |
| `artifact.<target>` for both targets | Local package and recorded fixture-step consistency; implemented with `automated-fixture-integrity` scope |
| `engine.<target>` for both targets | Both copied executables report the matching qualified SQLite identity and pinned Bun; v1 is missing, unknown identities fail |
| `native.<target>` for both targets | Trusted producer revision and native execution attestation; `UNVERIFIABLE` |
| `lifecycle.<target>` for both targets | Online current paired native v2: install, distinct prior candidate upgrade, historical migration/recovery, native states, synthetic model matrix/recovery, restart, uninstall and complete cleanup; saved receipts remain unverified |
| `candidate.required-checks` | Exact-candidate required CI/check identities; adapter `NOT_IMPLEMENTED` |
| `candidate.independent-review` | Independent specification/security and regression review; adapter `NOT_IMPLEMENTED` |
| `candidate.current-p0-disposition` | Complete current-head findings and explicit freshness policy; `UNVERIFIABLE` |
| `surface.capabilities-and-docs` | Exact-candidate executable surface and documentation inventory; v3 receipt adapter implemented |
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
| `owner.seven-day-rails` | Optional post-readiness diagnostic; `NOT_IMPLEMENTED`, `superseded-readiness-gate` |
| `estate.fourteen-day-parity` | Optional post-readiness diagnostic; `NOT_IMPLEMENTED`, `superseded-readiness-gate` |
| `owner.final-cutover` | Separate operational decision; `NOT_IMPLEMENTED`, `superseded-readiness-gate` |
| `diagnostic.fixture-observation` | Existing strict original-directory fixture observer; diagnostic only |

All eight journey adapters remain `NOT_IMPLEMENTED`, even where constituent
product behavior or component tests exist. Adapter status describes acceptance
evidence support, not whether a product feature exists.

The frozen C3 catalogue is Telegram user sign-in, Gmail, Google Calendar,
IMAP, ICS, WHOOP, X API, screenpipe, Markdown folder, ChatGPT export, Claude
export, X archive, WhatsApp export, Pocket and Omnivore. Report entries include
the current connector IDs, including the registered X API connector `kizuki.x`.
Registration does not establish actual account qualification. File importers
cannot stand in for live accounts. Composio and WhatsApp Business API remain explicitly deferred.

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
identity. Artifact proofs have no operational observation interval. Fixture diagnostics
display actual observed and credited duration, last observation and pending
boundary rails, with `release_credit: false`. Nothing advances observation
time, starts a service, opens an account, or calls a model.

The offline checker has no trusted attempt inventory or current remote CI status.
Neither path has an actor/account authority source, review source or P0 freshness
policy. These gaps
cannot be filled by a handwritten passing flag or selecting a green rerun.
Retain failed attempts and unresolved findings with the candidate; future
adapters must validate their complete disposition before granting acceptance.
An offline report cannot discover a finding created after its input snapshot.

For optional observation, seven and fourteen dated files do not prove those
elapsed intervals. Fixture window completion, synthetic clocks, unit tests and
agent concurrency do not qualify owner rails or estate parity. An artifact
change requires a new optional observation if that diagnostic is being pursued;
there is no reviewed carry-forward policy. These intervals do not block readiness.
The [unfamiliar-user protocol](unfamiliar-user-proof.md) defines a future human
run, and does not itself produce a trusted passing receipt.

## Verification

```bash
bun test scripts/github-release-evidence.test.ts scripts/artifact-proof.test.ts scripts/artifact-engine.test.ts scripts/go-no-go.test.ts scripts/stranger-proof.test.ts scripts/release-artifacts.test.ts scripts/release-targets.test.ts scripts/qualification.test.ts
bun run typecheck
bun run verify
```

The evaluator tests use synthetic packages, temporary vaults and hostile
evidence. They verify refusal and enumeration, never live platform, account,
human or elapsed qualification. Retain the exact candidate SHA, commands,
complete results and any failing checks with each implementation review.
