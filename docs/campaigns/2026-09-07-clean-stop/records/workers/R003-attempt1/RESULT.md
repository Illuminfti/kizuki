# Result R003

Outcome: FINDINGS. Scope: BUILD identity field lineage from `kizuki.release-build/v1` production through proof expected identity and qualification identity, using harmless matching and ordinary-mismatching fixtures.

- Repository/worktree/branch: frozen git archive at `/repo` (no Git metadata, no worktree, no branch). Owner: grok-R003. Write scope `/work/out` only.
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). Head did not move; no source edits.
- Dirty/local-only state and owned files: repository unchanged. Outputs only under `/work/out`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, RFC 0002, RFC 0000, `docs/architecture.md`. `vps-nav` / git fetch not run (controller-owned archive).
- What changed and why: preparation artifacts only. No public product behavior changed.
- Ownership/dependencies: P003 retains shared evidence design; P015 source-B; P006 canonical docs. This packet feeds P008 and P094. No authority to replace those owners.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/identity-fixture.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 22 cases, `/work/out/identity-fixture.report.json` | PASS |
| Existing proof/BUILD unit tests | `cd /repo && bun test ./scripts/artifact-proof.test.ts ./scripts/stranger-proof.test.ts ./scripts/release-artifacts.test.ts ./scripts/release-targets.test.ts`, 45 pass / 0 fail | PASS |
| Qualification / go-no-go / native-quality identity tests | bun test filters as in `/work/out/checks.md` | NOT_RUN (missing `js-tiktoken/lite`; no `node_modules`; install forbidden) |
| Package/type/full gate | `bunx tsc`, `scripts/verify.sh` | NOT_RUN (no full-suite slot; bash/node_modules incomplete) |
| Native BUILD production | `bun scripts/build-release.ts` | NOT_RUN (Git required; archive has no Git metadata) |
| Privacy/diff integrity | no source diff; fixtures are synthetic SHAs and public schema fields | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no native package built | NOT_RUN |

Findings first, severity ordered:

1. **Qualification identity drops `bun_version` (and BUILD `schema`).** `scripts/qualification.ts:81,104` stores `{source_sha, binary_sha256, build_sha256, proof_sha256, target}`. Proof expected identity still carries `bun_version` (`scripts/artifact-proof.ts:18-20,96-97`). Confirmed by fixture case `qualification-identity-drops-bun-and-schema`. Affected invariant: toolchain identity from BUILD production should remain comparable at proof consumption. Smallest correction (for P008/P094, not this lane): add `bun_version` to stored identity, or document that `build_sha256` is the only binding and every re-read uses `parseProofJson`.
2. **BUILD decoder split.** `parseBuildInfo` uses `JSON.parse` (`scripts/stranger-proof.ts:101`); qualification and go-no-go use `parseProofJson` on hashed BUILD bytes (`scripts/qualification.ts:94`, `scripts/go-no-go.ts:118`). Duplicate `source_sha` last-wins under JSON.parse and is `duplicate-json-key` under parseProofJson. Confirmed by fixture cases `json-parse-duplicate-source-sha-last-wins` and `parseProofJson-duplicate-source-sha`. Production `JSON.stringify` cannot emit duplicate keys; this is a consumer inconsistency on non-canonical bytes. Smallest correction: `parseBuildInfo` should decode with `parseProofJson`.
3. **`bun_version` validation is uneven.** `parseBuildInfoValue` accepts `""`; proof `text(..., 64)` rejects `invalid-proof-string`; go-no-go semver regex rejects. Confirmed by fixture cases `empty-bun-parses-as-string`, `empty-bun-fails-go-no-go-semver`, `empty-bun-proof-text`. Production `Bun.version` is nonempty, so this is a parser-floor gap.
4. **`SHA256SUMS` trim vs exact compare.** `verifyChecksumManifest` trims (`scripts/release-artifacts.ts:47-49`); qualification/go-no-go compare exact reconstructed bytes (`scripts/qualification.ts:92-93`, `scripts/go-no-go.ts:121-122`). Extra trailing newline passes smoke/proof checksum verification and fails qualification. Confirmed by fixture checksum cases.
5. **Proof receipt `bun_version` is runner `Bun.version`, not a copy of BUILD.** Static: `scripts/stranger-proof.ts:283,291,307` with host pin at line 152. Matching is required, but the field is not echoed.
6. **Pretty vs compact BUILD bytes.** Production pretty-prints (`scripts/build-release.ts:99-107`); equal fields hash differently. Confirmed `pretty_sha256=125a885d0daa2be7da3c6ad7ec1bab0dd62f9b206b1772ad9c9a3dfe30f6d1e0` vs compact `a97eff15cca2b927d20a5c18d21358138ea7096c100477fde3b9b363fa804c9c`.
7. **Smoke does not consume `source_sha`.** Static: `scripts/smoke-release.ts:22-24`.

Hypotheses, not confirmed by execution: none of the above were observed on a real `build-release.ts` package because Git is absent.

Remaining risk: qualification/go-no-go tests unread-as-executed; no native package; no full gate. Next smallest action: P008/P094 consume `/work/out/field-lineage.md` and `/work/out/identity-fixture.ts` after rebase; do not duplicate tests listed in `/work/out/existing-coverage.md`.

No credentials, private records, or owner-vault paths.
