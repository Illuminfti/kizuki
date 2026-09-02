---
name: release-readiness
description: Determine whether a Kizuki branch or version is genuinely ready to ship by checking exact-head correctness, compatibility, migrations, privacy, security, documentation, recovery, packaging, and rollback evidence. Use before tagging, publishing, or recommending release.
---

# Release readiness

## Binding context (read first)

Read `docs/CURRENT.md`, `docs/decision-log.md` and
`rfcs/0002-autonomous-canon.md` before anything else in this playbook. They
are binding and override every other document in the tree, including this
one. Never write, restate or re-derive a superseded policy as current:
owner-invoked promotion as the canon write path, or any owner review queue
or approval step (D9, D10; corrections go through MCP `correct` and
`kizuki tell`, D14); owner labeling of sensitivity (D11; auto-labeled,
private by default); a zero-model floor that writes canon (D12; capture,
ledger, search, timeline, context, audit and undo stay model-free); a
SQLite-only rule for derived retrieval (D13; retrieval sits behind a
versioned port with its own rebuildable store under the vault); an
owner-started daemon (D15; `kizuki init` installs it); or the review gate as
the product's moat (C8).

Fail any change that reintroduces one of those policies, in code, tests,
documentation, specs, skills or pull-request text.

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
- the model-free floor with no model and no network services: capture, ledger, search, timeline, context, audit and undo, with `doctor` reporting canon writing as off (docs/decision-log.md D12);
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
