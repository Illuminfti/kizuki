# Result R098

Outcome: **FINDINGS** (prepared inventory; no signed-artifact false claim found). Scope: current-code map of signed/unsigned/notarized/platform-trust claims and closed release metadata fields.

- Repository/worktree/branch: `/repo` git archive of exact base; no Git metadata; not a live worktree
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; head not independently resolved (`git rev-parse` fails); no source edits
- Dirty/local-only state and owned files: repository untouched; outputs only under `/work/out`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, orient-repository, issue-pickup-execution, documentation-accuracy, release-readiness, handoff-work
- What changed and why: no repository change; produced claim-to-evidence map and unsigned-field inventory
- Ownership/dependencies: P006 canonical docs; P094/P100 consume this map; P003/P015 reserved

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `TMPDIR=/work/out/tmp bun test scripts/stranger-proof.test.ts scripts/release-artifacts.test.ts scripts/release-targets.test.ts scripts/artifact-proof.test.ts` on archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06; 45 pass 0 fail | PASS |
| Closed BUILD.json extra signing keys | bun probe of `parseBuildInfoValue`; `/work/out/checks/closed-build-schema-probe.json` exit 0 | PASS |
| go-no-go native UNVERIFIABLE tests | `bun test scripts/go-no-go.test.ts` | NOT_RUN (`js-tiktoken/lite` missing; no install) |
| extraction-quality extra-key tests | `bun test scripts/extraction-quality-native.test.ts -t artifact` | NOT_RUN (same missing module) |
| Tracked workflow git listing | `git ls-files .github/workflows` via verify-workflows | FAIL/NOT_RUN in this archive (git exit 128; no metadata) |
| Native compile / codesign / notary / gh attestation | compile forbidden; Apple/`gh` tools absent; Linux host; no `dist/` | NOT_RUN |
| Package/type/full gate | `bun run verify` | NOT_RUN (no Git history, no frozen install) |
| Privacy/diff integrity | no source diff; no credentials; no vault | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no binary built | NOT_RUN |

Findings first, severity ordered:

1. **Coverage gap (low), `scripts/build-release.ts:75`**: package README.txt unsigned sentence is written but not asserted by any test. Closed-key BUILD.json tests already exist (`scripts/stranger-proof.test.ts:26-38`). Do not duplicate.
2. **Docs tension for P006 (low), `CONTRIBUTING.md:89` vs local native package**: contributor text says not to invent a packaged binary; `build:release` already emits a local unsigned package. Not a claim that artifacts are signed.
3. **Historical spec not shipped (info), `docs/wave1/specs/packaging-release.md`**: `gh attestation verify` / Sigstore permissions are unimplemented. Current workflows are `contents: read` only.

Confirmed: current producer and current docs claim **unsigned / not notarized / not a signed installer**. No finding that the tree claims a signature it does not produce.

Remaining risk: native compile, Apple Gatekeeper, GitHub attestations, and go-no-go tests were not executed here. Next smallest action: P094/P006/P100 consume `/work/out/claim-to-evidence-map.md` and `/work/out/unsigned-metadata-fields.json` without adding unsigned booleans to BUILD.json.
