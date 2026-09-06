# P101 corrective handoff: closed CLI diagnostics

Root-authorized correction on 2026-09-06. Integration base remains `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`. Start from existing candidate `d9b3969c7ff2d43e624094760c854456fc590cbc`. Preserve its history and add a normal corrective commit; no amend, reset, rebase or replacement commit.

Own exactly `scripts/qualification.ts` and `scripts/qualification.test.ts`. The accepted canonical-value comparisons in collect, sampleQualification and statusQualification must remain. Reordering keys remains equivalent; changed values still refuse or interrupt. Preserve genesis inode/digest checks, proof validation, package hashes, privacy projections, sampling and process-binding semantics, and every existing test assertion.

The original candidate has a sealed passing receipt: run `633ee1bb85eb49868a28828511ebecb0`, 38 tests passed with 184 assertions, exit 0. Root independently found the diagnostic fallback blocker despite that pass. Preserve that result accurately; it does not resolve the review finding or replace a corrected-candidate run.

## Required correction

At the starting candidate, `cliDiagnostic` maps SyntaxError, SQLiteError and syscall-bearing errors to fixed messages, but its final branch still returns arbitrary `Error.message`. That branch does not satisfy the closed diagnostic contract. Its ArtifactProofError branch also returns `reason` unchecked: the constructor accepts a string, even though the inspected producer presently emits bounded reason literals.

Make the final CLI rendering boundary admit only a closed set of trustworthy diagnostic values. Unknown ordinary exceptions, unknown proof reasons, non-Error values and otherwise unclassified failures must produce a fixed generic diagnostic such as `qualification failed`, with failure exit 1 and empty stdout. Keep the existing fixed JSON, filesystem and SQLite messages. Preserve useful fixed usage guidance and useful known qualification/proof failure messages where their exact finite vocabulary is established from source.

A narrow implementation can use explicit literal sets for the local qualification messages and reviewed proof reasons, or a local diagnostic class keyed by closed codes and rendered through fixed messages. A class whose payload is still an arbitrary string is insufficient. Do not allow arbitrary message/reason strings merely because they match a regular expression, have a familiar prefix, look like a reason code, or fall below a length limit. Do not turn runtime source parsing into a diagnostic allowlist.

Inspect the owned qualification file's fixed failures and the existing artifact-proof producer statically. Its `reject` calls, missing/unqualified engine results and qualification's unsupported-package version result explain the existing proof vocabulary; keep the artifact-proof implementation unchanged. Unrecognized values fail closed at this CLI boundary. Do not introduce a general error framework or alter collection/proof control flow to solve presentation.

## Validation and delivery

Preserve the original reorder, changed-value, JSON/filesystem/SQLite diagnostic and useful-usage assertions, as well as all earlier tests. Any necessary new coverage must be ordinary bounded diagnostic mapping cases with neutral values. Do not add vulnerability, data-exposure, filesystem-fault, timing/race, resource or account reproductions. Do not manufacture provider or private data.

Root owns sealed test execution. Do not run Bun tests, product commands, builds, proof producers or ad hoc reproductions in the worker container. Write `/work/out/test-request.json` with a new request id such as `p101-correction-closed-diagnostics` and exactly `test_paths: ["scripts/qualification.test.ts"]`. If no root result is supplied, finish with `awaiting_root_test`; do not claim a pass or poll indefinitely.

Add a normal commit containing only the corrective owned changes, retaining the supplied start head as an ancestor. Report base_sha, start_head, final head_sha/tree, exact changed paths, the test request and any supplied root receipt in `/work/out/result.json`. Keep all existing failure evidence. No Core, artifact-proof, other test, controller, roster, docs/help, account, native, service, model, remote or release changes. Final acceptance belongs to root after sealed results and independent review.
