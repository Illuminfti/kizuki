# P101 corrected qualification independent review

**Verdict: ACCEPT for the bounded production correction at `7a217b3f274068b8bdb4b471811692622fcccf85`.** No blocking findings. Static review and independent verification of root's retained test evidence were complete before the owner's clean-stop instruction. This is candidate acceptance for integration, not release qualification.

## Exact scope and ownership

- Clone: `PRIVATE_FLEET/code-repos/P101`.
- HEAD: `7a217b3f274068b8bdb4b471811692622fcccf85`; tree: `bc1e0ca6c157153404e018d7d566a0f0c877f4f7`.
- Normal parent chain: corrected HEAD → `d9b3969c7ff2d43e624094760c854456fc590cbc` → base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.
- Full base-to-HEAD diff: exactly `scripts/qualification.ts` and `scripts/qualification.test.ts`, as authorized by the original and corrective P101 handoffs in `GROK-P101-P105-CODE-PACKETS`. Worktree clean; `git diff --check` passes.
- Review covered the full diff, corresponding qualification/manifest/proof code and existing tests. The reviewer did not modify candidate files, execute product tests or perform reproductions.

## Findings and behavior

The three semantic comparisons in collection, sampling and status use the existing canonical object representation. It sorts object keys recursively while preserving array order and values. Manifest schema validation, canonical genesis digest, inode identity, artifact byte hashes, proof validation and sample interruption logic are unchanged. The new reorder test changes serialized key order, confirms status/sample acceptance, and confirms changed schedule values still interrupt. Its changed identity fixture reaches and retains the artifact/proof identity rejection. Existing genesis, package, privacy and process-binding assertions remain intact.

The corrected CLI renderer has two literal finite allowlists: known local/core qualification messages and reviewed `ArtifactProofError` reasons. Proof reasons are checked even though their constructor accepts a string. JSON, SQLite and syscall-bearing errors map to fixed messages. Every unknown ordinary error, unknown proof reason and non-Error value maps to `qualification failed`; neither a prefix nor a regular expression admits arbitrary text. Useful fixed usage guidance remains. The CLI catch sets exit 1 and only successful command completion prints stdout.

The diagnostic lists were compared with local throw literals, core qualification failures and the unchanged artifact-proof producer's reject/engine vocabulary. The added tests exercise closed mapping with ordinary neutral values, retained fixed class diagnostics, useful local/proof messages, empty failure stdout and exact stderr. No proof producer, collector control flow or core policy was changed to alter a diagnostic.

## Retained execution and identity

Root's sealed run `893bbc0ef9874ff88979b5f227e3419f` executed `bun test scripts/qualification.test.ts`: **39 pass, 0 fail, 207 assertions**, one file, reported test duration 3.81 seconds. Full retained stderr was read; stdout identifies Bun 1.3.14 (`0d9b296a`). Exit 0, no termination reason, `stale: false`, confirmed cleanup, and matching observed/retained log byte counts were independently checked.

The complete candidate diff equals the runner's owned overlay set. Every committed blob, current file, frozen source file and owned receipt hash agrees. Canonical before/after identity objects and their independently recomputed digest match: `70f57cdc90e3800e9fa493641a85ec03de32953db896ff6c730db883b6a1f79b`. This run used the ordinary archive with `workflow_git_index: false` and no `.git` directory.

| Artifact | SHA-256 |
| --- | --- |
| `scripts/qualification.ts` (28,982 bytes) | `29957437b185b9ebeb25e3d78f44bda19c4b5b22d8415208a0c3c054f5ee14d7` |
| `scripts/qualification.test.ts` (30,631 bytes) | `066faa555239110ed04ddd16f5350051e5881cb7fd77d5ab37fb74a55425f987` |
| Corrected `result.json` | `6d0efcbdb6552d60bc2d084996e3fdc9e1085a595d9f3b054471a7b427b1c476` |
| Corrected stdout (28 bytes) | `d6684989b8dd63b37d2f1954270826fbe1bd89a8debd12bcacf03ed1c6140ef6` |
| Corrected stderr (3,582 bytes) | `3ecc5d255e9c1db0e0b15926b6bfab8dc8b3875feadd86bbddc4b940f79a61f3` |

Evidence remains under `PRIVATE_FLEET/test-controller/runs/893bbc0ef9874ff88979b5f227e3419f/`. The fixed `aca1b9d024834903f414fcbb90e096ec406152e8b08177bb00f4b991cc811eef` image used no network, read-only source/dependency mounts and bounded temporary storage.

Original run `633ee1bb85eb49868a28828511ebecb0` remains accurately retained as **38 pass, 0 fail, 184 assertions** at `d9b3969c7ff2d43e624094760c854456fc590cbc`; it did not resolve the later diagnostic review finding. Its independently rehashed result is `4e8150cf74db2b06c78bc7c584d2f2612d2cdd4e7427267b2a0438b899ed910d`, stderr `5b0b700bc384e2003ab758127d83ac72e0dc22afc79625486d55fbff340e84bc`.

Full repository/type checks, merged artifact proof and real qualification windows remain separate. These synthetic fixtures establish neither owner-runtime nor elapsed qualification credit.
