---
name: release-readiness
description: Determine whether a Kizuki branch or version is genuinely ready to ship by checking exact-head correctness, compatibility, migrations, privacy, security, documentation, recovery, packaging, and rollback evidence. Use before tagging, publishing, or recommending release.
---

# Release readiness

## Pin the candidate

1. Run `orient-repository`.
2. Record the exact candidate SHA and intended base or tag.
3. Freeze review evidence to that SHA. Any head movement invalidates the release decision.

## Gate matrix

Verify:

- full tests, typecheck, repository policy, and diff integrity;
- public API and CLI compatibility;
- fresh install plus supported upgrade and migration paths;
- backup or export and clean restore where required;
- purge, redaction, secret custody, and zero silent egress;
- deterministic fallback without optional model or network services;
- packaging contents and absence of private or generated runtime state;
- README, examples, version claims, licenses, and notices;
- failure recovery and rollback procedure;
- no unresolved high-severity review findings;
- active PR or branch dependencies are integrated in the required order.

Inspect CI jobs and logs attached to the exact candidate rather than relying on
a badge.

## Output

Return a release decision of PASS, BLOCKED, or PASS WITH EXPLICIT RESIDUAL RISK,
with exact receipts. A release-readiness review does not itself authorize a
tag, publish, deploy, or merge.
