# Reflex impact experiment: verification and handoff

Date: 2026-09-17. Status: experimental implementation preserved for review, not merge-ready or activated in a live vault.

## Delivery identity

The branch adds `packages/reflex`, `docs/reflex-design.md`, this receipt, and the two workspace-registration entries in `bun.lock`. It is based on main `bee797ea7c6a8bba0a0f88ed06cb3329952c399f`, which includes Jev reranking PR #938. No existing core, CLI, retrieval, model-transport, canon, workflow, deployment or `.maestro` files are changed.

The complete 19-file `packages/reflex` Git tree is `4f2473194198b7df3f2760d0ea8da7fbe1f2ee8b`. Its hash was computed from the local delivery and matched against the uploaded GitHub subtree. This binds the tested source, tests and demo source to the uploaded bytes. It does not substitute for executing the complete repository at the final commit. The containing commit and pull request are the final head identifiers.

PR #944 is a separate core/CLI evidence-before-action implementation. Its branch and files were left untouched. This experiment's schema was changed to `kizuki.reflex-impact/v1` to avoid conflating its dependency-impact report with #944's differently shaped `kizuki.reflex/v1`. Both designs require reconciliation before a production journey exposes them.

## Executed checks

The 72 focused tests were rerun after the schema-name change: 72 passed, zero failed, zero skipped. They ran under Node 22.16.0 after TypeScript 5.8.3 compilation, not under Bun.

Strict scoped TypeScript checks passed in both ESNext/bundler/noEmit mode and CommonJS compilation mode. Settings included strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noUnusedLocals and noUnusedParameters. The ESNext pass also enabled verbatimModuleSyntax.

The local check mapped `@kizuki/core/contracts` to an explicitly identified, temporary request/response/port contract slice. It was not a full Kizuki checkout or workspace typecheck. Production source retains the normal type-only import from `@kizuki/core/contracts`; no shim or alternate runtime contract is installed in this branch.

Focused coverage includes request and byte reservations, concurrent evaluation ceilings, hung provider requests, stale snapshots and revocation during evaluation, destination changes after authorization, provider-error redaction, missing model configuration, malformed typed answers, revision-aware advisory preflight, cycle-safe propagation, complete trace provenance, 100 seeded random graphs checked against an independent transitive-closure oracle, and a 2,000-node dependency chain.

The local verifier executed `tsc --noEmit --module ESNext --moduleResolution bundler --verbatimModuleSyntax true`, a separate CommonJS `tsc` compile, and `node --test --test-concurrency=3` over the three compiled test suites using the scoped configuration described above. The local verification log's SHA-256 is `bdb73d60c08cec104bf2d3be3e862ec7574ce87142ca0dde461f395c041fdab3`. The supplemental contract slice's SHA-256 is `51df5722540527a7b6d2b24a5eeac2a0d7c0b45a38b26ee453dfa04a28f39681`. Those development artifacts remain in the delivered source bundle, not in production imports.

## Earlier visual evidence

The preceding delivery included Chromium checks of the synthetic offline HTML at desktop 1440x1120 and mobile 390x844. Both exercised six modes and JSON export without page errors, external requests or horizontal overflow. The mobile check used reduced motion. These are historical demo checks from before the report-schema rename, not a fresh browser check at this commit and not live-vault qualification.

## Not executed or established

The environment had neither the repository's Bun 1.3.14 runtime nor a complete checkout. `bun install --frozen-lockfile`, the native Bun test run, full-workspace `bun run typecheck`, and `bun run verify` remain required. The workspace lockfile entries were added without upgrading third-party dependencies; a successful frozen install is not claimed.

There was no live Jev request, API key use, paid provider call, live-vault integration test, independent coding-agent review, deployment, release, merge or settings change. No accuracy, cost-savings, latency or superiority benchmark is claimed. The five typed questions are correlated judgments from one model, not five independent agents.

The host adapter still requires actual core-owned snapshot construction, source lineage, destination-specific egress consent, currentness and audit callbacks. A caller-built JSON snapshot is not authority. The implementation never authorizes execution or writes canon.

## Required next gates

From a complete checkout on the exact review candidate:

```sh
bun install --frozen-lockfile
bun test packages/reflex/test
bun run typecheck
bun run verify
bun run packages/reflex/demo/run.ts
bun run packages/reflex/demo/build.ts
```

Inspect the generated offline lab, review specification/security and implementation/regression axes, and reconcile #944 before production integration. Keep the pull request draft until its acceptance evidence is complete. No merge or deployment is authorized by this handoff.
