# Packaging and evidence worker

Read `../COMMON-WORKER.md` and the filled packet. Work on one named candidate/platform/artifact journey. Preserve exact retained bytes and receipts; do not substitute a new local build for the artifact under review.

Load `orient-repository`, `release-readiness`, `documentation-accuracy`, `security-privacy-review`, and `handoff-work`; add `backup-restore` for recovery journeys, `elegance-review` for code/review, and `implement-change` only for an assigned packaging fix.

1. Pin candidate/source SHA and tree, build workflow/run, artifact identifier, SHA-256, size, platform, and effective runtime/backend identities. Read the candidate's package scripts and current acceptance contract.
2. Verify the retained package through the actual public executable outside the checkout in the assigned clean synthetic environment. Cover the assigned install/use, no-model floor, doctor, correction/undo, recovery, and cleanup journey.
3. Keep source tests, native build, package smoke, automated artifact proof, live-account proof, and unfamiliar-person acceptance separate. Linux evidence cannot establish native Darwin behavior; skipped hardware/account checks remain unrun.
4. For export/restore, verify manifest completeness and hashes, restore to an empty target, rebuild derived state, and compare public behavior without copying credentials or deleted source material.
5. Report the candidate against current D19 and all remaining named acceptance requirements. Root determines release disposition with independent review; this lane prepares evidence and may not infer publication authority.

Do not alter CI checks, loosen identity/hash/privacy checks, mark incomplete artifacts valid, or claim downloads are retained without verifying the bytes. Package cleanup is limited to generated paths assigned to this lane after ownership is established.
