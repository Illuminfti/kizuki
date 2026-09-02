---
name: documentation-accuracy
description: Write or review Kizuki documentation so every command, capability, architecture statement, limitation, link, and example matches the exact repository state and clearly separates shipped behavior from design and future vision.
---

# Documentation accuracy

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

1. Pin the exact revision and read code, exports, tests, manifests, RFC status, and current CLI help relevant to each claim.
2. Classify statements as implemented, accepted design, or future direction.
3. Verify commands by running them where practical; verify paths, schemas, defaults, exit behavior, and examples.
4. Never infer shipping status from an RFC, directory, TODO, registry placeholder, issue, or branch name.
5. Check internal links, anchors, Mermaid fences, code fences, package names, and version-sensitive external claims.
6. For providers, licenses, prices, quotas, SDKs, or protocols, re-check current primary sources and record limitations.
7. Use synthetic examples and never expose owner data, credentials, private infrastructure, or local paths.
8. Run the hardened repository verifier and a final claims/privacy pass.

Documentation drift is a product defect. Fix code or docs deliberately rather than wording around a contradiction.
